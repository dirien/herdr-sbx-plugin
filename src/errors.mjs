/**
 * Typed errors so every failure carries a stable `errorKind` for orchestrators.
 * @module errors
 */

/** Stable failure categories reported in the result line. */
export const ERROR_KINDS = Object.freeze([
  "not-found",
  "authentication",
  "permission",
  "network",
  "daemon",
  "conflict",
  "cancelled",
  "config",
  "target",
  "startup",
  "unknown",
]);

/**
 * Error with a stable machine-readable kind and optional captured CLI output.
 */
export class PluginError extends Error {
  /**
   * @param {string} errorKind One of {@link ERROR_KINDS}.
   * @param {string} message Human-readable explanation.
   * @param {{output?: string, cause?: unknown}} [details]
   */
  constructor(errorKind, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "PluginError";
    this.errorKind = ERROR_KINDS.includes(errorKind) ? errorKind : "unknown";
    this.output = details.output ?? "";
  }
}

/**
 * Returns the error kind of any thrown value, defaulting to "unknown".
 * @param {unknown} error
 * @returns {string}
 */
export function errorKindOf(error) {
  return error instanceof PluginError ? error.errorKind : "unknown";
}

/**
 * Returns a printable message for any thrown value.
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
