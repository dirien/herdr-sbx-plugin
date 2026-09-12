/**
 * Calls back into Herdr through the CLI at HERDR_BIN_PATH, which is the
 * portable plugin API (the socket transport differs per OS).
 * @module herdr
 */
import { spawnSync } from "node:child_process";
import { PluginError } from "./errors.mjs";

const MAX_BUFFER = 16 * 1024 * 1024;

/** A wedged Herdr server must not hang plugin commands or the agent launch. */
const HERDR_TIMEOUT_MS = 10_000;

/** Matches Herdr's error output when a pane id is unknown. */
export const PANE_NOT_FOUND_PATTERN = /pane_not_found|pane [^ ]+ not found|no such pane|unknown pane/i;
const PANE_NOT_FOUND = PANE_NOT_FOUND_PATTERN;

/**
 * Creates a client bound to one Herdr executable.
 * @param {{bin?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function createHerdrClient({ bin = "herdr", env = process.env } = {}) {
  /**
   * Runs a Herdr CLI command and parses its JSON response when present.
   * @param {string[]} args
   * @param {string} step
   * @returns {{stdout: string, json: any}}
   */
  function run(args, step) {
    const result = spawnSync(bin, args, { encoding: "utf8", env, maxBuffer: MAX_BUFFER, timeout: HERDR_TIMEOUT_MS, killSignal: "SIGKILL" });
    if (result.error) {
      throw new PluginError("startup", `Could not run the Herdr CLI ("${bin}") while ${step}: ${result.error.message}`, { cause: result.error });
    }
    const stdout = result.stdout ?? "";
    const output = `${stdout}${result.stderr ?? ""}`;
    if (result.status !== 0) {
      throw new PluginError("unknown", `herdr ${args.slice(0, 2).join(" ")} failed while ${step} (exit ${result.status}).`, { output });
    }
    let json = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
    return { stdout, json };
  }

  /**
   * Splits a pane and returns the new pane id.
   * @param {{paneId?: string|null, direction: string, ratio: number, cwd?: string|null, focus?: boolean}} input
   * @returns {string}
   */
  function splitPane({ paneId = null, direction, ratio, cwd = null, focus = true }) {
    const args = ["pane", "split"];
    if (paneId) args.push(paneId);
    args.push("--direction", direction, "--ratio", String(ratio));
    if (cwd) args.push("--cwd", cwd);
    args.push(focus ? "--focus" : "--no-focus");
    const { json, stdout } = run(args, "splitting the pane");
    const newPaneId = json?.result?.pane?.pane_id ?? json?.pane?.pane_id ?? null;
    if (typeof newPaneId !== "string" || newPaneId === "") {
      throw new PluginError("unknown", "herdr pane split did not return a pane id.", { output: stdout });
    }
    return newPaneId;
  }

  /**
   * Reads a pane's live record (`herdr pane get`).
   * @param {string} paneId
   * @returns {Record<string, any>|null} The pane object, or null when Herdr does not know the pane.
   */
  function getPane(paneId) {
    try {
      const { json } = run(["pane", "get", paneId], "reading the pane");
      return json?.result?.pane ?? null;
    } catch (error) {
      if (error instanceof PluginError && PANE_NOT_FOUND.test(error.output)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Creates a tab and returns its id plus its root pane id.
   * @param {{workspaceId?: string|null, cwd?: string|null, label?: string|null, focus?: boolean}} input
   * @returns {{tabId: string, paneId: string}}
   */
  function createTab({ workspaceId = null, cwd = null, label = null, focus = true }) {
    const args = ["tab", "create"];
    if (workspaceId) args.push("--workspace", workspaceId);
    if (cwd) args.push("--cwd", cwd);
    if (label) args.push("--label", label);
    args.push(focus ? "--focus" : "--no-focus");
    const { json, stdout } = run(args, "creating a tab");
    const tabId = json?.result?.tab?.tab_id ?? json?.tab?.tab_id ?? null;
    const paneId = json?.result?.root_pane?.pane_id ?? json?.root_pane?.pane_id ?? null;
    if (typeof tabId !== "string" || tabId === "" || typeof paneId !== "string" || paneId === "") {
      throw new PluginError("unknown", "herdr tab create did not return a tab and pane id.", { output: stdout });
    }
    return { tabId, paneId };
  }

  /**
   * Reports an agent's state on behalf of an agent Herdr cannot detect itself.
   * @param {{paneId: string, source: string, agent: string, state: "idle"|"working"|"blocked"|"unknown", message?: string|null}} input
   */
  function reportAgent({ paneId, source, agent, state, message = null }) {
    const args = ["pane", "report-agent", paneId, "--source", source, "--agent", agent, "--state", state];
    if (message) args.push("--message", message);
    run(args, "reporting the agent state");
  }

  /**
   * Ends the plugin's authority over a pane's agent state.
   * @param {{paneId: string, source: string, agent: string}} input
   */
  function releaseAgent({ paneId, source, agent }) {
    run(["pane", "release-agent", paneId, "--source", source, "--agent", agent], "releasing the agent state");
  }

  /**
   * Renames a pane label.
   * @param {string} paneId
   * @param {string} label
   */
  function renamePane(paneId, label) {
    run(["pane", "rename", paneId, label], "renaming the pane");
  }

  /**
   * Types a command into a pane and submits it.
   * @param {string} paneId
   * @param {string} command
   */
  function runInPane(paneId, command) {
    run(["pane", "run", paneId, command], "running a command in the pane");
  }

  /**
   * Shows a toast. Failures are reported on stderr and never abort the action.
   * @param {string} title
   * @param {string} body
   * @returns {boolean} Whether the toast was shown.
   */
  function notify(title, body) {
    try {
      run(["notification", "show", title, "--body", body, "--sound", "none"], "showing a notification");
      return true;
    } catch (error) {
      process.stderr.write(`notification skipped: ${error.message}\n`);
      return false;
    }
  }

  /**
   * Opens a manifest-declared plugin pane (used for the confirmation popup).
   * @param {{pluginId: string, entrypointId: string, env?: Record<string, string>, focus?: boolean}} input
   */
  /**
   * Lists the ids of every pane Herdr knows, in one `herdr pane list` call.
   * @returns {string[]}
   */
  function listPaneIds() {
    const { json, stdout } = run(["pane", "list"], "listing panes");
    const panes = json?.result?.panes ?? json?.panes ?? null;
    if (!Array.isArray(panes)) {
      throw new PluginError("unknown", "herdr pane list did not return a pane list.", { output: stdout });
    }
    return panes.map((pane) => pane?.pane_id).filter((id) => typeof id === "string" && id !== "");
  }

  /**
   * Closes a pane (`herdr pane close`).
   * @param {string} paneId
   */
  function closePane(paneId) {
    run(["pane", "close", paneId], "closing the pane");
  }

  function openPluginPane({ pluginId, entrypointId, env: paneEnv = {}, focus = true }) {
    const args = ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", entrypointId];
    for (const [key, value] of Object.entries(paneEnv)) {
      args.push("--env", `${key}=${value}`);
    }
    args.push(focus ? "--focus" : "--no-focus");
    run(args, "opening the plugin pane");
  }

  return { bin, run, getPane, listPaneIds, closePane, splitPane, createTab, reportAgent, releaseAgent, renamePane, runInPane, notify, openPluginPane };
}
