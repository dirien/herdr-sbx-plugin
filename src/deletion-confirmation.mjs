/**
 * Popup entry point declared in herdr-plugin.toml. The logic lives in
 * confirmation-pane.mjs so tests can import it without running it.
 */
import { runConfirmationPopup } from "./confirmation-pane.mjs";

process.exitCode = await runConfirmationPopup(process.env, { input: process.stdin, output: process.stdout }, { installSignalHandlers: true });
