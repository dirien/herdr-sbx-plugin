/**
 * Pane-to-sandbox mapping store: one JSON file per pane under
 * HERDR_PLUGIN_STATE_DIR/panes/, each rewritten atomically. Per-pane files
 * mean a bridge updating one pane can never clobber another pane's mapping.
 * @module state
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIFECYCLE_STATES, LOCK_WAIT_ENV, LOCK_WAIT_MS, PANES_DIR, STATE_VERSION } from "./constants.mjs";
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
  // `revision` changes on every save, unlike `updatedAt`, which two saves in the same millisecond share.
  const stored = { ...entry, version: STATE_VERSION, paneId, updatedAt: new Date().toISOString(), revision: randomBytes(6).toString("hex") };
  // Every writer takes the mapping lock, so a compare-and-delete under the same
  // lock can never unlink a file another process replaced in between.
  withPaneLock(stateDir, paneId, () => writeJsonAtomic(paneEntryPath(stateDir, paneId), stored));
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
  // Read, merge and write under one lock, or a concurrent writer's fields (a
  // bridge's pid, a deletion claim) would be overwritten with a stale copy.
  return withPaneLock(stateDir, paneId, () => {
    const current = requirePaneEntry(stateDir, paneId);
    return savePaneEntry(stateDir, paneId, { ...current, ...patch });
  });
}

/**
 * Removes the entry for a pane if present.
 * @param {string} stateDir
 * @param {string} paneId
 * @returns {boolean} Whether an entry existed.
 */
/**
 * Path of the lock file that serialises read-check-write sequences on a
 * pane's mapping (next to the mapping, so it lives and dies with the state dir).
 * @param {string} stateDir
 * @param {string} paneId
 * @returns {string}
 */
export function paneLockPath(stateDir, paneId) {
  return `${paneEntryPath(stateDir, paneId)}.lock`;
}

/** Lock files this process holds right now, so nested sections do not wait for themselves. */
const heldLocks = new Set();

/** How long a caller waits for a live lock owner: {@link LOCK_WAIT_MS} unless {@link LOCK_WAIT_ENV} overrides it. */
function defaultLockWaitMs() {
  const raw = Number(process.env[LOCK_WAIT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : LOCK_WAIT_MS;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {any} */ (error).code === "EPERM";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` while holding an exclusive lock on a pane's mapping, so a bridge
 * acknowledging itself and an action deleting the sandbox cannot interleave
 * their read-check-write sequences. The lock is a file created with O_EXCL
 * that holds the owner's pid; a lock whose owner is gone, or that stayed empty
 * longer than the wait, is broken. Waits up to `waitMs` for a live owner.
 * @template T
 * @param {string} stateDir
 * @param {string} paneId
 * @param {() => T} fn
 * @param {{waitMs?: number}} [options]
 * @returns {T}
 */
export function withPaneLock(stateDir, paneId, fn, { waitMs = defaultLockWaitMs() } = {}) {
  const lock = paneLockPath(stateDir, paneId);
  if (heldLocks.has(lock)) {
    // Re-entrant within one process: a save inside a locked section must not wait for itself.
    return fn();
  }
  mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd = null;
    try {
      fd = openSync(lock, "wx");
    } catch (error) {
      if (/** @type {any} */ (error).code !== "EEXIST") {
        throw new PluginError("startup", `Could not lock ${lock}: ${/** @type {any} */ (error).message}`, { cause: error });
      }
    }
    if (fd !== null) {
      try {
        writeFileSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      heldLocks.add(lock);
      try {
        return fn();
      } finally {
        heldLocks.delete(lock);
        try {
          unlinkSync(lock);
        } catch {
          // Already broken by someone who thought we were gone; nothing to do.
        }
      }
    }
    let owner = NaN;
    let ageMs = 0;
    try {
      owner = Number(readFileSync(lock, "utf8").trim());
      ageMs = Date.now() - statSync(lock).mtimeMs;
    } catch {
      // Being written or removed right now; look again.
    }
    const stale = Number.isInteger(owner) && owner > 0 ? !processAlive(owner) : ageMs > waitMs;
    if (stale) {
      try {
        unlinkSync(lock);
      } catch {
        // Someone else broke it first.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new PluginError("conflict", `The mapping of pane ${paneId} is locked by process ${Number.isInteger(owner) && owner > 0 ? owner : "unknown"}; try again in a moment.`);
    }
    sleepSync(20);
  }
}

/**
 * Removes the entry for a pane only if it is still the one the caller read
 * (same `revision` and `updatedAt`), so a mapping rewritten in the meantime
 * (Herdr handed the pane id to a new sandbox) survives a cleanup that decided
 * on stale data.
 * @param {string} stateDir
 * @param {string} paneId
 * @param {{revision?: string, updatedAt?: string}} seen The entry as the caller read it.
 * @returns {boolean} Whether the entry was removed.
 */
export function deletePaneEntryIfUnchanged(stateDir, paneId, seen) {
  return withPaneLock(stateDir, paneId, () => {
    const current = getPaneEntry(stateDir, paneId);
    if (!current || current.revision !== seen?.revision || current.updatedAt !== seen?.updatedAt) {
      return false;
    }
    return deletePaneEntry(stateDir, paneId);
  });
}

export function deletePaneEntry(stateDir, paneId) {
  const file = paneEntryPath(stateDir, paneId);
  return withPaneLock(stateDir, paneId, () => {
    if (!existsSync(file)) {
      return false;
    }
    try {
      unlinkSync(file);
    } catch (error) {
      throw new PluginError("startup", `Could not remove ${file}: ${error.message}`, { cause: error });
    }
    return true;
  });
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
