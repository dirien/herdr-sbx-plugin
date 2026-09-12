import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ACTION_IDS } from "../src/action-main.mjs";
import { BUILTIN_AGENTS } from "../src/agents.mjs";
import { CONFIG_DEFAULTS } from "../src/config.mjs";
import { CONFIRMATION_TIMEOUT_ENV, PLUGIN_ID, RESULT_MARKER, SBX_BIN_ENV } from "../src/constants.mjs";
import { ERROR_KINDS } from "../src/errors.mjs";
import { ROOT } from "./helpers.mjs";

const manifest = readFileSync(path.join(ROOT, "herdr-plugin.toml"), "utf8");
const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

function manifestTables() {
  const parts = manifest.split(/^\[\[(\w+)\]\]$/m);
  const tables = { head: parts[0], actions: [], events: [], panes: [], build: [], link_handlers: [] };
  for (let index = 1; index < parts.length; index += 2) {
    tables[parts[index]].push(parts[index + 1]);
  }
  return tables;
}

function field(block, name) {
  const match = block.match(new RegExp(`^${name} = "([^"]+)"`, "m"));
  return match ? match[1] : null;
}

function commandPath(block) {
  const match = block.match(/^command = \["sh", "(bin\/run\.sh|scripts\/[^"]+)"(?:, "([^"]+)")?\]/m);
  if (!match) {
    return null;
  }
  return match[2] ?? match[1];
}

const tables = manifestTables();

test("manifest header matches the code and package metadata", () => {
  assert.equal(field(tables.head, "id"), PLUGIN_ID);
  assert.equal(field(tables.head, "version"), pkg.version);
  assert.ok(field(tables.head, "min_herdr_version"));
  assert.match(tables.head, /^platforms = \["linux", "macos"\]$/m);
  assert.ok(changelog.includes(`## ${pkg.version}`), "CHANGELOG has a heading for the current version");
});

test("manifest actions and the dispatcher agree", () => {
  const ids = tables.actions.map((block) => field(block, "id"));
  assert.deepEqual([...ids].sort(), [...ACTION_IDS].sort());
  for (const block of tables.actions) {
    assert.ok(field(block, "title"), "every action has a title");
    assert.match(block, /^contexts = \[/m);
  }
});

test("every manifest command points at an existing script through the node shim", () => {
  for (const block of [...tables.actions, ...tables.events, ...tables.panes]) {
    assert.match(block, /^command = \["sh", "bin\/run\.sh", "src\/[a-z-]+\.mjs"\]$/m, block.trim().split("\n")[0]);
    const script = commandPath(block);
    assert.ok(existsSync(path.join(ROOT, script)), `${script} exists`);
  }
  assert.ok(existsSync(path.join(ROOT, "bin", "run.sh")));
  assert.equal(tables.build.length, 1);
  assert.ok(existsSync(path.join(ROOT, commandPath(tables.build[0]))), "build script exists");
  assert.equal(tables.events.length, 1);
  assert.equal(field(tables.events[0], "on"), "worktree.removed");
  assert.deepEqual(tables.panes.map((block) => field(block, "id")), ["deletion-confirmation", "sandboxes"]);
  assert.equal(tables.link_handlers.length, 1);
  assert.ok(ACTION_IDS.includes(field(tables.link_handlers[0], "action")), "link handler names a real action");
  assert.ok(new RegExp(field(tables.link_handlers[0], "pattern")).test("sbx://herdr-claude-code-abc123def456/3000"));
});

test("README documents every action, config key, agent kind and error kind", () => {
  for (const id of ACTION_IDS) {
    assert.ok(readme.includes(`\`${id}\``), `README mentions action ${id}`);
  }
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    assert.ok(readme.includes(`\`${key}\``), `README mentions config key ${key}`);
  }
  for (const kind of Object.keys(BUILTIN_AGENTS)) {
    assert.ok(readme.includes(`\`${kind}\``), `README mentions agent kind ${kind}`);
  }
  for (const kind of ERROR_KINDS) {
    assert.ok(readme.includes(`\`${kind}\``), `README mentions error kind ${kind}`);
  }
  assert.ok(readme.includes(RESULT_MARKER));
});

test("README documents the hook, the popup, the environment overrides and every module", () => {
  for (const token of ["worktree.removed", "deletion-confirmation", SBX_BIN_ENV, CONFIRMATION_TIMEOUT_ENV, "HERDR_AGENT", "docs/manual-testing.md", "sbx://", "bin/run.sh", "scripts/write-node-path.sh", "scripts/install-keybindings.sh"]) {
    assert.ok(readme.includes(token), `README mentions ${token}`);
  }
  for (const file of readdirSync(path.join(ROOT, "src")).filter((name) => name.endsWith(".mjs"))) {
    assert.ok(readme.includes(`src/${file}`), `README file table lists src/${file}`);
  }
});

test("the bootstrap keeps the marker literal in sync with the constant", () => {
  const bootstrap = readFileSync(path.join(ROOT, "src", "action.mjs"), "utf8");
  assert.ok(bootstrap.includes(`const RESULT_MARKER = "${RESULT_MARKER}";`));
  assert.ok(bootstrap.includes(`plugin: "${PLUGIN_ID}"`));
});
