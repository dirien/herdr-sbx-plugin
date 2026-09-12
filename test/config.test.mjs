import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_DEFAULTS, loadConfig, validateConfig } from "../src/config.mjs";

test("validateConfig returns defaults for an empty object", () => {
  const config = validateConfig({});
  assert.equal(config.agentKind, "claude-code");
  assert.equal(config.workspaceMode, "mount");
  assert.deepEqual(config.kits, []);
  assert.equal(config.paneRatio, 0.5);
  assert.equal(config.cleanupOnWorktreeRemoved, true);
});

test("validateConfig rejects unknown keys", () => {
  assert.throws(() => validateConfig({ agentKnid: "codex" }), /Unknown config key\(s\): agentKnid/);
});

const invalidCases = [
  ["agentKind", 42, /agentKind/],
  ["agentArgs", { codex: "not-an-array" }, /agentArgs/],
  ["workspaceMode", "upload", /workspaceMode/],
  ["kits", ["ok", ""], /kits/],
  ["cpus", 1.5, /cpus/],
  ["memory", "", /memory/],
  ["paneRatio", 1, /paneRatio/],
  ["paneDirection", "left", /paneDirection/],
  ["sandboxNamePrefix", "-bad", /sandboxNamePrefix/],
  ["cleanupOnWorktreeRemoved", "yes", /cleanupOnWorktreeRemoved/],
  ["template", 7, /template/],
  ["env", ["1BAD=x"], /env/],
  ["openIn", "window", /openIn/],
  ["reportAgentStatus", "yes", /reportAgentStatus/],
  ["agentEnv", ["has space=1"], /agentEnv/],
];

for (const [key, value, pattern] of invalidCases) {
  test(`validateConfig rejects invalid ${key}`, () => {
    assert.throws(() => validateConfig({ [key]: value }), (error) => error.errorKind === "config" && pattern.test(error.message));
  });
}

test("env lists accept KEY=VALUE and bare KEY entries", () => {
  assert.doesNotThrow(() => validateConfig({ env: ["CI=1", "HOME_TOKEN", "EMPTY="], agentEnv: ["X=a=b"] }));
});

test("every default key is accepted when passed explicitly", () => {
  assert.doesNotThrow(() => validateConfig({ ...CONFIG_DEFAULTS }));
});

test("loadConfig reads config.json and resolves sbxBin from the environment", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-config-"));
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ agentKind: "codex", kits: ["ghcr.io/example/kit:1"] }));
  const config = loadConfig(dir, { HERDR_SBX_BIN: "/opt/sbx" });
  assert.equal(config.agentKind, "codex");
  assert.deepEqual(config.kits, ["ghcr.io/example/kit:1"]);
  assert.equal(config.sbxBin, "/opt/sbx");
});

test("loadConfig prefers config.sbxBin over the environment and defaults to sbx", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-config-"));
  assert.equal(loadConfig(dir, {}).sbxBin, "sbx");
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ sbxBin: "/usr/local/bin/sbx" }));
  assert.equal(loadConfig(dir, { HERDR_SBX_BIN: "/opt/sbx" }).sbxBin, "/usr/local/bin/sbx");
});

test("loadConfig reports invalid JSON as a config error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-config-"));
  writeFileSync(path.join(dir, "config.json"), "{ not json");
  assert.throws(() => loadConfig(dir, {}), (error) => error.errorKind === "config" && /not valid JSON/.test(error.message));
});
