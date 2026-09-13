/**
 * Opens a URL with the platform's opener without ever throwing: the caller
 * reports the URL anyway, so a missing opener only costs the convenience.
 * @module open
 */
import { spawn } from "node:child_process";
import { OPENER_ENV, OPENER_GRACE_MS } from "./constants.mjs";

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
 * Starts the opener with the URL and reports whether it accepted it. The
 * opener runs detached with its output discarded, and the answer arrives when
 * it exits or after `graceMs`, whichever comes first: `xdg-open` without a
 * desktop environment, or a browser named in HERDR_SBX_OPENER, runs the
 * browser in the foreground and returns only when that exits, which must not
 * hold up the action. An opener still running after the grace period is
 * therefore taken to be showing the page.
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{graceMs?: number}} [options]
 * @returns {Promise<{ok: boolean, command: string, error: string|null}>}
 */
export function openUrl(url, env = process.env, { graceMs = OPENER_GRACE_MS } = {}) {
  const command = openerCommand(env);
  return new Promise((resolve) => {
    const child = spawn(command, [url], { env, stdio: "ignore", detached: true });
    const timer = setTimeout(() => resolve({ ok: true, command, error: null }), graceMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, command, error: error.message });
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      resolve(status === 0 ? { ok: true, command, error: null } : { ok: false, command, error: `${command} exited with ${status === null ? `signal ${signal}` : status}` });
    });
    // The child must not keep this process alive: a foreground browser lives on after the action ends.
    child.unref();
  });
}
