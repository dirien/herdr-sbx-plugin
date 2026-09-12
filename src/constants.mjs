/**
 * Shared constants for the sbx.sandbox plugin.
 * @module constants
 */

/** Plugin id declared in herdr-plugin.toml; used when HERDR_PLUGIN_ID is absent. */
export const PLUGIN_ID = "sbx.sandbox";

/** Prefix of the machine-readable first stdout line every action prints. */
export const RESULT_MARKER = "HERDR_SANDBOX_RESULT:";

/** Schema version of the result line payload. */
export const RESULT_SCHEMA_VERSION = 1;

/** Directory inside HERDR_PLUGIN_STATE_DIR holding one JSON file per mapped pane. */
export const PANES_DIR = "panes";

/** Schema version written into every pane mapping file. */
export const STATE_VERSION = 1;

/** File name of the user configuration inside HERDR_PLUGIN_CONFIG_DIR. */
export const CONFIG_FILE = "config.json";

/** Directory (inside the state dir) holding confirmation requests and decisions. */
export const CONFIRMATIONS_DIR = "confirmations";

/** How long a deletion confirmation popup stays valid. */
export const CONFIRMATION_TTL_MS = 60_000;

/** Environment variable that carries a confirmation request id into the popup pane. */
export const CONFIRMATION_ID_ENV = "HERDR_SBX_CONFIRMATION_ID";

/** Source id used when the plugin reports agent state to Herdr on behalf of an agent Herdr cannot detect. */
export const AGENT_REPORT_SOURCE = "sbx.sandbox";

/** Environment variable naming the program that opens URLs (defaults to `open` on macOS, `xdg-open` elsewhere). */
export const OPENER_ENV = "HERDR_SBX_OPENER";

/** How long an action waits for the bridge it typed into a pane to update the mapping before it opens a new pane instead. */
export const BRIDGE_START_TIMEOUT_MS = 4000;

/** Environment variable overriding {@link BRIDGE_START_TIMEOUT_MS}; used by tests. */
export const BRIDGE_START_TIMEOUT_ENV = "HERDR_SBX_BRIDGE_START_TIMEOUT_MS";

/** Environment variable that shortens the confirmation timeout (milliseconds); used by tests. */
export const CONFIRMATION_TIMEOUT_ENV = "HERDR_SBX_CONFIRMATION_TIMEOUT_MS";

/** Oldest sbx release whose CLI surface this plugin was written against. */
export const MIN_SBX_VERSION = "0.42.0";

/** Environment variable that overrides the sbx executable. */
export const SBX_BIN_ENV = "HERDR_SBX_BIN";

/** How long a captured sbx call (ls, ports, stop, rm, exec probes) may run before it is killed and reported as a daemon failure. */
export const SBX_CALL_TIMEOUT_MS = 120_000;

/** Environment variable overriding {@link SBX_CALL_TIMEOUT_MS} (milliseconds). */
export const SBX_CALL_TIMEOUT_ENV = "HERDR_SBX_TIMEOUT_MS";

/** How long the slow sbx calls may run: `create` pulls an image the first time, and setup scripts install software. */
export const SBX_SLOW_CALL_TIMEOUT_MS = 1_800_000;

/** Environment variable overriding {@link SBX_SLOW_CALL_TIMEOUT_MS} (milliseconds). */
export const SBX_SLOW_CALL_TIMEOUT_ENV = "HERDR_SBX_SLOW_TIMEOUT_MS";

/** Lifecycle states a pane mapping moves through. */
export const LIFECYCLE_STATES = Object.freeze([
  "provisional",
  "creating",
  "created",
  "prepared",
  "ready",
  "stopped",
  "missing",
  "failed",
]);

const ESC = String.fromCharCode(27);

/**
 * Escape sequences written after an interactive agent exits so a crashed TUI
 * cannot leave the Herdr pane in mouse-tracking or alternate-screen mode.
 */
export const TERMINAL_RESTORE_SEQUENCE = [
  "[?1000l",
  "[?1002l",
  "[?1003l",
  "[?1004l",
  "[?1006l",
  "[?2004l",
  "[?1049l",
  "[?25h",
  "[0m",
].map((sequence) => ESC + sequence).join("");
