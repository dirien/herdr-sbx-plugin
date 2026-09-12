/**
 * Runs inside the Herdr pane. Modes: `start` (prepare, then attach the agent),
 * `connect` (attach the agent again) and `shell` (attach a login shell).
 * Invoked through `src/bridge.mjs <mode> --state-dir DIR --config-dir DIR --pane-id ID [--herdr-bin BIN] [--sbx-bin BIN] [--launch-id ID]`.
 * @module bridge-main
 */
import { loadConfig } from "./config.mjs";
import { PluginError, errorMessageOf } from "./errors.mjs";
import { createHerdrClient } from "./herdr.mjs";
import { createLifecycle } from "./lifecycle.mjs";

const MODES = new Set(["start", "connect", "shell"]);

/**
 * Parses the bridge argv.
 * @param {string[]} argv
 * @returns {{mode: string, stateDir: string, configDir: string, paneId: string, herdrBin: string, sbxBin: string|null, launchId: string|null}}
 */
export function parseBridgeArgs(argv) {
  const [mode, ...rest] = argv;
  if (!MODES.has(mode)) {
    throw new PluginError("startup", `Unknown bridge mode "${mode}". Expected one of ${[...MODES].join(", ")}.`);
  }
  const options = { stateDir: null, configDir: null, paneId: null, herdrBin: "herdr", sbxBin: null, launchId: null };
  const names = { "--state-dir": "stateDir", "--config-dir": "configDir", "--pane-id": "paneId", "--herdr-bin": "herdrBin", "--sbx-bin": "sbxBin", "--launch-id": "launchId" };
  for (let index = 0; index < rest.length; index += 2) {
    const key = names[rest[index]];
    const value = rest[index + 1];
    if (!key || value === undefined) {
      throw new PluginError("startup", `Unexpected bridge argument "${rest[index]}".`);
    }
    options[key] = value;
  }
  for (const key of ["stateDir", "configDir", "paneId"]) {
    if (!options[key]) {
      throw new PluginError("startup", `Missing bridge option for ${key}.`);
    }
  }
  return { mode, ...options };
}

/**
 * Entry point; returns the process exit code.
 * @param {string[]} argv
 * @returns {number}
 */
export function runBridge(argv) {
  const log = (line) => process.stdout.write(`${line}\n`);
  try {
    const { mode, stateDir, configDir, paneId, herdrBin, sbxBin, launchId } = parseBridgeArgs(argv);
    const config = loadConfig(configDir);
    if (sbxBin) {
      // The action already resolved the executable; the pane's shell may not have the same environment.
      config.sbxBin = sbxBin;
    }
    const herdr = createHerdrClient({ bin: herdrBin });
    const lifecycle = createLifecycle({ stateDir, config, log, herdr });
    if (mode !== "shell") {
      // Actions wait for this acknowledgement; a shell pane touches no lifecycle state.
      lifecycle.acknowledgeBridge(paneId, launchId);
    }
    if (mode === "start") {
      lifecycle.prepare(paneId);
      return lifecycle.connect(paneId).exitCode;
    }
    if (mode === "connect") {
      return lifecycle.connect(paneId).exitCode;
    }
    return lifecycle.shell(paneId).exitCode;
  } catch (error) {
    log(`error: ${errorMessageOf(error)}`);
    const output = /** @type {any} */ (error)?.output;
    if (typeof output === "string" && output.trim() !== "") {
      log(output.trim());
    }
    return 1;
  }
}
