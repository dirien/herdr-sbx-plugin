/**
 * Popup pane logic that asks the user to type DELETE before a sandbox is
 * removed. The request id arrives in HERDR_SBX_CONFIRMATION_ID; the decision is
 * written to the state directory where the waiting action polls for it.
 * @module confirmation-pane
 */
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { readConfirmationRequest, writeConfirmationDecision } from "./confirm.mjs";
import { CONFIRMATION_ID_ENV } from "./constants.mjs";
import { errorMessageOf } from "./errors.mjs";

/**
 * Asks the question and resolves with the answer, or null on timeout.
 * @param {string} prompt
 * @param {number} timeoutMs
 * @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream}} streams
 * @returns {Promise<string|null>}
 */
export async function askWithTimeout(prompt, timeoutMs, streams) {
  const rl = readline.createInterface({ input: streams.input, output: streams.output, terminal: false });
  const controller = new AbortController();
  const answer = new Promise((resolve) => {
    rl.question(prompt, (text) => resolve(text));
    rl.once("close", () => resolve(null));
  });
  const timeout = sleep(timeoutMs, null, { signal: controller.signal }).then(() => null, () => null);
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    controller.abort();
    rl.close();
  }
}

/**
 * Runs the popup flow and returns the exit code.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream}} [streams]
 * @param {{installSignalHandlers?: boolean}} [options] Install SIGINT/SIGTERM handlers that record a cancellation.
 * @returns {Promise<number>}
 */
/** Line width the popup wraps its text to. */
const POPUP_WIDTH = 96;

/**
 * Splits text into lines no longer than `width`, breaking after a comma or a
 * space when one is in reach and hard-breaking otherwise, so no character is
 * ever dropped.
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrapText(text, width) {
  const limit = Math.max(1, Math.floor(width));
  const lines = [];
  let rest = text;
  while (rest.length > limit) {
    // A line may end with a comma at index limit-1, or just before a space at index limit.
    const afterComma = rest.lastIndexOf(",", limit - 1) + 1;
    const beforeSpace = rest.lastIndexOf(" ", limit);
    const cut = afterComma > 0 && afterComma >= beforeSpace ? afterComma : beforeSpace > 0 ? beforeSpace : limit;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
}

export async function runConfirmationPopup(env = process.env, streams = { input: process.stdin, output: process.stdout }, { installSignalHandlers = false } = {}) {
  const write = (line) => streams.output.write(`${line}\n`);
  const requestId = env[CONFIRMATION_ID_ENV];
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!requestId || !stateDir) {
    write(`This pane must be opened by the plugin with ${CONFIRMATION_ID_ENV} and HERDR_PLUGIN_STATE_DIR set.`);
    return 1;
  }
  let request;
  try {
    request = readConfirmationRequest(stateDir, requestId);
  } catch (error) {
    write(`Cannot load the confirmation request: ${errorMessageOf(error)}`);
    return 1;
  }
  const expiresAt = Date.parse(request.expiresAt);
  const remainingMs = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : 0;
  const cancelOnSignal = () => {
    try {
      writeConfirmationDecision(stateDir, requestId, "cancelled");
    } catch (error) {
      streams.output.write(`Could not record the cancellation: ${errorMessageOf(error)}\n`);
    }
    process.exit(130);
  };
  if (installSignalHandlers) {
    process.once("SIGINT", cancelOnSignal);
    process.once("SIGTERM", cancelOnSignal);
  }
  // Paths and names come from the file system and older state files; strip
  // control characters (C0 and C1, where CSI and OSC live for a UTF-8 terminal,
  // plus the Unicode line separators) so nothing can redraw the one prompt that
  // authorises a deletion. Nothing is ever cut: every sandbox this answer will
  // delete, and every warning, is printed in full, wrapped over several lines.
  const shown = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  const field = (label, value) => {
    const [first, ...more] = wrapText(shown(value), POPUP_WIDTH - label.length - 2);
    write(`  ${label}${first}`);
    for (const line of more) {
      write(`  ${" ".repeat(label.length)}${line}`);
    }
  };
  write("Docker Sandbox deletion");
  write("");
  field("action:   ", request.action);
  field("sandbox:  ", request.sandboxName);
  field("worktree: ", request.localPath);
  field("pane:     ", request.paneId);
  write("");
  for (const line of wrapText(shown(request.consequence), POPUP_WIDTH - 2)) {
    write(`  ${line}`);
  }
  write(`  This prompt expires in ${Math.round(remainingMs / 1000)}s.`);
  write("");
  const answer = await askWithTimeout("Type DELETE to confirm, anything else to cancel: ", remainingMs, streams);
  if (installSignalHandlers) {
    process.off("SIGINT", cancelOnSignal);
    process.off("SIGTERM", cancelOnSignal);
  }
  const decision = answer !== null && answer.trim() === "DELETE" ? "confirmed" : "cancelled";
  try {
    writeConfirmationDecision(stateDir, requestId, decision);
  } catch (error) {
    write(`Could not record the decision: ${errorMessageOf(error)}`);
    return 1;
  }
  write(decision === "confirmed" ? "Confirmed. The sandbox is being deleted." : "Cancelled. Nothing was deleted.");
  return 0;
}
