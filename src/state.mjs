/**
 * Pane-to-sandbox mapping store: one JSON file per pane under
 * HERDR_PLUGIN_STATE_DIR/panes/, each rewritten atomically. Per-pane files
 * mean a bridge updating one pane can never clobber another pane's mapping.
 * @module state
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIFECYCLE_STATES, PANES_DIR, STATE_VERSION } from "./constants.mjs";
import { canonicalPath } from "./context.mjs";
import { PluginError } from "./errors.mjs";

/**
 * Returns the directory holding the per-pane files.
 * @param {string} stateDir
 * @returns {string}
 */
export function panesDir(stateDir) {
  return path.join(stateDir, PANES_DIR);
}

/**
 * Returns the file that stores one pane's mapping. The name keeps the pane id
 * readable and appends a hash so distinct ids can never collide.
 * @param {string} stateDir
 * @param {string} paneId
 * @returns {string}
 */
export function paneEntryPath(stateDir, paneId) {
  if (typeof paneId !== "string" || paneId === "") {
    throw new PluginError("target", "A pane id is required to address a sandbox mapping.");
  }
  const readable = paneId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const digest = createHash("sha256").update(paneId).digest("hex").slice(0, 10);
  return path.join(panesDir(stateDir), `${readable}-${digest}.json`);
}

/**
 * Writes JSON atomically by writing a sibling temp file and renaming it.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        process.stderr.write(`could not remove temp file ${temp}: ${cleanupError.message}\n`);
      }
    }
    throw new PluginError("startup", `Could not write ${file}: ${error.message}`, { cause: error });
  }
}

function readEntryFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PluginError("startup", `Mapping file ${file} is unreadable: ${error.message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION || typeof parsed.paneId !== "string") {
    throw new PluginError("startup", `Mapping file ${file} has an unsupported format. Expected version ${STATE_VERSION}.`);
  }
  return parsed;
}

/**
 * Loads every mapping. `panes` is a null-prototype object keyed by pane id.
 * @param {string} stateDir
 * @returns {{version: number, panes: Record<string, any>}}
 */
export function loadState(stateDir) {
  const panes = Object.create(null);
  const dir = panesDir(stateDir);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((item) => item.endsWith(".json")).sort()) {
      const entry = readEntryFile(path.join(dir, name));
      panes[entry.paneId] = entry;
    }
  }
  return { version: STATE_VERSION, panes };
}

/**
 * Inserts or replaces the entry for a pane.
 * @param {string} stateDir
 * @param {string} paneId
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>} The stored entry.
 */
export function savePaneEntry(stateDir, paneId, entry) {
  if (!LIFECYCLE_STATES.includes(entry.lifecycleState)) {
    throw new PluginError("startup", `Refusing to store unknown lifecycle state "${entry.lifecycleState}".`);
  }
  const stored = { ...entry, version: STATE_VERSION, paneId, updatedAt: new Date().toISOString() };
  writeJsonAtomic(paneEntryPath(stateDir, paneId), stored);
  return stored;
}

/**
 * Applies a partial update to an existing entry.
 * @param {string} stateDir
 * @param {string} paneId
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>} The stored entry.
 */
export function updatePaneEntry(stateDir, paneId, patch) {
  const current = requirePaneEntry(stateDir, paneId);
  return savePaneEntry(stateDir, paneId, { ...current, ...patch });
}

/**
 * Removes the entry for a pane if present.
 * @param {string} stateDir
 * @param {string} paneId
 * @returns {boolean} Whether an entry existed.
 */
export function deletePaneEntry(stateDir, paneId) {
  const file = paneEntryPath(stateDir, paneId);
  if (!existsSync(file)) {
    return false;
  }
  try {
    unlinkSync(file);
  } catch (error) {
    throw new PluginError("startup", `Could not remove ${file}: ${error.message}`, { cause: error });
  }
  return true;
}

/**
 * Returns the entry for a pane or null.
 * @param {string} stateDir
 * @param {string|null} paneId
 * @returns {Record<string, any>|null}
 */
export function getPaneEntry(stateDir, paneId) {
  if (!paneId) {
    return null;
  }
  const file = paneEntryPath(stateDir, paneId);
  if (!existsSync(file)) {
    return null;
  }
  const entry = readEntryFile(file);
  if (entry.paneId !== paneId) {
    throw new PluginError("startup", `Mapping file ${file} belongs to pane ${entry.paneId}, not ${paneId}.`);
  }
  return entry;
}

/**
 * Returns the entry for a pane or throws a target error.
 * @param {string} stateDir
 * @param {string|null} paneId
 * @returns {Record<string, any>}
 */
export function requirePaneEntry(stateDir, paneId) {
  const entry = getPaneEntry(stateDir, paneId);
  if (!entry) {
    throw new PluginError("target", paneId ? `No sandbox is mapped to pane ${paneId}. Run start-agent from that pane first.` : "No focused pane was provided, so there is no sandbox mapping to act on.");
  }
  return entry;
}

/**
 * Finds every entry whose mount root equals the given path.
 * @param {{panes: Record<string, any>}} state
 * @param {string} localPath
 * @returns {Array<[string, Record<string, any>]>}
 */
export function entriesForLocalPath(state, localPath) {
  const wanted = canonicalPath(localPath);
  return Object.entries(state.panes).filter(([, entry]) => typeof entry.localPath === "string" && canonicalPath(entry.localPath) === wanted);
}
