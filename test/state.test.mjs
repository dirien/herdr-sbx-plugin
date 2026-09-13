import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deletePaneEntry, deletePaneEntryIfUnchanged, entriesForLocalPath, getPaneEntry, loadState, paneEntryPath, paneLockPath, processStartToken, requirePaneEntry, sandboxLockPath, savePaneEntry, updatePaneEntry, withPaneLock, withSandboxLocks } from "../src/state.mjs";

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

test("deletePaneEntryIfUnchanged only removes the entry the caller read", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-state-"));
  const entry = { sandboxName: "herdr-x-1", localPath: "/w", workdir: "/w", agentKind: "claude-code", workspaceMode: "mount", lifecycleState: "ready" };
  savePaneEntry(stateDir, "pane-1", entry);
  const seen = getPaneEntry(stateDir, "pane-1");
  savePaneEntry(stateDir, "pane-1", { ...seen, sandboxName: "herdr-x-2" });
  assert.equal(deletePaneEntryIfUnchanged(stateDir, "pane-1", seen), false, "rewritten since it was read, even within the same millisecond");
  assert.equal(getPaneEntry(stateDir, "pane-1").sandboxName, "herdr-x-2");
  const current = getPaneEntry(stateDir, "pane-1");
  assert.notEqual(current.revision, seen.revision);
  assert.equal(deletePaneEntryIfUnchanged(stateDir, "pane-1", current), true);
  assert.equal(getPaneEntry(stateDir, "pane-1"), null);
  assert.equal(deletePaneEntryIfUnchanged(stateDir, "pane-1", current), false, "already gone");
});

test("withPaneLock runs the callback under a lock file, breaks stale locks and gives up on a live one", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-lock-"));
  const lock = paneLockPath(stateDir, "pane-1");
  assert.equal(withPaneLock(stateDir, "pane-1", () => {
    assert.ok(existsSync(lock), "held while the callback runs");
    return 42;
  }), 42);
  assert.ok(!existsSync(lock), "released afterwards");
  assert.throws(() => withPaneLock(stateDir, "pane-1", () => { throw new Error("boom"); }), /boom/);
  assert.ok(!existsSync(lock), "released after a throw too");
  writeFileSync(lock, "2147483647\n");
  assert.equal(withPaneLock(stateDir, "pane-1", () => "broke the stale lock"), "broke the stale lock", "a lock whose owner is gone is taken over");
  writeFileSync(lock, `${process.pid}\n`);
  const started = Date.now();
  assert.throws(() => withPaneLock(stateDir, "pane-1", () => "never", { waitMs: 150 }), (error) => error.errorKind === "conflict" && /locked by process/.test(error.message));
  assert.ok(Date.now() - started >= 150, "waited for the live owner before giving up");
  assert.ok(existsSync(lock), "a live owner's lock is left alone");
});

test("the mapping lock is re-entrant and every writer and deleter takes it", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-lock-"));
  const lock = paneLockPath(stateDir, "pane-1");
  const entry = { sandboxName: "herdr-x-1", localPath: "/w", workdir: "/w", agentKind: "claude-code", workspaceMode: "mount", lifecycleState: "ready" };
  const seen = withPaneLock(stateDir, "pane-1", () => {
    const stored = savePaneEntry(stateDir, "pane-1", entry);
    assert.ok(existsSync(lock), "a save inside a locked section reuses the lock instead of waiting for it");
    return withPaneLock(stateDir, "pane-1", () => getPaneEntry(stateDir, "pane-1"));
  });
  assert.ok(!existsSync(lock));
  assert.equal(seen.sandboxName, "herdr-x-1");
  writeFileSync(lock, `${process.pid}\n`);
  assert.throws(() => savePaneEntry(stateDir, "pane-1", { ...entry, sandboxName: "herdr-x-2" }), (error) => error.errorKind === "conflict" && /locked by process/.test(error.message), "a save waits for a foreign live lock rather than racing it");
  assert.throws(() => deletePaneEntryIfUnchanged(stateDir, "pane-1", seen), (error) => error.errorKind === "conflict");
  assert.equal(getPaneEntry(stateDir, "pane-1").sandboxName, "herdr-x-1", "nothing changed while the lock was foreign");
});

test("updatePaneEntry reads and writes under the lock, so a concurrent bridge pid is never overwritten", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-lock-"));
  const lock = paneLockPath(stateDir, "pane-1");
  savePaneEntry(stateDir, "pane-1", { sandboxName: "herdr-x-1", localPath: "/w", workdir: "/w", agentKind: "claude-code", workspaceMode: "mount", lifecycleState: "ready" });
  writeFileSync(lock, `${process.pid}\n`);
  process.env.HERDR_SBX_LOCK_WAIT_MS = "150";
  try {
    assert.throws(() => updatePaneEntry(stateDir, "pane-1", { lifecycleState: "stopped" }), (error) => error.errorKind === "conflict", "the read waits for the lock, not only the write");
  } finally {
    delete process.env.HERDR_SBX_LOCK_WAIT_MS;
  }
  assert.equal(getPaneEntry(stateDir, "pane-1").lifecycleState, "ready");
});

test("two contenders reclaiming the same stale lock never hold it at the same time", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-lock-"));
  const lock = paneLockPath(stateDir, "pane-1");
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, "2147483647\n");
  const script = `
    import { withPaneLock } from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
    const [stateDir, paneId] = process.argv.slice(1);
    const held = withPaneLock(stateDir, paneId, () => {
      const start = Date.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return [start, Date.now()];
    });
    process.stdout.write(JSON.stringify(held));
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, "--", stateDir, "pane-1"], { encoding: "utf8" });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err}`))));
  });
  const [a, b] = await Promise.all([run(), run()]);
  const overlap = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  assert.ok(overlap <= 0, `the two hold intervals overlap by ${overlap}ms: ${JSON.stringify([a, b])}`);
  assert.ok(!existsSync(lock), "the lock is released at the end");
});

test("a stale lock is reclaimed even when a dead reclaimer left its guard behind", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-lock-"));
  const lock = paneLockPath(stateDir, "pane-1");
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, "2147483647\n");
  writeFileSync(`${lock}.reclaim`, "2147483646\n");
  assert.equal(withPaneLock(stateDir, "pane-1", () => "reclaimed"), "reclaimed");
  assert.ok(!existsSync(lock));
  assert.ok(!existsSync(`${lock}.reclaim`), "the abandoned guard is gone too");
  writeFileSync(lock, `${process.pid}\n`);
  writeFileSync(`${lock}.reclaim`, `${process.pid}\n`);
  process.env.HERDR_SBX_LOCK_WAIT_MS = "150";
  try {
    assert.throws(() => withPaneLock(stateDir, "pane-1", () => "never"), (error) => error.errorKind === "conflict", "a live owner's lock is never reclaimed");
  } finally {
    delete process.env.HERDR_SBX_LOCK_WAIT_MS;
  }
  assert.ok(existsSync(lock));
});

test("a lock whose pid was recycled is reclaimed, and a live reclaim guard never makes a waiter hang", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-lock-"));
  const lock = paneLockPath(stateDir, "pane-1");
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, `${process.pid} linux:0\n`);
  assert.equal(withPaneLock(stateDir, "pane-1", () => "reclaimed"), "reclaimed", "a live pid with a different start token is a different process");
  assert.ok(!existsSync(lock));
  writeFileSync(lock, "2147483647 -\n");
  writeFileSync(`${lock}.reclaim`, `${process.pid}\n`);
  const started = Date.now();
  let outcome;
  try {
    outcome = withPaneLock(stateDir, "pane-1", () => "acquired", { waitMs: 300 });
  } catch (error) {
    outcome = error.errorKind;
  }
  assert.ok(Date.now() - started < 5000, "the waiter returns, it does not spin forever");
  assert.ok(outcome === "acquired" || outcome === "conflict", `the wait ends one way or the other, got ${outcome}`);
});

test("process start tokens carry no whitespace, and a lock naming a live owner by its real token is honoured", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-lock-"));
  const lock = paneLockPath(stateDir, "pane-1");
  mkdirSync(path.dirname(lock), { recursive: true });
  const token = processStartToken(process.pid);
  assert.ok(token && !/\s/.test(token), `token is a single word: ${token}`);
  writeFileSync(lock, `${process.pid} ${token}\n`);
  process.env.HERDR_SBX_LOCK_WAIT_MS = "200";
  try {
    assert.throws(() => withPaneLock(stateDir, "pane-1", () => "never"), (error) => error.errorKind === "conflict", "our own live incarnation holds the lock, so it is not reclaimed");
  } finally {
    delete process.env.HERDR_SBX_LOCK_WAIT_MS;
  }
  assert.ok(existsSync(lock));
  writeFileSync(lock, `${process.pid} ps:Sun_Sep_13_12:34:56_2026\n`);
  assert.equal(withPaneLock(stateDir, "pane-1", () => "reclaimed"), "reclaimed", "a token from another incarnation, whatever its shape, marks the lock stale");
  // The same two-process contention as before, but with a lock that names a live owner in ps form on the wire.
  const script = `
    import { withPaneLock } from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
    const [stateDir, paneId] = process.argv.slice(1);
    const held = withPaneLock(stateDir, paneId, () => {
      const start = Date.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      return [start, Date.now()];
    });
    process.stdout.write(JSON.stringify(held));
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, "--", stateDir, "pane-1"], { encoding: "utf8" });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.ok(Math.min(a[1], b[1]) - Math.max(a[0], b[0]) <= 0, "no overlap between two live holders");
});

test("loadState skips a mapping removed during the listing but still reports a broken one", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-state-"));
  savePaneEntry(stateDir, "pane-1", { sandboxName: "herdr-x-1", localPath: "/w", workdir: "/w", agentKind: "claude-code", workspaceMode: "mount", lifecycleState: "ready" });
  const dir = path.join(stateDir, "panes");
  symlinkSync(path.join(dir, "vanished.json"), path.join(dir, "gone-0123456789.json"));
  assert.deepEqual(Object.keys(loadState(stateDir).panes), ["pane-1"], "a file that is gone by the time it is read is not an error");
  writeFileSync(path.join(dir, "broken-0123456789.json"), "{ not json");
  assert.throws(() => loadState(stateDir), (error) => error.errorKind === "startup" && /unreadable/.test(error.message));
});

test("withSandboxLocks takes one lock per sandbox in a fixed order and is re-entrant", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-lock-"));
  const names = ["herdr-b", "herdr-a", "herdr-a"];
  const result = withSandboxLocks(stateDir, names, () => {
    const held = readdirSync(path.join(stateDir, "panes")).filter((name) => name.startsWith("sandbox-") && name.endsWith(".lock")).sort();
    assert.equal(held.length, 2, "one lock per distinct sandbox");
    return withSandboxLocks(stateDir, ["herdr-a"], () => "nested");
  });
  assert.equal(result, "nested");
  assert.deepEqual(readdirSync(path.join(stateDir, "panes")).filter((name) => name.endsWith(".lock")), [], "all released");
  writeFileSync(sandboxLockPath(stateDir, "herdr-a"), `${process.pid} ${processStartToken(process.pid)}\n`);
  process.env.HERDR_SBX_LOCK_WAIT_MS = "150";
  try {
    assert.throws(() => withSandboxLocks(stateDir, ["herdr-a"], () => "never"), (error) => error.errorKind === "conflict" && /Sandbox herdr-a is locked by process/.test(error.message));
  } finally {
    delete process.env.HERDR_SBX_LOCK_WAIT_MS;
  }
});
