/**
 * Action entry point. Kept dependency-free so the result marker is printed
 * even when the real dispatcher fails to load (syntax error, unsupported Node).
 */
const RESULT_MARKER = "HERDR_SANDBOX_RESULT:";

try {
  const { main } = await import("./action-main.mjs");
  process.exitCode = await main();
} catch (error) {
  const payload = {
    schemaVersion: 1,
    plugin: "sbx.sandbox",
    action: process.env.HERDR_PLUGIN_ACTION_ID ?? null,
    ok: false,
    errorKind: "startup",
    message: error instanceof Error ? error.message : String(error),
  };
  process.stdout.write(`${RESULT_MARKER} ${JSON.stringify(payload)}\n`);
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
