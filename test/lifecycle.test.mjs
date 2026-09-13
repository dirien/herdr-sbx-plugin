import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_DEFAULTS } from "../src/config.mjs";
import { bridgeIsRunning, createLifecycle, deletionTargets, liveShells, processCommandLine, shellIsRunning } from "../src/lifecycle.mjs";
import { createSbxClient } from "../src/sbx.mjs";
import { deletePaneEntry, processStartToken } from "../src/state.mjs";
import { PluginError } from "../src/errors.mjs";
import { FAKE_HERDR, FAKE_SBX, ROOT, createFixture, fakeActionProcess, fakeBridgeProcess, fakeShellProcess, mappingFor } from "./helpers.mjs";

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

test("bridgeIsRunning tells a live bridge for the pane from a dead, recycled or unrelated pid", () => {
  const bridge = fakeBridgeProcess("pane-1");
  try {
    assert.equal(bridgeIsRunning({ bridgePid: bridge.pid, paneId: "pane-1" }), true);
    assert.equal(bridgeIsRunning({ bridgePid: bridge.pid, paneId: "pane-10" }), false, "a bridge for another pane is not this mapping's bridge");
    assert.equal(bridgeIsRunning({ bridgePid: process.pid, paneId: "pane-1" }), false, "a recycled pid now running something else does not count");
    assert.equal(bridgeIsRunning({ bridgePid: 2147483647, paneId: "pane-1" }), false);
    assert.equal(bridgeIsRunning({ bridgePid: 1, paneId: "pane-1" }), false, "another user's process is never our bridge");
    assert.equal(bridgeIsRunning({ bridgePid: null, paneId: "pane-1" }), false);
    assert.equal(bridgeIsRunning({}), false);
    assert.equal(bridgeIsRunning({ bridgePid: -1 }), false);
    assert.match(processCommandLine(bridge.pid), /bridge\.mjs connect --pane-id pane-1/);
  } finally {
    bridge.stop();
  }
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
  const bridge = fakeBridgeProcess("pane-1");
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }, { bridgePid: bridge.pid, bridgeStartedAt: "2026-09-13T00:00:00.000Z" }),
    "pane-2": mappingFor({ worktree: p.worktree }, { paneId: "pane-2" }),
  }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {}, herdr: { getPane: (paneId) => (paneId === "pane-2" ? { agent: "claude" } : null) } });
  assert.throws(() => lifecycle.destroy("pane-1"), (error) => error.errorKind === "conflict" && /still runs the bridge/.test(error.message) && /Nothing was deleted/.test(error.message));
  assert.throws(() => lifecycle.forget("pane-2"), (error) => error.errorKind === "conflict" && /running agent "claude" again/.test(error.message));
  assert.deepEqual(f.sbxCalls(), [], "no sbx rm ran");
  assert.deepEqual(Object.keys(f.mappings().panes).sort(), ["pane-1", "pane-2"]);
  bridge.stop();
  f.cleanup();
});

test("a deletion claims the mapping: no bridge acknowledges and no second deletion starts while it runs", () => {
  const deleter = fakeActionProcess();
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }, { deletingPid: deleter.pid, deletingSince: "2026-09-13T00:00:00.000Z" }),
    "pane-2": mappingFor({ worktree: p.worktree }, { paneId: "pane-2", sandboxName: "herdr-codex-999999999999", deletingPid: 2147483647, deletingSince: "2026-09-13T00:00:00.000Z" }),
  }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.acknowledgeBridge("pane-1", "launch-1"), (error) => error.errorKind === "conflict" && /being deleted right now/.test(error.message));
  assert.equal(f.mappings().panes["pane-1"].bridgePid, undefined, "nothing was recorded");
  assert.throws(() => lifecycle.destroy("pane-1"), (error) => error.errorKind === "conflict" && /Another deletion/.test(error.message));
  assert.deepEqual(f.sbxCalls(), []);
  lifecycle.acknowledgeBridge("pane-2", "launch-2");
  assert.equal(f.mappings().panes["pane-2"].bridgePid, process.pid, "a claim whose owner is gone is ignored");
  deleter.stop();
  f.cleanup();
});

test("destroy fails closed when Herdr cannot be asked, and looks again before every rm", () => {
  const other = "herdr-codex-999999999999";
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }, { name: other, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { replacesSandboxNames: [other] }) }) });
  const failing = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx: createSbxClient({ bin: FAKE_SBX, env: f.env() }), log: () => {}, herdr: { getPane: () => { throw new PluginError("unknown", "herdr pane get failed while reading the pane (exit 1)."); } } });
  assert.throws(() => failing.destroy("pane-1"), (error) => /Could not confirm with Herdr/.test(error.message) && /Nothing was deleted/.test(error.message));
  assert.deepEqual(f.sbxCalls(), [], "an unanswered safety check is not a green light");
  assert.equal(f.mappings().panes["pane-1"].deletingPid, undefined, "the mapping was never claimed");

  const bridge = fakeBridgeProcess("pane-1");
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env({ FAKE_SBX_RM_TOUCH_PANE: "pane-1", FAKE_SBX_RM_TOUCH_BRIDGE_PID: String(bridge.pid) }) });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {}, herdr: { getPane: () => null } });
  assert.throws(() => lifecycle.destroy("pane-1"), (error) => error.errorKind === "conflict" && /still runs the bridge/.test(error.message));
  assert.deepEqual(f.sbxCalls().filter((call) => call[0] === "rm").map((call) => call[2]), [NAME], "the predecessor was left alone once a bridge appeared");
  const entry = f.mappings().panes["pane-1"];
  assert.deepEqual(entry.deletedSandboxNames, [NAME]);
  assert.equal(entry.lifecycleState, "missing");
  assert.equal(entry.deletingPid, null, "the claim is released on failure");
  assert.deepEqual(f.sbxSandboxes().map((item) => item.name), [other]);
  bridge.stop();
  f.cleanup();
});

test("forget keeps the deletion claim until the mapping is removed, and yields to a takeover", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.deepEqual(lifecycle.destroy("pane-1", { keepClaim: true }), { deleted: [NAME], missing: [] });
  const claimed = f.mappings().panes["pane-1"];
  assert.equal(claimed.deletingPid, process.pid, "the claim outlives destroy when asked");
  assert.equal(claimed.lifecycleState, "missing");
  assert.deepEqual(lifecycle.forget("pane-1"), { deleted: [], missing: [] }, "nothing left to delete; the mapping goes");
  assert.equal(f.mappings().panes["pane-1"], undefined);

  const other = fakeActionProcess();
  const stolen = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const stolenLifecycle = createLifecycle({ stateDir: stolen.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx: createSbxClient({ bin: FAKE_SBX, env: stolen.env({ FAKE_SBX_RM_TOUCH_PANE: "pane-1", FAKE_SBX_RM_TOUCH_DELETING_PID: String(other.pid) }) }), log: () => {} });
  assert.throws(() => stolenLifecycle.forget("pane-1"), (error) => error.errorKind === "conflict" && /taken over by process/.test(error.message));
  const left = stolen.mappings().panes["pane-1"];
  assert.ok(left, "the mapping was left to the other process");
  assert.equal(left.deletingPid, other.pid, "the other claim was not clobbered");
  assert.deepEqual(left.deletedSandboxNames, [NAME], "what was deleted is still recorded");
  other.stop();
  f.cleanup();
  stolen.cleanup();
});

test("an open-shell session blocks deletion, a shell refuses to open during one, and a duplicate mapping's bridge counts too", () => {
  const shell = fakeShellProcess("pane-1");
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }, { shellPids: [{ pid: shell.pid, since: "2026-09-13T00:00:00.000Z" }, { pid: 2147483647, since: "2026-09-13T00:00:00.000Z" }] }),
  }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.destroy("pane-1"), (error) => error.errorKind === "conflict" && /an open-shell session in herdr-claude-code-abc123def456 \(pid \d+\)/.test(error.message));
  assert.deepEqual(f.sbxCalls(), []);
  shell.stop();

  const deleter = fakeActionProcess();
  const deleting = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { deletingPid: deleter.pid, deletingSince: "2026-09-13T00:00:00.000Z" }) }) });
  const deletingLifecycle = createLifecycle({ stateDir: deleting.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx: createSbxClient({ bin: FAKE_SBX, env: deleting.env() }), log: () => {} });
  assert.throws(() => deletingLifecycle.shell("pane-1"), (error) => error.errorKind === "conflict" && /not opening a shell/.test(error.message));
  assert.ok(!deleting.sbxCalls().some((call) => call[0] === "exec"));
  deleter.stop();

  const bridge = fakeBridgeProcess("pane-9");
  const duplicated = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }),
    "pane-9": mappingFor({ worktree: p.worktree }, { paneId: "pane-9", bridgePid: bridge.pid, bridgeStartedAt: "2026-09-13T00:00:00.000Z" }),
  }) });
  const dupLifecycle = createLifecycle({ stateDir: duplicated.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx: createSbxClient({ bin: FAKE_SBX, env: duplicated.env() }), log: () => {} });
  assert.throws(() => dupLifecycle.destroy("pane-1"), (error) => error.errorKind === "conflict" && /Pane pane-9 also tracks herdr-claude-code-abc123def456 and still has a bridge or shell attached/.test(error.message));
  assert.deepEqual(duplicated.sbxCalls(), []);
  bridge.stop();
  f.cleanup();
  deleting.cleanup();
  duplicated.cleanup();
});

test("ownership records survive a recycled pid check: a different incarnation of the same pid is not the owner", () => {
  const bridge = fakeBridgeProcess("pane-1");
  assert.equal(bridgeIsRunning({ bridgePid: bridge.pid, bridgeToken: "linux:0", paneId: "pane-1" }), false, "a start token that does not match means the pid was recycled");
  const token = processStartToken(bridge.pid);
  assert.ok(token, "the platform reports a start token");
  assert.equal(bridgeIsRunning({ bridgePid: bridge.pid, bridgeToken: token, paneId: "pane-1" }), true);
  assert.equal(bridgeIsRunning({ bridgePid: bridge.pid, bridgeToken: null, paneId: "pane-1" }), true, "records without a token fall back to the command line check");
  bridge.stop();
});

test("a deletion claimed through one mapping blocks bridges and shells on another mapping of the same sandbox", () => {
  const deleter = fakeActionProcess();
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }, { deletingPid: deleter.pid, deletingSince: "2026-09-13T00:00:00.000Z" }),
    "pane-9": mappingFor({ worktree: p.worktree }, { paneId: "pane-9" }),
  }) });
  const sbx = createSbxClient({ bin: FAKE_SBX, env: f.env() });
  const lifecycle = createLifecycle({ stateDir: f.stateDir, config: { ...CONFIG_DEFAULTS, sbxBin: FAKE_SBX }, sbx, log: () => {} });
  assert.throws(() => lifecycle.acknowledgeBridge("pane-9", "launch-9"), (error) => error.errorKind === "conflict" && /being deleted right now through pane pane-1/.test(error.message));
  assert.throws(() => lifecycle.shell("pane-9"), (error) => error.errorKind === "conflict" && /through pane pane-1/.test(error.message));
  assert.equal(f.mappings().panes["pane-9"].bridgePid, undefined);
  assert.deepEqual(f.sbxCalls(), []);
  deleter.stop();
  lifecycle.acknowledgeBridge("pane-9", "launch-9");
  assert.equal(f.mappings().panes["pane-9"].bridgePid, process.pid, "a stale claim on the other mapping is ignored");
  assert.deepEqual(readdirSync(path.join(f.stateDir, "panes")).filter((name) => name.endsWith(".lock")), [], "no lock left behind");
  f.cleanup();
});

test("only a bridge running in shell mode counts as a live shell", () => {
  const shell = fakeShellProcess("pane-1");
  const agent = fakeBridgeProcess("pane-1");
  try {
    assert.deepEqual(liveShells({ paneId: "pane-1", shellPids: [{ pid: shell.pid }, { pid: agent.pid }, { pid: 2147483647 }] }).map((item) => item.pid), [shell.pid], "a connect bridge recorded as a shell is not a shell, a dead pid is nothing");
    assert.equal(shellIsRunning({ paneId: "pane-2", shellPids: [{ pid: shell.pid, paneId: "pane-1" }] }), true, "the shell's own pane id is what counts after a move");
    assert.equal(shellIsRunning({ paneId: "pane-2", shellPids: [{ pid: shell.pid }] }), false);
  } finally {
    shell.stop();
    agent.stop();
  }
});
