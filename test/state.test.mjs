import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deletePaneEntry, entriesForLocalPath, getPaneEntry, loadState, paneEntryPath, requirePaneEntry, savePaneEntry, updatePaneEntry } from "../src/state.mjs";

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), "herdr-sbx-state-"));
}

test("loadState returns an empty store when nothing was saved", () => {
  const state = loadState(freshDir());
  assert.equal(state.version, 1);
  assert.deepEqual(Object.keys(state.panes), []);
});

test("save, update, get and delete round-trip with one file per pane and no temp files", () => {
  const dir = freshDir();
  const stored = savePaneEntry(dir, "ws:1:3", { sandboxName: "s-1", lifecycleState: "provisional", localPath: "/repo" });
  assert.equal(stored.paneId, "ws:1:3");
  assert.equal(stored.version, 1);
  assert.ok(stored.updatedAt);
  assert.equal(getPaneEntry(dir, "ws:1:3").sandboxName, "s-1");
  updatePaneEntry(dir, "ws:1:3", { lifecycleState: "ready" });
  assert.equal(requirePaneEntry(dir, "ws:1:3").lifecycleState, "ready");
  savePaneEntry(dir, "ws:1:4", { sandboxName: "s-2", lifecycleState: "ready", localPath: "/repo" });
  const files = readdirSync(path.join(dir, "panes"));
  assert.equal(files.length, 2);
  assert.ok(files.every((name) => /^ws_1_[34]-[a-f0-9]{10}\.json$/.test(name)), files.join(","));
  assert.equal(path.basename(paneEntryPath(dir, "ws:1:3")), files.find((name) => name.startsWith("ws_1_3")));
  assert.deepEqual(Object.keys(loadState(dir).panes).sort(), ["ws:1:3", "ws:1:4"]);
  assert.equal(deletePaneEntry(dir, "ws:1:3"), true);
  assert.equal(deletePaneEntry(dir, "ws:1:3"), false);
  assert.equal(getPaneEntry(dir, "ws:1:3"), null);
  assert.equal(getPaneEntry(dir, null), null);
  assert.deepEqual(Object.keys(loadState(dir).panes), ["ws:1:4"]);
});

test("pane ids that look like prototype keys are stored safely", () => {
  const dir = freshDir();
  savePaneEntry(dir, "__proto__", { sandboxName: "s-p", lifecycleState: "ready", localPath: "/repo" });
  const state = loadState(dir);
  assert.equal(Object.getPrototypeOf(state.panes), null);
  assert.equal(state.panes.__proto__.sandboxName, "s-p");
  assert.equal(getPaneEntry(dir, "constructor"), null);
});

test("savePaneEntry refuses unknown lifecycle states", () => {
  assert.throws(() => savePaneEntry(freshDir(), "p", { lifecycleState: "bogus" }), /unknown lifecycle state/);
});

test("requirePaneEntry explains the missing mapping", () => {
  const dir = freshDir();
  assert.throws(() => requirePaneEntry(dir, "pane-9"), (error) => error.errorKind === "target" && /pane-9/.test(error.message));
  assert.throws(() => requirePaneEntry(dir, null), (error) => error.errorKind === "target" && /No focused pane/.test(error.message));
});

test("loadState rejects unsupported formats", () => {
  const dir = freshDir();
  mkdirSync(path.join(dir, "panes"));
  writeFileSync(path.join(dir, "panes", "x.json"), JSON.stringify({ version: 99, paneId: "x" }));
  assert.throws(() => loadState(dir), /unsupported format/);
  writeFileSync(path.join(dir, "panes", "x.json"), "nope");
  assert.throws(() => loadState(dir), /unreadable/);
});

test("entriesForLocalPath matches resolved and symlinked paths", () => {
  const state = { panes: { a: { localPath: "/repo/x/../x" }, b: { localPath: "/repo/y" }, c: {} } };
  assert.deepEqual(entriesForLocalPath(state, "/repo/x").map(([id]) => id), ["a"]);
  const dir = freshDir();
  mkdirSync(path.join(dir, "real"));
  symlinkSync(path.join(dir, "real"), path.join(dir, "alias"));
  const linked = { panes: { r: { localPath: path.join(dir, "real") } } };
  assert.deepEqual(entriesForLocalPath(linked, path.join(dir, "alias")).map(([id]) => id), ["r"]);
});

test("entriesForLocalPath still matches a removed worktree that was recorded under a symlinked prefix", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-state-"));
  const stateDir = path.join(dir, "state");
  mkdirSync(path.join(dir, "real"), { recursive: true });
  symlinkSync(path.join(dir, "real"), path.join(dir, "alias"));
  // The worktree existed when the mapping was written, so its canonical spelling was stored; now it is gone.
  savePaneEntry(stateDir, "pane-1", { sandboxName: "herdr-x-1", localPath: path.join(dir, "real", "gone"), workdir: path.join(dir, "real", "gone"), agentKind: "claude-code", workspaceMode: "mount", lifecycleState: "ready" });
  assert.deepEqual(entriesForLocalPath(loadState(stateDir), path.join(dir, "alias", "gone")).map(([paneId]) => paneId), ["pane-1"]);
  assert.deepEqual(entriesForLocalPath(loadState(stateDir), path.join(dir, "alias", "other")), []);
});
