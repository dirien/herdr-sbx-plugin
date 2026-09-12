/**
 * Access to the environment and JSON context Herdr injects into plugin
 * commands, plus the rules that turn that context into a sandbox mount root.
 * @module context
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { PLUGIN_ID } from "./constants.mjs";
import { PluginError } from "./errors.mjs";

/**
 * Reads the Herdr-injected plugin environment into a plain object.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{actionId: string|null, eventName: string|null, pluginId: string, pluginRoot: string, stateDir: string|null, configDir: string|null, herdrBin: string}}
 */
export function readPluginEnv(env = process.env) {
  return {
    actionId: env.HERDR_PLUGIN_ACTION_ID ?? null,
    eventName: env.HERDR_PLUGIN_EVENT ?? null,
    pluginId: env.HERDR_PLUGIN_ID ?? PLUGIN_ID,
    pluginRoot: env.HERDR_PLUGIN_ROOT ?? process.cwd(),
    stateDir: env.HERDR_PLUGIN_STATE_DIR ?? null,
    configDir: env.HERDR_PLUGIN_CONFIG_DIR ?? null,
    herdrBin: env.HERDR_BIN_PATH ?? "herdr",
  };
}

/**
 * Ensures the state and config directories Herdr promises are present.
 * @param {ReturnType<typeof readPluginEnv>} pluginEnv
 * @returns {ReturnType<typeof readPluginEnv> & {stateDir: string, configDir: string}}
 */
export function requirePluginDirs(pluginEnv) {
  if (!pluginEnv.stateDir) {
    throw new PluginError("startup", "HERDR_PLUGIN_STATE_DIR is not set. Run this command through Herdr.");
  }
  if (!pluginEnv.configDir) {
    throw new PluginError("startup", "HERDR_PLUGIN_CONFIG_DIR is not set. Run this command through Herdr.");
  }
  return /** @type {any} */ (pluginEnv);
}

function readJsonEnv(env, name) {
  const raw = env[name];
  if (!raw) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginError("startup", `${name} is not valid JSON: ${error.message}`, { cause: error });
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/**
 * Parses HERDR_PLUGIN_CONTEXT_JSON.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, any>}
 */
export function readContext(env = process.env) {
  return readJsonEnv(env, "HERDR_PLUGIN_CONTEXT_JSON");
}

/**
 * Parses HERDR_PLUGIN_EVENT_JSON for event hooks.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, any>}
 */
export function readEventPayload(env = process.env) {
  return readJsonEnv(env, "HERDR_PLUGIN_EVENT_JSON");
}

/**
 * Picks the pane an action was invoked for.
 * @param {Record<string, any>} context
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function resolvePaneId(context, env = process.env) {
  return context.focused_pane_id ?? env.HERDR_PANE_ID ?? null;
}

/**
 * Canonical absolute form of a path: symlinks resolved when the path exists
 * (macOS spells the temp directory both `/var/...` and `/private/var/...`),
 * plain resolution otherwise.
 * @param {string} value
 * @returns {string}
 */
export function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    // The path is gone (a removed worktree) or not there yet: canonicalise the
    // longest ancestor that exists so both spellings of a symlinked prefix agree.
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonicalPath(parent), path.basename(resolved));
  }
}

/**
 * Whether `candidate` is `root` or lies inside it, comparing canonical paths.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
export function isInside(root, candidate) {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  // Only a leading ".." component means "outside"; a directory named "..cache" is inside.
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`);
  return relative === "" || (!escapes && !path.isAbsolute(relative));
}

/**
 * Returns the git top-level directory containing `dir`, or null.
 * @param {string} dir
 * @returns {string|null}
 */
export function gitToplevel(dir) {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return null;
  }
  const top = (result.stdout ?? "").trim();
  return top === "" ? null : top;
}

function nonEmptyString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Picks the directory that becomes the sandbox workspace (the mount root).
 * Order: the workspace's worktree checkout, the workspace directory, the git
 * top level of the focused pane's directory, then that directory itself. The
 * pane's own directory comes last on purpose: it changes with every `cd`, and
 * mounting a subdirectory would hide `.git` from the agent.
 * @param {Record<string, any>} context
 * @param {{toplevel?: (dir: string) => string|null}} [options]
 * @returns {string|null}
 */
export function resolveMountRoot(context, { toplevel = gitToplevel } = {}) {
  const checkout = nonEmptyString(context.worktree?.checkout_path);
  if (checkout) {
    return canonicalPath(checkout);
  }
  const workspace = nonEmptyString(context.workspace_cwd);
  if (workspace) {
    return canonicalPath(workspace);
  }
  const paneCwd = nonEmptyString(context.focused_pane_cwd);
  if (paneCwd) {
    return canonicalPath(toplevel(paneCwd) ?? paneCwd);
  }
  return null;
}

/**
 * Picks the directory the agent starts in: the focused pane's directory when
 * it lies inside the mount root, otherwise the root itself.
 * @param {Record<string, any>} context
 * @param {string} mountRoot
 * @returns {string}
 */
export function resolveWorkdir(context, mountRoot) {
  const paneCwd = nonEmptyString(context.focused_pane_cwd);
  if (paneCwd && isInside(mountRoot, paneCwd)) {
    return canonicalPath(paneCwd);
  }
  return canonicalPath(mountRoot);
}
