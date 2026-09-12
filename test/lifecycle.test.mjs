import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_DEFAULTS } from "../src/config.mjs";
import { createLifecycle } from "../src/lifecycle.mjs";
import { createSbxClient } from "../src/sbx.mjs";
import { FAKE_SBX, createFixture, mappingFor } from "./helpers.mjs";

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
