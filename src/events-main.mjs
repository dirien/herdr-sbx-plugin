/**
 * Event hook for `worktree.removed`: offers to delete the sandboxes that were
 * created for the removed worktree and forgets their mappings, unless the
 * user set `cleanupOnWorktreeRemoved` to false. Deleting is never automatic:
 * the same DELETE popup as forget-mapping runs first.
 * @module events-main
 */
import { loadConfig } from "./config.mjs";
import { requestDeletionConfirmation } from "./confirm.mjs";
import { CONFIRMATION_TIMEOUT_ENV, CONFIRMATION_TTL_MS } from "./constants.mjs";
import { readEventPayload, readPluginEnv } from "./context.mjs";
import { errorMessageOf } from "./errors.mjs";
import { createHerdrClient } from "./herdr.mjs";
import { createLifecycle, deletionTargets } from "./lifecycle.mjs";
import { entriesForLocalPath, loadState } from "./state.mjs";

/**
 * Extracts the removed worktree path from the event payload.
 * @param {Record<string, any>} payload
 * @returns {string|null}
 */
export function removedWorktreePath(payload) {
  return payload?.data?.worktree?.path ?? payload?.worktree?.path ?? null;
}

function confirmationTimeout(env) {
  const raw = Number(env[CONFIRMATION_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : CONFIRMATION_TTL_MS;
}

async function handleEventUnsafe(env) {
  const pluginEnv = readPluginEnv(env);
  const log = (line) => process.stdout.write(`${line}\n`);
  if (pluginEnv.eventName !== "worktree.removed") {
    log(`ignoring event ${pluginEnv.eventName ?? "(none)"}`);
    return 0;
  }
  if (!pluginEnv.stateDir || !pluginEnv.configDir) {
    log("no plugin state directory; nothing to clean up");
    return 0;
  }
  const config = loadConfig(pluginEnv.configDir, env);
  if (!config.cleanupOnWorktreeRemoved) {
    log("cleanupOnWorktreeRemoved is false; leaving sandboxes alone");
    return 0;
  }
  const removedPath = removedWorktreePath(readEventPayload(env));
  if (!removedPath) {
    log("event carries no worktree path; nothing to clean up");
    return 0;
  }
  const matches = entriesForLocalPath(loadState(pluginEnv.stateDir), removedPath);
  if (matches.length === 0) {
    log(`no sandbox mapped to ${removedPath}`);
    return 0;
  }
  const lifecycle = createLifecycle({ stateDir: pluginEnv.stateDir, config, log });
  const herdr = createHerdrClient({ bin: pluginEnv.herdrBin, env });
  // The sandboxes may hold work that exists only inside them (clone mode).
  const targets = matches.flatMap(([, entry]) => deletionTargets(entry));
  const confirmed = await requestDeletionConfirmation({
    stateDir: pluginEnv.stateDir,
    herdr,
    pluginId: pluginEnv.pluginId,
    details: {
      action: "worktree.removed",
      paneId: matches.map(([paneId]) => paneId).join(", "),
      sandboxName: targets.join(", "),
      localPath: removedPath,
      consequence: `Herdr removed this worktree. DELETE removes ${targets.length === 1 ? "its sandbox" : `its ${targets.length} sandboxes`} permanently, including anything that exists only inside ${targets.length === 1 ? "it" : "them"}; anything else keeps ${targets.length === 1 ? "it" : "them"} (prune-mappings offers this again later).`,
    },
    timeoutMs: confirmationTimeout(env),
  });
  if (!confirmed) {
    log(`deletion of ${targets.join(", ")} was not confirmed; mappings kept`);
    return 0;
  }
  let failures = 0;
  const removed = [];
  for (const [paneId, entry] of matches) {
    try {
      const outcome = lifecycle.forget(paneId, { expectedNames: deletionTargets(entry) });
      removed.push(...outcome.deleted);
      log(`forgot mapping for pane ${paneId} (${entry.sandboxName})`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`could not clean up ${entry.sandboxName} for pane ${paneId}: ${errorMessageOf(error)}\n`);
    }
  }
  if (removed.length > 0) {
    herdr.notify("Docker Sandboxes removed", `${removed.join(", ")} (worktree ${removedPath} was removed)`);
  }
  return failures === 0 ? 0 : 1;
}

/**
 * Handles the event and returns the exit code. Any unexpected failure is
 * reported as one line on stderr instead of a stack trace.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export async function handleEvent(env = process.env) {
  try {
    return await handleEventUnsafe(env);
  } catch (error) {
    process.stderr.write(`worktree cleanup failed: ${errorMessageOf(error)}\n`);
    return 1;
  }
}
