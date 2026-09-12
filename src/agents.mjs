/**
 * Agent adapters: which sbx agent template to create, which command to launch
 * inside the sandbox, and which label tells Herdr's screen detection what it
 * is looking at. Defaults mirror the startup commands documented for each
 * Docker Sandboxes agent template.
 * @module agents
 */
import { PluginError } from "./errors.mjs";

/** Built-in adapters keyed by agent kind. */
export const BUILTIN_AGENTS = Object.freeze({
  "claude-code": {
    title: "Claude Code",
    sbxAgent: "claude",
    command: ["claude"],
    defaultArgs: ["--dangerously-skip-permissions"],
    herdrDetectionKind: "claude",
    setupScript: null,
  },
  codex: {
    title: "Codex CLI",
    sbxAgent: "codex",
    command: ["codex"],
    defaultArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    herdrDetectionKind: "codex",
    setupScript: null,
  },
  gemini: {
    title: "Gemini CLI",
    sbxAgent: "gemini",
    command: ["gemini"],
    defaultArgs: ["--yolo"],
    herdrDetectionKind: "gemini",
    setupScript: null,
  },
  opencode: {
    title: "OpenCode",
    sbxAgent: "opencode",
    command: ["opencode"],
    defaultArgs: [],
    herdrDetectionKind: "opencode",
    setupScript: null,
  },
  copilot: {
    title: "GitHub Copilot CLI",
    sbxAgent: "copilot",
    command: ["copilot"],
    defaultArgs: ["--yolo"],
    herdrDetectionKind: "copilot",
    setupScript: null,
  },
  cursor: {
    title: "Cursor Agent",
    sbxAgent: "cursor",
    command: ["cursor-agent"],
    defaultArgs: ["--yolo"],
    herdrDetectionKind: "cursor",
    setupScript: null,
  },
});

const KIND_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates one custom agent profile from config.customAgents.
 * @param {string} kind
 * @param {unknown} profile
 * @returns {{title: string, sbxAgent: string, command: string[], defaultArgs: string[], herdrDetectionKind: string|null, setupScript: string|null}}
 */
export function validateCustomAgent(kind, profile) {
  const fail = (reason) => {
    throw new PluginError("config", `customAgents.${kind} ${reason}.`);
  };
  if (!KIND_PATTERN.test(kind)) fail("has an invalid kind; use lowercase letters, digits and hyphens");
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) fail("must be an object");
  const known = ["title", "sbxAgent", "command", "defaultArgs", "herdrDetectionKind", "setupScript"];
  const unknown = Object.keys(profile).filter((key) => !known.includes(key));
  if (unknown.length > 0) fail(`has unknown field(s): ${unknown.join(", ")}`);
  const { title, sbxAgent, command, defaultArgs = [], herdrDetectionKind = null, setupScript = null } = /** @type {any} */ (profile);
  if (typeof title !== "string" || title === "") fail("needs a non-empty title");
  if (typeof sbxAgent !== "string" || sbxAgent === "") fail("needs sbxAgent: the agent name or sandbox kit reference passed to sbx create");
  if (!isStringArray(command) || command.length === 0) fail("needs command: a non-empty array of strings launched inside the sandbox");
  if (!isStringArray(defaultArgs)) fail("defaultArgs must be an array of strings");
  if (herdrDetectionKind !== null && (typeof herdrDetectionKind !== "string" || herdrDetectionKind === "")) fail("herdrDetectionKind must be a non-empty string or null");
  if (setupScript !== null && typeof setupScript !== "string") fail("setupScript must be a string or null");
  return { title, sbxAgent, command, defaultArgs, herdrDetectionKind, setupScript };
}

/**
 * Returns every adapter available for a config: built-ins overlaid by custom profiles.
 * @param {{customAgents: Record<string, unknown>}} config
 * @returns {Record<string, ReturnType<typeof validateCustomAgent>>}
 */
export function availableAgents(config) {
  const agents = { ...BUILTIN_AGENTS };
  for (const [kind, profile] of Object.entries(config.customAgents ?? {})) {
    agents[kind] = validateCustomAgent(kind, profile);
  }
  return agents;
}

/**
 * Resolves the configured agent and its final launch argv.
 * @param {{agentKind: string, agentArgs: Record<string, string[]>, customAgents: Record<string, unknown>}} config
 * @returns {ReturnType<typeof validateCustomAgent> & {kind: string, launchArgv: string[]}}
 */
export function resolveAgent(config) {
  const agents = availableAgents(config);
  const adapter = typeof config.agentKind === "string" && Object.hasOwn(agents, config.agentKind) ? agents[config.agentKind] : undefined;
  if (!adapter) {
    throw new PluginError("config", `Unknown agentKind "${config.agentKind}". Available: ${Object.keys(agents).join(", ")}.`);
  }
  const args = config.agentArgs?.[config.agentKind] ?? adapter.defaultArgs;
  return { ...adapter, kind: config.agentKind, launchArgv: [...adapter.command, ...args] };
}
