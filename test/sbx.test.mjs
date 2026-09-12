import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_DEFAULTS } from "../src/config.mjs";
import { buildCreateArgs, buildExecArgs, classifyFailure, createSbxClient, normalizeSandboxList, timeoutFromEnv } from "../src/sbx.mjs";
import { FAKE_SBX, createFixture } from "./helpers.mjs";

const classifyCases = [
  ['Error: sandbox "x" not found', "not-found"],
  ["no such sandbox: x", "not-found"],
  ["Error: cannot connect to the daemon at /tmp/s.sock: is the daemon running?", "daemon"],
  ["sandboxd is not running", "daemon"],
  ['Error: not logged in; run "sbx login"', "authentication"],
  ["permission denied while opening socket", "permission"],
  ['sandbox "x" already exists', "conflict"],
  ['sandbox "x" has an active session', "conflict"],
  ["dial tcp: connection refused", "network"],
  ["some other failure", "unknown"],
  ["", "unknown"],
];
for (const [output, expected] of classifyCases) {
  test(`classifyFailure(${JSON.stringify(output)}) === ${expected}`, () => {
    assert.equal(classifyFailure(output), expected);
  });
}

test("buildCreateArgs renders every config knob in sbx order", () => {
  const config = {
    ...CONFIG_DEFAULTS,
    template: "docker/sandbox-templates:shell-docker",
    kits: ["ghcr.io/acme/kit:1", "./local-kit"],
    kitArgs: ["region=eu"],
    env: ["CI=1", "HOME_TOKEN"],
    envFiles: ["/etc/sbx.env"],
    publish: ["8080:3000"],
    cpus: 4,
    memory: "8g",
    denyNetwork: ["example.com"],
    workspaceMode: "clone",
    extraWorkspaces: ["/data/fixtures:ro"],
  };
  const args = buildCreateArgs({ config, sandboxName: "herdr-x-1", agent: { sbxAgent: "claude" }, localPath: "/repo" });
  assert.deepEqual(args, [
    "create", "--name", "herdr-x-1",
    "--template", "docker/sandbox-templates:shell-docker",
    "--kit", "ghcr.io/acme/kit:1", "--kit", "./local-kit",
    "--kit-arg", "region=eu",
    "--env", "CI=1", "--env", "HOME_TOKEN",
    "--env-file", "/etc/sbx.env",
    "--publish", "8080:3000",
    "--cpus", "4",
    "--memory", "8g",
    "--deny-network", "example.com",
    "--clone",
    "claude", "/repo", "/data/fixtures:ro",
  ]);
});

test("buildCreateArgs with defaults is minimal", () => {
  assert.deepEqual(buildCreateArgs({ config: CONFIG_DEFAULTS, sandboxName: "n-1", agent: { sbxAgent: "codex" }, localPath: "/repo" }), ["create", "--name", "n-1", "codex", "/repo"]);
});

test("buildExecArgs mirrors docker exec flags", () => {
  assert.deepEqual(buildExecArgs({ sandboxName: "n-1", workdir: "/repo", interactive: true, tty: true, env: ["A=1"], argv: ["claude", "--flag"] }), ["exec", "--interactive", "--tty", "--workdir", "/repo", "--env", "A=1", "n-1", "--", "claude", "--flag"]);
  assert.deepEqual(buildExecArgs({ sandboxName: "n-1", argv: ["true"] }), ["exec", "n-1", "--", "true"]);
});

test("normalizeSandboxList accepts the shapes sbx ls --json may print", () => {
  const wrapped = normalizeSandboxList({ sandboxes: [{ name: "a", status: "running" }, { Name: "b", Status: "stopped" }] });
  assert.deepEqual(wrapped.map((item) => [item.name, item.status]), [["a", "running"], ["b", "stopped"]]);
  assert.deepEqual(normalizeSandboxList([{ name: "c" }]).map((item) => item.name), ["c"]);
  assert.deepEqual(normalizeSandboxList({ "m-1": { status: "running" }, "m-2": { name: "m-2", state: "stopped" } }).map((item) => [item.name, item.status]), [["m-1", "running"], ["m-2", "stopped"]]);
  assert.deepEqual(normalizeSandboxList(null), []);
  assert.deepEqual(normalizeSandboxList({}), []);
  assert.deepEqual(normalizeSandboxList({ sandboxes: [] }), []);
  assert.deepEqual(normalizeSandboxList({ sandboxes: null }), [], "a nil Go slice marshals to null");
  assert.deepEqual(normalizeSandboxList({ items: null }), []);
});

test("normalizeSandboxList refuses to mistake an unknown payload for an empty list", () => {
  assert.throws(() => normalizeSandboxList({ data: { sandboxes: [] } }), (error) => error.errorKind === "unknown" && /does not understand/.test(error.message));
  assert.throws(() => normalizeSandboxList([{ label: "no-name" }]), (error) => error.errorKind === "unknown" && /name field/.test(error.message));
  assert.throws(() => normalizeSandboxList([{ name: "a" }, { id: "" }]), (error) => error.errorKind === "unknown" && /1 sandbox entry without/.test(error.message), "a partially unreadable list is rejected as a whole");
  assert.throws(() => normalizeSandboxList("text"), (error) => error.errorKind === "unknown");
});

test("createSbxClient reports a missing executable as a startup error", () => {
  const client = createSbxClient({ bin: "/definitely/not/here/sbx" });
  assert.throws(() => client.version(), (error) => error.errorKind === "startup" && /was not found/.test(error.message));
});

test("createSbxClient classifies non-zero exits from the fake CLI", () => {
  const fixture = createFixture({ sandboxes: [{ name: "live", status: "running" }] });
  const client = createSbxClient({ bin: FAKE_SBX, env: fixture.env() });
  assert.equal(client.findSandbox("live").status, "running");
  assert.equal(client.findSandbox("nope"), null);
  assert.throws(() => client.runChecked(["stop", "nope"], "stopping"), (error) => error.errorKind === "not-found");
  const daemonClient = createSbxClient({ bin: FAKE_SBX, env: fixture.env({ FAKE_SBX_FAIL: "ls:daemon" }) });
  assert.throws(() => daemonClient.listSandboxes(), (error) => error.errorKind === "daemon");
  assert.equal(client.version().json.server.version, "0.42.1");
  assert.equal(client.daemonStatus().ok, true);
  fixture.cleanup();
});

test("classifyFailure reads a daemon or credential failure before the broad not-found wording", () => {
  assert.equal(classifyFailure("Error: cannot connect to the daemon at /run/sandboxd.sock: socket not found"), "daemon");
  assert.equal(classifyFailure('Error: not logged in; token not found, run "sbx login"'), "authentication");
  assert.equal(classifyFailure('Error: sandbox "x" not found'), "not-found");
  assert.equal(classifyFailure(""), "unknown");
  assert.equal(timeoutFromEnv("250", 5), 250);
  assert.equal(timeoutFromEnv("", 5), 5);
  assert.equal(timeoutFromEnv("0", 5), 5);
  assert.equal(timeoutFromEnv(undefined, 5), 5);
});
