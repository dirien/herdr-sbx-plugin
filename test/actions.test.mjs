import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { parseResultLine } from "../src/result.mjs";
import { bridgeStartTimeout, entryCwd, keepBranchCommand } from "../src/action-main.mjs";
import path from "node:path";
import { test } from "node:test";
import { FAKE_HERDR, ROOT, createFixture, fakeActionProcess, fakeBridgeProcess, fakeShellProcess, git, mappingFor, runAction } from "./helpers.mjs";

const NAME = "herdr-claude-code-abc123def456";

test("doctor reports the sbx version and daemon with the marker first", () => {
  const f = createFixture();
  const { status, result, stdout } = runAction(f, "doctor");
  assert.equal(status, 0);
  assert.equal(result.ok, true);
  assert.equal(result.action, "doctor");
  assert.equal(result.version.server.version, "0.42.1");
  assert.equal(result.versionWarning, null);
  assert.ok(result.daemon);
  assert.equal(result.stateDir, f.stateDir);
  assert.equal(result.configDir, f.configDir);
  assert.equal(result.node, process.execPath);
  assert.match(stdout, /state dir: /);
  assert.ok(stdout.split("\n")[0].startsWith("HERDR_SANDBOX_RESULT:"));
  assert.match(stdout, /sbx version: 0\.42\.1/);
  f.cleanup();
});

test("doctor fails with a startup kind when sbx is missing", () => {
  const f = createFixture({ config: { sbxBin: "/nope/sbx" } });
  const { status, result } = runAction(f, "doctor");
  assert.equal(status, 1);
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "startup");
  f.cleanup();
});

test("doctor classifies a daemon failure", () => {
  const f = createFixture();
  const { result } = runAction(f, "doctor", { env: { FAKE_SBX_FAIL: "version:daemon" } });
  assert.equal(result.errorKind, "daemon");
  const statusOnly = runAction(f, "doctor", { env: { FAKE_SBX_FAIL: "daemon:generic" } });
  assert.equal(statusOnly.status, 1);
  assert.equal(statusOnly.result.ok, false);
  assert.equal(statusOnly.result.errorKind, "daemon");
  assert.match(statusOnly.result.message, /sbx daemon start/);
  f.cleanup();
});

test("doctor warns about an sbx release older than the one the plugin targets", () => {
  const f = createFixture();
  const { result, stdout } = runAction(f, "doctor", { env: { FAKE_SBX_VERSION: "0.39.0" } });
  assert.equal(result.ok, true);
  assert.match(result.versionWarning, /0\.39\.0 is older than 0\.42\.0/);
  assert.match(stdout, /warning: sbx 0\.39\.0/);
  assert.equal(runAction(f, "doctor", { env: { FAKE_SBX_VERSION: "1.0.0" } }).result.versionWarning, null);
  f.cleanup();
});

test("start-agent opens a tab when openIn is tab", () => {
  const f = createFixture({ config: { openIn: "tab" } });
  const { result } = runAction(f, "start-agent", { context: { focused_pane_id: "wA:p1", workspace_id: "wA", workspace_cwd: f.worktree } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.openIn, "tab");
  const calls = f.herdrCalls();
  assert.equal(calls[0][0], "tab");
  assert.deepEqual(calls[0].slice(0, 6), ["tab", "create", "--workspace", "wA", "--cwd", f.worktree]);
  assert.ok(calls[0].includes("--label"));
  assert.ok(!calls.some((call) => call[1] === "split"));
  assert.equal(calls.find((call) => call[1] === "run")[2], "pane-new-1");
  assert.ok(calls.find((call) => call[1] === "run")[3].includes(`--herdr-bin ${FAKE_HERDR}`));
  f.cleanup();
});

test("prune-mappings drops mappings whose pane and sandbox are both gone and keeps the rest", () => {
  const f = createFixture({
    sandboxes: [{ name: NAME, status: "stopped" }, { name: "herdr-codex-333333333333", status: "running" }],
    panes: (p) => ({
      "wP:p3": mappingFor({ worktree: p.worktree }, { paneId: "wP:p3", sandboxName: "herdr-claude-code-111111111111" }),
      "wP:p4": mappingFor({ worktree: p.worktree }, { paneId: "wP:p4", sandboxName: "herdr-claude-code-222222222222" }),
      "wP:p5": mappingFor({ worktree: p.worktree }, { paneId: "wP:p5", sandboxName: NAME }),
      "wQ:p3": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p3", sandboxName: "herdr-codex-444444444444", replacesSandboxNames: ["herdr-codex-333333333333"] }),
      "wQ:p4": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p4", sandboxName: "herdr-codex-555555555555" }),
    }),
  });
  const { result, stdout } = runAction(f, "prune-mappings", { env: { FAKE_HERDR_MISSING_PANES: "wP:p3,wP:p4,wP:p5", FAKE_POPUP_DECISION: "cancelled" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.pruned.map((item) => item.paneId).sort(), ["wP:p3", "wP:p4"]);
  assert.deepEqual(result.kept.map((item) => [item.paneId, item.reason.split(":")[0]]).sort(), [["wP:p5", "sandbox still exists"], ["wQ:p4", "pane still open"]]);
  assert.equal(result.orphansConfirmed, false);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(Object.keys(f.mappings().panes).sort(), ["wP:p5", "wQ:p3", "wQ:p4"]);
  assert.match(stdout, /pruned 2 mappings/);
  assert.match(stdout, /kept 1 orphaned sandbox \(deletion not confirmed\)/);
  assert.deepEqual(f.sbxCalls(), [["ls", "--json"]]);
  const popup = f.herdrCalls().find((call) => call[0] === "plugin");
  assert.ok(popup, "the popup was opened for the orphan");
  const confirmed = runAction(f, "prune-mappings", { env: { FAKE_HERDR_MISSING_PANES: "wP:p3,wP:p4,wP:p5", FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(confirmed.result.orphansConfirmed, true);
  assert.deepEqual(confirmed.result.deleted, [NAME]);
  assert.deepEqual(Object.keys(f.mappings().panes).sort(), ["wQ:p3", "wQ:p4"]);
  assert.ok(f.sbxCalls().some((call) => call.join(" ") === `rm --force ${NAME}`));
  const nothing = runAction(f, "prune-mappings", { env: { FAKE_HERDR_MISSING_PANES: "wP:p3,wP:p4,wP:p5" } });
  assert.equal(nothing.result.orphansConfirmed, null, "no popup when there is no orphan");
  const down = runAction(f, "prune-mappings", { env: { FAKE_SBX_FAIL: "ls:daemon" } });
  assert.equal(down.result.errorKind, "daemon");
  f.cleanup();
});

test("sandboxes opens the overlay pane", () => {
  const f = createFixture();
  const { result } = runAction(f, "sandboxes");
  assert.equal(result.ok, true);
  assert.deepEqual(f.herdrCalls()[0], ["plugin", "pane", "open", "--plugin", "sbx.sandbox", "--entrypoint", "sandboxes", "--focus"]);
  f.cleanup();
});

test("open-port opens the browser for a clicked sbx:// link", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running", ports: [{ host_port: 8080, sandbox_port: 3000 }] }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result, stdout } = runAction(f, "open-port", { context: { invocation_source: "link_click", clicked_url: `sbx://${NAME}/3000` } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.sandboxPort, result.hostPort, result.url, result.opened], [3000, 8080, "http://localhost:8080", true]);
  assert.deepEqual(f.openedUrls(), ["http://localhost:8080"]);
  assert.match(stdout, /http:\/\/localhost:8080/);
  assert.deepEqual(f.sbxCalls(), [["ports", NAME, "--json"]]);
  f.cleanup();
});

test("open-port falls back to the focused sandbox's first port and reports opener failures", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running", ports: [{ host_port: 8081, sandbox_port: 5173 }] }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "open-port", { context: { focused_pane_id: "pane-1" } });
  assert.equal(result.url, "http://localhost:8081");
  const failed = runAction(f, "open-port", { context: { focused_pane_id: "pane-1" }, env: { FAKE_OPENER_EXIT: "1" } });
  assert.equal(failed.result.ok, true);
  assert.equal(failed.result.opened, false);
  const noPorts = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  assert.equal(runAction(noPorts, "open-port", { context: { focused_pane_id: "pane-1" } }).result.errorKind, "target");
  const badLink = runAction(f, "open-port", { context: { clicked_url: "sbx://nope" } });
  assert.equal(badLink.result.errorKind, "target");
  noPorts.cleanup();
  f.cleanup();
});

test("open-port refuses links to sandboxes the plugin does not track and to unpublished ports", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running", ports: [{ host_port: 8080, sandbox_port: 3000 }] }, { name: "herdr-codex-000000000000", status: "running", ports: [{ host_port: 9999, sandbox_port: 80 }] }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const untracked = runAction(f, "open-port", { context: { clicked_url: "sbx://herdr-codex-000000000000/80" } });
  assert.equal(untracked.result.errorKind, "target");
  assert.match(untracked.result.message, /not managed by this plugin/);
  const unpublished = runAction(f, "open-port", { context: { clicked_url: `sbx://${NAME}/4000` } });
  assert.equal(unpublished.result.errorKind, "target");
  assert.match(unpublished.result.message, /does not publish port 4000/);
  const dashed = runAction(f, "open-port", { context: { clicked_url: "sbx://--help/1" } });
  assert.equal(dashed.result.errorKind, "target");
  assert.deepEqual(f.openedUrls(), []);
  assert.ok(!f.sbxCalls().some((call) => call[1] === "--help"), "no flag-like sandbox name reached sbx");
  f.cleanup();
});

test("a transient herdr failure never turns a live mapping into an orphan", () => {
  const f = createFixture({ panes: (p) => ({ "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC" }) }) });
  const { result } = runAction(f, "reconnect", { context: { focused_pane_id: "wP:p1", workspace_id: "wP" }, env: { FAKE_HERDR_FAIL: "pane list" } });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "unknown");
  assert.deepEqual(Object.keys(f.mappings().panes), ["wC:p2"]);
  assert.ok(!f.herdrCalls().some((call) => call[1] === "split" || call[1] === "run"));
  f.cleanup();
});

test("info lists published ports with links", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running", ports: [{ host_port: 8080, sandbox_port: 3000 }] }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result, stdout } = runAction(f, "info", { context: { focused_pane_id: "pane-1" } });
  assert.deepEqual(result.ports, [{ hostPort: 8080, sandboxPort: 3000, url: "http://localhost:8080", link: `sbx://${NAME}/3000` }]);
  assert.equal(result.portsError, null);
  assert.ok(stdout.includes(`sbx://${NAME}/3000`));
  f.cleanup();
});

test("start-agent honors paneDirection and sandboxNamePrefix", () => {
  const f = createFixture({ config: { paneDirection: "down", sandboxNamePrefix: "team" } });
  const { result } = runAction(f, "start-agent", { context: { focused_pane_id: "pane-0", workspace_cwd: f.worktree } });
  assert.equal(result.ok, true);
  assert.match(result.sandboxName, /^team-claude-code-[a-f0-9]{12}$/);
  assert.deepEqual(f.herdrCalls()[0].slice(0, 5), ["pane", "split", "pane-0", "--direction", "down"]);
  f.cleanup();
});

test("the bootstrap prints a startup failure when the dispatcher cannot load", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-bootstrap-"));
  copyFileSync(path.join(ROOT, "src", "action.mjs"), path.join(dir, "action.mjs"));
  const result = spawnSync(process.execPath, [path.join(dir, "action.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH, HERDR_PLUGIN_ACTION_ID: "doctor" } });
  assert.equal(result.status, 1);
  const parsed = parseResultLine(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errorKind, "startup");
  assert.equal(parsed.action, "doctor");
  assert.ok(result.stdout.startsWith("HERDR_SANDBOX_RESULT:"));
  assert.match(result.stderr, /action-main/);
});

test("start-agent splits a pane, stores a provisional mapping and runs the bridge", () => {
  const f = createFixture({ config: { agentKind: "codex", paneRatio: 0.4 } });
  const { status, result } = runAction(f, "start-agent", { context: { focused_pane_id: "pane-0", focused_pane_cwd: f.worktree }, env: { FAKE_HERDR_BRIDGE_STARTS: "0" } });
  assert.equal(status, 0);
  assert.equal(result.ok, true);
  assert.equal(result.paneId, "pane-new-1");
  assert.equal(result.sourcePaneId, "pane-0");
  assert.match(result.sandboxName, /^herdr-codex-[a-f0-9]{12}$/);
  assert.equal(result.workspaceMode, "mount");
  const calls = f.herdrCalls();
  assert.deepEqual(calls[0], ["pane", "split", "pane-0", "--direction", "right", "--ratio", "0.4", "--cwd", f.worktree, "--focus"]);
  assert.deepEqual(calls[1].slice(0, 3), ["pane", "rename", "pane-new-1"]);
  assert.match(calls[1][3], /^sbx codex [a-f0-9]{6}$/);
  assert.deepEqual(calls[2].slice(0, 3), ["pane", "run", "pane-new-1"]);
  const command = calls[2][3];
  assert.ok(command.startsWith("env HERDR_AGENT=codex "), command);
  assert.ok(command.includes(`${path.join(ROOT, "src", "bridge.mjs")} start --state-dir `), command);
  assert.ok(command.includes("--pane-id pane-new-1"), command);
  assert.deepEqual(calls[3].slice(0, 3), ["notification", "show", "Docker Sandbox starting"]);
  const mapping = f.mappings().panes["pane-new-1"];
  assert.equal(mapping.lifecycleState, "provisional");
  assert.equal(mapping.sandboxName, result.sandboxName);
  assert.equal(mapping.agentKind, "codex");
  assert.equal(mapping.sbxAgent, "codex");
  assert.equal(mapping.localPath, f.worktree);
  assert.equal(mapping.workdir, f.worktree);
  assert.equal(mapping.workspaceId, null);
  assert.deepEqual(mapping.replacesSandboxNames, []);
  assert.deepEqual(f.sbxCalls(), [["version", "--json"]]);
  f.cleanup();
});

test("start-agent mounts the workspace root and starts the agent in the pane's subdirectory", () => {
  const f = createFixture();
  const sub = path.join(f.worktree, "src");
  mkdirSync(sub);
  const { result } = runAction(f, "start-agent", { context: { focused_pane_id: "pane-0", focused_pane_cwd: sub, workspace_cwd: f.worktree } });
  assert.equal(result.ok, true);
  assert.equal(result.localPath, f.worktree);
  assert.equal(result.workdir, sub);
  assert.deepEqual(f.herdrCalls()[0].slice(-3), ["--cwd", sub, "--focus"]);
  const outside = runAction(f, "start-agent", { context: { focused_pane_id: "pane-0", focused_pane_cwd: f.root, workspace_cwd: f.worktree } });
  assert.equal(outside.result.localPath, f.worktree);
  assert.equal(outside.result.workdir, f.worktree);
  f.cleanup();
});

test("start-agent finds the git root when only the pane directory is known", () => {
  const f = createFixture();
  const sub = path.join(f.worktree, "pkg");
  mkdirSync(sub);
  const { result } = runAction(f, "start-agent", { context: { focused_pane_id: "pane-0", focused_pane_cwd: sub } });
  assert.equal(result.ok, true);
  assert.equal(result.localPath, f.worktree);
  assert.equal(result.workdir, sub);
  f.cleanup();
});

test("start-agent refuses to mount the home directory or the filesystem root", () => {
  const f = createFixture();
  const home = runAction(f, "start-agent", { context: { workspace_cwd: f.root }, env: { HOME: f.root } });
  assert.equal(home.result.errorKind, "target");
  assert.match(home.result.message, /Refusing/);
  const root = runAction(f, "start-agent", { context: { workspace_cwd: "/" } });
  assert.equal(root.result.errorKind, "target");
  assert.deepEqual(f.herdrCalls(), []);
  f.cleanup();
});

test("start-agent keeps a stale mapping's sandboxes deletable when Herdr reuses a pane id", () => {
  const f = createFixture({ panes: () => ({ "pane-new-1": { sandboxName: "old-sandbox", agentKind: "claude-code", sbxAgent: "claude", localPath: "/gone", workspaceMode: "mount", lifecycleState: "ready", replacesSandboxNames: ["older-sandbox"], deletedSandboxNames: ["older-sandbox"] } }) });
  const { result, stderr } = runAction(f, "start-agent", { context: { focused_pane_id: "pane-0", workspace_cwd: f.worktree } });
  assert.equal(result.ok, true);
  assert.equal(result.paneId, "pane-new-1");
  assert.deepEqual(result.previousSandboxNames, ["old-sandbox", "older-sandbox"]);
  assert.match(stderr, /previously mapped to old-sandbox/);
  const mapping = f.mappings().panes["pane-new-1"];
  assert.equal(mapping.sandboxName, result.sandboxName);
  assert.deepEqual(mapping.replacesSandboxNames, ["old-sandbox", "older-sandbox"]);
  assert.deepEqual(mapping.deletedSandboxNames, ["older-sandbox"]);
  f.cleanup();
});

test("start-agent falls back to workspace_cwd and omits the split target without a pane", () => {
  const f = createFixture();
  const { result } = runAction(f, "start-agent", { context: { workspace_cwd: f.worktree } });
  assert.equal(result.ok, true);
  assert.equal(result.sourcePaneId, null);
  assert.deepEqual(f.herdrCalls()[0].slice(0, 4), ["pane", "split", "--direction", "right"]);
  f.cleanup();
});

test("start-agent needs an existing workspace directory", () => {
  const f = createFixture();
  assert.equal(runAction(f, "start-agent", { context: {} }).result.errorKind, "target");
  assert.equal(runAction(f, "start-agent", { context: { workspace_cwd: "/does/not/exist" } }).result.errorKind, "target");
  assert.deepEqual(f.herdrCalls(), []);
  f.cleanup();
});

test("start-agent surfaces herdr split failures without leaving a mapping", () => {
  const f = createFixture();
  const { result } = runAction(f, "start-agent", { context: { workspace_cwd: f.worktree }, env: { FAKE_HERDR_FAIL: "pane split" } });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "unknown");
  assert.deepEqual(Object.keys(f.mappings().panes), []);
  f.cleanup();
});

test("start-agent rejects a config error before touching herdr or sbx", () => {
  const f = createFixture({ config: { agentKind: "nope" } });
  const { result } = runAction(f, "start-agent", { context: { workspace_cwd: f.worktree } });
  assert.equal(result.errorKind, "config");
  assert.deepEqual(f.herdrCalls(), []);
  assert.deepEqual(f.sbxCalls(), []);
  f.cleanup();
});

test("start-agent reports an unreachable sbx before splitting a pane", () => {
  const f = createFixture();
  const { result } = runAction(f, "start-agent", { context: { workspace_cwd: f.worktree }, env: { FAKE_SBX_FAIL: "version:daemon" } });
  assert.equal(result.errorKind, "daemon");
  assert.deepEqual(f.herdrCalls(), []);
  f.cleanup();
});

test("reconnect runs the bridge connect mode in the mapped pane", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "reconnect", { context: { focused_pane_id: "pane-1", focused_pane_cwd: f.worktree } });
  assert.equal(result.ok, true);
  assert.equal(result.sandboxName, NAME);
  const run = f.herdrCalls().find((call) => call[1] === "run");
  assert.equal(run[2], "pane-1");
  assert.ok(run[3].startsWith("env HERDR_AGENT=claude "), run[3]);
  assert.ok(run[3].includes("bridge.mjs connect "), run[3]);
  f.cleanup();
});

test("pane actions fall back to the workspace's only mapping when the focused pane has none", () => {
  const f = createFixture({ panes: (p) => ({ "wD:p2": mappingFor({ worktree: p.worktree }, { paneId: "wD:p2", workspaceId: "wD" }) }) });
  const { result, stderr } = runAction(f, "reconnect", { context: { focused_pane_id: "wD:p1", workspace_id: "wD" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.paneId, "wD:p2");
  assert.match(stderr, /using the workspace's only mapping, pane wD:p2/);
  const run = f.herdrCalls().find((call) => call[1] === "run");
  assert.equal(run[2], "wD:p2");
  assert.deepEqual(f.herdrCalls()[0].slice(0, 3), ["pane", "get", "wD:p2"]);
  const other = runAction(f, "reconnect", { context: { focused_pane_id: "wE:p1", workspace_id: "wE" } });
  assert.equal(other.result.errorKind, "target");
  assert.match(other.result.message, /No sandbox is mapped in workspace wE\. Existing mappings: wD:p2 \(herdr-claude-code-abc123def456\)\. Focus that workspace, for example "herdr workspace focus wD"/);
  f.cleanup();
});

test("reconnect adopts a sandbox whose pane disappeared into a new pane in the focused workspace", () => {
  const f = createFixture({ panes: (p) => ({ "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC" }) }) });
  const { result, stderr } = runAction(f, "reconnect", { context: { focused_pane_id: "wP:p1", workspace_id: "wP" }, env: { FAKE_HERDR_MISSING_PANES: "wC:p2" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.paneId, "pane-new-1");
  assert.equal(result.adoptedFrom, "wC:p2");
  assert.match(stderr, /adopting its sandbox/);
  const calls = f.herdrCalls();
  assert.deepEqual(calls.find((call) => call[1] === "split").slice(0, 3), ["pane", "split", "wP:p1"]);
  assert.deepEqual(calls.find((call) => call[1] === "rename").slice(2), ["pane-new-1", "sbx claude-code abc123"]);
  const run = calls.find((call) => call[1] === "run");
  assert.equal(run[2], "pane-new-1");
  assert.ok(run[3].includes("bridge.mjs start "), run[3]);
  const panes = f.mappings().panes;
  assert.deepEqual(Object.keys(panes), ["pane-new-1"]);
  assert.equal(panes["pane-new-1"].sandboxName, NAME);
  assert.equal(panes["pane-new-1"].workspaceId, "wP");
  assert.equal(panes["pane-new-1"].adoptedFrom, "wC:p2");
  f.cleanup();
});

test("orphaned sandboxes can be listed, inspected with a shell, and forgotten", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "stopped" }], panes: (p) => ({ "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC" }) }) });
  const env = { FAKE_HERDR_MISSING_PANES: "wC:p2" };
  const listed = runAction(f, "list-sandboxes", { env });
  assert.equal(listed.result.mappings[0].paneExists, false);
  assert.match(listed.stdout, /wC:p2 \(pane gone\)/);
  const shell = runAction(f, "open-shell", { context: { focused_pane_id: "wP:p1", workspace_id: "wP" }, env });
  assert.equal(shell.result.ok, true, JSON.stringify(shell.result));
  assert.deepEqual(f.herdrCalls().find((call) => call[1] === "split").slice(0, 3), ["pane", "split", "wP:p1"]);
  assert.ok(f.herdrCalls().find((call) => call[1] === "run")[3].includes("--pane-id wC:p2"));
  const forgotten = runAction(f, "forget-mapping", { context: { focused_pane_id: "wP:p1", workspace_id: "wP" }, env: { ...env, FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(forgotten.result.ok, true, JSON.stringify(forgotten.result));
  assert.deepEqual(forgotten.result.deleted, [NAME]);
  assert.deepEqual(Object.keys(f.mappings().panes), []);
  f.cleanup();
});

test("the workspace fallback treats a closed sandbox pane as an orphan and gives it a new pane", () => {
  const f = createFixture({ panes: (p) => ({ "wD:p2": mappingFor({ worktree: p.worktree }, { paneId: "wD:p2", workspaceId: "wD" }) }) });
  const { result, stderr } = runAction(f, "reconnect", { context: { focused_pane_id: "wD:p1", workspace_id: "wD" }, env: { FAKE_HERDR_MISSING_PANES: "wD:p2" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.adoptedFrom, "wD:p2");
  assert.equal(result.paneId, "pane-new-1");
  assert.match(stderr, /whose pane is gone/);
  const runs = f.herdrCalls().filter((call) => call[1] === "run");
  assert.deepEqual(runs.map((call) => call[2]), ["pane-new-1"], "nothing was typed into the missing pane");
  assert.deepEqual(Object.keys(f.mappings().panes), ["pane-new-1"]);
  f.cleanup();
});

test("the workspace fallback still refuses a running agent and ambiguous workspaces", () => {
  const f = createFixture({ panes: (p) => ({ "wD:p2": mappingFor({ worktree: p.worktree }, { paneId: "wD:p2", workspaceId: "wD" }) }) });
  const busy = runAction(f, "reconnect", { context: { focused_pane_id: "wD:p1", workspace_id: "wD" }, env: { FAKE_HERDR_PANE_AGENT: "claude" } });
  assert.equal(busy.result.errorKind, "conflict");
  assert.match(busy.result.message, /wD:p2 is still running agent "claude"/);
  const two = createFixture({ panes: (p) => ({ "wD:p2": mappingFor({ worktree: p.worktree }, { paneId: "wD:p2", workspaceId: "wD" }), "wD:p3": mappingFor({ worktree: p.worktree }, { paneId: "wD:p3", sandboxName: "herdr-codex-000000000000" }) }) });
  const ambiguous = runAction(two, "reconnect", { context: { focused_pane_id: "wD:p1", workspace_id: "wD" } });
  assert.equal(ambiguous.result.errorKind, "target");
  assert.match(ambiguous.result.message, /several: wD:p2 .* wD:p3/);
  two.cleanup();
  f.cleanup();
});

test("reconnect refuses while an agent still runs and without a mapping", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  assert.equal(runAction(f, "reconnect", { context: { focused_pane_id: "pane-1", focused_pane_agent: "claude" } }).result.errorKind, "conflict");
  assert.equal(runAction(f, "reconnect", { context: { focused_pane_id: "pane-2" } }).result.errorKind, "target");
  assert.ok(!f.herdrCalls().some((call) => call[1] === "split" || call[1] === "run"), "nothing was split or run");
  f.cleanup();
});

test("open-shell splits below the pane the user is in and runs the bridge shell mode for the mapped pane", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "open-shell", { context: { focused_pane_id: "pane-1" } });
  assert.equal(result.ok, true);
  assert.equal(result.paneId, "pane-new-1");
  assert.equal(result.mappedPaneId, "pane-1");
  const calls = f.herdrCalls();
  assert.deepEqual(calls[0], ["pane", "split", "pane-1", "--direction", "down", "--ratio", "0.5", "--cwd", f.worktree, "--focus"]);
  const elsewhere = createFixture({ panes: (p) => ({ "wQ:p3": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p3", workspaceId: "wQ" }) }) });
  const viaWorkspace = runAction(elsewhere, "open-shell", { context: { focused_pane_id: "wQ:p5", workspace_id: "wQ" } });
  assert.equal(viaWorkspace.result.ok, true, JSON.stringify(viaWorkspace.result));
  assert.equal(elsewhere.herdrCalls().find((call) => call[1] === "split")[2], "wQ:p5", "splits next to the user's pane");
  assert.ok(elsewhere.herdrCalls().find((call) => call[1] === "run")[3].includes("--pane-id wQ:p3"), "the shell still targets the mapped sandbox");
  elsewhere.cleanup();
  const run = calls.find((call) => call[1] === "run");
  assert.equal(run[2], "pane-new-1");
  assert.ok(!run[3].startsWith("env "), run[3]);
  assert.ok(run[3].includes("bridge.mjs shell "), run[3]);
  assert.ok(run[3].includes("--pane-id pane-1"), run[3]);
  f.cleanup();
});

test("stop stops the sandbox and records the state", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "stop", { context: { focused_pane_id: "pane-1" } });
  assert.equal(result.ok, true);
  assert.deepEqual(f.sbxCalls(), [["stop", NAME]]);
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "stopped");
  assert.equal(f.sbxSandboxes()[0].status, "stopped");
  assert.deepEqual(f.herdrCalls()[0].slice(0, 3), ["notification", "show", "Docker Sandbox stopped"]);
  f.cleanup();
});

test("stop explains an attached session as a conflict", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "stop", { context: { focused_pane_id: "pane-1" }, env: { FAKE_SBX_FAIL: "stop:busy" } });
  assert.equal(result.errorKind, "conflict");
  assert.match(result.message, /Exit the agent and any open-shell pane/);
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "ready");
  f.cleanup();
});

test("stop marks a vanished sandbox as missing", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "stop", { context: { focused_pane_id: "pane-1" } });
  assert.equal(result.errorKind, "not-found");
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "missing");
  f.cleanup();
});

test("info describes the mapping, adapter and live sandbox", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone" }) }) });
  const { result, stdout } = runAction(f, "info", { context: { focused_pane_id: "pane-1" } });
  assert.equal(result.ok, true);
  assert.equal(result.mapping.sandboxName, NAME);
  assert.equal(result.sandbox.status, "running");
  assert.equal(result.gitRemote, `sandbox-${NAME}`);
  assert.deepEqual(result.agent.launchArgv, ["claude", "--dangerously-skip-permissions"]);
  assert.match(stdout, /"sandboxName"/);
  f.cleanup();
});

test("list-sandboxes flags missing sandboxes", () => {
  const f = createFixture({
    sandboxes: [{ name: NAME, status: "stopped" }],
    panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }), "pane-2": mappingFor({ worktree: p.worktree }, { paneId: "pane-2", sandboxName: "herdr-codex-000000000000" }) }),
  });
  const { result, stdout } = runAction(f, "list-sandboxes");
  assert.equal(result.ok, true);
  const byPane = Object.fromEntries(result.mappings.map((item) => [item.paneId, item]));
  assert.equal(byPane["pane-1"].exists, true);
  assert.equal(byPane["pane-1"].status, "stopped");
  assert.equal(byPane["pane-2"].exists, false);
  assert.match(stdout, /MISSING/);
  f.cleanup();
});

test("list-sandboxes tolerates an unreachable daemon", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "list-sandboxes", { env: { FAKE_SBX_FAIL: "ls:daemon" } });
  assert.equal(result.ok, true);
  assert.equal(result.sandboxError.kind, "daemon");
  assert.equal(result.mappings[0].exists, null);
  f.cleanup();
});

test("forget-mapping deletes the sandbox after confirmation and drops the mapping", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "forget-mapping", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.deleted, [NAME]);
  const popup = f.herdrCalls().find((call) => call[0] === "plugin");
  assert.deepEqual(popup.slice(0, 7), ["plugin", "pane", "open", "--plugin", "sbx.sandbox", "--entrypoint", "deletion-confirmation"]);
  assert.ok(popup.some((arg) => arg.startsWith("HERDR_SBX_CONFIRMATION_ID=")), popup.join(" "));
  assert.deepEqual(f.sbxCalls(), [["rm", "--force", NAME]]);
  assert.deepEqual(Object.keys(f.mappings().panes), []);
  assert.deepEqual(f.sbxSandboxes(), []);
  assert.deepEqual(readdirSync(path.join(f.stateDir, "confirmations")), []);
  f.cleanup();
});

test("the deletion popup names every sandbox the mapping still owns", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }, { name: "herdr-claude-code-111111111111", status: "stopped" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { replacesSandboxNames: ["herdr-claude-code-111111111111", "herdr-claude-code-222222222222"], deletedSandboxNames: ["herdr-claude-code-222222222222"] }) }) });
  const { result } = runAction(f, "forget-mapping", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const [request] = f.confirmations();
  assert.equal(request.sandboxName, `${NAME}, herdr-claude-code-111111111111`, "the already deleted predecessor is not shown");
  assert.match(request.consequence, /These 2 sandboxes are deleted permanently/);
  assert.deepEqual(result.deleted.sort(), [NAME, "herdr-claude-code-111111111111"].sort());
  f.cleanup();
});

test("forget-mapping keeps everything when the popup cancels", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "forget-mapping", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "cancelled" } });
  assert.equal(result.errorKind, "cancelled");
  assert.deepEqual(f.sbxCalls(), []);
  assert.ok(f.mappings().panes["pane-1"]);
  f.cleanup();
});

test("forget-mapping times out without a decision", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "forget-mapping", { context: { focused_pane_id: "pane-1" }, env: { HERDR_SBX_CONFIRMATION_TIMEOUT_MS: "300" } });
  assert.equal(result.errorKind, "cancelled");
  assert.deepEqual(f.sbxCalls(), []);
  assert.deepEqual(readdirSync(path.join(f.stateDir, "confirmations")), []);
  f.cleanup();
});

test("forget-mapping tolerates an already deleted sandbox", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "forget-mapping", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.alreadyMissing, [NAME]);
  assert.deepEqual(Object.keys(f.mappings().panes), []);
  f.cleanup();
});

test("forget-mapping refuses while the agent runs", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "forget-mapping", { context: { focused_pane_id: "pane-1", focused_pane_agent: "claude" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(result.errorKind, "conflict");
  assert.deepEqual(f.herdrCalls(), []);
  f.cleanup();
});

test("replace-sandbox deletes, remaps and restarts in the same pane", () => {
  const f = createFixture({ config: { agentKind: "codex" }, sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "replace-sandbox", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.deleted, [NAME]);
  assert.match(result.sandboxName, /^herdr-codex-[a-f0-9]{12}$/);
  assert.equal(result.paneId, "pane-1");
  assert.equal(result.movedTo, null);
  const mapping = f.mappings().panes["pane-1"];
  assert.equal(mapping.lifecycleState, "creating", "the emulated bridge started in the same pane");
  assert.equal(mapping.sandboxName, result.sandboxName);
  assert.equal(mapping.agentKind, "codex");
  assert.deepEqual(mapping.replacesSandboxNames, [NAME]);
  assert.deepEqual(mapping.deletedSandboxNames, [NAME]);
  assert.deepEqual(f.sbxCalls(), [["rm", "--force", NAME]]);
  const run = f.herdrCalls().find((call) => call[1] === "run");
  assert.equal(run[2], "pane-1");
  assert.ok(run[3].startsWith("env HERDR_AGENT=codex "), run[3]);
  assert.ok(run[3].includes("bridge.mjs start "), run[3]);
  f.cleanup();
});

test("a bridge that acknowledged itself is trusted even when it stays busy, and adoption survives a reused pane id", () => {
  const slow = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "wQ:p3": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p3", workspaceId: "wQ" }) }) });
  const { result } = runAction(slow, "reconnect", { context: { focused_pane_id: "wQ:p5", workspace_id: "wQ" }, env: { FAKE_HERDR_BRIDGE_ACK_ONLY: "1" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.movedTo, null, "an acknowledged bridge is never replaced");
  assert.equal(slow.mappings().panes["wQ:p3"].lifecycleState, "ready");
  const reused = createFixture({ panes: (p) => ({ "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC" }) }) });
  const adopted = runAction(reused, "reconnect", { context: { focused_pane_id: "wP:p1", workspace_id: "wP" }, env: { FAKE_HERDR_MISSING_PANES: "wC:p2", FAKE_HERDR_NEW_PANE_ID: "wC:p2" } });
  assert.equal(adopted.result.ok, true, JSON.stringify(adopted.result));
  assert.equal(adopted.result.paneId, "wC:p2");
  assert.deepEqual(Object.keys(reused.mappings().panes), ["wC:p2"], "the mapping survives when Herdr reuses the orphan's pane id");
  assert.equal(reused.mappings().panes["wC:p2"].sandboxName, NAME);
  reused.cleanup();
  slow.cleanup();
});

test("re-homing an orphan into a pane id another mapping still uses keeps that mapping's sandboxes", () => {
  const f = createFixture({ panes: (p) => ({
    "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC" }),
    "wD:p2": mappingFor({ worktree: p.worktree }, { paneId: "wD:p2", workspaceId: "wD", sandboxName: "herdr-codex-777777777777", deletedSandboxNames: ["herdr-codex-000000000000"] }),
  }) });
  const { result, stderr } = runAction(f, "reconnect", { context: { focused_pane_id: "wP:p1", workspace_id: "wP" }, env: { FAKE_HERDR_MISSING_PANES: "wC:p2,wD:p2", FAKE_HERDR_NEW_PANE_ID: "wD:p2" } });
  assert.equal(result.errorKind, "target", "two orphans are ambiguous");
  const single = createFixture({ panes: (p) => ({
    "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC" }),
    "wD:p2": mappingFor({ worktree: p.worktree }, { paneId: "wD:p2", workspaceId: "wD", sandboxName: "herdr-codex-777777777777", deletedSandboxNames: ["herdr-codex-000000000000"] }),
  }) });
  const adopted = runAction(single, "reconnect", { context: { focused_pane_id: "wC:p1", workspace_id: "wC" }, env: { FAKE_HERDR_MISSING_PANES: "wC:p2", FAKE_HERDR_NEW_PANE_ID: "wD:p2" } });
  assert.equal(adopted.result.ok, true, JSON.stringify(adopted.result));
  assert.equal(adopted.result.paneId, "wD:p2");
  const mapping = single.mappings().panes["wD:p2"];
  assert.equal(mapping.sandboxName, NAME);
  assert.deepEqual(mapping.replacesSandboxNames, ["herdr-codex-777777777777"], "the displaced mapping's sandbox stays deletable");
  assert.deepEqual(mapping.deletedSandboxNames, ["herdr-codex-000000000000"]);
  assert.deepEqual(Object.keys(single.mappings().panes), ["wD:p2"]);
  assert.match(adopted.stderr, /was mapped to herdr-codex-777777777777/);
  single.cleanup();
  f.cleanup();
  void stderr;
});

test("a stale acknowledgement from an earlier bridge does not satisfy a new launch", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "wQ:p3": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p3", workspaceId: "wQ", bridgeStartedAt: new Date().toISOString(), bridgeLaunchId: "previous" }) }) });
  const { result } = runAction(f, "reconnect", { context: { focused_pane_id: "wQ:p5", workspace_id: "wQ" }, env: { FAKE_HERDR_BRIDGE_STARTS: "0" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.movedTo, "pane-new-1", "the swallowed launch fell back to a fresh pane despite the fresh-looking old acknowledgement");
  const typed = f.herdrCalls().find((call) => call[1] === "run")[3];
  assert.match(typed, /--sbx-bin \S+ --launch-id [a-f0-9]{12}/, "the bridge command carries the resolved sbx and a launch id");
  f.cleanup();
});

test("keepBranchCommand quotes paths, branches and refs", () => {
  assert.equal(keepBranchCommand("/tmp/my repo", "agent-work", "sandbox-x/agent-work"), "git -C '/tmp/my repo' branch agent-work sandbox-x/agent-work");
  assert.equal(keepBranchCommand("/tmp/repo", "feat;x", "sandbox-x/feat;x"), "git -C /tmp/repo branch 'feat;x' 'sandbox-x/feat;x'");
});

test("reconnect prepares a mapping that never got created and falls back to a fresh pane when the pane ignores the command", () => {
  const f = createFixture({ panes: (p) => ({ "wQ:p3": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p3", workspaceId: "wQ", lifecycleState: "provisional", createdAt: null }) }) });
  const { result } = runAction(f, "reconnect", { context: { focused_pane_id: "wQ:p5", workspace_id: "wQ" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, "start");
  assert.equal(result.paneId, "wQ:p3");
  assert.equal(result.movedTo, null);
  assert.ok(f.herdrCalls().find((call) => call[1] === "run")[3].includes("bridge.mjs start "));
  const stuck = createFixture({ panes: (p) => ({ "wQ:p3": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p3", workspaceId: "wQ" }) }) });
  const fallback = runAction(stuck, "reconnect", { context: { focused_pane_id: "wQ:p5", workspace_id: "wQ" }, env: { FAKE_HERDR_BRIDGE_STARTS: "0" } });
  assert.equal(fallback.result.ok, true, JSON.stringify(fallback.result));
  assert.equal(fallback.result.movedTo, "pane-new-1");
  assert.equal(fallback.result.paneId, "pane-new-1");
  assert.match(fallback.stderr, /did not run the bridge command/);
  const runs = stuck.herdrCalls().filter((call) => call[1] === "run");
  assert.deepEqual(runs.map((call) => call[2]), ["wQ:p3", "pane-new-1"]);
  assert.ok(runs[1][3].includes("bridge.mjs start "));
  assert.deepEqual(Object.keys(stuck.mappings().panes), ["pane-new-1"]);
  assert.equal(stuck.herdrCalls().find((call) => call[1] === "split")[2], "wQ:p5", "the new pane is next to the user");
  stuck.cleanup();
  f.cleanup();
});

test("replace-sandbox falls back to a fresh pane when the old pane ignores the command", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "wQ:p3": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p3", workspaceId: "wQ" }) }) });
  const { result } = runAction(f, "replace-sandbox", { context: { focused_pane_id: "wQ:p5", workspace_id: "wQ" }, env: { FAKE_POPUP_DECISION: "confirmed", FAKE_HERDR_BRIDGE_STARTS: "0" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.deleted, [NAME]);
  assert.equal(result.movedTo, "pane-new-1");
  const panes = f.mappings().panes;
  assert.deepEqual(Object.keys(panes), ["pane-new-1"]);
  assert.equal(panes["pane-new-1"].sandboxName, result.sandboxName);
  assert.deepEqual(panes["pane-new-1"].replacesSandboxNames, [NAME]);
  f.cleanup();
});

test("replacing an orphan into a reused pane id keeps the displaced mapping's sandboxes in the history", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC" }),
    "wD:p2": mappingFor({ worktree: p.worktree }, { paneId: "wD:p2", workspaceId: "wD", sandboxName: "herdr-codex-777777777777" }),
  }) });
  const { result } = runAction(f, "replace-sandbox", { context: { focused_pane_id: "wC:p1", workspace_id: "wC" }, env: { FAKE_HERDR_MISSING_PANES: "wC:p2", FAKE_HERDR_NEW_PANE_ID: "wD:p2", FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.paneId, "wD:p2");
  const mapping = f.mappings().panes["wD:p2"];
  assert.equal(mapping.sandboxName, result.sandboxName);
  assert.deepEqual([...mapping.replacesSandboxNames].sort(), [NAME, "herdr-codex-777777777777"].sort(), "both the replaced and the displaced sandbox stay tracked");
  assert.deepEqual(mapping.deletedSandboxNames, [NAME]);
  assert.deepEqual(Object.keys(f.mappings().panes), ["wD:p2"]);
  f.cleanup();
});

test("replace-sandbox validates the replacement before deleting anything", () => {
  const f = createFixture({ config: { agentKind: "nope" }, sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "replace-sandbox", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(result.errorKind, "config");
  assert.deepEqual(f.sbxCalls(), []);
  assert.deepEqual(f.herdrCalls(), []);
  assert.equal(f.mappings().panes["pane-1"].sandboxName, NAME);
  const gone = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { localPath: path.join(p.root, "deleted-worktree") }) }) });
  const missing = runAction(gone, "replace-sandbox", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(missing.result.errorKind, "target");
  assert.deepEqual(gone.sbxCalls(), []);
  gone.cleanup();
  f.cleanup();
});

test("replace-sandbox keeps the full deletion history across rounds", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { replacesSandboxNames: ["first-sandbox"], deletedSandboxNames: ["first-sandbox"] }) }) });
  const { result } = runAction(f, "replace-sandbox", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(result.ok, true);
  assert.deepEqual(f.sbxCalls(), [["rm", "--force", NAME]]);
  const mapping = f.mappings().panes["pane-1"];
  assert.deepEqual(mapping.replacesSandboxNames, [NAME, "first-sandbox"]);
  assert.deepEqual(mapping.deletedSandboxNames.sort(), ["first-sandbox", NAME].sort());
  f.cleanup();
});

test("replace-sandbox leaves everything untouched when cancelled", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(f, "replace-sandbox", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "cancelled" } });
  assert.equal(result.errorKind, "cancelled");
  assert.equal(f.mappings().panes["pane-1"].sandboxName, NAME);
  assert.deepEqual(f.sbxCalls(), []);
  f.cleanup();
});

test("fetch-changes uses the registered remote of a running sandbox, in clone mode only", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone" }), "pane-2": mappingFor({ worktree: p.worktree }, { paneId: "pane-2" }) }) });
  const bare = path.join(f.root, "sandbox-repo.git");
  git(f.root, ["init", "-q", "--bare", "--initial-branch=agent-work", bare]);
  git(f.worktree, ["remote", "add", `sandbox-${NAME}`, bare]);
  git(f.worktree, ["push", "-q", `sandbox-${NAME}`, "HEAD:refs/heads/agent-work"]);
  const { result, stdout } = runAction(f, "fetch-changes", { context: { focused_pane_id: "pane-1" } });
  assert.equal(result.ok, true);
  assert.equal(result.remote, `sandbox-${NAME}`);
  assert.deepEqual(result.branches, [`sandbox-${NAME}/agent-work`], "the remote HEAD pointer is not listed as a branch");
  assert.equal(result.transport, "remote");
  assert.deepEqual(result.keep, [{ ref: `sandbox-${NAME}/agent-work`, local: "agent-work", command: `git -C ${f.worktree} branch agent-work sandbox-${NAME}/agent-work` }]);
  assert.match(stdout, /Keep a branch with:/);
  assert.deepEqual(f.sbxCalls(), [["ls", "--json"]], "a running sandbox needs no exec before the fetch");
  assert.equal(runAction(f, "fetch-changes", { context: { focused_pane_id: "pane-2" } }).result.errorKind, "target");
  f.cleanup();
});

test("fetch-changes bundles instead of trusting a remote whose sandbox is stopped", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "stopped" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone" }) }) });
  const bare = path.join(f.root, "sandbox-repo.git");
  git(f.root, ["init", "-q", "--bare", "--initial-branch=agent-work", bare]);
  git(f.worktree, ["remote", "add", `sandbox-${NAME}`, bare]);
  const { result, stderr } = runAction(f, "fetch-changes", { context: { focused_pane_id: "pane-1" }, env: { FAKE_SBX_EXEC_RUN: "1" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.transport, "bundle", "the daemon behind the remote died with the session that registered it");
  assert.match(stderr, /is not running, so the sandbox-.* remote has no git daemon behind it/);
  assert.ok(f.sbxCalls().some((call) => call[0] === "exec" && call.join(" ").includes("bundle create")), "the bundle exec starts the stopped sandbox itself");
  f.cleanup();
});

test("fetch-changes falls back to a bundle when the registered remote of a running sandbox is dead", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone" }) }) });
  git(f.worktree, ["remote", "add", `sandbox-${NAME}`, path.join(f.root, "no-longer-served.git")]);
  const { result, stderr } = runAction(f, "fetch-changes", { context: { focused_pane_id: "pane-1" }, env: { FAKE_SBX_EXEC_RUN: "1" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.transport, "bundle");
  assert.match(stderr, /git fetch sandbox-.* failed \(exit \d+\)\. Fetching through a git bundle instead/);
  assert.ok(result.branches.length > 0, result.branches.join(","));
  f.cleanup();
});

test("fetch-changes kills a git fetch whose remote accepts the connection and then stays silent", async () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone" }) }) });
  // A listener that never answers: the kernel completes git's connection, the daemon never replies.
  const server = createServer((socket) => socket.unref());
  server.unref();
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    git(f.worktree, ["remote", "add", `sandbox-${NAME}`, `git://127.0.0.1:${port}/repo.git`]);
    const started = Date.now();
    const { result, stderr } = runAction(f, "fetch-changes", { context: { focused_pane_id: "pane-1" }, env: { HERDR_SBX_TIMEOUT_MS: "700", FAKE_SBX_EXEC_RUN: "1" } });
    assert.ok(Date.now() - started < 10_000, "the action came back promptly");
    assert.match(stderr, /git fetch sandbox-.* did not finish within 1s and was killed.*Fetching through a git bundle instead/);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.transport, "bundle", "a silent daemon is not the end of the fetch");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    f.cleanup();
  }
});

test("fetch-changes carries commits over in a bundle when sbx registered no remote", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "stopped" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone" }) }) });
  git(f.worktree, ["checkout", "-q", "-b", "agent-work"]);
  writeFileSync(path.join(f.worktree, "note.txt"), "note\n");
  git(f.worktree, ["add", "note.txt"]);
  git(f.worktree, ["commit", "-q", "-m", "agent work"]);
  git(f.worktree, ["checkout", "-q", "-"]);
  const { result, stderr } = runAction(f, "fetch-changes", { context: { focused_pane_id: "pane-1" }, env: { FAKE_SBX_EXEC_RUN: "1" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.transport, "bundle");
  assert.ok(result.branches.includes(`sandbox-${NAME}/agent-work`), result.branches.join(","));
  assert.ok(result.branches.some((ref) => ref.endsWith("/main") || ref.endsWith("/master")), "the default branch was bundled too");
  assert.deepEqual(result.keep, [], "every bundled branch already exists locally in this fixture");
  assert.match(stderr, /fetching through a git bundle/);
  const calls = f.sbxCalls().map((call) => call.join(" "));
  const bundlePattern = new RegExp(`/tmp/herdr-sbx-${NAME}-\\d+-[a-f0-9]{8}\\.bundle`);
  const create = calls.find((call) => call.startsWith(`exec ${NAME} -- git -C ${f.worktree} bundle create `));
  assert.ok(create && bundlePattern.test(create) && create.endsWith("--branches"), calls.join("\n"));
  const bundlePath = create.match(bundlePattern)[0];
  assert.ok(calls.some((call) => call.startsWith(`cp ${NAME}:${bundlePath} `)), calls.join("\n"));
  assert.ok(calls.some((call) => call === `exec ${NAME} -- rm -f ${bundlePath}`), calls.join("\n"));
  assert.equal(git(f.worktree, ["log", "--oneline", "-1", `sandbox-${NAME}/agent-work`]).includes("agent work"), true);
  assert.equal(git(f.worktree, ["branch", "--show-current"]).trim(), git(f.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).trim());
  f.cleanup();
});

test("fetch-changes reports a missing sandbox as not-found", () => {
  const gone = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone" }) }) });
  const missing = runAction(gone, "fetch-changes", { context: { focused_pane_id: "pane-1" } });
  assert.equal(missing.result.errorKind, "not-found");
  assert.match(missing.result.message, /no longer exists/);
  assert.equal(gone.mappings().panes["pane-1"].lifecycleState, "missing");
  gone.cleanup();
});

test("unknown actions and missing plugin directories fail cleanly", () => {
  const f = createFixture();
  const unknown = runAction(f, "bogus");
  assert.equal(unknown.status, 1);
  assert.equal(unknown.result.errorKind, "target");
  const inherited = runAction(f, "constructor");
  assert.equal(inherited.status, 1);
  assert.equal(inherited.result.errorKind, "target");
  const noDirs = runAction(f, "doctor", { env: { HERDR_PLUGIN_STATE_DIR: "" } });
  assert.equal(noDirs.result.errorKind, "startup");
  const badContext = runAction(f, "doctor", { env: { HERDR_PLUGIN_CONTEXT_JSON: "{oops" } });
  assert.equal(badContext.result.errorKind, "startup");
  f.cleanup();
});

test("install-keybindings appends the four bindings once and reloads Herdr", () => {
  const f = createFixture();
  const configPath = path.join(f.root, "herdr", "config.toml");
  const first = runAction(f, "install-keybindings", { env: { HERDR_CONFIG_PATH: configPath } });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.result.ok, true);
  assert.equal(first.result.configPath, configPath);
  assert.deepEqual(first.result.added.map((item) => `${item.key}=${item.action}`), [
    "prefix+shift+a=start-agent",
    "prefix+shift+b=reconnect",
    "prefix+shift+s=open-shell",
    "prefix+shift+o=sandboxes",
  ]);
  assert.deepEqual(first.result.existing, []);
  assert.deepEqual(first.result.warnings, []);
  assert.equal(first.result.reloaded, true);
  assert.match(first.stdout, /bound prefix\+shift\+a -> sbx\.sandbox\.start-agent/);
  const written = readFileSync(configPath, "utf8");
  assert.equal(written.match(/\[\[keys\.command\]\]/g).length, 4);
  assert.match(written, /type = "plugin_action"\ncommand = "sbx\.sandbox\.start-agent"/);
  const calls = f.herdrCalls().map((argv) => argv.slice(0, 2).join(" "));
  assert.deepEqual(calls, ["config check", "server reload-config"]);

  const second = runAction(f, "install-keybindings", { env: { HERDR_CONFIG_PATH: configPath } });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(second.result.added, []);
  assert.equal(second.result.existing.length, 4);
  assert.equal(readFileSync(configPath, "utf8"), written);
  f.cleanup();
});

test("install-keybindings resolves the config like Herdr and keeps hand-written bindings", () => {
  const f = createFixture();
  const xdg = path.join(f.root, "xdg");
  const configPath = path.join(xdg, "herdr", "config.toml");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, [
    "[[keys.command]]",
    'command = "sbx.sandbox.open-shell"',
    'type = "plugin_action"',
    'key = "prefix+shift+u"',
    "",
    "[[keys.command]]",
    'key = "prefix+shift+d"',
    'type = "plugin_action"',
    'command = "sbx.sandbox.start-agent"',
    "",
  ].join("\n"));
  const { status, result } = runAction(f, "install-keybindings", { env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(status, 0);
  assert.equal(result.configPath, configPath);
  assert.deepEqual(result.added.map((item) => item.action), ["reconnect", "sandboxes"]);
  assert.deepEqual(result.existing, [{ key: "prefix+shift+u", action: "open-shell" }]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /start-agent is bound to prefix\+shift\+d, which Herdr uses itself/);
  assert.match(readFileSync(configPath, "utf8"), /key = "prefix\+shift\+d"\ntype = "plugin_action"\ncommand = "sbx\.sandbox\.start-agent"/);

  const home = runAction(f, "install-keybindings");
  assert.equal(home.status, 0);
  assert.equal(home.result.configPath, path.join(f.root, ".config", "herdr", "config.toml"));
  f.cleanup();
});

test("install-keybindings restores the config when Herdr rejects it", () => {
  const f = createFixture();
  const configPath = path.join(f.root, "config.toml");
  writeFileSync(configPath, "[general]\nprefix = \"ctrl+b\"\n");
  const { status, result } = runAction(f, "install-keybindings", { env: { HERDR_CONFIG_PATH: configPath, FAKE_HERDR_FAIL: "config check" } });
  assert.equal(status, 1);
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "config");
  assert.match(result.message, /was restored to its previous content and Herdr was not reloaded/);
  assert.match(result.output, /fake herdr refuses config check/);
  assert.equal(readFileSync(configPath, "utf8"), "[general]\nprefix = \"ctrl+b\"\n", "the file is exactly what it was before");
  assert.deepEqual(readdirSync(f.root).filter((name) => name.includes("sbx-backup")), [], "no backup file is left behind");
  f.cleanup();
});

test("install-keybindings leaves a chord alone when another command already uses it", () => {
  const f = createFixture();
  const configPath = path.join(f.root, "config.toml");
  writeFileSync(configPath, [
    "[[keys.command]]",
    "key = 'prefix+shift+o'",
    "type = 'plugin_action'",
    "command = 'other.plugin.overlay'",
    "",
    "[other]",
    'key = "prefix+shift+s"',
    "",
  ].join("\n"));
  const { status, result } = runAction(f, "install-keybindings", { env: { HERDR_CONFIG_PATH: configPath } });
  assert.equal(status, 0, result.message);
  assert.deepEqual(result.added.map((item) => item.action), ["start-agent", "reconnect", "open-shell"], "a key line outside a keys.command block does not count as taken");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /prefix\+shift\+o is already bound to other\.plugin\.overlay/);
  assert.ok(!readFileSync(configPath, "utf8").includes("sbx.sandbox.sandboxes"));
  f.cleanup();
});

test("list-sandboxes tells a missing pane from a failed pane check", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const failed = runAction(f, "list-sandboxes", { env: { FAKE_HERDR_FAIL: "pane list" } });
  assert.equal(failed.result.ok, true);
  assert.equal(failed.result.mappings[0].paneExists, null);
  assert.match(failed.result.mappings[0].paneError, /pane list/);
  assert.match(failed.stdout, /pane-1 \(pane \?\)\t/);
  assert.ok(!failed.stdout.includes("pane gone"));
  const gone = runAction(f, "list-sandboxes", { env: { FAKE_HERDR_MISSING_PANES: "pane-1" } });
  assert.equal(gone.result.mappings[0].paneExists, false);
  assert.match(gone.stdout, /pane-1 \(pane gone\)\t/);
  f.cleanup();
});

test("bridgeStartTimeout and entryCwd fall back sensibly", () => {
  assert.equal(bridgeStartTimeout({}), 4000);
  assert.equal(bridgeStartTimeout({ HERDR_SBX_BRIDGE_START_TIMEOUT_MS: "" }), 4000, "an empty override is not a zero timeout");
  assert.equal(bridgeStartTimeout({ HERDR_SBX_BRIDGE_START_TIMEOUT_MS: "0" }), 4000);
  assert.equal(bridgeStartTimeout({ HERDR_SBX_BRIDGE_START_TIMEOUT_MS: "250" }), 250);
  const f = createFixture();
  assert.equal(entryCwd({ workdir: path.join(f.worktree, "gone"), localPath: f.worktree }), f.worktree);
  assert.equal(entryCwd({ workdir: f.worktree, localPath: f.worktree }), f.worktree);
  assert.equal(entryCwd({ workdir: null, localPath: path.join(f.root, "nope") }), null);
  f.cleanup();
});

test("open-shell opens next to the mounted path when only the working directory is gone", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workdir: path.join(p.worktree, "packages", "gone") }) }) });
  const { result } = runAction(f, "open-shell", { context: { focused_pane_id: "pane-1" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const split = f.herdrCalls().find((call) => call[1] === "split");
  assert.equal(split[split.indexOf("--cwd") + 1], f.worktree);
  f.cleanup();
});

test("a bridge that acknowledges while its replacement pane opens keeps the mapping, and the spare pane is closed", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "wQ:p3": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p3", workspaceId: "wQ" }) }) });
  const { result, stderr } = runAction(f, "reconnect", { context: { focused_pane_id: "wQ:p5", workspace_id: "wQ" }, env: { FAKE_HERDR_BRIDGE_STARTS: "0", FAKE_HERDR_ACK_ON_SPLIT: "1" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.paneId, "wQ:p3");
  assert.equal(result.movedTo, null);
  assert.match(stderr, /ran the bridge command after all/);
  const calls = f.herdrCalls();
  assert.equal(calls.filter((call) => call[1] === "run").length, 1, "the bridge is not started a second time");
  assert.ok(calls.some((call) => call[0] === "pane" && call[1] === "close" && call[2] === "pane-new-1"), "the unused pane is closed");
  assert.deepEqual(Object.keys(f.mappings().panes), ["wQ:p3"]);
  assert.ok(f.mappings().panes["wQ:p3"].bridgeLaunchId);

  const moved = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "wQ:p3": mappingFor({ worktree: p.worktree }, { paneId: "wQ:p3", workspaceId: "wQ" }) }) });
  const outcome = runAction(moved, "reconnect", { context: { focused_pane_id: "wQ:p5", workspace_id: "wQ" }, env: { FAKE_HERDR_BRIDGE_STARTS: "0" } });
  assert.equal(outcome.result.movedTo, "pane-new-1");
  assert.equal(outcome.result.mode, "start", "a moved bridge always prepares, whatever was planned");
  const renames = moved.herdrCalls().filter((call) => call[1] === "rename").map((call) => call.slice(2));
  assert.ok(renames.some(([paneId, label]) => paneId === "wQ:p3" && / \(moved to pane-new-1\)$/.test(label)), JSON.stringify(renames));
  f.cleanup();
  moved.cleanup();
});

test("prune-mappings warns about clone-mode orphans, reports a failed deletion and keeps going", () => {
  const other = "herdr-codex-999999999999";
  const f = createFixture({
    sandboxes: [{ name: NAME, status: "stopped" }, { name: other, status: "stopped" }],
    panes: (p) => ({
      "wA:p1": mappingFor({ worktree: p.worktree }, { paneId: "wA:p1", workspaceMode: "clone" }),
      "wB:p1": mappingFor({ worktree: p.worktree }, { paneId: "wB:p1", sandboxName: other, agentKind: "codex" }),
    }),
  });
  const { result, stdout } = runAction(f, "prune-mappings", { env: { FAKE_HERDR_MISSING_PANES: "wA:p1,wB:p1", FAKE_POPUP_DECISION: "confirmed", FAKE_SBX_FAIL: `rm:daemon@${other}` } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(f.confirmations()[0].consequence, new RegExp(`Clone mode: every branch fetched from it under sandbox-${NAME}/`));
  assert.deepEqual(result.deleted, [NAME]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].sandboxName, other);
  assert.equal(result.failures[0].errorKind, "daemon");
  assert.ok(result.kept.some((item) => item.sandboxName === other && item.reason.startsWith("deletion failed (daemon)")), JSON.stringify(result.kept));
  assert.match(stdout, new RegExp(`failed wB:p1\\t${other}`));
  assert.deepEqual(Object.keys(f.mappings().panes), ["wB:p1"]);
  assert.deepEqual(f.sbxSandboxes().map((item) => item.name), [other]);
  f.cleanup();
});

test("fetch-changes does not promote a mapping that never finished preparing", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone", lifecycleState: "failed", lastError: { kind: "config", message: "setup failed", at: "2026-09-12T00:00:00.000Z" } }) }) });
  const bare = path.join(f.root, "sandbox-repo.git");
  git(f.root, ["init", "-q", "--bare", "--initial-branch=agent-work", bare]);
  git(f.worktree, ["remote", "add", `sandbox-${NAME}`, bare]);
  git(f.worktree, ["push", "-q", `sandbox-${NAME}`, "HEAD:refs/heads/agent-work"]);
  const { result } = runAction(f, "fetch-changes", { context: { focused_pane_id: "pane-1" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const entry = f.mappings().panes["pane-1"];
  assert.equal(entry.lifecycleState, "failed", "starting the VM for a fetch does not make the mapping connectable");
  assert.equal(entry.lastError.kind, "config");

  const stale = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone", lifecycleState: "missing" }) }) });
  git(stale.root, ["init", "-q", "--bare", "--initial-branch=agent-work", path.join(stale.root, "sandbox-repo.git")]);
  git(stale.worktree, ["remote", "add", `sandbox-${NAME}`, path.join(stale.root, "sandbox-repo.git")]);
  git(stale.worktree, ["push", "-q", `sandbox-${NAME}`, "HEAD:refs/heads/agent-work"]);
  assert.equal(runAction(stale, "fetch-changes", { context: { focused_pane_id: "pane-1" } }).result.ok, true);
  assert.equal(stale.mappings().panes["pane-1"].lifecycleState, "created", "a sandbox that turned out to exist is created, not ready");
  f.cleanup();
  stale.cleanup();
});

test("fetch-changes keeps its result when the bundle cleanup inside the sandbox hangs", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "stopped" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone" }) }) });
  git(f.worktree, ["checkout", "-q", "-b", "agent-work"]);
  writeFileSync(path.join(f.worktree, "note.txt"), "note\n");
  git(f.worktree, ["add", "note.txt"]);
  git(f.worktree, ["commit", "-q", "-m", "agent work"]);
  git(f.worktree, ["checkout", "-q", "-"]);
  const { result, stderr } = runAction(f, "fetch-changes", { context: { focused_pane_id: "pane-1" }, env: { FAKE_SBX_EXEC_RUN: "1", FAKE_SBX_SLEEP_MS: "5000", FAKE_SBX_SLEEP_MATCH: "-- rm -f", HERDR_SBX_TIMEOUT_MS: "150" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.transport, "bundle");
  assert.ok(result.branches.includes(`sandbox-${NAME}/agent-work`), result.branches.join(","));
  assert.match(stderr, /could not remove .*\.bundle inside the sandbox: .*did not finish within/);
  f.cleanup();
});

test("actions refuse to touch a mapping whose bridge process is still alive, even before Herdr sees an agent", () => {
  const bridge = fakeBridgeProcess("pane-1");
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({
    "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "creating", bridgePid: bridge.pid, bridgeStartedAt: "2026-09-12T20:00:00.000Z" }),
    "pane-2": mappingFor({ worktree: p.worktree }, { paneId: "pane-2", bridgePid: 2147483647, bridgeStartedAt: "2026-09-12T20:00:00.000Z" }),
  }) });
  for (const action of ["reconnect", "forget-mapping", "replace-sandbox"]) {
    const { result } = runAction(f, action, { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
    assert.equal(result.ok, false, action);
    assert.equal(result.errorKind, "conflict", action);
    assert.match(result.message, new RegExp(`still runs the bridge for ${NAME} \\(pid ${bridge.pid}`), action);
  }
  assert.deepEqual(f.confirmations(), [], "no popup was opened for a busy mapping");
  assert.ok(f.sbxSandboxes().some((item) => item.name === NAME), "nothing was deleted");
  const dead = runAction(f, "reconnect", { context: { focused_pane_id: "pane-2" } });
  assert.equal(dead.result.ok, true, JSON.stringify(dead.result));
  bridge.stop();
  f.cleanup();
});

test("prune-mappings does not delete an orphan whose pane came back while the popup was open", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "stopped" }], panes: (p) => ({ "wA:p1": mappingFor({ worktree: p.worktree }, { paneId: "wA:p1" }) }) });
  const missingFile = path.join(f.root, "missing-panes.txt");
  writeFileSync(missingFile, "wA:p1");
  const { result } = runAction(f, "prune-mappings", { env: { FAKE_HERDR_MISSING_PANES_FILE: missingFile, FAKE_HERDR_RESTORE_PANES_ON_POPUP: "1", FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.orphansConfirmed, true);
  assert.deepEqual(result.deleted, []);
  assert.ok(result.kept.some((item) => item.paneId === "wA:p1" && /pane came back while the confirmation was open/.test(item.reason)), JSON.stringify(result.kept));
  assert.deepEqual(f.sbxSandboxes().map((item) => item.name), [NAME]);
  assert.deepEqual(Object.keys(f.mappings().panes), ["wA:p1"]);
  f.cleanup();
});

test("prune-mappings keeps a mapping that was rewritten while it was listing sandboxes", () => {
  const f = createFixture({ panes: (p) => ({ "wA:p1": mappingFor({ worktree: p.worktree }, { paneId: "wA:p1" }) }) });
  const { result } = runAction(f, "prune-mappings", { env: { FAKE_HERDR_MISSING_PANES: "wA:p1", FAKE_SBX_LS_TOUCH_PANE: "wA:p1" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.pruned, []);
  assert.ok(result.kept.some((item) => item.paneId === "wA:p1" && /mapping changed while pruning/.test(item.reason)), JSON.stringify(result.kept));
  assert.equal(f.mappings().panes["wA:p1"].sandboxName, `${NAME}-new`, "the newer mapping survived");
  f.cleanup();
});

test("replace-sandbox still starts the replacement when the pane cannot be relabelled", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result, stderr } = runAction(f, "replace-sandbox", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed", FAKE_HERDR_FAIL: "pane rename" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.deleted, [NAME]);
  assert.match(stderr, /could not relabel pane pane-1/);
  assert.ok(f.herdrCalls().some((call) => call[1] === "run"), "the bridge was started");
  f.cleanup();
});

test("a sandbox whose agent reconnected while the deletion popup was open is not deleted", () => {
  const bridge = fakeBridgeProcess("pane-1");
  for (const action of ["forget-mapping", "replace-sandbox"]) {
    const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
    const { result } = runAction(f, action, { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed", FAKE_HERDR_POPUP_BRIDGE_PANE: "pane-1", FAKE_HERDR_POPUP_BRIDGE_PID: String(bridge.pid) } });
    assert.equal(result.ok, false, action);
    assert.equal(result.errorKind, "conflict", action);
    assert.match(result.message, /still runs the bridge for .*Nothing was deleted/, action);
    assert.equal(f.confirmations().length, 1, `${action}: the popup was shown, the answer arrived after the agent came back`);
    assert.ok(!f.sbxCalls().some((call) => call[0] === "rm"), `${action}: no sbx rm ran`);
    assert.equal(f.mappings().panes["pane-1"].sandboxName, NAME, `${action}: the mapping is untouched`);
    f.cleanup();
  }
  bridge.stop();
});

test("reconnect and the destructive actions refuse a mapping another process is deleting", () => {
  const deleter = fakeActionProcess();
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { deletingPid: deleter.pid, deletingSince: "2026-09-13T00:00:00.000Z" }) }) });
  for (const action of ["reconnect", "forget-mapping", "replace-sandbox"]) {
    const { result } = runAction(f, action, { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
    assert.equal(result.ok, false, action);
    assert.equal(result.errorKind, "conflict", action);
    assert.match(result.message, /being deleted right now \(pid \d+/, action);
  }
  assert.deepEqual(f.confirmations(), []);
  assert.ok(!f.sbxCalls().some((call) => call[0] === "rm"));
  deleter.stop();
  f.cleanup();
});

test("an orphan whose bridge or deletion is still running is refused before it is re-homed", () => {
  const bridge = fakeBridgeProcess("wC:p2");
  const busy = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC", bridgePid: bridge.pid, bridgeStartedAt: "2026-09-13T00:00:00.000Z" }) }) });
  const attached = runAction(busy, "reconnect", { context: { focused_pane_id: "wP:p1", workspace_id: "wP" }, env: { FAKE_HERDR_MISSING_PANES: "wC:p2" } });
  assert.equal(attached.result.errorKind, "conflict", JSON.stringify(attached.result));
  assert.match(attached.result.message, /still runs the bridge/);
  assert.deepEqual(Object.keys(busy.mappings().panes), ["wC:p2"], "the mapping was not moved");
  bridge.stop();
  const deleter = fakeActionProcess();
  const deleting = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC", deletingPid: deleter.pid, deletingSince: "2026-09-13T00:00:00.000Z" }) }) });
  for (const action of ["reconnect", "replace-sandbox"]) {
    const { result } = runAction(deleting, action, { context: { focused_pane_id: "wP:p1", workspace_id: "wP" }, env: { FAKE_HERDR_MISSING_PANES: "wC:p2", FAKE_POPUP_DECISION: "confirmed" } });
    assert.equal(result.errorKind, "conflict", action);
    assert.match(result.message, /being deleted right now/, action);
  }
  assert.deepEqual(Object.keys(deleting.mappings().panes), ["wC:p2"]);
  assert.ok(!deleting.herdrCalls().some((call) => call[1] === "split"), "no replacement pane was opened");
  deleter.stop();
  busy.cleanup();
  deleting.cleanup();
});

test("re-homing waits for the old pane's lock and gives up cleanly when it stays held", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "wC:p2": mappingFor({ worktree: p.worktree }, { paneId: "wC:p2", workspaceId: "wC" }) }) });
  writeFileSync(`${path.join(f.stateDir, "panes")}/${readdirSync(path.join(f.stateDir, "panes")).find((name) => name.endsWith(".json"))}.lock`, `${process.pid}\n`);
  const { result } = runAction(f, "reconnect", { context: { focused_pane_id: "wP:p1", workspace_id: "wP" }, env: { FAKE_HERDR_MISSING_PANES: "wC:p2", HERDR_SBX_LOCK_WAIT_MS: "200" } });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "conflict");
  assert.match(result.message, /locked by process/);
  assert.deepEqual(Object.keys(f.mappings().panes), ["wC:p2"], "the mapping stayed where it was");
  assert.ok(f.herdrCalls().some((call) => call[1] === "close"), "the pane opened for the move was closed again");
  assert.ok(!f.herdrCalls().some((call) => call[1] === "run"), "no bridge was started");
  f.cleanup();
});

test("prune-mappings keeps a mapping whose bridge is still creating a sandbox that sbx does not list yet", () => {
  const bridge = fakeBridgeProcess("wA:p1");
  const f = createFixture({ panes: (p) => ({ "wA:p1": mappingFor({ worktree: p.worktree }, { paneId: "wA:p1", lifecycleState: "creating", bridgePid: bridge.pid, bridgeStartedAt: "2026-09-13T00:00:00.000Z" }) }) });
  const { result } = runAction(f, "prune-mappings", { env: { FAKE_HERDR_MISSING_PANES: "wA:p1" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.pruned, []);
  assert.ok(result.kept.some((item) => item.paneId === "wA:p1" && /a bridge or a deletion still owns this mapping/.test(item.reason)), JSON.stringify(result.kept));
  assert.deepEqual(Object.keys(f.mappings().panes), ["wA:p1"]);
  bridge.stop();
  f.cleanup();
});

test("replace-sandbox keeps its claim until the replacement is written and stops when it is taken over", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const ok = runAction(f, "replace-sandbox", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
  assert.equal(ok.result.ok, true, JSON.stringify(ok.result));
  const replaced = f.mappings().panes["pane-1"];
  assert.notEqual(replaced.sandboxName, NAME);
  assert.equal(replaced.deletingPid, undefined, "the fresh mapping carries no claim");
  assert.deepEqual(replaced.deletedSandboxNames, [NAME]);

  const other = fakeActionProcess();
  const stolen = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { result } = runAction(stolen, "replace-sandbox", { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed", FAKE_SBX_RM_TOUCH_PANE: "pane-1", FAKE_SBX_RM_TOUCH_DELETING_PID: String(other.pid) } });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "conflict");
  assert.match(result.message, /taken over by process/);
  const left = stolen.mappings().panes["pane-1"];
  assert.equal(left.sandboxName, NAME, "no replacement mapping was written over the other process's claim");
  assert.deepEqual(left.deletedSandboxNames, [NAME], "what was deleted is recorded for whoever owns the mapping now");
  assert.ok(!stolen.herdrCalls().some((call) => call[1] === "run"), "no bridge was started");
  other.stop();
  f.cleanup();
  stolen.cleanup();
});

test("an open shell blocks forget-mapping and replace-sandbox but not reconnect, and a busy displaced mapping stops start-agent", () => {
  const shell = fakeShellProcess("pane-1");
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "stopped", shellPids: [{ pid: shell.pid, since: "2026-09-13T00:00:00.000Z" }] }) }) });
  for (const action of ["forget-mapping", "replace-sandbox"]) {
    const { result } = runAction(f, action, { context: { focused_pane_id: "pane-1" }, env: { FAKE_POPUP_DECISION: "confirmed" } });
    assert.equal(result.errorKind, "conflict", action);
    assert.match(result.message, /an open-shell session/, action);
  }
  assert.deepEqual(f.confirmations(), [], "refused before any popup");
  const back = runAction(f, "reconnect", { context: { focused_pane_id: "pane-1" } });
  assert.equal(back.result.ok, true, JSON.stringify(back.result));
  shell.stop();

  const bridge = fakeBridgeProcess("pane-new-1");
  const reused = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-new-1": mappingFor({ worktree: p.worktree }, { paneId: "pane-new-1", bridgePid: bridge.pid, bridgeStartedAt: "2026-09-13T00:00:00.000Z" }) }) });
  const started = runAction(reused, "start-agent", { context: { focused_pane_id: "wA:p1", workspace_id: "wA", workspace_cwd: reused.worktree } });
  assert.equal(started.result.errorKind, "conflict", JSON.stringify(started.result));
  assert.match(started.result.message, /still in use/);
  assert.equal(reused.mappings().panes["pane-new-1"].sandboxName, NAME, "the live mapping was not overwritten");
  assert.ok(!reused.herdrCalls().some((call) => call[1] === "run"), "no bridge was started into the busy pane");
  bridge.stop();
  f.cleanup();
  reused.cleanup();
});
