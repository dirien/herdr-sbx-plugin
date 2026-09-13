/**
 * Sandbox lifecycle operations shared by the action dispatcher, the pane
 * bridge and the event hook. Progress messages go through the injected `log`
 * so pane modes can print to the terminal while captured modes keep stdout
 * clean for the result marker.
 * @module lifecycle
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { resolveAgent } from "./agents.mjs";
import { AGENT_REPORT_SOURCE, SBX_CALL_TIMEOUT_ENV, SBX_CALL_TIMEOUT_MS, TERMINAL_RESTORE_SEQUENCE } from "./constants.mjs";
import { canonicalPath } from "./context.mjs";
import { PluginError, errorKindOf, errorMessageOf } from "./errors.mjs";
import { sandboxGitRemote } from "./naming.mjs";
import { buildCreateArgs, buildExecArgs, classifyFailure, createSbxClient } from "./sbx.mjs";
import { shellQuote } from "./shell.mjs";
import { deletePaneEntry, getPaneEntry, loadState, processStartToken, requirePaneEntry, updatePaneEntry, withPaneLock, withSandboxLocks } from "./state.mjs";

/** Lifecycle states in which the sandbox exists and the agent can be attached. */
export const CONNECTABLE_STATES = new Set(["prepared", "ready", "stopped"]);

/**
 * The command line of a process, or null when it cannot be read. Linux exposes
 * it under /proc; elsewhere `ps` answers.
 * @param {number} pid
 * @returns {string|null}
 */
export function processCommandLine(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    // Not Linux, or the process is gone: fall through to ps.
  }
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) {
    return null;
  }
  const line = (result.stdout ?? "").trim();
  return line === "" ? null : line;
}

/**
 * Whether the bridge process that last acknowledged a mapping is still alive
 * and really is that bridge. The bridge lives exactly as long as the
 * preparation and the attached agent session, so a live one means the sandbox
 * is busy even before Herdr can see an agent in the pane. Pids are recycled,
 * so the process must also run `bridge.mjs` for this mapping's pane; a bridge
 * that exits cleanly clears its pid, this check covers the ones that crashed.
 * @param {{bridgePid?: number|null, paneId?: string}} entry
 * @returns {boolean}
 */
export function bridgeIsRunning(entry) {
  return processOwns({ pid: entry?.bridgePid, token: entry?.bridgeToken ?? null }, ["bridge.mjs"], entry?.paneId);
}

/**
 * Whether a recorded process is alive, is the same incarnation that was
 * recorded (start token), and runs one of the given scripts for the pane.
 * @param {{pid: unknown, token: string|null}} record
 * @param {string[]} scripts Script basenames one of which the command line must end a word with.
 * @param {string|null} paneId When given, the command line must carry `--pane-id <paneId>`.
 * @returns {boolean}
 */
function processOwns(record, scripts, paneId = null) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH: gone. EPERM: another user's process, which a process of ours never is.
    return false;
  }
  if (record.token && record.token !== "-") {
    const current = processStartToken(pid);
    if (current !== null && current !== record.token) {
      // The pid was recycled since the record was written.
      return false;
    }
  }
  const commandLine = processCommandLine(pid);
  if (commandLine === null) {
    // Alive but uninspectable: err on the side of treating the mapping as busy.
    return true;
  }
  const words = commandLine.split(/\s+/);
  if (!words.some((word) => scripts.some((script) => word.endsWith(script)))) {
    return false;
  }
  if (paneId === null) {
    return true;
  }
  const paneIndex = words.indexOf("--pane-id");
  return paneIndex !== -1 && words[paneIndex + 1] === String(paneId);
}

/**
 * The open-shell sessions of a mapping that are still alive: entries of
 * `shellPids` whose process runs `bridge.mjs shell` for the pane the shell
 * was opened for. A shell records that pane itself, because a mapping can be
 * moved to another pane (reconnect re-homing an orphan) while the shell keeps
 * running with the old id on its command line.
 * @param {{shellPids?: Array<{pid: number, token?: string|null, since?: string, paneId?: string}>, paneId?: string}} entry
 * @returns {Array<{pid: number, token?: string|null, since?: string, paneId?: string}>}
 */
export function liveShells(entry) {
  return (entry?.shellPids ?? []).filter((shell) => processOwns({ pid: shell.pid, token: shell.token ?? null }, ["bridge.mjs"], shell.paneId ?? entry?.paneId) && (processCommandLine(shell.pid) ?? "shell").includes(" shell "));
}

/**
 * Whether an open-shell session is attached to the mapping's sandbox.
 * @param {{shellPids?: Array<{pid: number, token?: string|null, since?: string}>, paneId?: string}} entry
 * @returns {boolean}
 */
export function shellIsRunning(entry) {
  return liveShells(entry).length > 0;
}

/**
 * Whether an action or hook is deleting this mapping's sandboxes right now:
 * `destroy` records its pid while it works, and the record counts only while
 * that process is alive and really is a plugin action or event hook.
 * @param {{deletingPid?: number|null}} entry
 * @returns {boolean}
 */
export function deletionInProgress(entry) {
  return processOwns({ pid: entry?.deletingPid, token: entry?.deletingToken ?? null }, ["action.mjs", "events.mjs"]);
}

/**
 * Every sandbox name a mapping still tracks (its own and the ones it replaced),
 * whether or not a deletion checkpoint already covers them.
 * @param {{sandboxName?: string, replacesSandboxNames?: string[]}} entry
 * @returns {string[]}
 */
export function trackedSandboxNames(entry) {
  return deletionTargets({ ...entry, deletedSandboxNames: [] });
}

/** Lifecycle states in which no sandbox exists for the mapping, so not even a shell can open. */
export const NO_SANDBOX_STATES = new Set(["provisional", "missing"]);

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
 * @param {{stateDir: string, config: Record<string, any>, sbx?: ReturnType<typeof createSbxClient>, log?: (line: string) => void, herdr?: {reportAgent?: Function, releaseAgent?: Function, getPane?: Function}|null}} input
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
        // "conflict" also covers a published host port that is taken; only a
        // sandbox that sbx really lists can be reused.
        let exists = false;
        if (errorKindOf(error) === "conflict") {
          try {
            exists = sbx.findSandbox(entry.sandboxName) !== null;
          } catch {
            exists = false;
          }
        }
        if (!exists) {
          updatePaneEntry(stateDir, paneId, { lifecycleState: "failed", lastError: describeError(error) });
          throw error;
        }
        reused = true;
        log(`sbx reports that ${entry.sandboxName} already exists; reusing it.`);
      }
    }
    if (!reused) {
      // The mapping may have been forgotten while sbx create ran for minutes;
      // a sandbox nobody tracks must not be left behind.
      // Read under the lock; nobody else can be mid-write. The name is tracked by no
      // mapping any more, which is why this rm may bypass destroy's checks.
      const still = withPaneLock(stateDir, paneId, () => getPaneEntry(stateDir, paneId));
      if (!still || still.sandboxName !== entry.sandboxName) {
        log(`The mapping for pane ${paneId} disappeared while ${entry.sandboxName} was being created; deleting the sandbox again.`);
        try {
          sbx.runChecked(["rm", "--force", entry.sandboxName], `deleting the orphaned sandbox ${entry.sandboxName}`);
        } catch (error) {
          log(`Could not delete ${entry.sandboxName}: ${errorMessageOf(error)}. Remove it with "sbx rm -f ${entry.sandboxName}".`);
        }
        throw new PluginError("conflict", `The mapping for pane ${paneId} was removed while sandbox ${entry.sandboxName} was being created; the sandbox was deleted again.`);
      }
      // A recreated sandbox must not stay on the deletion checkpoint, or a later
      // destroy would skip it, and its setup has to run again in the new VM.
      const deletedSandboxNames = (entry.deletedSandboxNames ?? []).filter((name) => name !== entry.sandboxName);
      updatePaneEntry(stateDir, paneId, { lifecycleState: "created", createdAt: new Date().toISOString(), lastError: null, deletedSandboxNames, setupScriptRanAt: null });
      entry.setupScriptRanAt = null;
    } else {
      // A reused sandbox that the mapping had written off as deleted is a new
      // VM under the old name: take it off the checkpoint so destroy deletes
      // it, and run the setup again because it never ran in this VM.
      const checkpointed = (entry.deletedSandboxNames ?? []).includes(entry.sandboxName);
      const patch = {};
      if (checkpointed) {
        log(`Sandbox ${entry.sandboxName} was recorded as deleted but exists again; treating it as new.`);
        patch.deletedSandboxNames = entry.deletedSandboxNames.filter((name) => name !== entry.sandboxName);
        patch.setupScriptRanAt = null;
        entry.setupScriptRanAt = null;
      }
      if (checkpointed || !CONNECTABLE_STATES.has(entry.lifecycleState)) {
        patch.lifecycleState = "created";
        patch.lastError = null;
      }
      if (Object.keys(patch).length > 0) {
        updatePaneEntry(stateDir, paneId, patch);
      }
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
      // A missing command is a silent non-zero exit; anything sbx prints is sbx failing.
      const kind = probe.output.trim() === "" ? "unknown" : classifyFailure(probe.output);
      if (kind !== "unknown" || probe.output.trim() !== "") {
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
    // Agent launches need a prepared sandbox. A shell only needs the sandbox to
    // exist: it is the way to inspect and repair one whose preparation failed.
    if (track && !CONNECTABLE_STATES.has(entry.lifecycleState)) {
      throw new PluginError("target", `Sandbox ${entry.sandboxName} is not ready (state: ${entry.lifecycleState}). Run start-agent or replace-sandbox first.`);
    }
    if (!track && NO_SANDBOX_STATES.has(entry.lifecycleState)) {
      throw new PluginError("target", `Sandbox ${entry.sandboxName} does not exist yet (state: ${entry.lifecycleState}). Run reconnect or replace-sandbox first.`);
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
    // A shell is attached to the VM like the agent is: it registers itself so
    // no deletion runs under it, and it never opens into a deletion in progress.
    acknowledgeShell(paneId);
    let outcome;
    try {
      outcome = runAttached(paneId, [config.shell, "-l"], { label: `a ${config.shell} login shell`, track: false });
    } finally {
      releaseShell(paneId);
    }
    log(`Shell exited with code ${outcome.exitCode}.`);
    return outcome;
  }

  /**
   * Records this process as an open-shell session of the mapping, under the
   * mapping lock, refusing while a deletion claims it.
   * @param {string} paneId
   */
  function acknowledgeShell(paneId) {
    withOwnershipLocks(paneId, (entry) => {
      assertNoDeletion(paneId, entry, "not opening a shell");
      const shells = liveShells(entry).filter((shell) => shell.pid !== process.pid);
      shells.push({ pid: process.pid, token: processStartToken(process.pid), since: new Date().toISOString(), paneId });
      updatePaneEntry(stateDir, paneId, { shellPids: shells });
    });
  }

  /**
   * Removes this process from the mapping's open-shell sessions.
   * @param {string} paneId
   */
  function releaseShell(paneId) {
    try {
      withPaneLock(stateDir, paneId, () => {
        const entry = getPaneEntry(stateDir, paneId);
        if (!entry) {
          return;
        }
        updatePaneEntry(stateDir, paneId, { shellPids: (entry.shellPids ?? []).filter((shell) => shell.pid !== process.pid) });
      });
    } catch (error) {
      log(`Could not release the shell record for pane ${paneId}: ${errorMessageOf(error)}`);
    }
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
      updatePaneEntry(stateDir, paneId, { ...(errorKindOf(error) === "not-found" ? { lifecycleState: "missing" } : {}), lastError: describeError(error) });
      if (errorKindOf(error) === "conflict") {
        throw new PluginError("conflict", `sbx refused to stop ${entry.sandboxName} while a session is attached. Exit the agent and any open-shell pane for this sandbox, then try again.`, { output: error.output, cause: error });
      }
      throw error;
    }
    // Stopping says nothing about readiness: a mapping that never finished
    // preparing (failed, provisional, creating) keeps that state and its error,
    // so the next reconnect runs prepare again instead of attaching blindly.
    // Decided on the mapping as it is now, not as it was before the slow stop.
    withPaneLock(stateDir, paneId, () => {
      const now = requirePaneEntry(stateDir, paneId);
      if (CONNECTABLE_STATES.has(now.lifecycleState)) {
        updatePaneEntry(stateDir, paneId, { lifecycleState: "stopped", lastError: null });
      }
    });
    return { sandboxName: entry.sandboxName };
  }

  /**
   * Deletes every sandbox tracked by a mapping, checkpointing progress so a
   * retry never re-deletes or forgets a name. When `expectedNames` is given
   * (the names a confirmation popup displayed), the mapping must still track
   * exactly those names, otherwise nothing is deleted.
   * With `keepClaim` the mapping stays claimed by this process afterwards, for
   * a caller that goes on to remove the mapping itself.
   * @param {string} paneId
   * @param {{expectedNames?: string[]|null, keepClaim?: boolean}} [options]
   */
  function destroy(paneId, { expectedNames = null, keepClaim = false } = {}) {
    // The confirmation popup may have stayed open for a minute, long enough for
    // reconnect to attach an agent again. This is the one place every sbx rm
    // passes through, so the mapping is re-read and re-checked here under the
    // mapping lock, and the deletion claims the mapping so no bridge can
    // acknowledge itself until it is over.
    // Herdr is asked outside the lock (a slow Herdr must not hold every other
    // participant up); the process-based checks and the claim happen under it.
    assertHerdrIdle(paneId);
    const entry = withOwnershipLocks(paneId, (current) => {
      assertNoOwners(paneId, current);
      if (deletionInProgress(current) && current.deletingPid !== process.pid) {
        throw new PluginError("conflict", `Another deletion of pane ${paneId}'s sandboxes is in progress (pid ${current.deletingPid}). Nothing was deleted.`);
      }
      return updatePaneEntry(stateDir, paneId, { deletingPid: process.pid, deletingToken: processStartToken(process.pid), deletingSince: new Date().toISOString() });
    });
    const names = deletionTargets(entry);
    const alreadyDeleted = new Set(entry.deletedSandboxNames ?? []);
    const deleted = [];
    const missing = [];
    try {
      if (expectedNames) {
        const current = [...names].sort();
        const expected = [...new Set(expectedNames)].filter(Boolean).sort();
        if (current.join("\n") !== expected.join("\n")) {
          throw new PluginError("conflict", `The mapping of pane ${paneId} changed while the confirmation was open (now ${current.join(", ") || "nothing"}, confirmed ${expected.join(", ") || "nothing"}). Nothing was deleted; run the action again.`);
        }
      }
      for (const name of names) {
        // Every rm can take a while; look again right before each one.
        assertHerdrIdle(paneId);
        withOwnershipLocks(paneId, (now) => {
          if (now.deletingPid !== process.pid) {
            throw new PluginError("conflict", `The deletion of pane ${paneId}'s sandboxes was taken over by process ${now.deletingPid ?? "unknown"}; stopping here.`);
          }
          assertNoOwners(paneId, now);
        });
        try {
          sbx.runChecked(["rm", "--force", name], `deleting sandbox ${name}`);
          deleted.push(name);
          log(`Deleted sandbox ${name}.`);
        } catch (error) {
          if (errorKindOf(error) !== "not-found") {
            throw error;
          }
          confirmGone(name, error);
          missing.push(name);
          log(`Sandbox ${name} was already gone.`);
        }
      }
    } catch (failure) {
      // The mapping's own sandbox may already be gone even though a predecessor is not.
      const ownGone = deleted.includes(entry.sandboxName) || missing.includes(entry.sandboxName);
      try {
        withPaneLock(stateDir, paneId, () => {
          const now = requirePaneEntry(stateDir, paneId);
          // What was deleted is recorded either way; the claim is released only if it is still ours.
          const release = now.deletingPid === process.pid ? { deletingPid: null, deletingSince: null } : {};
          updatePaneEntry(stateDir, paneId, { ...(ownGone ? { lifecycleState: "missing" } : {}), deletedSandboxNames: [...alreadyDeleted, ...deleted, ...missing], lastError: describeError(failure), ...release });
        });
      } catch (error) {
        log(`Could not record the failed deletion for pane ${paneId}: ${errorMessageOf(error)}`);
      }
      throw failure;
    }
    withPaneLock(stateDir, paneId, () => {
      const now = requirePaneEntry(stateDir, paneId);
      const record = { lifecycleState: "missing", deletedSandboxNames: [...alreadyDeleted, ...deleted, ...missing], lastError: null };
      if (now.deletingPid !== process.pid) {
        // Whoever owns the mapping now must still learn what is gone; only the claim is theirs.
        updatePaneEntry(stateDir, paneId, record);
        throw new PluginError("conflict", `The deletion of pane ${paneId}'s sandboxes was taken over by process ${now.deletingPid ?? "unknown"} after ${deleted.join(", ") || "nothing"} was deleted; the mapping was left to it.`);
      }
      updatePaneEntry(stateDir, paneId, { ...record, ...(keepClaim ? {} : { deletingPid: null, deletingSince: null }) });
    });
    return { deleted, missing };
  }

  /**
   * Throws when a process owns the mapping's sandboxes: its bridge is alive,
   * an open-shell session is attached, or another mapping that tracks one of
   * the same sandboxes (a duplicate left by an interrupted move) has a live
   * bridge or shell.
   * @param {string} paneId
   * @param {Record<string, any>} entry
   */
  function assertNoOwners(paneId, entry) {
    if (bridgeIsRunning(entry)) {
      throw new PluginError("conflict", `Pane ${paneId} still runs the bridge for ${entry.sandboxName} (pid ${entry.bridgePid}, since ${entry.bridgeStartedAt}): the sandbox is being prepared or the agent is attached. Nothing was deleted.`);
    }
    const shells = liveShells(entry);
    if (shells.length > 0) {
      throw new PluginError("conflict", `Pane ${paneId} has ${shells.length === 1 ? "an open-shell session" : `${shells.length} open-shell sessions`} in ${entry.sandboxName} (pid ${shells.map((shell) => shell.pid).join(", ")}). Close ${shells.length === 1 ? "it" : "them"} first. Nothing was deleted.`);
    }
    const mine = new Set(trackedSandboxNames(entry));
    for (const other of Object.values(loadState(stateDir).panes)) {
      if (other.paneId === paneId) {
        continue;
      }
      const shared = trackedSandboxNames(other).filter((name) => mine.has(name));
      if (shared.length > 0 && (bridgeIsRunning(other) || shellIsRunning(other))) {
        throw new PluginError("conflict", `Pane ${other.paneId} also tracks ${shared.join(", ")} and still has a bridge or shell attached. Nothing was deleted.`);
      }
    }
  }

  /**
   * Throws when Herdr reports an agent in the pane. When Herdr cannot be asked,
   * that is a failure too, not a green light. Never called under the mapping
   * lock: the call may take up to Herdr's own timeout.
   * @param {string} paneId
   */
  function assertHerdrIdle(paneId) {
    if (typeof herdr?.getPane !== "function") {
      return;
    }
    let agent = null;
    try {
      agent = herdr.getPane(paneId)?.agent ?? null;
    } catch (error) {
      throw new PluginError(errorKindOf(error) === "unknown" ? "unknown" : errorKindOf(error), `Could not confirm with Herdr that pane ${paneId} runs no agent (${errorMessageOf(error)}). Nothing was deleted; try again.`, { output: /** @type {any} */ (error)?.output, cause: error });
    }
    if (agent) {
      throw new PluginError("conflict", `Pane ${paneId} is running agent "${agent}" again. Nothing was deleted; exit the agent and try again.`);
    }
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
    // The claim taken by destroy stays on the mapping until it is removed under
    // the same lock, so no bridge can adopt the mapping in between.
    const outcome = destroy(paneId, { ...options, keepClaim: true });
    withPaneLock(stateDir, paneId, () => {
      const now = getPaneEntry(stateDir, paneId);
      if (now && now.deletingPid !== process.pid) {
        throw new PluginError("conflict", `The mapping of pane ${paneId} was taken over by process ${now.deletingPid ?? "unknown"} after its sandboxes were deleted; the mapping was left to it.`);
      }
      deletePaneEntry(stateDir, paneId);
    });
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
    withOwnershipLocks(paneId, (entry) => {
      assertNoDeletion(paneId, entry, "not attaching");
      updatePaneEntry(stateDir, paneId, { bridgeStartedAt: new Date().toISOString(), bridgeLaunchId: launchId, bridgePid: process.pid, bridgeToken: processStartToken(process.pid) });
    });
  }

  /**
   * Runs `fn` with the mapping re-read under the locks of every sandbox the
   * mapping tracks plus the mapping's own lock, the order every ownership
   * change uses. The names are taken from an unlocked read first; a mapping
   * that gained a name in between is reported as changed rather than acted on.
   * @template T
   * @param {string} paneId
   * @param {(entry: Record<string, any>) => T} fn
   * @returns {T}
   */
  function withOwnershipLocks(paneId, fn) {
    const names = trackedSandboxNames(requirePaneEntry(stateDir, paneId));
    return withSandboxLocks(stateDir, names, () => withPaneLock(stateDir, paneId, () => {
      const entry = requirePaneEntry(stateDir, paneId);
      const locked = new Set(names);
      if (!trackedSandboxNames(entry).every((name) => locked.has(name))) {
        throw new PluginError("conflict", `The mapping of pane ${paneId} changed while its sandboxes were being locked; try again.`);
      }
      return fn(entry);
    }));
  }

  /**
   * Throws when a deletion claims this mapping, or claims another mapping that
   * tracks one of the same sandboxes (a duplicate left by an interrupted move).
   * @param {string} paneId
   * @param {Record<string, any>} entry
   * @param {string} refusal What the caller will not do.
   */
  function assertNoDeletion(paneId, entry, refusal) {
    if (deletionInProgress(entry)) {
      throw new PluginError("conflict", `The sandboxes of pane ${paneId} are being deleted right now (pid ${entry.deletingPid}); ${refusal}.`);
    }
    const mine = new Set(trackedSandboxNames(entry));
    for (const other of Object.values(loadState(stateDir).panes)) {
      if (other.paneId === paneId) {
        continue;
      }
      const shared = trackedSandboxNames(other).filter((name) => mine.has(name));
      if (shared.length > 0 && deletionInProgress(other) && other.deletingPid !== process.pid) {
        throw new PluginError("conflict", `${shared.join(", ")} ${shared.length === 1 ? "is" : "are"} being deleted right now through pane ${other.paneId} (pid ${other.deletingPid}); ${refusal}.`);
      }
    }
  }

  /**
   * Clears this process's ownership of a mapping when the bridge exits, so a
   * recycled pid can never make the mapping look busy later. A mapping that
   * moved on to another bridge, or is gone, is left alone.
   * @param {string} paneId
   */
  function releaseBridge(paneId) {
    try {
      withPaneLock(stateDir, paneId, () => {
        // Decided and written under the lock: a pid another bridge recorded meanwhile stays.
        const entry = getPaneEntry(stateDir, paneId);
        if (!entry || entry.bridgePid !== process.pid) {
          return;
        }
        updatePaneEntry(stateDir, paneId, { bridgePid: null, bridgeToken: null, bridgeExitedAt: new Date().toISOString() });
      });
    } catch (error) {
      log(`Could not release the mapping for pane ${paneId} on exit: ${errorMessageOf(error)}`);
    }
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
    if (entry.lifecycleState === "missing") {
      // The sandbox turned out to exist. That proves nothing about its
      // preparation, so the mapping becomes created, not connectable.
      updatePaneEntry(stateDir, paneId, { lifecycleState: "created", lastError: null });
    }
    const wasRunning = String(live.status ?? "").toLowerCase() === "running";
    const remoteCheck = spawnSync("git", ["-C", entry.localPath, "remote", "get-url", remote], { encoding: "utf8" });
    const hasRemote = remoteCheck.status === 0;
    let output;
    let transport;
    if (hasRemote && wasRunning) {
      // The remote's git daemon lives inside the session that registered it, so
      // it is only tried while the sandbox is running on its own, and a running
      // sandbox is still no proof that the daemon is there: the session may have
      // ended while the plugin's own exec kept the VM up. The bundle path does
      // not depend on it, so any remote failure falls back to it.
      transport = "remote";
      let failure = null;
      try {
        const fetch = runGit(["-C", entry.localPath, "fetch", "--verbose", remote], `git fetch ${remote}`);
        output = fetch.output;
        if (fetch.status !== 0) {
          failure = new PluginError(classifyGitFailure(output), `git fetch ${remote} failed (exit ${fetch.status}).`, { output });
        }
      } catch (error) {
        if (errorKindOf(error) === "startup") {
          throw error;
        }
        failure = error;
      }
      if (failure) {
        log(`${errorMessageOf(failure)} Fetching through a git bundle instead.`);
        transport = "bundle";
        output = fetchViaBundle(entry, remote);
      }
    } else {
      // sbx registers the remote only while `sbx run` attaches and stops the
      // sandbox once that session ends, so a stopped sandbox has no daemon to
      // fetch from even when the remote is still registered. A bundle carried
      // out with `sbx exec` and `sbx cp` works in every state.
      transport = "bundle";
      log(hasRemote
        ? `${entry.sandboxName} is not running, so the ${remote} remote has no git daemon behind it; fetching through a git bundle instead.`
        : `${entry.localPath} has no ${remote} remote; fetching through a git bundle instead.`);
      output = fetchViaBundle(entry, remote);
    }
    const refs = spawnSync("git", ["-C", entry.localPath, "for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/`], { encoding: "utf8" });
    // The remote's HEAD pointer shows up as the bare remote name; it is not a branch.
    const branches = refs.status === 0 ? (refs.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line && line !== remote) : [];
    return { remote, branches, transport, output: output.trim() };
  }

  /**
   * Runs git on the host with the same deadline as a captured sbx call, so a
   * remote that accepts a connection and then stays silent cannot hang an
   * action. A timeout is reported as a network failure.
   * @param {string[]} args
   * @param {string} step
   * @returns {{status: number|null, output: string}}
   */
  function runGit(args, step) {
    const timeout = sbx.timeouts?.call ?? SBX_CALL_TIMEOUT_MS;
    const result = spawnSync("git", args, { encoding: "utf8", timeout, killSignal: "SIGKILL" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.error) {
      if (/** @type {any} */ (result.error).code === "ETIMEDOUT") {
        throw new PluginError("network", `${step} did not finish within ${Math.round(timeout / 1000)}s and was killed; the other side accepted the connection but stopped answering (${SBX_CALL_TIMEOUT_ENV} raises the limit).`, { output });
      }
      throw new PluginError("startup", `Could not run git: ${result.error.message}`, { cause: result.error });
    }
    return { status: result.status, output };
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
    // A private directory (0700): the bundle holds every branch of the repository.
    const hostDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-"));
    const onHost = path.join(hostDir, "clone.bundle");
    try {
      sbx.runChecked(buildExecArgs({ sandboxName: entry.sandboxName, argv: ["git", "-C", entry.localPath, "bundle", "create", inSandbox, "--branches"] }), "bundling the sandbox clone");
      sbx.runChecked(["cp", `${entry.sandboxName}:${inSandbox}`, onHost], "copying the bundle out of the sandbox");
      const fetch = runGit(["-C", entry.localPath, "fetch", "--verbose", onHost, `+refs/heads/*:refs/remotes/${remote}/*`], "git fetch from the sandbox bundle");
      const { output } = fetch;
      if (fetch.status !== 0) {
        throw new PluginError(classifyGitFailure(output), `git fetch from the sandbox bundle failed (exit ${fetch.status}).`, { output });
      }
      return output;
    } finally {
      try {
        rmSync(hostDir, { recursive: true, force: true });
      } catch (error) {
        log(`could not remove ${hostDir}: ${errorMessageOf(error)}`);
      }
      // Cleanup must never change the fetch outcome: a timeout or spawn failure here is logged only.
      try {
        const cleanup = sbx.run(buildExecArgs({ sandboxName: entry.sandboxName, argv: ["rm", "-f", inSandbox] }));
        if (cleanup.status !== 0) {
          log(`could not remove ${inSandbox} inside the sandbox: ${cleanup.output.trim()}`);
        }
      } catch (error) {
        log(`could not remove ${inSandbox} inside the sandbox: ${errorMessageOf(error)}`);
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

  return { prepare, connect, shell, stop, destroy, forget, acknowledgeBridge, releaseBridge, acknowledgeShell, releaseShell, fetchChanges, describe, listAll };
}
