import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_AGENTS, availableAgents, resolveAgent, validateCustomAgent } from "../src/agents.mjs";
import { CONFIG_DEFAULTS } from "../src/config.mjs";

test("built-in adapters launch the documented sbx default commands", () => {
  const claude = resolveAgent({ ...CONFIG_DEFAULTS, agentKind: "claude-code" });
  assert.deepEqual(claude.launchArgv, ["claude", "--dangerously-skip-permissions"]);
  assert.equal(claude.herdrDetectionKind, "claude");
  assert.deepEqual(resolveAgent({ ...CONFIG_DEFAULTS, agentKind: "codex" }).launchArgv, ["codex", "--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(resolveAgent({ ...CONFIG_DEFAULTS, agentKind: "opencode" }).launchArgv, ["opencode"]);
  assert.equal(Object.keys(BUILTIN_AGENTS).length, 6);
});

const builtinCases = [
  ["claude-code", "claude", ["claude", "--dangerously-skip-permissions"], "claude"],
  ["codex", "codex", ["codex", "--dangerously-bypass-approvals-and-sandbox"], "codex"],
  ["gemini", "gemini", ["gemini", "--yolo"], "gemini"],
  ["opencode", "opencode", ["opencode"], "opencode"],
  ["copilot", "copilot", ["copilot", "--yolo"], "copilot"],
  ["cursor", "cursor", ["cursor-agent", "--yolo"], "cursor"],
];
for (const [kind, sbxAgent, launchArgv, detection] of builtinCases) {
  test(`built-in adapter ${kind} creates the ${sbxAgent} template and launches ${launchArgv.join(" ")}`, () => {
    const agent = resolveAgent({ ...CONFIG_DEFAULTS, agentKind: kind });
    assert.equal(agent.sbxAgent, sbxAgent);
    assert.deepEqual(agent.launchArgv, launchArgv);
    assert.equal(agent.herdrDetectionKind, detection);
    assert.equal(agent.setupScript, null);
    assert.ok(agent.title);
  });
}

test("agentArgs replaces the default arguments entirely", () => {
  const agent = resolveAgent({ ...CONFIG_DEFAULTS, agentKind: "claude-code", agentArgs: { "claude-code": ["--model", "opus"] } });
  assert.deepEqual(agent.launchArgv, ["claude", "--model", "opus"]);
});

test("unknown agent kinds list the available ones", () => {
  assert.throws(() => resolveAgent({ ...CONFIG_DEFAULTS, agentKind: "nope" }), (error) => error.errorKind === "config" && /Available: claude-code/.test(error.message));
});

test("custom agents are validated and can override built-ins", () => {
  const config = { ...CONFIG_DEFAULTS, agentKind: "aider", customAgents: { aider: { title: "Aider", sbxAgent: "shell", command: ["aider"], defaultArgs: ["--yes"], herdrDetectionKind: null, setupScript: "pipx install aider-chat" } } };
  const agent = resolveAgent(config);
  assert.deepEqual(agent.launchArgv, ["aider", "--yes"]);
  assert.equal(agent.setupScript, "pipx install aider-chat");
  assert.ok("aider" in availableAgents(config));
  const overridden = resolveAgent({ ...CONFIG_DEFAULTS, agentKind: "codex", customAgents: { codex: { title: "Codex nightly", sbxAgent: "codex", command: ["codex-nightly"] } } });
  assert.deepEqual(overridden.launchArgv, ["codex-nightly"]);
});

const invalidProfiles = [
  ["Bad Kind", { title: "x", sbxAgent: "shell", command: ["x"] }, /invalid kind/],
  ["a", "string", /must be an object/],
  ["a", { title: "", sbxAgent: "shell", command: ["x"] }, /title/],
  ["a", { title: "x", sbxAgent: "", command: ["x"] }, /sbxAgent/],
  ["a", { title: "x", sbxAgent: "shell", command: [] }, /command/],
  ["a", { title: "x", sbxAgent: "shell", command: ["x"], extra: 1 }, /unknown field/],
  ["a", { title: "x", sbxAgent: "shell", command: ["x"], setupScript: 5 }, /setupScript/],
];
for (const [kind, profile, pattern] of invalidProfiles) {
  test(`validateCustomAgent rejects ${JSON.stringify(profile)}`, () => {
    assert.throws(() => validateCustomAgent(kind, profile), (error) => error.errorKind === "config" && pattern.test(error.message));
  });
}
