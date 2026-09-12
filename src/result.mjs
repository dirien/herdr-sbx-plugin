/**
 * The machine-readable result contract: the first stdout line of every action
 * is `HERDR_SANDBOX_RESULT: {json}` so orchestrators polling
 * `herdr plugin log list` can parse it without scraping human text.
 * @module result
 */
import { PLUGIN_ID, RESULT_MARKER, RESULT_SCHEMA_VERSION } from "./constants.mjs";
import { errorKindOf, errorMessageOf } from "./errors.mjs";

/**
 * Formats a result payload as the marker line.
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
export function formatResultLine(payload) {
  return `${RESULT_MARKER} ${JSON.stringify({ schemaVersion: RESULT_SCHEMA_VERSION, plugin: PLUGIN_ID, ...payload })}`;
}

/**
 * Writes the marker line followed by optional human-readable lines.
 * @param {Record<string, unknown>} payload
 * @param {string[]} [extraLines]
 */
export function emitResult(payload, extraLines = []) {
  process.stdout.write(`${formatResultLine(payload)}\n`);
  for (const line of extraLines) {
    process.stdout.write(`${line}\n`);
  }
}

/**
 * Builds the failure payload for a thrown error.
 * @param {string|null} action
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
export function failurePayload(action, error) {
  const payload = { action, ok: false, errorKind: errorKindOf(error), message: errorMessageOf(error) };
  const output = /** @type {any} */ (error)?.output;
  if (typeof output === "string" && output.trim() !== "") {
    payload.output = output.trim().slice(0, 4000);
  }
  return payload;
}

/**
 * Extracts the parsed result payload from captured stdout, or null when absent.
 * @param {string} text
 * @returns {Record<string, any>|null}
 */
export function parseResultLine(text) {
  for (const line of String(text).split("\n")) {
    if (line.startsWith(RESULT_MARKER)) {
      return JSON.parse(line.slice(RESULT_MARKER.length).trim());
    }
  }
  return null;
}
