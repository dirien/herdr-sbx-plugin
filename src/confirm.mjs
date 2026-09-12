/**
 * Human confirmation for destructive actions. The action writes a request
 * file, opens the popup pane, and polls for a decision file that the popup
 * writes once the user typed DELETE (or anything else, or ran out of time).
 * @module confirm
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { CONFIRMATIONS_DIR, CONFIRMATION_ID_ENV, CONFIRMATION_TTL_MS } from "./constants.mjs";
import { PluginError, errorMessageOf } from "./errors.mjs";
import { writeJsonAtomic } from "./state.mjs";

const ID_PATTERN = /^[a-f0-9]{12}$/;

/**
 * Returns the request and decision file paths for a request id.
 * @param {string} stateDir
 * @param {string} requestId
 */
export function confirmationPaths(stateDir, requestId) {
  if (!ID_PATTERN.test(requestId)) {
    throw new PluginError("target", `Invalid confirmation request id "${requestId}".`);
  }
  const dir = path.join(stateDir, CONFIRMATIONS_DIR);
  return { dir, request: path.join(dir, `${requestId}.request.json`), decision: path.join(dir, `${requestId}.decision.json`) };
}

/**
 * Removes request and decision files older than `maxAgeMs`, which a crashed
 * popup or an expired action can leave behind.
 * @param {string} stateDir
 * @param {number} [maxAgeMs]
 * @returns {number} How many files were removed.
 */
export function sweepStaleConfirmations(stateDir, maxAgeMs = 2 * CONFIRMATION_TTL_MS) {
  const dir = path.join(stateDir, CONFIRMATIONS_DIR);
  if (!existsSync(dir)) {
    return 0;
  }
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (statSync(file).mtimeMs < cutoff) {
        unlinkSync(file);
        removed += 1;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        process.stderr.write(`could not sweep ${file}: ${errorMessageOf(error)}\n`);
      }
    }
  }
  return removed;
}

/**
 * Writes a new confirmation request and returns its id.
 * @param {string} stateDir
 * @param {Record<string, unknown>} details Shown to the user in the popup.
 * @param {number} [ttlMs]
 * @returns {string}
 */
export function createConfirmationRequest(stateDir, details, ttlMs = CONFIRMATION_TTL_MS) {
  sweepStaleConfirmations(stateDir, 2 * ttlMs);
  const requestId = randomBytes(6).toString("hex");
  const paths = confirmationPaths(stateDir, requestId);
  mkdirSync(paths.dir, { recursive: true });
  const now = Date.now();
  writeJsonAtomic(paths.request, { requestId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(), ...details });
  return requestId;
}

/**
 * Reads a request file.
 * @param {string} stateDir
 * @param {string} requestId
 * @returns {Record<string, any>}
 */
export function readConfirmationRequest(stateDir, requestId) {
  const paths = confirmationPaths(stateDir, requestId);
  if (!existsSync(paths.request)) {
    throw new PluginError("not-found", `Confirmation request ${requestId} does not exist or has already been consumed.`);
  }
  try {
    return JSON.parse(readFileSync(paths.request, "utf8"));
  } catch (error) {
    throw new PluginError("unknown", `Confirmation request ${requestId} is unreadable: ${error.message}`, { cause: error });
  }
}

/**
 * Records the user's decision.
 * @param {string} stateDir
 * @param {string} requestId
 * @param {"confirmed"|"cancelled"} decision
 */
export function writeConfirmationDecision(stateDir, requestId, decision) {
  if (decision !== "confirmed" && decision !== "cancelled") {
    throw new PluginError("unknown", `Invalid confirmation decision "${decision}".`);
  }
  const paths = confirmationPaths(stateDir, requestId);
  writeJsonAtomic(paths.decision, { requestId, decision, decidedAt: new Date().toISOString() });
}

/**
 * Reads the decision file, or null while the user has not answered.
 * @param {string} stateDir
 * @param {string} requestId
 * @returns {Record<string, any>|null}
 */
export function readConfirmationDecision(stateDir, requestId) {
  const paths = confirmationPaths(stateDir, requestId);
  if (!existsSync(paths.decision)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(paths.decision, "utf8"));
  } catch (error) {
    throw new PluginError("unknown", `Confirmation decision ${requestId} is unreadable: ${error.message}`, { cause: error });
  }
}

/**
 * Removes request and decision files, ignoring ones that never existed.
 * @param {string} stateDir
 * @param {string} requestId
 */
export function cleanupConfirmation(stateDir, requestId) {
  const paths = confirmationPaths(stateDir, requestId);
  for (const file of [paths.request, paths.decision]) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new PluginError("unknown", `Could not remove ${file}: ${error.message}`, { cause: error });
      }
    }
  }
}

/**
 * Opens the confirmation popup and waits for the user's answer.
 * @param {{stateDir: string, herdr: {openPluginPane: Function}, pluginId: string, details: Record<string, unknown>, timeoutMs?: number, pollMs?: number}} input
 * @returns {Promise<boolean>} True only when the user confirmed.
 */
export async function requestDeletionConfirmation({ stateDir, herdr, pluginId, details, timeoutMs = CONFIRMATION_TTL_MS, pollMs = 250 }) {
  const requestId = createConfirmationRequest(stateDir, details, timeoutMs);
  try {
    herdr.openPluginPane({ pluginId, entrypointId: "deletion-confirmation", env: { [CONFIRMATION_ID_ENV]: requestId } });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const decision = readConfirmationDecision(stateDir, requestId);
      if (decision) {
        return decision.decision === "confirmed";
      }
      await sleep(pollMs);
    }
    // An answer written during the last sleep still counts; the popup already told the user it did.
    return readConfirmationDecision(stateDir, requestId)?.decision === "confirmed";
  } finally {
    try {
      cleanupConfirmation(stateDir, requestId);
    } catch (error) {
      process.stderr.write(`could not clean up confirmation ${requestId}: ${errorMessageOf(error)}\n`);
    }
  }
}
