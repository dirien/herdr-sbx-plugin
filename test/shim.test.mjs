import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT, createFixture, runAction } from "./helpers.mjs";

const SHIM = path.join(ROOT, "bin", "run.sh");

function runShim(env, ...args) {
  return spawnSync("sh", [SHIM, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
}

test("the shim honors HERDR_SBX_NODE and falls back to node on PATH", () => {
  const preferred = runShim({ HERDR_SBX_NODE: process.execPath }, "-p", "process.execPath");
  assert.equal(preferred.status, 0, preferred.stderr);
  assert.equal(preferred.stdout.trim(), process.execPath);
  const fallback = runShim({ HERDR_SBX_NODE: "/definitely/missing/node" }, "-p", "'ok'");
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.stdout.trim(), "ok");
});

test("the shim reads bin/node-path written by the build script", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-shim-"));
  copyFileSync(SHIM, path.join(dir, "run.sh"));
  const wrote = spawnSync("sh", [path.join(ROOT, "scripts", "write-node-path.sh"), path.join(dir, "node-path")], { encoding: "utf8", env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` } });
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.equal(readFileSync(path.join(dir, "node-path"), "utf8").trim(), process.execPath);
  const result = spawnSync("sh", [path.join(dir, "run.sh"), "-p", "process.execPath"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.execPath);
  writeFileSync(path.join(dir, "node-path"), "/not/a/node\n");
  chmodSync(path.join(dir, "run.sh"), 0o755);
  const stale = spawnSync("sh", [path.join(dir, "run.sh"), "-p", "'fallback'"], { encoding: "utf8", env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.equal(stale.stdout.trim(), "fallback");
});

test("the build script exits 0 without node and says so", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-shim-"));
  const env = { PATH: "/nonexistent", HOME: dir, HERDR_SBX_NODE_CANDIDATES: `${dir}/none/node` };
  const result = spawnSync("/bin/sh", [path.join(ROOT, "scripts", "write-node-path.sh"), path.join(dir, "node-path")], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /node was not found/);
  const probed = spawnSync("/bin/sh", [path.join(ROOT, "scripts", "write-node-path.sh"), path.join(dir, "node-path")], { encoding: "utf8", env: { ...env, HERDR_SBX_NODE_CANDIDATES: `${dir}/none/node ${process.execPath}` } });
  assert.equal(probed.status, 0, probed.stderr);
  assert.equal(readFileSync(path.join(dir, "node-path"), "utf8").trim(), process.execPath);
});

test("the shim explains a missing node and still prints the result marker for actions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-shim-"));
  copyFileSync(SHIM, path.join(dir, "run.sh"));
  const result = spawnSync("/bin/sh", [path.join(dir, "run.sh"), "src/action.mjs"], { encoding: "utf8", env: { PATH: "/nonexistent", HERDR_PLUGIN_ACTION_ID: "doctor" } });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /write-node-path\.sh/);
  assert.ok(result.stdout.startsWith('HERDR_SANDBOX_RESULT: {"schemaVersion":1,"plugin":"sbx.sandbox","action":"doctor","ok":false,"errorKind":"startup"'), result.stdout);
  const byName = spawnSync("/bin/sh", [path.join(dir, "run.sh"), "-p", "'named'"], { encoding: "utf8", env: { PATH: path.dirname(process.execPath), HERDR_SBX_NODE: path.basename(process.execPath) } });
  assert.equal(byName.stdout.trim(), "named");
});

test("actions run end to end through the shim as the manifest declares", () => {
  const f = createFixture();
  const result = spawnSync("sh", [SHIM, path.join(ROOT, "src", "action.mjs")], { cwd: ROOT, encoding: "utf8", env: f.env({ HERDR_PLUGIN_ACTION_ID: "doctor", HERDR_PLUGIN_CONTEXT_JSON: "{}", HERDR_SBX_NODE: process.execPath }) });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith("HERDR_SANDBOX_RESULT:"));
  assert.equal(runAction(f, "doctor").result.ok, true);
  f.cleanup();
});
