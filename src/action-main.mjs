/**
 * Action dispatcher. Every action prints the result marker line first and
 * uses stderr for diagnostics, so `herdr plugin log list` stays parseable.
 * @module action-main
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveAgent } from "./agents.mjs";
import { loadConfig } from "./config.mjs";
import { requestDeletionConfirmation } from "./confirm.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { BRIDGE_START_TIMEOUT_ENV, BRIDGE_START_TIMEOUT_MS, CONFIRMATION_TIMEOUT_ENV, CONFIRMATION_TTL_MS, KEYBINDING_INSTALL_TIMEOUT_MS, MIN_SBX_VERSION } from "./constants.mjs";
import { isInside, readContext, readPluginEnv, requirePluginDirs, resolveMountRoot, resolvePaneId, resolveWorkdir } from "./context.mjs";
import { PluginError, errorKindOf, errorMessageOf } from "./errors.mjs";
import { createHerdrClient } from "./herdr.mjs";
import { CONNECTABLE_STATES, agentForEntry, assertMountRoot, bridgeIsRunning, createLifecycle, deletionInProgress, deletionTargets, liveShells, shellIsRunning } from "./lifecycle.mjs";
import { hyperlink, parseSandboxPortUrl, sandboxPortUrl } from "./links.mjs";
import { sandboxNameFor } from "./naming.mjs";
import { openUrl } from "./open.mjs";
import { emitResult, failurePayload } from "./result.mjs";
import { createSbxClient } from "./sbx.mjs";
import { buildPaneCommand, shellQuote } from "./shell.mjs";
import { deletePaneEntry, deletePaneEntryIfUnchanged, getPaneEntry, loadState, paneLockPath, savePaneEntry, withPaneLock } from "./state.mjs";

/**
 * Builds the command typed into a pane to run the bridge.
 * @param {{pluginEnv: {pluginRoot: string, stateDir: string, configDir: string, herdrBin?: string}, mode: string, paneId: string, detectionKind?: string|null, sbxBin?: string|null, launchId?: string|null}} input
 * @returns {string}
 */
export function bridgeCommand({ pluginEnv, mode, paneId, detectionKind = null, sbxBin = null, launchId = null }) {
  const argv = [
    process.execPath,
    path.join(pluginEnv.pluginRoot, "src", "bridge.mjs"),
    mode,
    "--state-dir", pluginEnv.stateDir,
    "--config-dir", pluginEnv.configDir,
    "--pane-id", paneId,
    "--herdr-bin", pluginEnv.herdrBin ?? "herdr",
  ];
  if (sbxBin) argv.push("--sbx-bin", sbxBin);
  if (launchId) argv.push("--launch-id", launchId);
  return buildPaneCommand({ argv, env: detectionKind ? { HERDR_AGENT: detectionKind } : {} });
}

function workspaceOf(deps) {
  return deps.context.workspace_id ?? deps.env.HERDR_WORKSPACE_ID ?? null;
}

/**
 * Finds the mapping a pane-scoped action should act on: the focused pane's
 * own mapping; else the single mapping in the focused workspace (users tend
 * to run actions from the pane next to the agent); else the single mapping
 * whose pane Herdr no longer has, which happens after a Herdr restart. Such an
 * orphan is flagged so the caller can give it a new pane.
 */
function requireFocusedMapping(deps) {
  const focused = resolvePaneId(deps.context, deps.env);
  const own = getPaneEntry(deps.pluginEnv.stateDir, focused);
  if (own) {
    return { paneId: focused, entry: own, viaWorkspace: false };
  }
  const workspaceId = workspaceOf(deps);
  const all = Object.values(loadState(deps.pluginEnv.stateDir).panes);
  const candidates = workspaceId
    ? all.filter((entry) => entry.workspaceId === workspaceId || String(entry.paneId).startsWith(`${workspaceId}:`))
    : [];
  if (candidates.length === 1) {
    const [entry] = candidates;
    // The mapped pane may have been closed while its workspace stayed open; then it needs a new pane.
    const paneExists = deps.herdr.getPane(entry.paneId) !== null;
    process.stderr.write(`pane ${focused ?? "(none)"} has no sandbox; using the workspace's only mapping, pane ${entry.paneId} (${entry.sandboxName})${paneExists ? "" : ", whose pane is gone"}\n`);
    return { paneId: entry.paneId, entry, viaWorkspace: paneExists, orphan: !paneExists };
  }
  if (candidates.length > 1) {
    const list = candidates.map((entry) => `${entry.paneId} (${entry.sandboxName})`).join(", ");
    throw new PluginError("target", `Pane ${focused ?? "(none)"} has no sandbox and this workspace has several: ${list}. Focus the pane you mean.`);
  }
  if (all.length > 0) {
    const paneIds = new Set(deps.herdr.listPaneIds());
    const orphans = all.filter((entry) => !paneIds.has(entry.paneId));
    if (orphans.length === 1) {
      const [entry] = orphans;
      process.stderr.write(`pane ${entry.paneId} no longer exists; adopting its sandbox ${entry.sandboxName}\n`);
      return { paneId: entry.paneId, entry, viaWorkspace: false, orphan: true };
    }
    if (orphans.length > 1) {
      const list = orphans.map((entry) => `${entry.paneId} (${entry.sandboxName})`).join(", ");
      throw new PluginError("target", `Several sandboxes lost their panes: ${list}. Delete the ones you no longer need with "sbx rm -f <name>", run list-sandboxes, then try again.`);
    }
    const elsewhere = all.map((entry) => `${entry.paneId} (${entry.sandboxName})`).join(", ");
    throw new PluginError("target", `No sandbox is mapped in workspace ${workspaceId ?? "(unknown)"}. Existing mappings: ${elsewhere}. Focus that workspace, for example "herdr workspace focus ${String(all[0].paneId).split(":")[0]}", and try again.`);
  }
  throw new PluginError("target", focused ? `No sandbox is mapped to pane ${focused} or to another pane in this workspace. Run start-agent first.` : "No focused pane was provided, so there is no sandbox mapping to act on.");
}

function refuseWhileAgentRuns(deps, target, verb, { shellsBlock = true } = {}) {
  // Process ownership is checked for every target, orphan or not: a pane Herdr
  // no longer knows proves nothing about the bridge process or a running deletion.
  // A live bridge means the sandbox is being prepared or the agent is attached,
  // whether or not Herdr can see an agent in the pane yet.
  if (bridgeIsRunning(target.entry)) {
    throw new PluginError("conflict", `Pane ${target.paneId} still runs the bridge for ${target.entry.sandboxName} (pid ${target.entry.bridgePid}, since ${target.entry.bridgeStartedAt}): the sandbox is being prepared or the agent is attached. Exit it before you ${verb}.`);
  }
  if (deletionInProgress(target.entry)) {
    throw new PluginError("conflict", `The sandboxes of pane ${target.paneId} are being deleted right now (pid ${target.entry.deletingPid}, since ${target.entry.deletingSince}). Wait for that to finish before you ${verb}.`);
  }
  if (shellsBlock) {
    const shells = liveShells(target.entry);
    if (shells.length > 0) {
      throw new PluginError("conflict", `Pane ${target.paneId} has ${shells.length === 1 ? "an open-shell session" : `${shells.length} open-shell sessions`} in ${target.entry.sandboxName} (pid ${shells.map((shell) => shell.pid).join(", ")}). Close ${shells.length === 1 ? "it" : "them"} before you ${verb}.`);
    }
  }
  if (target.orphan) {
    // Only Herdr's own record of the pane is unavailable for an orphan.
    return;
  }
  const agent = target.viaWorkspace ? deps.herdr.getPane(target.paneId)?.agent ?? null : deps.context.focused_pane_agent ?? null;
  if (agent) {
    throw new PluginError("conflict", `Pane ${target.paneId} is still running agent "${agent}". Exit it before you ${verb}. If nothing is running there, clear a stale report with "herdr pane release-agent ${target.paneId} --source sbx.sandbox --agent ${agent}".`);
  }
}

/**
 * How long to wait for a typed bridge command to acknowledge itself, in
 * milliseconds. An unset, empty or non-positive override means the default.
 * @param {Record<string, string|undefined>} env
 * @returns {number}
 */
export function bridgeStartTimeout(env) {
  const raw = Number(env[BRIDGE_START_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : BRIDGE_START_TIMEOUT_MS;
}

/**
 * The directory a pane for a mapping opens in: the recorded working
 * directory, else the mounted path, else nothing when both are gone.
 * @param {{workdir?: string|null, localPath?: string}} entry
 * @returns {string|null}
 */
export function entryCwd(entry) {
  if (typeof entry.workdir === "string" && existsSync(entry.workdir)) {
    return entry.workdir;
  }
  return typeof entry.localPath === "string" && existsSync(entry.localPath) ? entry.localPath : null;
}

/**
 * Types the bridge command into `paneId` and waits until the bridge has
 * touched the mapping. A pane that is not at a shell prompt (an agent still
 * closing, a popup still open) swallows typed text, so when nothing happens
 * the mapping is moved to a fresh pane next to the user and started there.
 * @returns {Promise<{paneId: string, movedTo: string|null}>}
 */
async function startBridge(deps, { paneId, mode, agent, label }) {
  const launchId = randomBytes(6).toString("hex");
  deps.herdr.runInPane(paneId, bridgeCommand({ pluginEnv: deps.pluginEnv, mode, paneId, detectionKind: agent.herdrDetectionKind, sbxBin: deps.sbx.bin, launchId }));
  const deadline = Date.now() + bridgeStartTimeout(deps.env);
  while (Date.now() < deadline) {
    await sleep(150);
    const now = getPaneEntry(deps.pluginEnv.stateDir, paneId);
    // The bridge acknowledges this launch by id before any call that can block,
    // so neither a slow sbx nor a stale acknowledgement can mislead us.
    if (now?.bridgeLaunchId === launchId) {
      return { paneId, movedTo: null };
    }
  }
  const acknowledged = () => getPaneEntry(deps.pluginEnv.stateDir, paneId)?.bridgeLaunchId === launchId;
  const entry = getPaneEntry(deps.pluginEnv.stateDir, paneId);
  if (!entry || acknowledged()) {
    return { paneId, movedTo: null };
  }
  if (bridgeIsRunning(entry)) {
    // An earlier bridge still owns that pane's shell (preparing, or attached);
    // the typed command waits in its input, and a second bridge must not race it.
    process.stderr.write(`pane ${paneId} still runs an earlier bridge for ${entry.sandboxName} (pid ${entry.bridgePid}); leaving the mapping there\n`);
    return { paneId, movedTo: null };
  }
  process.stderr.write(`pane ${paneId} did not run the bridge command; starting in a new pane instead\n`);
  // A bridge that acknowledges while the new pane is being opened keeps the mapping.
  const fresh = rehomeOrphan(deps, { paneId, entry, orphan: true }, label, { abandonIf: acknowledged });
  if (fresh === null) {
    process.stderr.write(`pane ${paneId} ran the bridge command after all; keeping the sandbox there\n`);
    return { paneId, movedTo: null };
  }
  try {
    deps.herdr.renamePane(paneId, `${label} (moved to ${fresh})`);
  } catch (error) {
    process.stderr.write(`could not relabel pane ${paneId}: ${errorMessageOf(error)}\n`);
  }
  deps.herdr.runInPane(fresh, bridgeCommand({ pluginEnv: deps.pluginEnv, mode: "start", paneId: fresh, detectionKind: agent.herdrDetectionKind, sbxBin: deps.sbx.bin }));
  return { paneId: fresh, movedTo: fresh };
}

/**
 * The command that turns a fetched sandbox ref into a local branch, quoted for
 * the user's shell.
 * @param {string} localPath
 * @param {string} local
 * @param {string} ref
 * @returns {string}
 */
export function keepBranchCommand(localPath, local, ref) {
  return ["git", "-C", localPath, "branch", local, ref].map(shellQuote).join(" ");
}

/**
 * For each fetched `sandbox-<name>/<branch>` ref, the local branch that would
 * keep its commits once the sandbox is deleted: the branch's own name when the
 * host has no such branch, a `<branch>-sandbox` name when the host branch
 * exists but no local branch reaches the fetched commits, and nothing when
 * some local branch already does.
 * @param {string} localPath
 * @param {string} remote
 * @param {string[]} branches Fetched refs, `<remote>/<branch>`.
 * @returns {Array<{ref: string, local: string, reason: string, command: string}>}
 */
export function keepSuggestions(localPath, remote, branches) {
  const git = (...args) => spawnSync("git", ["-C", localPath, ...args], { encoding: "utf8" });
  const exists = (branch) => git("show-ref", "--verify", "--quiet", `refs/heads/${branch}`).status === 0;
  const reached = (ref) => {
    const result = git("branch", "--contains", ref, "--format=%(refname:short)");
    return result.status === 0 && result.stdout.trim() !== "";
  };
  const keep = [];
  for (const ref of branches) {
    const branch = ref.slice(remote.length + 1);
    if (!exists(branch)) {
      keep.push({ ref, local: branch, reason: "the host has no such branch" });
      continue;
    }
    if (reached(ref)) {
      continue;
    }
    let local = `${branch}-sandbox`;
    for (let index = 2; exists(local); index += 1) {
      local = `${branch}-sandbox-${index}`;
    }
    keep.push({ ref, local, reason: `the host's ${branch} does not contain these commits` });
  }
  return keep.map((item) => ({ ...item, command: keepBranchCommand(localPath, item.local, item.ref) }));
}

/** Extra popup text for clone-mode sandboxes, whose git remote and fetched refs vanish with them. */
function cloneWarning(entry) {
  return entry.workspaceMode === "clone" ? ` Clone mode: every branch fetched from it under sandbox-${entry.sandboxName}/ is removed too. Cancel and run "git branch <name> sandbox-${entry.sandboxName}/<name>" first to keep work.` : "";
}

function confirmationTimeout(env) {
  const raw = Number(env[CONFIRMATION_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : CONFIRMATION_TTL_MS;
}

function freshEntry({ sandboxName, agent, localPath, workdir, config, sourcePaneId, workspaceId = null }) {
  return {
    sandboxName,
    workspaceId,
    agentKind: agent.kind,
    sbxAgent: agent.sbxAgent,
    localPath,
    workdir,
    workspaceMode: config.workspaceMode,
    lifecycleState: "provisional",
    createdAt: null,
    sourcePaneId,
    replacesSandboxNames: [],
    deletedSandboxNames: [],
    lastError: null,
  };
}

/**
 * Extracts `major.minor.patch` from a version string or `sbx version --json` payload.
 * @param {unknown} value
 * @returns {number[]|null}
 */
export function parseVersion(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Returns a warning when the sbx version is older than the one this plugin targets, else null.
 * @param {{json: any, raw: string}} version
 * @returns {string|null}
 */
export function sbxVersionWarning(version) {
  const found = parseVersion(version.json?.client?.version ?? version.json?.server?.version ?? version.json ?? version.raw);
  const wanted = parseVersion(MIN_SBX_VERSION);
  if (!found || !wanted) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (found[index] !== wanted[index]) {
      return found[index] < wanted[index] ? `sbx ${found.join(".")} is older than ${MIN_SBX_VERSION}; the plugin was written against the newer CLI and some flags may be missing.` : null;
    }
  }
  return null;
}

/**
 * Opens the pane an agent will run in: a split next to the anchor pane, or a
 * new tab when `openIn` is "tab". Returns the new pane id, already labelled.
 */
function openAgentPane(deps, { anchorPaneId, cwd, label }) {
  let paneId;
  if (deps.config.openIn === "tab") {
    ({ paneId } = deps.herdr.createTab({ workspaceId: workspaceOf(deps), cwd, label, focus: true }));
  } else {
    paneId = deps.herdr.splitPane({ paneId: anchorPaneId, direction: deps.config.paneDirection, ratio: deps.config.paneRatio, cwd, focus: true });
  }
  deps.herdr.renamePane(paneId, label);
  return paneId;
}

/**
 * Gives an orphaned mapping a new pane next to the focused one and moves the
 * mapping there. Returns the new pane id, or null when `abandonIf` reports,
 * once the pane exists, that the mapping must stay where it is; the unused
 * pane is closed again then.
 * @returns {string|null}
 */
function rehomeOrphan(deps, target, label, { abandonIf = null } = {}) {
  const stateDir = deps.pluginEnv.stateDir;
  const oldPaneId = target.entry.paneId;
  const focused = resolvePaneId(deps.context, deps.env);
  const cwd = entryCwd(target.entry);
  const paneId = openAgentPane(deps, { anchorPaneId: focused, cwd, label });
  const closeSpare = () => {
    try {
      deps.herdr.closePane(paneId);
    } catch (error) {
      process.stderr.write(`could not close the unused pane ${paneId}: ${errorMessageOf(error)}\n`);
    }
  };
  if (paneId !== oldPaneId && abandonIf && abandonIf()) {
    closeSpare();
    return null;
  }
  let moved;
  try {
    // The move is decided and written under both panes' locks, taken in a fixed
    // order so two mirrored moves cannot wait for each other: a bridge
    // acknowledging itself or a deletion claiming either mapping waits for the
    // locks, and whatever happened before is visible in the re-read entries.
    const ordered = [...new Set([oldPaneId, paneId])].sort((a, b) => (paneLockPath(stateDir, a) < paneLockPath(stateDir, b) ? -1 : 1));
    const locked = (fn) => ordered.reduceRight((inner, id) => () => withPaneLock(stateDir, id, inner), fn)();
    moved = locked(() => {
      const latest = getPaneEntry(stateDir, oldPaneId);
      if (!latest) {
        throw new PluginError("conflict", `The mapping of pane ${oldPaneId} disappeared while a new pane was being opened for it; nothing was moved.`);
      }
      if (paneId !== oldPaneId && abandonIf && abandonIf()) {
        return null;
      }
      // This process's own deletion claim (replace-sandbox re-homing after destroy) is fine to carry along.
      if (bridgeIsRunning(latest) || (deletionInProgress(latest) && latest.deletingPid !== process.pid)) {
        throw new PluginError("conflict", `The mapping of pane ${oldPaneId} is in use again (bridge ${latest.bridgePid ?? "none"}, deletion ${latest.deletingPid ?? "none"}); nothing was moved.`);
      }
      const next = { ...latest, workspaceId: workspaceOf(deps), sourcePaneId: focused, adoptedFrom: oldPaneId };
      if (paneId === oldPaneId) {
        // Herdr handed out the orphan's own id again; the saved entry is the one to keep.
        savePaneEntry(stateDir, paneId, next);
        return next;
      }
      // Herdr may hand out an id that another mapping still uses; keep that mapping's
      // sandboxes deletable, unless it is still in use, in which case nothing moves.
      const displaced = getPaneEntry(stateDir, paneId);
      if (displaced) {
        if (bridgeIsRunning(displaced) || shellIsRunning(displaced) || deletionInProgress(displaced)) {
          throw new PluginError("conflict", `Herdr handed out pane ${paneId}, but its mapping to ${displaced.sandboxName} is still in use (bridge ${displaced.bridgePid ?? "none"}, deletion ${displaced.deletingPid ?? "none"}); nothing was moved.`);
        }
        next.replacesSandboxNames = [...new Set([...(next.replacesSandboxNames ?? []), ...trackedNames(displaced)])];
        next.deletedSandboxNames = [...new Set([...(next.deletedSandboxNames ?? []), ...(displaced.deletedSandboxNames ?? [])])];
        process.stderr.write(`pane ${paneId} was mapped to ${displaced.sandboxName}; it stays deletable through the adopted mapping\n`);
      }
      savePaneEntry(stateDir, paneId, next);
      deletePaneEntry(stateDir, oldPaneId);
      return next;
    });
  } catch (error) {
    closeSpare();
    throw error;
  }
  if (moved === null) {
    closeSpare();
    return null;
  }
  return paneId;
}

/**
 * Lists a sandbox's published ports with the links the overlay and `info` print.
 */
function describePorts(deps, sandboxName) {
  try {
    const ports = deps.sbx.listPorts(sandboxName).map(({ hostPort, sandboxPort }) => ({
      hostPort,
      sandboxPort,
      url: hostPort ? `http://localhost:${hostPort}` : null,
      link: sandboxPortUrl(sandboxName, sandboxPort),
    }));
    return { ports, portsError: null };
  } catch (error) {
    return { ports: [], portsError: { kind: errorKindOf(error), message: errorMessageOf(error) } };
  }
}

/** Pane label for an agent pane: the agent kind plus the sandbox's short id, so several agents in one workspace stay apart. */
function paneLabel(agentKind, sandboxName) {
  const shortId = String(sandboxName).split("-").pop().slice(0, 6);
  return `sbx ${agentKind} ${shortId}`;
}

/** Every sandbox name a mapping is responsible for, current one first. */
function trackedNames(entry) {
  return [...new Set([entry.sandboxName, ...(entry.replacesSandboxNames ?? [])])].filter(Boolean);
}

/**
 * Parses the report lines printed by scripts/install-keybindings.sh.
 * @param {string} text
 * @returns {{configPath: string|null, added: Array<{key: string, action: string}>, existing: Array<{key: string, action: string}>, warnings: string[], reloaded: boolean}}
 */
export function parseKeybindingReport(text) {
  const report = { configPath: /** @type {string|null} */ (null), added: /** @type {Array<{key: string, action: string}>} */ ([]), existing: /** @type {Array<{key: string, action: string}>} */ ([]), warnings: /** @type {string[]} */ ([]), reloaded: false };
  for (const line of text.split("\n")) {
    let match;
    if ((match = line.match(/^config: (.+)$/))) {
      report.configPath = match[1];
    } else if ((match = line.match(/^bound (\S+) -> sbx\.sandbox\.(\S+)$/))) {
      report.added.push({ key: match[1], action: match[2] });
    } else if ((match = line.match(/^already bound: sbx\.sandbox\.(\S+) \((.+)\)$/))) {
      report.existing.push({ key: match[2], action: match[1] });
    } else if ((match = line.match(/^warning: (.+)$/))) {
      report.warnings.push(match[1]);
    } else if (line === "reloaded") {
      report.reloaded = true;
    }
  }
  return report;
}

const ACTIONS = {
  doctor(deps) {
    const version = deps.sbx.version();
    const daemon = deps.sbx.daemonStatus();
    if (!daemon.ok) {
      throw new PluginError("daemon", `sbx ${version.raw.split("\n")[0]} answers, but its daemon does not. Run "sbx daemon start" or "sbx diagnose".`, { output: daemon.output });
    }
    const agent = resolveAgent(deps.config);
    const versionWarning = sbxVersionWarning(version);
    const payload = {
      sbxBin: deps.sbx.bin,
      node: process.execPath,
      pluginRoot: deps.pluginEnv.pluginRoot,
      stateDir: deps.pluginEnv.stateDir,
      configDir: deps.pluginEnv.configDir,
      version: version.json ?? version.raw,
      versionWarning,
      daemon: daemon.json ?? daemon.output,
      agentKind: agent.kind,
      workspaceMode: deps.config.workspaceMode,
      template: deps.config.template,
    };
    const clientVersion = version.json?.client?.version ?? version.json?.server?.version ?? version.raw.split("\n")[0];
    const lines = [
      `sbx executable: ${deps.sbx.bin}`,
      `node: ${process.execPath}`,
      `plugin root: ${deps.pluginEnv.pluginRoot}`,
      `state dir: ${deps.pluginEnv.stateDir}`,
      `config dir: ${deps.pluginEnv.configDir}`,
      `sbx version: ${clientVersion}`,
      "daemon: reachable",
      `configured agent: ${agent.kind} (${agent.launchArgv.join(" ")})`,
      `workspace mode: ${deps.config.workspaceMode}`,
    ];
    if (versionWarning) {
      lines.push(`warning: ${versionWarning}`);
    }
    return { payload, lines };
  },

  "install-keybindings"(deps) {
    const result = spawnSync("sh", ["scripts/install-keybindings.sh"], {
      cwd: deps.pluginEnv.pluginRoot,
      encoding: "utf8",
      env: { ...deps.env, HERDR_BIN_PATH: deps.pluginEnv.herdrBin },
      timeout: KEYBINDING_INSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.error) {
      const timedOut = /** @type {any} */ (result.error).code === "ETIMEDOUT";
      throw new PluginError("startup", timedOut
        ? `scripts/install-keybindings.sh did not finish within ${Math.round(KEYBINDING_INSTALL_TIMEOUT_MS / 1000)}s (Herdr's config check or reload hung) and was killed.`
        : `Could not run scripts/install-keybindings.sh: ${result.error.message}`, { output });
    }
    const report = parseKeybindingReport(result.stdout ?? "");
    if (result.status !== 0) {
      const restored = report.warnings.some((warning) => /restored to its previous content/.test(warning));
      throw new PluginError("config", `scripts/install-keybindings.sh exited with status ${result.status}; ${report.configPath ?? "the Herdr config"} ${restored ? "was restored to its previous content" : "was left as it was"} and Herdr was not reloaded.`, { output });
    }
    return { payload: { ...report }, lines: output.split("\n").filter(Boolean) };
  },

  "start-agent"(deps) {
    const mountRoot = resolveMountRoot(deps.context);
    if (!mountRoot) {
      throw new PluginError("target", "The invocation context has no workspace or pane directory. Invoke start-agent from a workspace or pane.");
    }
    const localPath = assertMountRoot(mountRoot);
    const workdir = resolveWorkdir(deps.context, localPath);
    const sourcePaneId = resolvePaneId(deps.context, deps.env);
    const agent = resolveAgent(deps.config);
    deps.sbx.version();
    const sandboxName = sandboxNameFor({ prefix: deps.config.sandboxNamePrefix, agentKind: agent.kind, localPath, paneId: sourcePaneId });
    const paneId = openAgentPane(deps, { anchorPaneId: sourcePaneId, cwd: workdir, label: paneLabel(agent.kind, sandboxName) });
    const entry = freshEntry({ sandboxName, agent, localPath, workdir, config: deps.config, sourcePaneId, workspaceId: workspaceOf(deps) });
    withPaneLock(deps.pluginEnv.stateDir, paneId, () => {
      const stale = getPaneEntry(deps.pluginEnv.stateDir, paneId);
      if (stale) {
        // Herdr reused a pane id. A mapping that still has a bridge, a shell or a
        // deletion attached is not stale at all; otherwise keep its sandboxes deletable.
        if (bridgeIsRunning(stale) || shellIsRunning(stale) || deletionInProgress(stale)) {
          throw new PluginError("conflict", `Herdr handed out pane ${paneId}, but its mapping to ${stale.sandboxName} is still in use (bridge ${stale.bridgePid ?? "none"}, deletion ${stale.deletingPid ?? "none"}). Try again in a moment.`);
        }
        entry.replacesSandboxNames = trackedNames(stale);
        entry.deletedSandboxNames = [...(stale.deletedSandboxNames ?? [])];
        process.stderr.write(`pane ${paneId} was previously mapped to ${stale.sandboxName}; it stays deletable through the new mapping\n`);
      }
      savePaneEntry(deps.pluginEnv.stateDir, paneId, entry);
    });
    deps.herdr.runInPane(paneId, bridgeCommand({ pluginEnv: deps.pluginEnv, mode: "start", paneId, detectionKind: agent.herdrDetectionKind, sbxBin: deps.sbx.bin }));
    deps.herdr.notify("Docker Sandbox starting", `${agent.title} in ${sandboxName}`);
    return { payload: { paneId, sourcePaneId, sandboxName, agentKind: agent.kind, localPath, workdir, workspaceMode: deps.config.workspaceMode, openIn: deps.config.openIn, previousSandboxNames: entry.replacesSandboxNames } };
  },

  async reconnect(deps) {
    const target = requireFocusedMapping(deps);
    const { entry } = target;
    // An open shell does not stop the agent from coming back; it only blocks deletions.
    refuseWhileAgentRuns(deps, target, "reconnect", { shellsBlock: false });
    const agent = agentForEntry(deps.config, entry);
    const label = paneLabel(agent.kind, entry.sandboxName);
    const paneId = target.orphan ? rehomeOrphan(deps, target, label) : target.paneId;
    // Re-homed or never-prepared mappings go through prepare so a deleted VM is recreated rather than failing.
    const mode = target.orphan || !CONNECTABLE_STATES.has(entry.lifecycleState) ? "start" : "connect";
    const started = await startBridge(deps, { paneId, mode, agent, label });
    // A bridge moved to a fresh pane always goes through prepare, whatever was planned.
    return { payload: { paneId: started.paneId, sandboxName: entry.sandboxName, agentKind: entry.agentKind, mode: started.movedTo ? "start" : mode, adoptedFrom: target.orphan ? entry.paneId : null, movedTo: started.movedTo } };
  },

  "open-shell"(deps) {
    const target = requireFocusedMapping(deps);
    const { paneId, entry } = target;
    // The shell opens below the pane the user is in, wherever the sandbox pane lives.
    const anchor = resolvePaneId(deps.context, deps.env) ?? paneId;
    const shellPaneId = deps.herdr.splitPane({ paneId: anchor, direction: "down", ratio: 0.5, cwd: entryCwd(entry), focus: true });
    deps.herdr.renamePane(shellPaneId, `sbx shell ${entry.sandboxName}`);
    deps.herdr.runInPane(shellPaneId, bridgeCommand({ pluginEnv: deps.pluginEnv, mode: "shell", paneId, sbxBin: deps.sbx.bin }));
    return { payload: { paneId: shellPaneId, mappedPaneId: paneId, sandboxName: entry.sandboxName } };
  },

  "fetch-changes"(deps) {
    const { paneId, entry } = requireFocusedMapping(deps);
    const outcome = deps.lifecycle.fetchChanges(paneId);
    const lines = outcome.output ? [outcome.output] : [];
    // Suggest keeping every fetched commit the host does not reach yet, under a
    // name that does not clash with a host branch of the same name.
    const keep = keepSuggestions(entry.localPath, outcome.remote, outcome.branches);
    if (keep.length > 0) {
      lines.push("These refs disappear when the sandbox is deleted. Keep a branch with:");
      for (const item of keep) lines.push(`  ${item.command}   # ${item.reason}`);
    }
    return { payload: { paneId, remote: outcome.remote, transport: outcome.transport, branches: outcome.branches, keep }, lines };
  },

  stop(deps) {
    const { paneId } = requireFocusedMapping(deps);
    const outcome = deps.lifecycle.stop(paneId);
    deps.herdr.notify("Docker Sandbox stopped", outcome.sandboxName);
    return { payload: { paneId, sandboxName: outcome.sandboxName } };
  },

  info(deps) {
    const { paneId } = requireFocusedMapping(deps);
    const description = deps.lifecycle.describe(paneId);
    const { ports, portsError } = description.sandbox ? describePorts(deps, description.mapping.sandboxName) : { ports: [], portsError: null };
    const lines = [JSON.stringify({ ...description, ports, portsError }, null, 2)];
    for (const port of ports) {
      lines.push(`port ${port.sandboxPort}: ${hyperlink(port.link, port.url ?? port.link)}`);
    }
    return { payload: { paneId, ...description, ports, portsError }, lines };
  },

  async "prune-mappings"(deps) {
    const state = loadState(deps.pluginEnv.stateDir);
    let live;
    try {
      live = new Set(deps.sbx.listSandboxes().map((item) => item.name));
    } catch (error) {
      throw new PluginError(errorKindOf(error), `Cannot prune without a sandbox list: ${errorMessageOf(error)}`, { output: /** @type {any} */ (error)?.output });
    }
    let paneIds;
    try {
      paneIds = new Set(deps.herdr.listPaneIds());
    } catch (error) {
      throw new PluginError(errorKindOf(error), `Cannot prune without Herdr's pane list: ${errorMessageOf(error)}`, { output: /** @type {any} */ (error)?.output });
    }
    const pruned = [];
    const kept = [];
    const failures = [];
    for (const entry of Object.values(state.panes)) {
      const paneExists = paneIds.has(entry.paneId);
      const sandboxExists = trackedNames(entry).some((name) => live.has(name));
      if (!paneExists && !sandboxExists) {
        // The snapshot is older than two CLI calls; a mapping rewritten since (the
        // pane id handed to a new sandbox) must not be pruned on stale data, and
        // a mapping whose bridge is still creating its sandbox (not listed yet)
        // or whose deletion is running is not garbage either.
        const outcome = withPaneLock(deps.pluginEnv.stateDir, entry.paneId, () => {
          const now = getPaneEntry(deps.pluginEnv.stateDir, entry.paneId);
          if (now && (bridgeIsRunning(now) || deletionInProgress(now))) {
            return "busy";
          }
          return deletePaneEntryIfUnchanged(deps.pluginEnv.stateDir, entry.paneId, entry) ? "pruned" : "changed";
        });
        if (outcome === "pruned") {
          pruned.push({ paneId: entry.paneId, sandboxName: entry.sandboxName });
        } else if (outcome === "busy") {
          kept.push({ paneId: entry.paneId, sandboxName: entry.sandboxName, reason: "a bridge or a deletion still owns this mapping" });
        } else {
          kept.push({ paneId: entry.paneId, sandboxName: entry.sandboxName, reason: "mapping changed while pruning; run prune-mappings again" });
        }
      } else if (!paneExists) {
        kept.push({ paneId: entry.paneId, sandboxName: entry.sandboxName, reason: "sandbox still exists: reconnect adopts it, forget-mapping deletes it" });
      } else if (!sandboxExists) {
        kept.push({ paneId: entry.paneId, sandboxName: entry.sandboxName, reason: "pane still open: run forget-mapping from that pane" });
      }
    }
    // Sandboxes whose pane is gone but which still exist can be deleted here, behind the popup.
    const orphans = kept.filter((item) => item.reason.startsWith("sandbox still exists"));
    const deleted = [];
    let orphansConfirmed = null;
    if (orphans.length > 0) {
      const names = orphans.flatMap((item) => deletionTargets(state.panes[item.paneId]));
      const paths = [...new Set(orphans.map((item) => state.panes[item.paneId]?.localPath).filter(Boolean))];
      // Orphans are the sandboxes most likely to hold unfetched clone-mode work.
      const cloneNotes = [...new Set(orphans.map((item) => cloneWarning(state.panes[item.paneId] ?? {})).filter(Boolean))].join("");
      orphansConfirmed = await requestDeletionConfirmation({
        stateDir: deps.pluginEnv.stateDir,
        herdr: deps.herdr,
        pluginId: deps.pluginEnv.pluginId,
        details: { action: "prune-mappings", paneId: orphans.map((item) => item.paneId).join(", "), sandboxName: names.join(", "), localPath: paths.join(", "), consequence: `${orphans.length} sandbox${orphans.length === 1 ? " has" : "es have"} lost ${orphans.length === 1 ? "its" : "their"} Herdr pane. DELETE removes ${orphans.length === 1 ? "it" : "them all"} permanently; anything else keeps ${orphans.length === 1 ? "it" : "them"} (reconnect adopts a single orphan).${cloneNotes}` },
        timeoutMs: confirmationTimeout(deps.env),
      });
      if (orphansConfirmed) {
        // The popup may have stayed open for a minute; a pane that came back in
        // the meantime (Herdr restored it, or reconnect adopted the sandbox) is no orphan.
        let panesNow;
        try {
          panesNow = new Set(deps.herdr.listPaneIds());
        } catch (error) {
          throw new PluginError(errorKindOf(error), `Cannot delete orphans without a fresh pane list: ${errorMessageOf(error)}`, { output: /** @type {any} */ (error)?.output });
        }
        for (const item of orphans) {
          if (panesNow.has(item.paneId)) {
            item.reason = "pane came back while the confirmation was open; nothing deleted";
            continue;
          }
          // One failed deletion must not hide what already happened to the others.
          try {
            const outcome = deps.lifecycle.forget(item.paneId, { expectedNames: deletionTargets(state.panes[item.paneId]) });
            deleted.push(...outcome.deleted, ...outcome.missing.map((name) => `${name} (already gone)`));
            kept.splice(kept.indexOf(item), 1);
          } catch (error) {
            failures.push({ paneId: item.paneId, sandboxName: item.sandboxName, errorKind: errorKindOf(error), message: errorMessageOf(error) });
            item.reason = `deletion failed (${errorKindOf(error)}): ${errorMessageOf(error)}`;
          }
        }
      }
    }
    const lines = [`pruned ${pruned.length} mapping${pruned.length === 1 ? "" : "s"}`];
    for (const item of pruned) lines.push(`  ${item.paneId}\t${item.sandboxName}`);
    if (deleted.length > 0) lines.push(`deleted ${deleted.length} orphaned sandbox${deleted.length === 1 ? "" : "es"}: ${deleted.join(", ")}`);
    if (orphansConfirmed === false) lines.push(`kept ${orphans.length} orphaned sandbox${orphans.length === 1 ? "" : "es"} (deletion not confirmed)`);
    for (const item of kept) lines.push(`kept ${item.paneId}\t${item.sandboxName}\t${item.reason}`);
    for (const item of failures) lines.push(`failed ${item.paneId}\t${item.sandboxName}\t${item.message}`);
    return { payload: { pruned, kept, deleted, failures, orphansConfirmed }, lines };
  },

  sandboxes(deps) {
    deps.herdr.openPluginPane({ pluginId: deps.pluginEnv.pluginId, entrypointId: "sandboxes", focus: true });
    return { payload: { entrypoint: "sandboxes" } };
  },

  "open-port"(deps) {
    const clicked = deps.context.clicked_url ?? deps.env.HERDR_PLUGIN_CLICKED_URL ?? null;
    let sandboxName;
    let sandboxPort = null;
    if (clicked) {
      const parsed = parseSandboxPortUrl(clicked);
      if (!parsed) {
        throw new PluginError("target", `Unrecognized link ${clicked}; expected sbx://<sandbox>/<port>.`);
      }
      ({ sandboxName, port: sandboxPort } = parsed);
      // Only sandboxes this plugin created may be opened from a link; pane output is untrusted.
      const tracked = Object.values(loadState(deps.pluginEnv.stateDir).panes).some((entry) => trackedNames(entry).includes(sandboxName));
      if (!tracked) {
        throw new PluginError("target", `Sandbox ${sandboxName} is not managed by this plugin; refusing to open a port for it.`);
      }
    } else {
      ({ entry: { sandboxName } } = requireFocusedMapping(deps));
    }
    const ports = deps.sbx.listPorts(sandboxName);
    let match = null;
    if (sandboxPort === null) {
      if (ports.length === 0) {
        throw new PluginError("target", `Sandbox ${sandboxName} publishes no ports. Add a "publish" entry to config.json before creating it, or run "sbx ports ${sandboxName} --publish HOST:PORT".`);
      }
      [match] = ports;
      sandboxPort = match.sandboxPort;
    } else {
      match = ports.find((item) => item.sandboxPort === sandboxPort) ?? null;
      if (!match) {
        throw new PluginError("target", `Sandbox ${sandboxName} does not publish port ${sandboxPort}. Run "sbx ports ${sandboxName} --publish HOST:${sandboxPort}" first.`);
      }
    }
    if (match.hostPort === null) {
      throw new PluginError("unknown", `sbx did not report a host port for ${sandboxName}:${sandboxPort}; run "sbx ports ${sandboxName}" to see the mapping.`, { output: JSON.stringify(match.raw) });
    }
    const hostPort = match.hostPort;
    const url = `http://localhost:${hostPort}`;
    const opened = openUrl(url, deps.env);
    if (!opened.ok) {
      process.stderr.write(`could not open ${url} with ${opened.command}: ${opened.error}\n`);
    }
    return { payload: { sandboxName, sandboxPort, hostPort, url, opened: opened.ok, opener: opened.command }, lines: [url] };
  },

  "list-sandboxes"(deps) {
    const outcome = deps.lifecycle.listAll();
    let paneIds = null;
    let paneError = null;
    try {
      paneIds = new Set(deps.herdr.listPaneIds());
    } catch (error) {
      paneError = errorMessageOf(error);
    }
    outcome.mappings = outcome.mappings.map((item) => ({ ...item, paneExists: paneIds ? paneIds.has(item.paneId) : null, paneError }));
    const lines = outcome.mappings.length === 0
      ? ["No sandbox mappings."]
      : outcome.mappings.map((item) => `${item.paneId}${item.paneExists === false ? " (pane gone)" : item.paneExists === null ? " (pane ?)" : ""}\t${item.sandboxName}\t${item.agentKind}\t${item.lifecycleState}\t${item.exists === null ? "unknown" : item.exists ? item.status ?? "exists" : "MISSING"}\t${item.localPath}`);
    if (outcome.sandboxError) {
      lines.push(`sbx ls failed (${outcome.sandboxError.kind}): ${outcome.sandboxError.message}`);
    }
    return { payload: outcome, lines };
  },

  async "replace-sandbox"(deps) {
    const target = requireFocusedMapping(deps);
    const { entry } = target;
    let { paneId } = target;
    refuseWhileAgentRuns(deps, target, "replace the sandbox");
    // Everything the replacement needs is checked before anything is deleted.
    const agent = resolveAgent(deps.config);
    const localPath = assertMountRoot(entry.localPath);
    const workdir = typeof entry.workdir === "string" && isInside(localPath, entry.workdir) && existsSync(entry.workdir) ? entry.workdir : localPath;
    const sandboxName = sandboxNameFor({ prefix: deps.config.sandboxNamePrefix, agentKind: agent.kind, localPath, paneId });
    const targets = deletionTargets(entry);
    const confirmed = await requestDeletionConfirmation({
      stateDir: deps.pluginEnv.stateDir,
      herdr: deps.herdr,
      pluginId: deps.pluginEnv.pluginId,
      details: { action: "replace-sandbox", paneId, sandboxName: targets.join(", "), localPath, consequence: `${targets.length === 1 ? "The sandbox is" : `These ${targets.length} sandboxes are`} deleted permanently, then a fresh one is created for this pane.${cloneWarning(entry)}` },
      timeoutMs: confirmationTimeout(deps.env),
    });
    if (!confirmed) {
      throw new PluginError("cancelled", `Replacing ${entry.sandboxName} was not confirmed.`);
    }
    // Delete only what the popup showed; a mapping changed meanwhile aborts with a
    // conflict. The deletion's claim on the mapping is kept until the replacement
    // is written, so no bridge can adopt the old mapping in between.
    const outcome = deps.lifecycle.destroy(paneId, { expectedNames: targets, keepClaim: true });
    if (target.orphan) {
      paneId = rehomeOrphan(deps, { ...target, entry: getPaneEntry(deps.pluginEnv.stateDir, paneId) ?? entry }, paneLabel(agent.kind, sandboxName));
    }
    withPaneLock(deps.pluginEnv.stateDir, paneId, () => {
      // Build the history from the mapping as it is now: re-homing may have absorbed a displaced mapping's sandboxes.
      const current = getPaneEntry(deps.pluginEnv.stateDir, paneId);
      if (!current || current.deletingPid !== process.pid) {
        throw new PluginError("conflict", `The mapping of pane ${paneId} was taken over by process ${current?.deletingPid ?? "unknown"} after ${outcome.deleted.join(", ") || "nothing"} was deleted; no replacement was started.`);
      }
      // The fresh entry carries no claim: the swap ends the deletion.
      savePaneEntry(deps.pluginEnv.stateDir, paneId, {
        ...freshEntry({ sandboxName, agent, localPath, workdir, config: deps.config, sourcePaneId: current.sourcePaneId ?? null, workspaceId: current.workspaceId ?? workspaceOf(deps) }),
        replacesSandboxNames: trackedNames(current),
        deletedSandboxNames: [...new Set([...(current.deletedSandboxNames ?? []), ...outcome.deleted, ...outcome.missing])],
      });
    });
    const label = paneLabel(agent.kind, sandboxName);
    try {
      deps.herdr.renamePane(paneId, label);
    } catch (error) {
      // The old sandboxes are gone already; a label is not worth failing the replacement.
      process.stderr.write(`could not relabel pane ${paneId}: ${errorMessageOf(error)}\n`);
    }
    const started = await startBridge(deps, { paneId, mode: "start", agent, label });
    deps.herdr.notify("Docker Sandbox replaced", `${entry.sandboxName} deleted, ${sandboxName} starting`);
    return { payload: { paneId: started.paneId, sandboxName, agentKind: agent.kind, deleted: outcome.deleted, alreadyMissing: outcome.missing, movedTo: started.movedTo } };
  },

  async "forget-mapping"(deps) {
    const target = requireFocusedMapping(deps);
    const { paneId, entry } = target;
    refuseWhileAgentRuns(deps, target, "delete the sandbox");
    const targets = deletionTargets(entry);
    const confirmed = await requestDeletionConfirmation({
      stateDir: deps.pluginEnv.stateDir,
      herdr: deps.herdr,
      pluginId: deps.pluginEnv.pluginId,
      details: { action: "forget-mapping", paneId, sandboxName: targets.join(", "), localPath: entry.localPath, consequence: `${targets.length === 1 ? "The sandbox is" : `These ${targets.length} sandboxes are`} deleted permanently and this pane forgets ${targets.length === 1 ? "it" : "them"}.${cloneWarning(entry)}` },
      timeoutMs: confirmationTimeout(deps.env),
    });
    if (!confirmed) {
      throw new PluginError("cancelled", `Deleting ${entry.sandboxName} was not confirmed.`);
    }
    const outcome = deps.lifecycle.forget(paneId, { expectedNames: targets });
    deps.herdr.notify("Docker Sandbox deleted", entry.sandboxName);
    return { payload: { paneId, sandboxName: entry.sandboxName, deleted: outcome.deleted, alreadyMissing: outcome.missing } };
  },
};

/** Action ids handled by this dispatcher, in manifest order. */
export const ACTION_IDS = Object.freeze(Object.keys(ACTIONS));

/**
 * Runs the action named by HERDR_PLUGIN_ACTION_ID and returns the exit code.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export async function main(env = process.env) {
  const pluginEnv = readPluginEnv(env);
  const action = pluginEnv.actionId;
  try {
    requirePluginDirs(pluginEnv);
    const handler = typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!handler) {
      throw new PluginError("target", `Unknown action "${action}". Known actions: ${ACTION_IDS.join(", ")}.`);
    }
    const context = readContext(env);
    const config = loadConfig(pluginEnv.configDir, env);
    const sbx = createSbxClient({ bin: config.sbxBin, env });
    const herdr = createHerdrClient({ bin: pluginEnv.herdrBin, env });
    const lifecycle = createLifecycle({ stateDir: pluginEnv.stateDir, config, sbx, log: (line) => process.stderr.write(`${line}\n`), herdr });
    const { payload, lines = [] } = await handler({ env, pluginEnv, context, config, sbx, herdr, lifecycle });
    emitResult({ action, ok: true, ...payload }, lines);
    return 0;
  } catch (error) {
    emitResult(failurePayload(action, error));
    process.stderr.write(`${errorMessageOf(error)}\n`);
    const output = /** @type {any} */ (error)?.output;
    if (typeof output === "string" && output.trim() !== "") {
      process.stderr.write(`${output.trim()}\n`);
    }
    return 1;
  }
}
