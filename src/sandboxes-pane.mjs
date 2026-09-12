/**
 * Overlay pane entry point declared in herdr-plugin.toml. Pass --once to
 * render a single frame (used by tests). The logic lives in
 * sandboxes-pane-main.mjs. Unexpected failures stay on screen for a moment,
 * because Herdr closes the overlay as soon as this process exits.
 */
import { holdForKey, runSandboxesPane } from "./sandboxes-pane-main.mjs";

const once = process.argv.includes("--once");
try {
  process.exitCode = await runSandboxesPane(process.env, { once });
} catch (error) {
  process.stdout.write(`the sandboxes overlay crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  if (!once) {
    await holdForKey(process.stdin, process.stdout, 15_000);
  }
  process.exitCode = 1;
}
