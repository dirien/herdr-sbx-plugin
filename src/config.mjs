/**
 * User configuration stored as JSON in HERDR_PLUGIN_CONFIG_DIR/config.json.
 * Unknown keys are rejected so typos never silently fall back to defaults.
 * @module config
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, SBX_BIN_ENV } from "./constants.mjs";
import { PluginError } from "./errors.mjs";

/** Workspace modes understood by the plugin. */
export const WORKSPACE_MODES = Object.freeze(["mount", "clone"]);

/** Directions accepted for the agent pane split. */
export const PANE_DIRECTIONS = Object.freeze(["right", "down"]);

/** Where start-agent puts the agent: a split next to the focused pane or a new tab. */
export const OPEN_MODES = Object.freeze(["split", "tab"]);

/** Every supported key with its default value. */
export const CONFIG_DEFAULTS = Object.freeze({
  agentKind: "claude-code",
  agentArgs: {},
  agentEnv: [],
  customAgents: {},
  workspaceMode: "mount",
  template: null,
  kits: [],
  kitArgs: [],
  env: [],
  envFiles: [],
  publish: [],
  cpus: null,
  memory: null,
  denyNetwork: [],
  extraWorkspaces: [],
  sbxBin: null,
  shell: "bash",
  paneDirection: "right",
  paneRatio: 0.5,
  openIn: "split",
  reportAgentStatus: true,
  sandboxNamePrefix: "herdr",
  cleanupOnWorktreeRemoved: true,
});

/**
 * Returns the config file path for a config directory.
 * @param {string} configDir
 * @returns {string}
 */
export function configPath(configDir) {
  return path.join(configDir, CONFIG_FILE);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

const ENV_ENTRY = /^[A-Za-z_][A-Za-z0-9_]*(=.*)?$/;

function isEnvList(value) {
  return isStringArray(value) && value.every((item) => ENV_ENTRY.test(item));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates a raw config object and merges it over the defaults.
 * @param {Record<string, unknown>} raw
 * @returns {typeof CONFIG_DEFAULTS & Record<string, any>}
 */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new PluginError("config", "config.json must contain a JSON object.");
  }
  const unknown = Object.keys(raw).filter((key) => !(key in CONFIG_DEFAULTS));
  if (unknown.length > 0) {
    throw new PluginError("config", `Unknown config key(s): ${unknown.join(", ")}. Supported keys: ${Object.keys(CONFIG_DEFAULTS).join(", ")}.`);
  }
  const config = { ...CONFIG_DEFAULTS, ...raw };
  const fail = (key, expectation) => {
    throw new PluginError("config", `Config key "${key}" ${expectation}.`);
  };
  if (typeof config.agentKind !== "string" || config.agentKind === "") fail("agentKind", "must be a non-empty string");
  if (!isPlainObject(config.agentArgs) || !Object.values(config.agentArgs).every(isStringArray)) fail("agentArgs", "must map agent kinds to arrays of strings");
  if (!isPlainObject(config.customAgents)) fail("customAgents", "must be an object keyed by agent kind");
  for (const key of ["kits", "kitArgs", "envFiles", "publish", "denyNetwork", "extraWorkspaces"]) {
    if (!isStringArray(config[key])) fail(key, "must be an array of non-empty strings");
  }
  for (const key of ["env", "agentEnv"]) {
    if (!isEnvList(config[key])) fail(key, "must be an array of KEY=VALUE or bare KEY strings");
  }
  if (!WORKSPACE_MODES.includes(config.workspaceMode)) fail("workspaceMode", `must be one of ${WORKSPACE_MODES.join(", ")}`);
  for (const key of ["template", "memory", "sbxBin"]) {
    if (config[key] !== null && (typeof config[key] !== "string" || config[key] === "")) fail(key, "must be a non-empty string or null");
  }
  if (config.cpus !== null && (!Number.isInteger(config.cpus) || config.cpus <= 0)) fail("cpus", "must be a positive integer or null");
  if (typeof config.shell !== "string" || config.shell === "") fail("shell", "must be a non-empty string");
  if (!PANE_DIRECTIONS.includes(config.paneDirection)) fail("paneDirection", `must be one of ${PANE_DIRECTIONS.join(", ")}`);
  if (!OPEN_MODES.includes(config.openIn)) fail("openIn", `must be one of ${OPEN_MODES.join(", ")}`);
  if (typeof config.reportAgentStatus !== "boolean") fail("reportAgentStatus", "must be true or false");
  if (typeof config.paneRatio !== "number" || !(config.paneRatio > 0 && config.paneRatio < 1)) fail("paneRatio", "must be a number between 0 and 1 (exclusive)");
  if (typeof config.sandboxNamePrefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(config.sandboxNamePrefix)) fail("sandboxNamePrefix", "must start with a letter or digit and contain only letters, digits and hyphens");
  if (typeof config.cleanupOnWorktreeRemoved !== "boolean") fail("cleanupOnWorktreeRemoved", "must be true or false");
  return config;
}

/**
 * Loads and validates the configuration, resolving the sbx executable.
 * @param {string} configDir
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ReturnType<typeof validateConfig> & {sbxBin: string}}
 */
export function loadConfig(configDir, env = process.env) {
  const file = configPath(configDir);
  let raw = {};
  if (existsSync(file)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new PluginError("config", `Could not read ${file}: ${error.message}`, { cause: error });
    }
    try {
      raw = text.trim() === "" ? {} : JSON.parse(text);
    } catch (error) {
      throw new PluginError("config", `${file} is not valid JSON: ${error.message}`, { cause: error });
    }
  }
  const config = validateConfig(raw);
  config.sbxBin = config.sbxBin ?? env[SBX_BIN_ENV] ?? "sbx";
  return config;
}
