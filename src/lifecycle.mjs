/**
 * Sandbox lifecycle operations shared by the action dispatcher, the pane
 * bridge and the event hook. Progress messages go through the injected `log`
 * so pane modes can print to the terminal while captured modes keep stdout
 * clean for the result marker.
 * @module lifecycle
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { resolveAgent } from "./agents.mjs";
import { AGENT_REPORT_SOURCE, TERMINAL_RESTORE_SEQUENCE } from "./constants.mjs";
import { canonicalPath } from "./context.mjs";
import { PluginError, errorKindOf, errorMessageOf } from "./errors.mjs";
import { sandboxGitRemote } from "./naming.mjs";
import { buildCreateArgs, buildExecArgs, classifyFailure, createSbxClient } from "./sbx.mjs";
import { shellQuote } from "./shell.mjs";
import { deletePaneEntry, getPaneEntry, loadState, requirePaneEntry, updatePaneEntry } from "./state.mjs";

/** Lifecycle states in which the sandbox exists and the agent can be attached. */
export const CONNECTABLE_STATES = new Set(["created", "prepared", "ready", "stopped"]);

/**
 * Throws unless the path is an existing absolute directory.
 * @param {unknown} localPath
 * @returns {string}
 */
export function assertLocalPath(localPath) {
  if (typeof localPath !== "string" || !path.isAbsolute(localPath)) {
    throw new PluginError("target", `The workspace path must be absolute (got ${JSON.stringify(localPath)}).`);
  }
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new PluginError("target", `The workspace path ${localPath} is not an existing directory.`);
  }
  return localPath;
}

/**
 * Like {@link assertLocalPath}, but also refuses the filesystem root and the
 * home directory: mounting either read-write into an agent VM is never intended.
 * @param {unknown} localPath
 * @returns {string} The resolved path.
 */
export function assertMountRoot(localPath) {
  assertLocalPath(localPath);
  const resolved = canonicalPath(/** @type {string} */ (localPath));
  const forbidden = [path.parse(resolved).root, canonicalPath(homedir())];
  if (forbidden.includes(resolved)) {
    throw new PluginError("target", `Refusing to use ${resolved} as a sandbox workspace. Invoke start-agent from a project directory.`);
  }
  return resolved;
}

/**
 * Resolves the adapter recorded in a mapping, honoring current config overrides.
 * @param {Record<string, any>} config
 * @param {{agentKind: string}} entry
 */
export function agentForEntry(config, entry) {
  return resolveAgent({ ...config, agentKind: entry.agentKind });
}

/**
 * The sandboxes a mapping still owns: its current name plus every predecessor
 * it replaced, minus those already deleted. This is exactly what a deletion
 * removes, so it is also exactly what a confirmation popup must show.
 * @param {{sandboxName: string, replacesSandboxNames?: string[], deletedSandboxNames?: string[]}} entry
 * @returns {string[]}
 */
export function deletionTargets(entry) {
  const deleted = new Set(entry.deletedSandboxNames ?? []);
  return [...new Set([entry.sandboxName, ...(entry.replacesSandboxNames ?? [])])].filter((name) => name && !deleted.has(name));
}

/**
 * Working directory for `sbx exec`: the recorded directory in mount mode. In
 * clone mode the clone's location is up to sbx, so no directory is forced.
 * @param {{workspaceMode: string, workdir?: string, localPath: string}} entry
 * @returns {string|null}
 */
export function execWorkdir(entry) {
  return entry.workspaceMode === "clone" ? null : entry.workdir ?? entry.localPath;
}

function describeError(error) {
  return { kind: errorKindOf(error), message: errorMessageOf(error), at: new Date().toISOString() };
}

function classifyGitFailure(output) {
  if (/not a git repository|no such remote|does not appear to be a git repository/i.test(output)) return "not-found";
  if (/connection refused|could not resolve|network is unreachable|timed out|could not read from remote/i.test(output)) return "network";
  return "unknown";
}

/**
 * Creates the lifecycle API bound to one state dir, config and sbx client.
 * @param {{stateDir: string, config: Record<string, any>, sbx?: ReturnType<typeof createSbxClient>, log?: (line: string) => void, herdr?: {reportAgent: Function, releaseAgent: Function}|null}} input
 */
export function createLifecycle({ stateDir, config, sbx = createSbxClient({ bin: config.sbxBin }), log = (line) => process.stderr.write(`${line}\n`), herdr = null }) {
  /**
   * Creates the sandbox for a mapping if needed, runs the adapter setup, and
   * verifies the agent command exists inside the sandbox.
   * @param {string} paneId
   */
  function prepare(paneId) {
    const entry = requirePaneEntry(stateDir, paneId);
    const agent = agentForEntry(config, entry);
    let reused = Boolean(sbx.findSandbox(entry.sandboxName));
    // An existing clone-mode sandbox carries its own checkout, so the host
    // directory is only required when a sandbox is created or bind-mounted.
    if (!reused || entry.workspaceMode !== "clone") {
      assertLocalPath(entry.localPath);
    }
    if (reused) {
      log(`Sandbox ${entry.sandboxName} already exists; reusing it.`);
    } else {
      log(`Creating Docker Sandbox ${entry.sandboxName} for ${entry.localPath} (agent ${agent.sbxAgent}, ${entry.workspaceMode} mode)...`);
      updatePaneEntry(stateDir, paneId, { lifecycleState: "creating", lastError: null });
      // The mapping's recorded mode wins over the current config: a sandbox that is
      // recreated later must keep the isolation its mapping and diagnostics promise.
      const args = buildCreateArgs({ config: { ...config, workspaceMode: entry.workspaceMode ?? config.workspaceMode }, sandboxName: entry.sandboxName, agent, localPath: entry.localPath });
      try {
        const result = sbx.runChecked(args, "creating the sandbox", { slow: true });
        if (result.output.trim() !== "") {
          log(result.output.trim());
        }
      } catch (error) {
        if (errorKindOf(error) !== "conflict") {
          updatePaneEntry(stateDir, paneId, { lifecycleState: "failed", lastError: describeError(error) });
          throw error;
        }
        reused = true;
        log(`sbx reports that ${entry.sandboxName} already exists; reusing it.`);
      }
    }
    if (!reused) {
      // A recreated sandbox must not stay on the deletion checkpoint, or a later
      // destroy would skip it, and its setup has to run again in the new VM.
      const deletedSandboxNames = (entry.deletedSandboxNames ?? []).filter((name) => name !== entry.sandboxName);
      updatePaneEntry(stateDir, paneId, { lifecycleState: "created", createdAt: new Date().toISOString(), lastError: null, deletedSandboxNames, setupScriptRanAt: null });
      entry.setupScriptRanAt = null;
    } else if (!CONNECTABLE_STATES.has(entry.lifecycleState)) {
      updatePaneEntry(stateDir, paneId, { lifecycleState: "created", lastError: null });
    }
    if (agent.setupScript && (!reused || !entry.setupScriptRanAt)) {
      log(`Running the ${agent.title} setup script inside ${entry.sandboxName}...`);
      try {
        const setup = sbx.runChecked(buildExecArgs({ sandboxName: entry.sandboxName, workdir: execWorkdir(entry), argv: [config.shell, "-lc", agent.setupScript] }), "running the agent setup script", { slow: true });
        if (setup.output.trim() !== "") {
          log(setup.output.trim());
        }
      } catch (error) {
        updatePaneEntry(stateDir, paneId, { lifecycleState: "failed", lastError: describeError(error) });
        throw error;
      }
      updatePaneEntry(stateDir, paneId, { setupScriptRanAt: new Date().toISOString() });
    } else if (agent.setupScript) {
      log(`Setup script already ran in ${entry.sandboxName} on ${entry.setupScriptRanAt}; skipping it.`);
    }
    // Probe exactly the way the launch runs: same working directory, same
    // agentEnv, and a plain (non-login) sh so PATH matches a direct exec.
    const probe = sbx.run(buildExecArgs({ sandboxName: entry.sandboxName, workdir: execWorkdir(entry), env: config.agentEnv, argv: ["sh", "-c", `command -v ${shellQuote(agent.command[0])}`] }));
    if (probe.status !== 0) {
      // sbx exec fails for its own reasons too (daemon gone, VM did not boot,
      // credentials expired); only a silent miss means the command is absent.
      const kind = classifyFailure(probe.output);
      if (kind !== "unknown") {
        const error = new PluginError(kind, `Could not check for "${agent.command[0]}" inside sandbox ${entry.sandboxName}; sbx exec failed.`, { output: probe.output });
        updatePaneEntry(stateDir, paneId, { lastError: describeError(error) });
        throw error;
      }
      const error = new PluginError("config", `The agent command "${agent.command[0]}" is not available inside sandbox ${entry.sandboxName}. Pick a template that ships it (config.template), add a setupScript to a custom agent, or choose another agentKind.`, { output: probe.output });
      updatePaneEntry(stateDir, paneId, { lifecycleState: "failed", lastError: describeError(error) });
      throw error;
    }
    updatePaneEntry(stateDir, paneId, { lifecycleState: "prepared", lastError: null });
    return { entry: getPaneEntry(stateDir, paneId), agent };
  }

  function runAttached(paneId, argv, { label, env = [], track }) {
    const entry = requirePaneEntry(stateDir, paneId);
    if (!CONNECTABLE_STATES.has(entry.lifecycleState)) {
      throw new PluginError("target", `Sandbox ${entry.sandboxName} is not ready (state: ${entry.lifecycleState}). Run start-agent or replace-sandbox first.`);
    }
    if (track) {
      updatePaneEntry(stateDir, paneId, { lifecycleState: "ready", lastError: null, lastConnectedAt: new Date().toISOString() });
    }
    const workdir = execWorkdir(entry);
    log(`Launching ${label} in sandbox ${entry.sandboxName}${workdir ? ` (${workdir})` : ""}...`);
    const args = buildExecArgs({ sandboxName: entry.sandboxName, workdir, interactive: true, tty: true, env, argv });
    let result;
    try {
      result = sbx.runInteractive(args);
    } finally {
      process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
    }
    const exitCode = result.status ?? 1;
    if (exitCode !== 0 && track) {
      // `sbx ls` lists stopped sandboxes too, and the parser refuses shapes it
      // does not understand, so an absent name means the sandbox is gone. An
      // `sbx exec` probe would be wrong here: it starts a stopped sandbox.
      let gone = false;
      try {
        gone = sbx.findSandbox(entry.sandboxName) === null;
      } catch (error) {
        log(`Could not check whether the sandbox still exists: ${errorMessageOf(error)}`);
      }
      if (gone) {
        updatePaneEntry(stateDir, paneId, { lifecycleState: "missing", lastError: { kind: "not-found", message: "The sandbox no longer exists.", at: new Date().toISOString() } });
        log(`Sandbox ${entry.sandboxName} no longer exists. Use replace-sandbox to create a new one.`);
      }
    }
    return { exitCode, entry: getPaneEntry(stateDir, paneId) };
  }

  /**
   * Launches the agent interactively; returns when it exits. Agents Herdr
   * cannot detect on its own are announced through `pane report-agent` while
   * attached, so Herdr knows which agent owns the pane.
   * @param {string} paneId
   */
  function connect(paneId) {
    const entry = requirePaneEntry(stateDir, paneId);
    const agent = agentForEntry(config, entry);
    const report = herdr !== null && config.reportAgentStatus && !agent.herdrDetectionKind;
    const identity = { paneId, source: AGENT_REPORT_SOURCE, agent: agent.kind };
    if (report) {
      try {
        herdr.reportAgent({ ...identity, state: "unknown", message: `${agent.title} in Docker Sandbox ${entry.sandboxName}` });
      } catch (error) {
        log(`could not report the agent to Herdr: ${errorMessageOf(error)}`);
      }
    }
    const release = () => {
      try {
        herdr.releaseAgent(identity);
      } catch (error) {
        log(`could not release the agent in Herdr: ${errorMessageOf(error)}`);
      }
    };
    const onSignal = (signal) => {
      release();
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    if (report) {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.once(signal, onSignal);
      }
    }
    let outcome;
    try {
      outcome = runAttached(paneId, agent.launchArgv, { label: agent.title, env: config.agentEnv, track: true });
    } finally {
      if (report) {
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
          process.off(signal, onSignal);
        }
        release();
      }
    }
    log(`${agent.title} exited with code ${outcome.exitCode}. Use reconnect to start it again or open-shell to inspect the sandbox.`);
    return outcome;
  }

  /**
   * Opens an interactive login shell inside the sandbox without touching the
   * agent's lifecycle record.
   * @param {string} paneId
   */
  function shell(paneId) {
    const outcome = runAttached(paneId, [config.shell, "-l"], { label: `a ${config.shell} login shell`, track: false });
    log(`Shell exited with code ${outcome.exitCode}.`);
    return outcome;
  }

  /**
   * Stops the sandbox, preserving its filesystem.
   * @param {string} paneId
   */
  function stop(paneId) {
    const entry = requirePaneEntry(stateDir, paneId);
    try {
      sbx.runChecked(["stop", entry.sandboxName], "stopping the sandbox");
    } catch (error) {
      updatePaneEntry(stateDir, paneId, { lifecycleState: errorKindOf(error) === "not-found" ? "missing" : entry.lifecycleState, lastError: describeError(error) });
      if (errorKindOf(error) === "conflict") {
        throw new PluginError("conflict", `sbx refused to stop ${entry.sandboxName} while a session is attached. Exit the agent and any open-shell pane for this sandbox, then try again.`, { output: error.output, cause: error });
      }
      throw error;
    }
    updatePaneEntry(stateDir, paneId, { lifecycleState: "stopped", lastError: null });
    return { sandboxName: entry.sandboxName };
  }

  /**
   * Deletes every sandbox tracked by a mapping, checkpointing progress so a
   * retry never re-deletes or forgets a name. When `expectedNames` is given
   * (the names a confirmation popup displayed), the mapping must still track
   * exactly those names, otherwise nothing is deleted.
   * @param {string} paneId
   * @param {{expectedNames?: string[]|null}} [options]
   */
  function destroy(paneId, { expectedNames = null } = {}) {
    const entry = requirePaneEntry(stateDir, paneId);
    const names = deletionTargets(entry);
    if (expectedNames) {
      const current = [...names].sort();
      const expected = [...new Set(expectedNames)].filter(Boolean).sort();
      if (current.join("\n") !== expected.join("\n")) {
        throw new PluginError("conflict", `The mapping of pane ${paneId} changed while the confirmation was open (now ${current.join(", ") || "nothing"}, confirmed ${expected.join(", ") || "nothing"}). Nothing was deleted; run the action again.`);
      }
    }
    const alreadyDeleted = new Set(entry.deletedSandboxNames ?? []);
    const deleted = [];
    const missing = [];
    for (const name of names) {
      try {
        sbx.runChecked(["rm", "--force", name], `deleting sandbox ${name}`);
        deleted.push(name);
        log(`Deleted sandbox ${name}.`);
      } catch (error) {
        try {
          if (errorKindOf(error) === "not-found") {
            confirmGone(name, error);
            missing.push(name);
            log(`Sandbox ${name} was already gone.`);
            continue;
          }
          throw error;
        } catch (failure) {
          // The mapping's own sandbox may already be gone even though a predecessor is not.
          const ownGone = deleted.includes(entry.sandboxName) || missing.includes(entry.sandboxName);
          updatePaneEntry(stateDir, paneId, { ...(ownGone ? { lifecycleState: "missing" } : {}), deletedSandboxNames: [...alreadyDeleted, ...deleted, ...missing], lastError: describeError(failure) });
          throw failure;
        }
      }
    }
    updatePaneEntry(stateDir, paneId, { lifecycleState: "missing", deletedSandboxNames: [...alreadyDeleted, ...deleted, ...missing], lastError: null });
    return { deleted, missing };
  }

  /**
   * `sbx rm` said "not found"; make sure `sbx ls` agrees before the name is
   * recorded as deleted, because the wording could describe something else
   * (a socket, an image) while the sandbox still exists.
   * @param {string} name
   * @param {unknown} error The error `sbx rm` produced.
   */
  function confirmGone(name, error) {
    let listed;
    try {
      listed = sbx.findSandbox(name) !== null;
    } catch (listError) {
      throw new PluginError(errorKindOf(listError), `sbx rm reported sandbox ${name} as not found, and sbx ls could not confirm it: ${errorMessageOf(listError)}. Nothing was recorded as deleted.`, { output: /** @type {any} */ (listError)?.output ?? /** @type {any} */ (error)?.output });
    }
    if (listed) {
      throw new PluginError("unknown", `sbx rm reported sandbox ${name} as not found, but sbx ls still lists it. Nothing was recorded as deleted; check "sbx ls" and try again.`, { output: /** @type {any} */ (error)?.output });
    }
  }

  /**
   * Deletes the sandboxes of a mapping and forgets the mapping.
   * @param {string} paneId
   * @param {{expectedNames?: string[]|null}} [options] See {@link destroy}.
   */
  function forget(paneId, options = {}) {
    const outcome = destroy(paneId, options);
    deletePaneEntry(stateDir, paneId);
    return outcome;
  }

  /**
   * Records that a bridge process started for a pane. The action that typed
   * the bridge command waits for the launch id it generated, so an older
   * acknowledgement can never satisfy a newer launch. This must happen before
   * any call that can block.
   * @param {string} paneId
   * @param {string|null} [launchId]
   */
  function acknowledgeBridge(paneId, launchId = null) {
    updatePaneEntry(stateDir, paneId, { bridgeStartedAt: new Date().toISOString(), bridgeLaunchId: launchId });
  }

  /**
   * Fetches commits from a clone-mode sandbox into the host repository.
   * @param {string} paneId
   */
  function fetchChanges(paneId) {
    const entry = requirePaneEntry(stateDir, paneId);
    if (entry.workspaceMode !== "clone") {
      throw new PluginError("target", `Sandbox ${entry.sandboxName} runs in mount mode, so the worktree is already shared with the host. fetch-changes only applies to clone mode.`);
    }
    assertLocalPath(entry.localPath);
    const remote = sandboxGitRemote(entry.sandboxName);
    // The sandbox's git daemon and the host-side remote only exist while the
    // sandbox runs, and sbx stops a sandbox once its last session ends. An
    // `sbx exec` starts it again; that is the intent here, not a probe.
    const live = sbx.findSandbox(entry.sandboxName);
    if (live === null) {
      updatePaneEntry(stateDir, paneId, { lifecycleState: "missing", lastError: { kind: "not-found", message: "The sandbox no longer exists.", at: new Date().toISOString() } });
      throw new PluginError("not-found", `Sandbox ${entry.sandboxName} no longer exists, so there is nothing to fetch.`);
    }
    if (String(live.status ?? "").toLowerCase() !== "running") {
      log(`Starting ${entry.sandboxName} so its git remote answers...`);
      sbx.runChecked(["exec", entry.sandboxName, "--", "true"], "starting the sandbox for the fetch");
      // Starting the VM proves it exists, nothing more: a mapping that never
      // finished preparing must not become connectable here.
      if (entry.lifecycleState === "missing") {
        updatePaneEntry(stateDir, paneId, { lifecycleState: "created", lastError: null });
      }
    }
    const remoteCheck = spawnSync("git", ["-C", entry.localPath, "remote", "get-url", remote], { encoding: "utf8" });
    let output;
    let transport;
    if (remoteCheck.status === 0) {
      transport = "remote";
      const fetch = spawnSync("git", ["-C", entry.localPath, "fetch", "--verbose", remote], { encoding: "utf8" });
      if (fetch.error) {
        throw new PluginError("startup", `Could not run git: ${fetch.error.message}`, { cause: fetch.error });
      }
      output = `${fetch.stdout ?? ""}${fetch.stderr ?? ""}`;
      if (fetch.status !== 0) {
        const kind = classifyGitFailure(output);
        throw new PluginError(kind, `git fetch ${remote} failed (exit ${fetch.status}).`, { output });
      }
    } else {
      // sbx registers the remote only while `sbx run` attaches; the plugin attaches
      // with `sbx exec`, so carry the commits over in a bundle instead.
      transport = "bundle";
      log(`${entry.localPath} has no ${remote} remote; fetching through a git bundle instead.`);
      output = fetchViaBundle(entry, remote);
    }
    const refs = spawnSync("git", ["-C", entry.localPath, "for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/`], { encoding: "utf8" });
    // The remote's HEAD pointer shows up as the bare remote name; it is not a branch.
    const branches = refs.status === 0 ? (refs.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line && line !== remote) : [];
    return { remote, branches, transport, output: output.trim() };
  }

  /**
   * Bundles every branch of the in-sandbox clone, copies the bundle out with
   * `sbx cp`, and fetches it into `refs/remotes/<remote>/*` on the host.
   * The clone sits at the host path inside the sandbox.
   * @returns {string} Combined git output.
   */
  function fetchViaBundle(entry, remote) {
    // Unique on both sides, so two overlapping fetches never delete each other's bundle.
    const token = `${process.pid}-${randomBytes(4).toString("hex")}`;
    const inSandbox = `/tmp/herdr-sbx-${entry.sandboxName}-${token}.bundle`;
    const onHost = path.join(tmpdir(), `herdr-sbx-${entry.sandboxName}-${token}.bundle`);
    try {
      sbx.runChecked(buildExecArgs({ sandboxName: entry.sandboxName, argv: ["git", "-C", entry.localPath, "bundle", "create", inSandbox, "--branches"] }), "bundling the sandbox clone");
      sbx.runChecked(["cp", `${entry.sandboxName}:${inSandbox}`, onHost], "copying the bundle out of the sandbox");
      const fetch = spawnSync("git", ["-C", entry.localPath, "fetch", "--verbose", onHost, `+refs/heads/*:refs/remotes/${remote}/*`], { encoding: "utf8" });
      if (fetch.error) {
        throw new PluginError("startup", `Could not run git: ${fetch.error.message}`, { cause: fetch.error });
      }
      const output = `${fetch.stdout ?? ""}${fetch.stderr ?? ""}`;
      if (fetch.status !== 0) {
        throw new PluginError(classifyGitFailure(output), `git fetch from the sandbox bundle failed (exit ${fetch.status}).`, { output });
      }
      return output;
    } finally {
      try {
        unlinkSync(onHost);
      } catch (error) {
        if (error.code !== "ENOENT") {
          log(`could not remove ${onHost}: ${errorMessageOf(error)}`);
        }
      }
      const cleanup = sbx.run(buildExecArgs({ sandboxName: entry.sandboxName, argv: ["rm", "-f", inSandbox] }));
      if (cleanup.status !== 0) {
        log(`could not remove ${inSandbox} inside the sandbox: ${cleanup.output.trim()}`);
      }
    }
  }

  /**
   * Describes a mapping together with the live sandbox status when reachable.
   * @param {string} paneId
   */
  function describe(paneId) {
    const entry = requirePaneEntry(stateDir, paneId);
    const agent = agentForEntry(config, entry);
    let sandbox = null;
    let sandboxError = null;
    try {
      const live = sbx.findSandbox(entry.sandboxName);
      sandbox = live ? { name: live.name, status: live.status } : null;
    } catch (error) {
      sandboxError = describeError(error);
    }
    return {
      mapping: entry,
      agent: { kind: agent.kind, title: agent.title, sbxAgent: agent.sbxAgent, launchArgv: agent.launchArgv, herdrDetectionKind: agent.herdrDetectionKind },
      gitRemote: entry.workspaceMode === "clone" ? sandboxGitRemote(entry.sandboxName) : null,
      sandbox,
      sandboxError,
    };
  }

  /**
   * Lists every mapping and whether its sandbox still exists.
   */
  function listAll() {
    const state = loadState(stateDir);
    let live = null;
    let sandboxError = null;
    try {
      live = new Map(sbx.listSandboxes().map((item) => [item.name, item]));
    } catch (error) {
      sandboxError = describeError(error);
    }
    const mappings = Object.values(state.panes).map((entry) => ({
      paneId: entry.paneId,
      sandboxName: entry.sandboxName,
      agentKind: entry.agentKind,
      localPath: entry.localPath,
      workdir: entry.workdir ?? entry.localPath,
      workspaceMode: entry.workspaceMode,
      lifecycleState: entry.lifecycleState,
      exists: live ? live.has(entry.sandboxName) : null,
      status: live?.get(entry.sandboxName)?.status ?? null,
    }));
    return { mappings, sandboxError };
  }

  return { prepare, connect, shell, stop, destroy, forget, acknowledgeBridge, fetchChanges, describe, listAll };
}
