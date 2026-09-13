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

test("the shim and the build script need nothing but shell builtins and pick the newest nvm node numerically", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-shim-"));
  copyFileSync(SHIM, path.join(dir, "run.sh"));
  writeFileSync(path.join(dir, "node-path"), `${process.execPath}\n`);
  const bare = spawnSync("/bin/sh", [path.join(dir, "run.sh"), "-p", "'builtins only'"], { encoding: "utf8", env: { PATH: "/nonexistent" } });
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout.trim(), "builtins only");
  assert.equal(bare.stderr, "", "no missing-command noise from dirname or head");

  const home = mkdtempSync(path.join(tmpdir(), "herdr-sbx-nvm-"));
  const fakeNode = (file, version) => {
    spawnSync("mkdir", ["-p", path.dirname(file)]);
    writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
    chmodSync(file, 0o755);
  };
  for (const version of ["v9.11.2", "v20.11.0", "v20.9.0", "not-a-version"]) {
    fakeNode(path.join(home, ".nvm", "versions", "node", version, "bin", "node"), version.replace(/^v/, ""));
  }
  const picked = spawnSync("/bin/sh", [path.join(ROOT, "scripts", "write-node-path.sh"), path.join(dir, "picked")], { encoding: "utf8", env: { PATH: "/nonexistent", HOME: home, HERDR_SBX_NODE_CANDIDATES: `${home}/none/node` } });
  assert.equal(picked.status, 0, picked.stderr);
  assert.equal(picked.stderr, "");
  assert.equal(readFileSync(path.join(dir, "picked"), "utf8").trim(), path.join(home, ".nvm", "versions", "node", "v20.11.0", "bin", "node"));
});

test("the build script skips a node that is too old and warns when nothing newer exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-old-node-"));
  const old = path.join(dir, "old", "node");
  spawnSync("mkdir", ["-p", path.dirname(old)]);
  writeFileSync(old, "#!/bin/sh\necho 12.22.12\n");
  chmodSync(old, 0o755);
  const newer = spawnSync("/bin/sh", [path.join(ROOT, "scripts", "write-node-path.sh"), path.join(dir, "node-path")], { encoding: "utf8", env: { PATH: "/nonexistent", HOME: dir, HERDR_SBX_NODE_CANDIDATES: `${old} ${process.execPath}` } });
  assert.equal(newer.status, 0, newer.stderr);
  assert.equal(newer.stderr, "");
  assert.equal(readFileSync(path.join(dir, "node-path"), "utf8").trim(), process.execPath, "an old node earlier in the list does not win");
  const onlyOld = spawnSync("/bin/sh", [path.join(ROOT, "scripts", "write-node-path.sh"), path.join(dir, "node-path")], { encoding: "utf8", env: { PATH: "/nonexistent", HOME: dir, HERDR_SBX_NODE_CANDIDATES: old } });
  assert.equal(onlyOld.status, 0, onlyOld.stderr);
  assert.match(onlyOld.stderr, /node 12\.22\.12 at .* is older than 20/);
  assert.equal(readFileSync(path.join(dir, "node-path"), "utf8").trim(), old, "recorded anyway so the user sees node's own error rather than none");
});

test("run-action.sh invokes an action and waits for its result line", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-run-action-"));
  const logs = path.join(dir, "logs.json");
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HERDR_BIN_PATH: path.join(ROOT, "test", "fakes", "herdr.mjs"), FAKE_HERDR_ACTION_LOGS: logs, FAKE_HERDR_LOG: path.join(dir, "herdr.log") };
  writeFileSync(logs, JSON.stringify([{ action_id: "info", status: "succeeded", stdout: 'HERDR_SANDBOX_RESULT: {"schemaVersion":1,"plugin":"sbx.sandbox","action":"info","ok":true,"paneId":"p1"}\nmore output\n', stderr: "pane p0 has no sandbox; using the workspace's only mapping\n" }]));
  const ok = spawnSync("sh", [path.join(ROOT, "scripts", "run-action.sh"), "info", "5"], { encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'HERDR_SANDBOX_RESULT: {"schemaVersion":1,"plugin":"sbx.sandbox","action":"info","ok":true,"paneId":"p1"}\n');
  assert.match(ok.stderr, /using the workspace's only mapping/);
  const calls = readFileSync(path.join(dir, "herdr.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line).argv.slice(0, 3).join(" "));
  assert.equal(calls[0], "plugin action invoke");
  writeFileSync(logs, JSON.stringify([{ action_id: "stop", status: "failed", stdout: 'HERDR_SANDBOX_RESULT: {"ok":false,"errorKind":"conflict","message":"busy"}\n', stderr: "" }, { action_id: "info", status: "succeeded", stdout: 'HERDR_SANDBOX_RESULT: {"ok":true}\n', stderr: "" }]));
  const failed = spawnSync("sh", [path.join(ROOT, "scripts", "run-action.sh"), "stop", "5"], { encoding: "utf8", env });
  assert.equal(failed.status, 1, "a result with ok:false exits 1");
  assert.match(failed.stdout, /"errorKind":"conflict"/);
  writeFileSync(logs, JSON.stringify([{ action_id: "forget-mapping", status: "running", stdout: "", stderr: "" }]));
  const timedOut = spawnSync("sh", [path.join(ROOT, "scripts", "run-action.sh"), "forget-mapping", "4"], { encoding: "utf8", env });
  assert.equal(timedOut.status, 2);
  assert.match(timedOut.stderr, /waiting for its popup/);
  assert.match(timedOut.stderr, /did not finish within 4 seconds/);
  assert.equal(spawnSync("sh", [path.join(ROOT, "scripts", "run-action.sh")], { encoding: "utf8", env }).status, 2, "usage error");
});
