/**
 * Event hook entry point declared in herdr-plugin.toml for `worktree.removed`.
 * The logic lives in events-main.mjs so tests can import it without running it.
 */
import { handleEvent } from "./events-main.mjs";

process.exitCode = await handleEvent();
