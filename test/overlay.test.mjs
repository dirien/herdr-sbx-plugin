import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { hyperlink, parseSandboxPortUrl, sandboxPortUrl } from "../src/links.mjs";
import { openUrl, openerCommand } from "../src/open.mjs";
import { renderSandboxes } from "../src/sandboxes-pane-main.mjs";
import { normalizePortList, parsePortSpec } from "../src/sbx.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { collectSandboxes, createOverlayClients, runCli, runSandboxesPane } from "../src/sandboxes-pane-main.mjs";
import { writeFileSync } from "node:fs";
import { bridgeCommand } from "../src/action-main.mjs";
import { FAKE_HERDR, FAKE_OPENER, FAKE_SBX, ROOT, createFixture, mappingFor } from "./helpers.mjs";

const NAME = "herdr-claude-code-abc123def456";
const ESC = String.fromCharCode(27);

test("sandbox port links round-trip and reject junk", () => {
  assert.equal(sandboxPortUrl(NAME, 3000), `sbx://${NAME}/3000`);
  assert.deepEqual(parseSandboxPortUrl(`sbx://${NAME}/3000`), { sandboxName: NAME, port: 3000 });
  assert.equal(parseSandboxPortUrl("sbx://bad name/1"), null);
  assert.equal(parseSandboxPortUrl(`sbx://${NAME}/70000`), null);
  assert.equal(parseSandboxPortUrl("http://localhost:3000"), null);
  assert.throws(() => sandboxPortUrl(NAME, 0), RangeError);
  assert.equal(hyperlink("sbx://a/1", "text"), `${ESC}]8;;sbx://a/1${ESC}\\text${ESC}]8;;${ESC}\\`);
});

test("normalizePortList accepts several field spellings and docker-style specs", () => {
  const rows = normalizePortList({ ports: [
    { host_port: 8080, sandbox_port: 3000 },
    { hostPort: "9000", containerPort: "80" },
    { published: "127.0.0.1:8443", target: 443 },
    { published: "8081:3001/tcp" },
    { spec: "0.0.0.0:8082:3002/udp" },
    { port: 22 },
  ] });
  assert.deepEqual(rows.map((item) => [item.hostPort, item.sandboxPort]), [[8080, 3000], [9000, 80], [8443, 443], [8081, 3001], [8082, 3002], [null, 22]]);
  assert.deepEqual(normalizePortList(null), []);
  assert.deepEqual(normalizePortList({ ports: [] }), []);
  assert.deepEqual(normalizePortList({ ports: null }), [], "a nil Go slice marshals to null");
  assert.deepEqual(normalizePortList({ items: null }), []);
  assert.deepEqual(normalizePortList([{ sandbox_port: 70000 }, { sandbox_port: 3000 }]).map((item) => item.sandboxPort), [3000]);
  assert.throws(() => normalizePortList({ published_ports: [] }), (error) => error.errorKind === "unknown");
  assert.throws(() => normalizePortList([{ nothing: 1 }]), (error) => error.errorKind === "unknown" && /recognizable sandbox port/.test(error.message));
});

test("parsePortSpec follows the sbx publish syntax", () => {
  assert.deepEqual(parsePortSpec("8080:3000"), { hostPort: 8080, sandboxPort: 3000, single: null, address: null });
  assert.deepEqual(parsePortSpec("127.0.0.1:8080:3000/tcp"), { hostPort: 8080, sandboxPort: 3000, single: null, address: "127.0.0.1" });
  assert.deepEqual(parsePortSpec("3000"), { hostPort: null, sandboxPort: null, single: 3000, address: null });
  assert.deepEqual(parsePortSpec(443), { hostPort: null, sandboxPort: null, single: 443, address: null });
  assert.deepEqual(parsePortSpec("a:b:c:d"), null);
  assert.deepEqual(parsePortSpec("127.0.0.1:8443"), { hostPort: null, sandboxPort: null, single: 8443, address: "127.0.0.1" });
  assert.deepEqual(parsePortSpec(true), null);
});

test("openerCommand and openUrl use the override and report failures", async () => {
  assert.equal(openerCommand({}, "darwin"), "open");
  assert.equal(openerCommand({}, "linux"), "xdg-open");
  assert.equal(openerCommand({ HERDR_SBX_OPENER: "/x/opener" }, "darwin"), "/x/opener");
  const missing = await openUrl("http://localhost:1", { HERDR_SBX_OPENER: "/definitely/missing/opener" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ENOENT/);
  const ok = await openUrl("http://localhost:1", { PATH: process.env.PATH, HERDR_SBX_OPENER: FAKE_OPENER });
  assert.equal(ok.ok, true);
  const failing = await openUrl("http://localhost:1", { PATH: process.env.PATH, HERDR_SBX_OPENER: FAKE_OPENER, FAKE_OPENER_EXIT: "3" });
  assert.deepEqual([failing.ok, failing.error], [false, `${FAKE_OPENER} exited with 3`]);
});

test("openUrl does not wait for an opener that runs the browser in the foreground", async () => {
  const f = createFixture();
  const foreground = path.join(f.root, "browser.sh");
  writeFileSync(foreground, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const started = Date.now();
  const running = await openUrl("http://localhost:1", { PATH: process.env.PATH, HERDR_SBX_OPENER: foreground }, { graceMs: 100 });
  assert.equal(running.ok, true, "an opener still running after the grace period is showing the page");
  assert.ok(Date.now() - started < 3000, "the action did not wait for the browser to exit");
  f.cleanup();
});

test("renderSandboxes prints a table with pane, status and port links", () => {
  const rows = [
    { paneId: "wA:p2", paneExists: true, sandboxName: NAME, agentKind: "claude-code", lifecycleState: "ready", exists: true, status: "running", localPath: "/repo", ports: [{ hostPort: 8080, sandboxPort: 3000 }], portsError: null },
    { paneId: "wB:p2", paneExists: false, sandboxName: "herdr-codex-000000000000", agentKind: "codex", lifecycleState: "stopped", exists: false, status: null, localPath: "/other", ports: [], portsError: null },
  ];
  const lines = renderSandboxes({ rows, sandboxError: null }, { at: new Date(0), links: true });
  assert.match(lines[0], /2 mappings/);
  assert.ok(lines[3].includes(hyperlink(`sbx://${NAME}/3000`, "8080->3000")));
  assert.match(lines[4], /wB:p2 \(gone\)/);
  assert.match(lines[4], /MISSING/);
  assert.ok(lines.some((line) => /1 stale mapping \(pane gone, sandbox missing\): run prune-mappings/.test(line)), lines.join("\n"));
  const plain = renderSandboxes({ rows, sandboxError: "daemon down" }, { links: false });
  assert.ok(plain[3].includes("8080->3000") && !plain[3].includes(ESC));
  assert.match(plain.at(-1), /sbx ls failed: daemon down/);
  assert.match(renderSandboxes({ rows: [], sandboxError: null })[2], /No sandboxes are mapped/);
});

test("collectSandboxes degrades per row when sbx or herdr fail", async () => {
  const f = createFixture({ panes: (p) => ({ "wA:p2": mappingFor({ worktree: p.worktree }, { paneId: "wA:p2" }) }) });
  const sbxDown = { async listSandboxes() { throw new Error("daemon down"); }, async listPorts() { throw new Error("unused"); } };
  const herdrDown = { async listPaneIds() { throw new Error("socket gone"); } };
  const data = await collectSandboxes({ stateDir: f.stateDir, sbx: sbxDown, herdr: herdrDown });
  assert.equal(data.sandboxError, "daemon down");
  assert.equal(data.rows[0].exists, null);
  assert.equal(data.rows[0].paneExists, null);
  assert.equal(data.rows[0].paneError, "socket gone");
  assert.deepEqual(data.rows[0].ports, []);
  const portsDown = { listSandboxes: async () => [{ name: NAME, status: "running" }], async listPorts() { throw new Error("no ports api"); } };
  const cache = new Map();
  const first = await collectSandboxes({ stateDir: f.stateDir, sbx: portsDown, herdr: { listPaneIds: async () => ["wA:p2"] }, cache });
  assert.equal(first.rows[0].portsError, "no ports api");
  let calls = 0;
  const counting = { listSandboxes: async () => [{ name: NAME, status: "running" }], async listPorts() { calls += 1; return [{ hostPort: 1, sandboxPort: 2 }]; } };
  await collectSandboxes({ stateDir: f.stateDir, sbx: counting, herdr: { listPaneIds: async () => ["wA:p2"] }, cache, refreshPorts: true });
  const cachedFrame = await collectSandboxes({ stateDir: f.stateDir, sbx: counting, herdr: { listPaneIds: async () => ["wA:p2"] }, cache, refreshPorts: false });
  assert.equal(calls, 1, "cached ports are reused when refreshPorts is false");
  assert.equal(cachedFrame.rows[0].paneExists, true);
  const vanished = { listSandboxes: async () => [], async listPorts() { throw new Error("unused"); } };
  const gone = await collectSandboxes({ stateDir: f.stateDir, sbx: vanished, herdr: { listPaneIds: async () => [] }, cache, refreshPorts: false });
  assert.equal(gone.rows[0].exists, false);
  assert.equal(gone.rows[0].paneExists, false);
  assert.deepEqual(gone.rows[0].ports, [], "cached ports are dropped once the sandbox is gone");
  const lines = renderSandboxes(data, { links: false });
  assert.match(lines.at(-1), /sbx ls failed: daemon down/);
  assert.ok(lines.some((line) => /pane check failed: wA:p2: socket gone/.test(line)));
  f.cleanup();
});

test("runCli kills a hung command on abort and on timeout", async () => {
  const controller = new AbortController();
  const hung = runCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal, timeoutMs: 30_000 });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(hung, (error) => error.errorKind === "cancelled");
  await assert.rejects(runCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }), (error) => error.errorKind === "network" && /did not answer/.test(error.message));
  await assert.rejects(runCli("/definitely/missing/bin", []), (error) => error.errorKind === "startup");
  const ok = await runCli(process.execPath, ["-e", "process.stdout.write('hi')"]);
  assert.deepEqual([ok.status, ok.stdout], [0, "hi"]);
  // 90 kB of a three-byte character: pipe chunks split it mid-sequence, which byte-wise concatenation would garble.
  const wide = await runCli(process.execPath, ["-e", "process.stdout.write('\u20ac'.repeat(30000))"]);
  assert.equal(wide.stdout, "\u20ac".repeat(30000));
});

test("the overlay clients parse like the synchronous ones", async () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running", ports: [{ host_port: 8080, sandbox_port: 3000 }] }] });
  const { sbx, herdr } = createOverlayClients({ sbxBin: FAKE_SBX, herdrBin: FAKE_HERDR, env: f.env({ FAKE_HERDR_MISSING_PANES: "wA:p2" }) });
  assert.deepEqual((await sbx.listSandboxes()).map((item) => [item.name, item.status]), [[NAME, "running"]]);
  assert.deepEqual((await sbx.listPorts(NAME)).map((item) => [item.hostPort, item.sandboxPort]), [[8080, 3000]]);
  assert.equal(await herdr.getPane("wA:p2", null), null, "missing panes resolve to null");
  assert.equal(typeof (await createOverlayClients({ sbxBin: FAKE_SBX, herdrBin: FAKE_HERDR, env: f.env({ FAKE_HERDR_MISSING_PANES: "" }) }).herdr.getPane("wA:p2")), "object");
  await assert.rejects(createOverlayClients({ sbxBin: FAKE_SBX, herdrBin: FAKE_HERDR, env: f.env({ FAKE_SBX_FAIL: "ls:daemon" }) }).sbx.listSandboxes(), (error) => error.errorKind === "daemon");
  f.cleanup();
});

test("a keypress closes the overlay even while a command hangs", async () => {
  const f = createFixture({ panes: (p) => ({ "wA:p2": mappingFor({ worktree: p.worktree }, { paneId: "wA:p2" }) }) });
  const hangingSbx = path.join(f.root, "hang.sh");
  writeFileSync(hangingSbx, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
  // A shell wrapper whose child keeps the pipes open is exactly the case the overlay must survive.
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const output = new PassThrough();
  output.on("data", () => {});
  const started = Date.now();
  const running = runSandboxesPane(f.env({ HERDR_PLUGIN_ENTRYPOINT_ID: "sandboxes", HERDR_SBX_BIN: hangingSbx }), { intervalMs: 40, input, output });
  await new Promise((resolve) => setTimeout(resolve, 150));
  input.emit("data", "q");
  assert.equal(await running, 0);
  assert.ok(Date.now() - started < 5000, "did not wait for the hung command");
  f.cleanup();
});

test("the overlay loop redraws until q and restores the terminal", async () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "wA:p2": mappingFor({ worktree: p.worktree }, { paneId: "wA:p2" }) }) });
  const input = new EventEmitter();
  const modes = [];
  input.isTTY = true;
  input.setRawMode = (value) => modes.push(value);
  input.resume = () => {};
  input.pause = () => {};
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });
  const running = runSandboxesPane(f.env({ HERDR_PLUGIN_ENTRYPOINT_ID: "sandboxes" }), { intervalMs: 40, input, output });
  await new Promise((resolve) => setTimeout(resolve, 900));
  input.emit("data", "qx");
  input.emit("data", "q");
  const code = await running;
  assert.equal(code, 0);
  assert.deepEqual(modes, [true, false]);
  assert.ok((text.match(/Docker Sandboxes/g) ?? []).length >= 2, "redrew at least twice");
  assert.ok(text.includes(NAME));
  f.cleanup();
});

test("bridgeCommand quotes a herdr path with spaces", () => {
  const command = bridgeCommand({ pluginEnv: { pluginRoot: "/plugin", stateDir: "/s", configDir: "/c", herdrBin: "/opt/my tools/herdr" }, mode: "connect", paneId: "p1", sbxBin: "/opt/docker bin/sbx", launchId: "id1" });
  assert.ok(command.endsWith("--herdr-bin '/opt/my tools/herdr' --sbx-bin '/opt/docker bin/sbx' --launch-id id1"), command);
});

test("the overlay holds an error on screen until a key is pressed", async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });
  const running = runSandboxesPane({ PATH: process.env.PATH }, { input, output, holdMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(text, /HERDR_PLUGIN_STATE_DIR/);
  assert.match(text, /press any key to close/);
  input.emit("data", "x");
  assert.equal(await running, 1);
});

test("the overlay entry point renders one frame with --once", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running", ports: [{ host_port: 8080, sandbox_port: 3000 }] }], panes: (p) => ({ "wA:p2": mappingFor({ worktree: p.worktree }, { paneId: "wA:p2" }) }) });
  const result = spawnSync(process.execPath, [path.join(ROOT, "src", "sandboxes-pane.mjs"), "--once"], { cwd: ROOT, encoding: "utf8", env: f.env({ HERDR_PLUGIN_ENTRYPOINT_ID: "sandboxes" }) });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(NAME));
  assert.ok(result.stdout.includes("running"));
  assert.ok(result.stdout.includes(`sbx://${NAME}/3000`));
  assert.ok(result.stdout.includes(f.worktree));
  const noDirs = spawnSync(process.execPath, [path.join(ROOT, "src", "sandboxes-pane.mjs"), "--once"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(noDirs.status, 1);
  assert.match(noDirs.stdout, /HERDR_PLUGIN_STATE_DIR/);
  f.cleanup();
});
