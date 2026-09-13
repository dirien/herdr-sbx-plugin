import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { removedWorktreePath } from "../src/events-main.mjs";
import { createFixture, mappingFor, runEvent } from "./helpers.mjs";

const NAME = "herdr-claude-code-abc123def456";

function removedEvent(worktreePath) {
  return { event: "worktree.removed", data: { workspace_id: "ws-1", worktree: { path: worktreePath, label: "feature", is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true }, forced: false } };
}

test("removedWorktreePath reads the envelope and a flat payload", () => {
  assert.equal(removedWorktreePath(removedEvent("/w")), "/w");
  assert.equal(removedWorktreePath({ worktree: { path: "/flat" } }), "/flat");
  assert.equal(removedWorktreePath({}), null);
});

test("worktree.removed deletes mapped sandboxes and forgets only those mappings", () => {
  const f = createFixture({
    sandboxes: [{ name: NAME, status: "running" }, { name: "other", status: "running" }],
    panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }), "pane-2": mappingFor({ worktree: p.worktree }, { paneId: "pane-2", sandboxName: "other", localPath: "/elsewhere" }) }),
  });
  const { status, stdout } = runEvent(f, "worktree.removed", removedEvent(f.worktree), { env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(status, 0, stdout);
  assert.deepEqual(f.sbxCalls(), [["rm", "--force", NAME]]);
  assert.deepEqual(Object.keys(f.mappings().panes), ["pane-2"]);
  assert.deepEqual(f.sbxSandboxes().map((item) => item.name), ["other"]);
  const popup = f.herdrCalls().find((call) => call[0] === "plugin");
  assert.deepEqual(popup.slice(0, 7), ["plugin", "pane", "open", "--plugin", "sbx.sandbox", "--entrypoint", "deletion-confirmation"]);
  const [request] = f.confirmations();
  assert.equal(request.action, "worktree.removed");
  assert.equal(request.sandboxName, NAME);
  assert.ok(f.herdrCalls().some((call) => call.slice(0, 3).join(" ") === "notification show Docker Sandboxes removed"));
  f.cleanup();
});

test("worktree.removed keeps everything when the popup is declined or times out", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const declined = runEvent(f, "worktree.removed", removedEvent(f.worktree), { env: { FAKE_POPUP_DECISION: "cancelled" } });
  assert.equal(declined.status, 0);
  assert.match(declined.stdout, /not confirmed; mappings kept/);
  const silent = runEvent(f, "worktree.removed", removedEvent(f.worktree));
  assert.equal(silent.status, 0);
  assert.deepEqual(f.sbxCalls(), []);
  assert.ok(f.mappings().panes["pane-1"]);
  f.cleanup();
});

test("worktree.removed respects cleanupOnWorktreeRemoved = false", () => {
  const f = createFixture({ config: { cleanupOnWorktreeRemoved: false }, sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { status, stdout } = runEvent(f, "worktree.removed", removedEvent(f.worktree));
  assert.equal(status, 0);
  assert.match(stdout, /leaving sandboxes alone/);
  assert.deepEqual(f.sbxCalls(), []);
  assert.ok(f.mappings().panes["pane-1"]);
  f.cleanup();
});

test("other events and unrelated worktrees are ignored", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  assert.equal(runEvent(f, "pane.closed", { event: "pane.closed", data: {} }).status, 0);
  assert.equal(runEvent(f, "worktree.removed", removedEvent("/some/other/worktree")).status, 0);
  assert.deepEqual(f.sbxCalls(), []);
  assert.ok(f.mappings().panes["pane-1"]);
  f.cleanup();
});

test("a corrupt config is reported as one line instead of a stack trace", () => {
  const f = createFixture({ config: null, panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  writeFileSync(path.join(f.configDir, "config.json"), "{ nope");
  const { status, stderr } = runEvent(f, "worktree.removed", removedEvent(f.worktree));
  assert.equal(status, 1);
  assert.match(stderr, /worktree cleanup failed: .*not valid JSON/);
  assert.doesNotMatch(stderr, /at .*\.mjs:\d+/);
  f.cleanup();
});

test("a failing deletion keeps the mapping and exits 1", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { status, stderr } = runEvent(f, "worktree.removed", removedEvent(f.worktree), { env: { FAKE_SBX_FAIL: "rm:generic", FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(status, 1);
  assert.match(stderr, /could not clean up/);
  assert.ok(f.mappings().panes["pane-1"]);
  assert.equal(f.mappings().panes["pane-1"].lastError.kind, "unknown");
  f.cleanup();
});

test("worktree.removed keeps a sandbox whose bridge came back while the popup was open", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { status, stderr } = runEvent(f, "worktree.removed", removedEvent(f.worktree), { env: { FAKE_POPUP_DECISION: "confirmed", FAKE_HERDR_POPUP_BRIDGE_PANE: "pane-1", FAKE_HERDR_POPUP_BRIDGE_PID: String(process.pid) } });
  assert.equal(status, 1);
  assert.match(stderr, /still runs the bridge for .*Nothing was deleted/);
  assert.ok(!f.sbxCalls().some((call) => call[0] === "rm"), "no sbx rm ran");
  assert.deepEqual(Object.keys(f.mappings().panes), ["pane-1"]);
  f.cleanup();
});
