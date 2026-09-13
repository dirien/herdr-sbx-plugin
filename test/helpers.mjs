/**
 * Shared fixture helpers: temp state/config/worktree directories, fake CLIs,
 * and runners that execute the plugin scripts as real child processes.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseResultLine } from "../src/result.mjs";
import { loadState, savePaneEntry } from "../src/state.mjs";

/** Absolute plugin root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FAKE_SBX = path.join(ROOT, "test", "fakes", "sbx.mjs");
export const FAKE_HERDR = path.join(ROOT, "test", "fakes", "herdr.mjs");
export const FAKE_OPENER = path.join(ROOT, "test", "fakes", "opener.mjs");

for (const fake of [FAKE_SBX, FAKE_HERDR, FAKE_OPENER]) {
  try {
    chmodSync(fake, 0o755);
  } catch (error) {
    // A read-only checkout cannot change modes; git already stores the fakes as executable.
    if (error.code !== "EROFS" && error.code !== "EPERM") {
      throw error;
    }
  }
}

/**
 * Runs git in a directory and throws on failure.
 * @param {string} cwd
 * @param {string[]} args
 */
export function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Creates an isolated fixture.
 * @param {{config?: Record<string, unknown>|null, sandboxes?: Array<Record<string, unknown>>, panes?: Record<string, Record<string, unknown>>|((paths: {root: string, stateDir: string, configDir: string, worktree: string}) => Record<string, Record<string, unknown>>)}} [options]
 */
export function createFixture({ config = {}, sandboxes = [], panes = {} } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "herdr-sbx-test-")));
  const stateDir = path.join(root, "state");
  const configDir = path.join(root, "config");
  const worktree = path.join(root, "worktree");
  for (const dir of [stateDir, configDir, worktree]) {
    mkdirSync(dir, { recursive: true });
  }
  git(worktree, ["init", "-q"]);
  writeFileSync(path.join(worktree, "README.md"), "fixture\n");
  git(worktree, ["add", "README.md"]);
  git(worktree, ["commit", "-q", "-m", "init"]);
  if (config !== null) {
    writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config, null, 2));
  }
  const sbxState = path.join(root, "sbx-state.json");
  writeFileSync(sbxState, JSON.stringify({ sandboxes }, null, 2));
  const paneEntries = typeof panes === "function" ? panes({ root, stateDir, configDir, worktree }) : panes;
  for (const [paneId, entry] of Object.entries(paneEntries)) {
    savePaneEntry(stateDir, paneId, entry);
  }
  const sbxLog = path.join(root, "sbx.log");
  const herdrLog = path.join(root, "herdr.log");
  const openerLog = path.join(root, "opener.log");
  const confirmationLog = path.join(root, "confirmations.log");
  const fixture = {
    root,
    stateDir,
    configDir,
    worktree,
    sbxState,
    sbxLog,
    herdrLog,
    env(overrides = {}) {
      return {
        PATH: process.env.PATH,
        HOME: root,
        HERDR_PLUGIN_ROOT: ROOT,
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_ID: "sbx.sandbox",
        HERDR_BIN_PATH: FAKE_HERDR,
        HERDR_SBX_BIN: FAKE_SBX,
        FAKE_SBX_LOG: sbxLog,
        FAKE_SBX_STATE: sbxState,
        FAKE_HERDR_LOG: herdrLog,
        HERDR_SBX_OPENER: FAKE_OPENER,
        FAKE_OPENER_LOG: openerLog,
        FAKE_HERDR_CONFIRMATION_LOG: confirmationLog,
        HERDR_SBX_BRIDGE_START_TIMEOUT_MS: "300",
        HERDR_SBX_CONFIRMATION_TIMEOUT_MS: "300",
        FAKE_HERDR_BRIDGE_STARTS: "1",
        ...overrides,
      };
    },
    sbxCalls() {
      return readJsonLines(sbxLog).map((entry) => entry.argv);
    },
    herdrCalls() {
      return readJsonLines(herdrLog).map((entry) => entry.argv);
    },
    confirmations() {
      return readJsonLines(confirmationLog);
    },
    openedUrls() {
      return existsSync(openerLog) ? readFileSync(openerLog, "utf8").split("\n").filter(Boolean) : [];
    },
    sbxSandboxes() {
      return JSON.parse(readFileSync(sbxState, "utf8")).sandboxes;
    },
    mappings() {
      return loadState(stateDir);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

/**
 * Reads a JSON-lines log, returning [] when the file does not exist.
 * @param {string} file
 */
export function readJsonLines(file) {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Runs `src/action.mjs` for an action id.
 * @param {ReturnType<typeof createFixture>} fixture
 * @param {string} actionId
 * @param {{context?: Record<string, unknown>, env?: Record<string, string>}} [options]
 */
export function runAction(fixture, actionId, { context = {}, env = {} } = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "src", "action.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    env: fixture.env({ HERDR_PLUGIN_ACTION_ID: actionId, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context), ...env }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, result: parseResultLine(result.stdout) };
}

/**
 * Runs `src/bridge.mjs` in a mode for a pane.
 * @param {ReturnType<typeof createFixture>} fixture
 * @param {string} mode
 * @param {string} paneId
 * @param {{env?: Record<string, string>}} [options]
 */
export function runBridge(fixture, mode, paneId, { env = {}, args = [] } = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "src", "bridge.mjs"), mode, "--state-dir", fixture.stateDir, "--config-dir", fixture.configDir, "--pane-id", paneId, "--herdr-bin", FAKE_HERDR, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: fixture.env(env),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs `src/events.mjs` with an event payload.
 * @param {ReturnType<typeof createFixture>} fixture
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {{env?: Record<string, string>}} [options]
 */
export function runEvent(fixture, eventName, payload, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "src", "events.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    env: fixture.env({ HERDR_PLUGIN_EVENT: eventName, HERDR_PLUGIN_EVENT_JSON: JSON.stringify(payload), ...env }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A mapping entry with sensible defaults for tests.
 * @param {ReturnType<typeof createFixture>} fixture
 * @param {Record<string, unknown>} [overrides]
 */
/**
 * Starts a process whose command line looks like a bridge for `paneId` (it
 * only sleeps), so tests can mark a mapping busy with a pid that passes the
 * identity check. Call `stop()` when done.
 * @param {string} paneId
 * @returns {{pid: number, stop: () => void}}
 */
export function fakeBridgeProcess(paneId) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", path.join("src", "bridge.mjs"), "connect", "--pane-id", paneId], { cwd: ROOT, stdio: "ignore" });
  child.unref();
  return { pid: /** @type {number} */ (child.pid), stop: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
}

export function mappingFor(fixture, overrides = {}) {
  return {
    paneId: "pane-1",
    sandboxName: "herdr-claude-code-abc123def456",
    agentKind: "claude-code",
    sbxAgent: "claude",
    localPath: fixture.worktree,
    workdir: fixture.worktree,
    workspaceMode: "mount",
    lifecycleState: "ready",
    createdAt: "2026-09-11T00:00:00.000Z",
    sourcePaneId: "pane-0",
    replacesSandboxNames: [],
    deletedSandboxNames: [],
    lastError: null,
    ...overrides,
  };
}
