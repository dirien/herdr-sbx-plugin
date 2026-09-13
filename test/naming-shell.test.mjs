import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_NAME_PATTERN, assertSandboxName, sandboxGitRemote, sandboxNameFor, slugify } from "../src/naming.mjs";
import { buildPaneCommand, shellQuote } from "../src/shell.mjs";

test("sandboxNameFor produces valid, unique names", () => {
  const first = sandboxNameFor({ agentKind: "claude-code", localPath: "/tmp/repo", paneId: "pane-1" });
  const second = sandboxNameFor({ agentKind: "claude-code", localPath: "/tmp/repo", paneId: "pane-1" });
  assert.match(first, /^herdr-claude-code-[a-f0-9]{12}$/);
  assert.match(first, SANDBOX_NAME_PATTERN);
  assert.notEqual(first, second);
});

test("sandboxNameFor honors the prefix and slugs odd agent kinds", () => {
  assert.match(sandboxNameFor({ prefix: "Team", agentKind: "My Agent!!", localPath: "/x", paneId: null }), /^team-my-agent-[a-f0-9]{12}$/);
});

const slugCases = [
  ["Claude Code", "claude-code"],
  ["--weird--", "weird"],
  ["", "agent"],
  ["UPPER_case.mixed", "upper-case-mixed"],
];
for (const [input, expected] of slugCases) {
  test(`slugify(${JSON.stringify(input)}) === ${expected}`, () => {
    assert.equal(slugify(input), expected);
  });
}

test("assertSandboxName rejects names sbx would reject", () => {
  for (const bad of ["default", "a", "-abc", "has space", "under_score"]) {
    assert.throws(() => assertSandboxName(bad), /Invalid sandbox name/);
  }
  assert.doesNotThrow(() => assertSandboxName("ok-name.1"));
});

test("sandboxGitRemote follows the sbx clone-mode convention", () => {
  assert.equal(sandboxGitRemote("herdr-codex-abc"), "sandbox-herdr-codex-abc");
});

const quoteCases = [
  ["simple", "simple"],
  ["/abs/path-1.2:x", "/abs/path-1.2:x"],
  ["has space", "'has space'"],
  ["it's", "'it'\\''s'"],
  ["", "''"],
];
for (const [input, expected] of quoteCases) {
  test(`shellQuote(${JSON.stringify(input)})`, () => {
    assert.equal(shellQuote(input), expected);
  });
}

test("shellQuote refuses control characters and backslashes", () => {
  assert.throws(() => shellQuote(`a${String.fromCharCode(10)}b`), (error) => error.errorKind === "target");
  assert.throws(() => shellQuote(`a${String.fromCharCode(92)}b`), (error) => error.errorKind === "target" && /backslash/.test(error.message));
});

test("buildPaneCommand uses env for fish compatibility and quotes words", () => {
  const command = buildPaneCommand({ argv: ["/usr/bin/node", "/plugin root/src/bridge.mjs", "start"], env: { HERDR_AGENT: "claude" } });
  assert.equal(command, "env HERDR_AGENT=claude /usr/bin/node '/plugin root/src/bridge.mjs' start");
  assert.equal(buildPaneCommand({ argv: ["ls"] }), "ls");
  assert.throws(() => buildPaneCommand({ argv: ["ls"], env: { "bad-name": "x" } }), /Invalid environment variable name/);
  assert.throws(() => buildPaneCommand({ argv: [] }), /non-empty argv/);
});

test("shellQuote quotes words that zsh or fish would expand when bare", () => {
  assert.equal(shellQuote("=ls"), "'=ls'", "zsh expands a bare =cmd to its path");
  assert.equal(shellQuote("%1"), "'%1'", "fish expands a bare %job");
  assert.equal(shellQuote("a=b"), "a=b", "an = inside a word is fine");
  assert.equal(shellQuote("50%"), "50%");
});
