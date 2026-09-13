import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { parseBridgeArgs } from "../src/bridge-main.mjs";
import { FAKE_SBX, createFixture, fakeActionProcess, fakeShellProcess, mappingFor, readJsonLines, runBridge } from "./helpers.mjs";

const NAME = "herdr-claude-code-abc123def456";

test("start creates the sandbox, verifies the agent and attaches it", () => {
  const f = createFixture({ config: { kits: ["ghcr.io/acme/kit:1"] }, panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  const { status, stdout } = runBridge(f, "start", "pane-1");
  assert.equal(status, 0, stdout);
  const calls = f.sbxCalls();
  assert.deepEqual(calls[0], ["ls", "--json"]);
  assert.deepEqual(calls[1], ["create", "--name", NAME, "--kit", "ghcr.io/acme/kit:1", "claude", f.worktree]);
  assert.deepEqual(calls[2], ["exec", "--workdir", f.worktree, NAME, "--", "sh", "-c", "command -v claude"], "the probe runs where and how the launch runs");
  assert.deepEqual(calls[3], ["exec", "--interactive", "--tty", "--workdir", f.worktree, NAME, "--", "claude", "--dangerously-skip-permissions"]);
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "ready");
  assert.match(stdout, /Creating Docker Sandbox/);
  assert.match(stdout, /Created sandbox/);
  assert.match(stdout, /exited with code 0/);
  assert.equal(f.sbxSandboxes()[0].name, NAME);
  f.cleanup();
});

test("connect passes HERDR_AGENT through to the interactive exec environment", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { status } = runBridge(f, "connect", "pane-1", { env: { HERDR_AGENT: "claude" } });
  assert.equal(status, 0);
  assert.equal(readJsonLines(f.sbxLog).at(-1).herdrAgent, "claude");
  f.cleanup();
});

test("start acknowledges itself before touching sbx and clears its own name from the deletion checkpoint", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional", deletedSandboxNames: [NAME, "older-sandbox"] }) }) });
  const { status, stdout } = runBridge(f, "start", "pane-1");
  assert.equal(status, 0, stdout);
  const mapping = f.mappings().panes["pane-1"];
  assert.ok(mapping.bridgeStartedAt, "bridgeStartedAt recorded");
  assert.deepEqual(mapping.deletedSandboxNames, ["older-sandbox"], "the recreated sandbox left the checkpoint");
  const broken = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  runBridge(broken, "start", "pane-1", { env: { FAKE_SBX_FAIL: "ls:daemon" } });
  assert.ok(broken.mappings().panes["pane-1"].bridgeStartedAt, "acknowledged even though the first sbx call failed");
  broken.cleanup();
  f.cleanup();
});

test("start reuses an existing sandbox", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "stopped" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  const { status, stdout } = runBridge(f, "start", "pane-1");
  assert.equal(status, 0, stdout);
  assert.deepEqual(f.sbxCalls().map((call) => call[0]), ["ls", "exec", "exec"]);
  assert.match(stdout, /already exists/);
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "ready");
  f.cleanup();
});

test("start records a create failure and exits non-zero", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  const { status, stdout } = runBridge(f, "start", "pane-1", { env: { FAKE_SBX_FAIL: "create:auth" } });
  assert.equal(status, 1);
  const mapping = f.mappings().panes["pane-1"];
  assert.equal(mapping.lifecycleState, "failed");
  assert.equal(mapping.lastError.kind, "authentication");
  assert.match(stdout, /sbx login/);
  f.cleanup();
});

test("start fails when the agent command is missing inside the sandbox", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  const { status, stdout } = runBridge(f, "start", "pane-1", { env: { FAKE_SBX_EXEC_EXIT: "127" } });
  assert.equal(status, 1);
  const mapping = f.mappings().panes["pane-1"];
  assert.equal(mapping.lifecycleState, "failed");
  assert.equal(mapping.lastError.kind, "config");
  assert.match(stdout, /not available inside sandbox/);
  assert.equal(f.sbxCalls().filter((call) => call.includes("--interactive")).length, 0);
  f.cleanup();
});

test("start runs a custom agent setup script before probing the command", () => {
  const config = { agentKind: "aider", customAgents: { aider: { title: "Aider", sbxAgent: "shell", command: ["aider"], defaultArgs: ["--yes"], setupScript: "pipx install aider-chat" } } };
  const f = createFixture({ config, panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional", agentKind: "aider", sbxAgent: "shell" }) }) });
  const { status, stdout } = runBridge(f, "start", "pane-1");
  assert.equal(status, 0, stdout);
  const calls = f.sbxCalls();
  assert.deepEqual(calls[1].slice(-2), ["shell", f.worktree]);
  assert.deepEqual(calls[2], ["exec", "--workdir", f.worktree, NAME, "--", "bash", "-lc", "pipx install aider-chat"]);
  const recreated = createFixture({ config, panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "ready", agentKind: "aider", sbxAgent: "shell", setupScriptRanAt: "2026-09-01T00:00:00.000Z" }) }) });
  assert.equal(runBridge(recreated, "start", "pane-1").status, 0);
  assert.ok(recreated.sbxCalls().some((call) => call.includes("pipx install aider-chat")), "a recreated VM runs the setup script again");
  recreated.cleanup();
  assert.deepEqual(calls[3], ["exec", "--workdir", f.worktree, NAME, "--", "sh", "-c", "command -v aider"]);
  assert.deepEqual(calls[4].slice(-2), ["aider", "--yes"]);
  assert.match(stdout, /setup script/);
  assert.ok(f.mappings().panes["pane-1"].setupScriptRanAt);
  const again = runBridge(f, "start", "pane-1");
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, /already ran/);
  assert.equal(f.sbxCalls().filter((call) => call.includes("pipx install aider-chat")).length, 1);
  f.cleanup();
});

test("start recreates a sandbox in the mode its mapping recorded, not the current config", () => {
  const cloneMapping = createFixture({ config: { workspaceMode: "mount" }, panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional", workspaceMode: "clone" }) }) });
  assert.equal(runBridge(cloneMapping, "start", "pane-1").status, 0);
  assert.ok(cloneMapping.sbxCalls()[1].includes("--clone"), "clone mapping keeps --clone although config says mount");
  const mountMapping = createFixture({ config: { workspaceMode: "clone" }, panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional", workspaceMode: "mount" }) }) });
  assert.equal(runBridge(mountMapping, "start", "pane-1").status, 0);
  assert.ok(!mountMapping.sbxCalls()[1].includes("--clone"), "mount mapping stays a mount although config says clone");
  assert.ok(mountMapping.sbxCalls()[3].includes("--workdir"), "mount mapping still gets a working directory");
  mountMapping.cleanup();
  cloneMapping.cleanup();
});

test("an existing clone-mode sandbox reconnects even when its host directory is gone", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "stopped" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: path.join(p.root, "removed-worktree") }, { lifecycleState: "provisional", workspaceMode: "clone" }) }) });
  const { status, stdout } = runBridge(f, "start", "pane-1");
  assert.equal(status, 0, stdout);
  assert.ok(!f.sbxCalls().some((call) => call[0] === "create"), "the existing clone is reused, not recreated");
  const missing = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: path.join(p.root, "removed-worktree") }, { lifecycleState: "provisional", workspaceMode: "clone" }) }) });
  const recreate = runBridge(missing, "start", "pane-1");
  assert.equal(recreate.status, 1);
  assert.match(recreate.stdout, /not an existing directory/, "creating a new sandbox still needs the host directory");
  missing.cleanup();
  f.cleanup();
});

test("start in clone mode passes --clone and never forces a working directory", () => {
  const f = createFixture({ config: { workspaceMode: "clone" }, panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional", workspaceMode: "clone" }) }) });
  const { status, stdout } = runBridge(f, "start", "pane-1");
  assert.equal(status, 0, stdout);
  const calls = f.sbxCalls();
  assert.deepEqual(calls[1], ["create", "--name", NAME, "--clone", "claude", f.worktree]);
  assert.deepEqual(calls[2], ["exec", NAME, "--", "sh", "-c", "command -v claude"], "no working directory in clone mode, for the probe either");
  assert.deepEqual(calls[3], ["exec", "--interactive", "--tty", NAME, "--", "claude", "--dangerously-skip-permissions"]);
  assert.ok(!calls.some((call) => call.includes("--workdir")));
  f.cleanup();
});

test("connect passes agentEnv and relaunches the recorded agent", () => {
  const f = createFixture({ config: { agentEnv: ["FOO=bar"] }, sandboxes: [{ name: NAME, status: "stopped" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { status } = runBridge(f, "connect", "pane-1");
  assert.equal(status, 0);
  assert.deepEqual(f.sbxCalls()[0], ["exec", "--interactive", "--tty", "--workdir", f.worktree, "--env", "FOO=bar", NAME, "--", "claude", "--dangerously-skip-permissions"]);
  const probed = createFixture({ config: { agentEnv: ["FOO=bar"] }, panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  assert.equal(runBridge(probed, "start", "pane-1").status, 0);
  assert.deepEqual(probed.sbxCalls()[2], ["exec", "--workdir", f.worktree === probed.worktree ? f.worktree : probed.worktree, "--env", "FOO=bar", NAME, "--", "sh", "-c", "command -v claude"], "agentEnv reaches the probe too");
  probed.cleanup();
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "ready");
  assert.ok(f.mappings().panes["pane-1"].lastConnectedAt);
  f.cleanup();
});

test("connect marks a vanished sandbox as missing using sbx ls, never an exec that would restart it", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { status, stdout } = runBridge(f, "connect", "pane-1");
  assert.equal(status, 1);
  assert.deepEqual(f.sbxCalls().map((call) => call[0]), ["exec", "ls"]);
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "missing");
  assert.match(stdout, /no longer exists/);
  const stopped = createFixture({ sandboxes: [{ name: NAME, status: "stopped" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const killed = runBridge(stopped, "connect", "pane-1", { env: { FAKE_SBX_EXEC_EXIT: "137" } });
  assert.equal(killed.status, 137);
  assert.equal(stopped.mappings().panes["pane-1"].lifecycleState, "ready");
  assert.ok(!stopped.sbxCalls().some((call) => call[0] === "exec" && call.includes("true")), "no exec probe after a killed session");
  stopped.cleanup();
  f.cleanup();
});

test("connect leaves the mapping alone when the agent merely exits non-zero", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { status, stdout } = runBridge(f, "connect", "pane-1", { env: { FAKE_SBX_EXEC_EXIT: "2" } });
  assert.equal(status, 2);
  assert.equal(f.mappings().panes["pane-1"].lifecycleState, "ready");
  assert.doesNotMatch(stdout, /no longer exists/);
  f.cleanup();
});

test("connect omits --workdir in clone mode", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { workspaceMode: "clone" }) }) });
  assert.equal(runBridge(f, "connect", "pane-1").status, 0);
  assert.deepEqual(f.sbxCalls()[0], ["exec", "--interactive", "--tty", NAME, "--", "claude", "--dangerously-skip-permissions"]);
  f.cleanup();
});

test("start treats a create conflict as an existing sandbox", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "provisional" }) }) });
  const { status, stdout } = runBridge(f, "start", "pane-1", { env: { FAKE_SBX_FAIL: "create:conflict" } });
  assert.equal(status, 1, stdout);
  assert.match(stdout, /already exists/);
  assert.equal(f.sbxCalls().filter((call) => call[0] === "create").length, 1);
  f.cleanup();
});

test("connect refuses mappings that were never prepared", () => {
  const f = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "failed" }) }) });
  const { status, stdout } = runBridge(f, "connect", "pane-1");
  assert.equal(status, 1);
  assert.match(stdout, /not ready/);
  assert.deepEqual(f.sbxCalls(), []);
  f.cleanup();
});

test("shell opens a login shell without touching the agent's mapping", () => {
  const f = createFixture({ config: { shell: "zsh" }, sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { lifecycleState: "stopped" }) }) });
  const before = f.mappings().panes["pane-1"];
  const { status } = runBridge(f, "shell", "pane-1");
  assert.equal(status, 0);
  assert.deepEqual(f.sbxCalls()[0], ["exec", "--interactive", "--tty", "--workdir", f.worktree, NAME, "--", "zsh", "-l"]);
  const { shellPids, updatedAt, revision, ...after } = f.mappings().panes["pane-1"];
  const { updatedAt: beforeUpdatedAt, revision: beforeRevision, ...beforeRest } = before;
  assert.deepEqual(shellPids, [], "the shell registered itself for the duration and released again");
  assert.deepEqual(after, beforeRest, "no lifecycle field changed");
  const gone = createFixture({ panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  assert.equal(runBridge(gone, "shell", "pane-1").status, 1);
  assert.equal(gone.mappings().panes["pane-1"].lifecycleState, "ready");
  gone.cleanup();
  f.cleanup();
});

test("connect reports agents Herdr cannot detect and releases them afterwards", () => {
  const config = { agentKind: "aider", customAgents: { aider: { title: "Aider", sbxAgent: "shell", command: ["aider"] } } };
  const f = createFixture({ config, sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { agentKind: "aider", sbxAgent: "shell" }) }) });
  assert.equal(runBridge(f, "connect", "pane-1").status, 0);
  const calls = f.herdrCalls();
  assert.deepEqual(calls[0], ["pane", "report-agent", "pane-1", "--source", "sbx.sandbox", "--agent", "aider", "--state", "unknown", "--message", `Aider in Docker Sandbox ${NAME}`]);
  assert.deepEqual(calls[1], ["pane", "release-agent", "pane-1", "--source", "sbx.sandbox", "--agent", "aider"]);
  const builtin = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  assert.equal(runBridge(builtin, "connect", "pane-1").status, 0);
  assert.deepEqual(builtin.herdrCalls(), []);
  const off = createFixture({ config: { ...config, reportAgentStatus: false }, sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { agentKind: "aider", sbxAgent: "shell" }) }) });
  assert.equal(runBridge(off, "connect", "pane-1").status, 0);
  assert.deepEqual(off.herdrCalls(), []);
  off.cleanup();
  builtin.cleanup();
  f.cleanup();
});

test("a failing report never blocks the agent", () => {
  const config = { agentKind: "aider", customAgents: { aider: { title: "Aider", sbxAgent: "shell", command: ["aider"] } } };
  const f = createFixture({ config, sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { agentKind: "aider", sbxAgent: "shell" }) }) });
  const { status, stdout } = runBridge(f, "connect", "pane-1", { env: { FAKE_HERDR_FAIL: "pane report-agent" } });
  assert.equal(status, 0);
  assert.match(stdout, /could not report the agent/);
  assert.ok(f.sbxCalls().some((call) => call.includes("--interactive")));
  f.cleanup();
});

test("the bridge prefers the sbx executable the action resolved over its own environment", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const withoutFlag = runBridge(f, "connect", "pane-1", { env: { HERDR_SBX_BIN: "/definitely/missing/sbx" } });
  assert.equal(withoutFlag.status, 1, "the pane's own environment cannot find sbx");
  assert.match(withoutFlag.stdout, /sbx CLI was not found/);
  const withFlag = runBridge(f, "connect", "pane-1", { env: { HERDR_SBX_BIN: "/definitely/missing/sbx" }, args: ["--sbx-bin", FAKE_SBX, "--launch-id", "abc123"] });
  assert.equal(withFlag.status, 0, withFlag.stdout);
  assert.equal(f.mappings().panes["pane-1"].bridgeLaunchId, "abc123");
  f.cleanup();
});

test("bridge reports bad arguments", () => {
  assert.throws(() => parseBridgeArgs(["dance"]), /Unknown bridge mode/);
  assert.throws(() => parseBridgeArgs(["start", "--state-dir", "/s"]), /Missing bridge option/);
  assert.throws(() => parseBridgeArgs(["start", "--bogus", "x"]), /Unexpected bridge argument/);
  assert.deepEqual(parseBridgeArgs(["shell", "--state-dir", "/s", "--config-dir", "/c", "--pane-id", "p"]), { mode: "shell", stateDir: "/s", configDir: "/c", paneId: "p", herdrBin: "herdr", sbxBin: null, launchId: null });
  assert.equal(parseBridgeArgs(["start", "--state-dir", "/s", "--config-dir", "/c", "--pane-id", "p", "--herdr-bin", "/opt/herdr"]).herdrBin, "/opt/herdr");
});

test("the bridge gives the mapping back when it exits, so a recycled pid can never look busy", () => {
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }) }) });
  const { status } = runBridge(f, "connect", "pane-1", { args: ["--launch-id", "abc123"] });
  assert.equal(status, 0);
  const entry = f.mappings().panes["pane-1"];
  assert.equal(entry.bridgePid, null);
  assert.ok(entry.bridgeExitedAt, "exit is recorded");
  assert.equal(entry.bridgeLaunchId, "abc123", "the acknowledgement itself is kept for the action that waited on it");
  f.cleanup();
});

test("the bridge does not attach while an action is deleting the mapping's sandboxes", () => {
  const deleter = fakeActionProcess();
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { deletingPid: deleter.pid, deletingSince: "2026-09-13T00:00:00.000Z" }) }) });
  const { status, stdout } = runBridge(f, "connect", "pane-1");
  assert.equal(status, 1);
  assert.match(stdout, /being deleted right now/);
  assert.ok(!f.sbxCalls().some((call) => call[0] === "exec"), "no attach happened");
  deleter.stop();
  f.cleanup();
});

test("the shell bridge does not open into a deletion in progress", () => {
  const deleter = fakeActionProcess();
  const f = createFixture({ sandboxes: [{ name: NAME, status: "running" }], panes: (p) => ({ "pane-1": mappingFor({ worktree: p.worktree }, { deletingPid: deleter.pid, deletingSince: "2026-09-13T00:00:00.000Z" }) }) });
  const { status, stdout } = runBridge(f, "shell", "pane-1");
  assert.equal(status, 1);
  assert.match(stdout, /not opening a shell/);
  assert.ok(!f.sbxCalls().some((call) => call[0] === "exec"));
  deleter.stop();
  const stale = fakeShellProcess("pane-1");
  stale.stop();
  f.cleanup();
});
