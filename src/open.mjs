/**
 * Opens a URL with the platform's opener without ever throwing: the caller
 * reports the URL anyway, so a missing opener only costs the convenience.
 * @module open
 */
import { spawnSync } from "node:child_process";
import { OPENER_ENV } from "./constants.mjs";

/**
 * Picks the opener command for this platform.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string}
 */
export function openerCommand(env = process.env, platform = process.platform) {
  if (env[OPENER_ENV]) {
    return env[OPENER_ENV];
  }
  return platform === "darwin" ? "open" : "xdg-open";
}

/**
 * Opens the URL and reports whether the opener accepted it.
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok: boolean, command: string, error: string|null}}
 */
export function openUrl(url, env = process.env) {
  const command = openerCommand(env);
  const result = spawnSync(command, [url], { encoding: "utf8", env });
  if (result.error) {
    return { ok: false, command, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, command, error: `${command} exited with ${result.status}: ${(result.stderr ?? "").trim()}` };
  }
  return { ok: true, command, error: null };
}
