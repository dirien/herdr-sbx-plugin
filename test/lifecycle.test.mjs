import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_DEFAULTS } from "../src/config.mjs";
import { bridgeIsRunning, createLifecycle, deletionTargets } from "../src/lifecycle.mjs";
import { createSbxClient } from "../src/sbx.mjs";
import { deletePaneEntry } from "../src/state.mjs";
import { FAKE_HERDR, FAKE_SBX, ROOT, createFixture, mappingFor } from "./helpers.mjs";

const NAME = "herdr-claude-code-abc123def456";

test("destroy refuses when the mapping no longer tracks the confirmed names", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }, { name: "herdr-codex-999999999999", status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.destroy("pane-1", { expectedNames: ["herdr-codex-999999999999"] }), (error) => error.errorKind === "conflict" && /changed while the confirmation was open/.test(error.message));
  assert.deepEqual(f.sbxCalls(), [], "nothing was deleted");
  assert.deepEqual(lifecycle.destroy("pane-1", { expectedNames: [NAME] }), { deleted: [NAME], missing: [] });
  assert.deepEqual(f.sbxCalls(), [["rm", "--force", NAME]]);
  f.cleanup();
});

test("destroy records the mapping's own sandbox as gone even when a predecessor fails to delete", () => {
  const other = "herdr-codex-999999999999";
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }, { name: other, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { replacesSandboxNames: [other] }) }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env({ FAKE_SBX_FAIL: `rm:daemon@${other}` }) });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.destroy("pane-1"), (error) => error.errorKind === "daemon");
  const entry = f.mappings().panes["pane-1"];
  assert.equal(entry.lifecycleState, "missing", "the current sandbox is gone, so the mapping is not usable");
  assert.deepEqual(entry.deletedSandboxNames, [NAME]);
  assert.equal(entry.lastError.kind, "daemon");
  assert.deepEqual(f.sbxSandboxes().map((item) => item.name), [other]);
  f.cleanup();
});

test("destroy trusts a not-found from sbx rm only when sbx ls agrees", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env({ FAKE_SBX_FAIL: "rm:not-found" }) });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.destroy("pane-1"), (error) => error.errorKind === "unknown" && /sbx ls still lists it/.test(error.message));
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "ready");
  assert.deepEqual(f.mappings().panes["pane-1"].deletedSandboxNames, []);
  assert.deepEqual(f.sbxCalls().map((call) => call[0]), ["rm", "ls"]);

  const gone = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const goneLifecycle = createLifecycle({ stateDir: gone.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx: createSbxClient({ bin: FAKE_SBX, env: gone.env() }), log: () => {} });
  assert.deepEqual(goneLifecycle.destroy("pane-1"), { deleted: [], missing: [NAME] });
  assert.equal(gone.mappings().panes["pane-1"].lifecycleState, "missing");
  f.cleanup();
  gone.cleanup();
});

test("prepare reports an exec failure during the agent probe by its own kind, not as a missing command", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "created" }) }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env({ FAKE_SBX_FAIL: "exec:daemon" }) });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.prepare("pane-1"), (error) => error.errorKind === "daemon" && /Could not check for "claude"/.test(error.message));
  const entry = f.mappings().panes["pane-1"];
  assert.notEqual(entry.lifecycleState, "failed", "a daemon hiccup is not a broken sandbox");
  assert.equal(entry.lastError.kind, "daemon");

  const absent = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "created" }) }) });
  const absentLifecycle = createLifecycle({ stateDir: absent.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx: createSbxClient({ bin: FAKE_SBX, env: absent.env({ FAKE_SBX_EXEC_EXIT: "127" }) }), log: () => {} });
  assert.throws(() => absentLifecycle.prepare("pane-1"), (error) => error.errorKind === "config" && /not available inside sandbox/.test(error.message));
  assert.equal(absent.mappings().panes["pane-1"].lifecycleState, "failed");
  f.cleanup();
  absent.cleanup();
});

test("a captured sbx call that outlives its timeout is killed and reported as a daemon failure", () => {
  const f = createFixture();
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env({ FAKE_SBX_SLEEP_MS: "5000", HERDR_SBX_TIMEOUT_MS: "150" }) });
  const started = Date.now();
  assert.throws(() => sbx.version(), (error) => error.errorKind === "daemon" && /did not finish within 0s and was killed/.test(error.message) && /HERDR_SBX_TIMEOUT_MS/.test(error.message));
  assert.ok(Date.now() - started < 4000, "the call was cut short");
  const patient = createSbxClient({ bin: FAKE_SBX, env: f.env({ FAKE_SBX_SLEEP_MS: "50", HERDR_SBX_TIMEOUT_MS: "" }) });
  assert.equal(patient.version().json.client.version, "0.42.1", "an empty override means the default timeout");
  f.cleanup();
});

test("prepare reuses a sandbox on a create conflict only when sbx really lists it", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env({ FAKE_SBX_FAIL: "create:conflict" }) });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.prepare("pane-1"), (error) => error.errorKind === "conflict", "a port clash reads as conflict too, and there is no sandbox to reuse");
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "failed");
  assert.equal(f.mappings().panes["pane-1"].lastError.kind, "conflict");

  const existing = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  const reusing = createLifecycle({ stateDir: existing.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx: createSbxClient({ bin: FAKE_SBX, env: existing.env({ FAKE_SBX_FAIL: "create:conflict" }) }), log: () => {} });
  assert.equal(reusing.prepare("pane-1").entry.lifecycleState, "prepared");
  f.cleanup();
  existing.cleanup();
});

test("prepare reports an exec failure that printed something as unknown rather than a missing command", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "created" }) }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env({ FAKE_SBX_EXEC_EXIT: "3", FAKE_SBX_EXEC_OUTPUT: "rpc error: transport closed while attaching" }) });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.prepare("pane-1"), (error) => error.errorKind === "unknown" && /sbx exec failed/.test(error.message) && /transport closed/.test(error.output));
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "created", "not marked failed: the sandbox may be fine");
  f.cleanup();
});

test("stop keeps a mapping that never finished preparing out of the connectable states", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "failed", lastError: { kind: "config", message: "setup script failed", at: "2026-09-12T00:00:00.000Z" } }),
    "pane-2": mappingFor({ worktree: p.worktree }, { paneId: "pane-2" }),
  }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.deepEqual(lifecycle.stop("pane-1"), { sandboxName: NAME });
  const failed = f.mappings().panes["pane-1"];
  assert.equal(failed.lifecycleState, "failed", "reconnect must run prepare again, not attach");
  assert.equal(failed.lastError.message, "setup script failed");
  assert.deepEqual(lifecycle.stop("pane-2"), { sandboxName: NAME });
  assert.equal(f.mappings().panes["pane-2"].lifecycleState, "stopped");
  assert.equal(f.mappings().panes["pane-2"].lastError, null);
  f.cleanup();
});

test("a shell opens in a sandbox whose preparation failed, but not before the sandbox exists", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "failed", lastError: { kind: "config", message: "setup script failed", at: "2026-09-12T00:00:00.000Z" } }),
    "pane-2": mappingFor({ worktree: p.worktree }, { paneId: "pane-2", lifecycleState: "missing" }),
  }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.connect("pane-1"), (error) => error.errorKind === "target" && /is not ready \(state: failed\)/.test(error.message), "the agent still needs prepare");
  assert.equal(lifecycle.shell("pane-1").exitCode, 0, "the shell is how a failed setup gets inspected");
  const shellCall = f.sbxCalls().find((call) => call[0] === "exec");
  assert.deepEqual(shellCall.slice(-3), ["--", "bash", "-l"]);
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "failed", "a shell changes no lifecycle state");
  assert.throws(() => lifecycle.shell("pane-2"), (error) => error.errorKind === "target" && /does not exist yet \(state: missing\)/.test(error.message));
  f.cleanup();
});

test("prepare takes a reused sandbox off the deletion checkpoint so a later destroy still deletes it", () => {
  const other = "herdr-codex-999999999999";
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }, { name: other, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "missing", deletedSandboxNames: [NAME], replacesSandboxNames: [other], setupScriptRanAt: "2026-09-12T00:00:00.000Z" }),
  }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  const prepared = lifecycle.prepare("pane-1").entry;
  assert.equal(prepared.lifecycleState, "prepared");
  assert.deepEqual(prepared.deletedSandboxNames, [], "a sandbox that exists again is no longer written off");
  assert.equal(prepared.setupScriptRanAt, null, "the setup never ran in this VM");
  assert.deepEqual(deletionTargets(prepared), [NAME, other]);
  assert.deepEqual(lifecycle.destroy("pane-1"), { deleted: [NAME, other], missing: [] });
  assert.deepEqual(f.sbxSandboxes(), []);
  f.cleanup();
});

test("bridgeIsRunning tells a live bridge process from a dead or unknown one", () => {
  assert.equal(bridgeIsRunning({ bridgePid: process.pid }), true);
  assert.equal(bridgeIsRunning({ bridgePid: 2147483647 }), false);
  assert.equal(bridgeIsRunning({ bridgePid: null }), false);
  assert.equal(bridgeIsRunning({}), false);
  assert.equal(bridgeIsRunning({ bridgePid: -1 }), false);
});

test("prepare deletes a sandbox whose mapping was forgotten while sbx create was running", async () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  const bridge = spawn(process.execPath, [path.join(ROOT, "src", "bridge.mjs"), "start", "--state-dir", f.stateDir, "--config-dir", f.configDir, "--pane-id", "pane-1", "--herdr-bin", FAKE_HERDR, "--sbx-bin", FAKE_SBX], {
    cwd: ROOT,
    env: f.env({ FAKE_SBX_SLEEP_MS: "1500", FAKE_SBX_SLEEP_MATCH: "create --name" }),
  });
  let output = "";
  bridge.stdout.on("data", (chunk) => { output += chunk; });
  bridge.stderr.on("data", (chunk) => { output += chunk; });
  // Wait until the bridge is inside sbx create, then forget the mapping the way forget-mapping does.
  const started = Date.now();
  while (!f.sbxCalls().some((call) => call[0] === "create") && Date.now() - started < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(f.sbxCalls().some((call) => call[0] === "create"), "sbx create started");
  deletePaneEntry(f.stateDir, "pane-1");
  const code = await new Promise((resolve) => bridge.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(output, /disappeared while herdr-claude-code-abc123def456 was being created; deleting the sandbox again/);
  assert.match(output, /was removed while sandbox .* was being created; the sandbox was deleted again/);
  assert.deepEqual(f.sbxCalls().map((call) => call[0]), ["ls", "create", "rm"], "the just-created sandbox is removed, nothing else runs");
  assert.deepEqual(f.sbxSandboxes(), [], "no untracked VM is left behind");
  f.cleanup();
});

test("destroy refuses right before sbx rm when a bridge or an agent is active again", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }, { bridgePid: process.pid, bridgeStartedAt: "2026-09-13T00:00:00.000Z" }),
    "pane-2": mappingFor({ worktree: p.worktree }, { paneId: "pane-2" }),
  }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {}, herdr: { getPane: (paneId) => (paneId === "pane-2" ? { agent: "claude" } : null) } });
  assert.throws(() => lifecycle.destroy("pane-1"), (error) => error.errorKind === "conflict" && /still runs the bridge/.test(error.message) && /Nothing was deleted/.test(error.message));
  assert.throws(() => lifecycle.forget("pane-2"), (error) => error.errorKind === "conflict" && /running agent "claude" again/.test(error.message));
  assert.deepEqual(f.sbxCalls(), [], "no sbx rm ran");
  assert.deepEqual(Object.keys(f.mappings().panes).sort(), ["pane-1", "pane-2"]);
  f.cleanup();
});
