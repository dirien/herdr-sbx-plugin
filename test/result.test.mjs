import assert from "node:assert/strict";
import { test } from "node:test";
import { RESULT_MARKER } from "../src/constants.mjs";
import { PluginError } from "../src/errors.mjs";
import { failurePayload, formatResultLine, parseResultLine } from "../src/result.mjs";

test("formatResultLine and parseResultLine round-trip", () => {
  const line = formatResultLine({ action: "info", ok: true, sandboxName: "s" });
  assert.ok(line.startsWith(`${RESULT_MARKER} {`));
  assert.deepEqual(parseResultLine(`noise\n${line}\nmore`), { schemaVersion: 1, plugin: "sbx.sandbox", action: "info", ok: true, sandboxName: "s" });
  assert.equal(parseResultLine("nothing here"), null);
});

test("failurePayload carries the error kind and trimmed output", () => {
  const payload = failurePayload("stop", new PluginError("not-found", "gone", { output: "  Error: sandbox not found  " }));
  assert.deepEqual(payload, { action: "stop", ok: false, errorKind: "not-found", message: "gone", output: "Error: sandbox not found" });
  assert.deepEqual(failurePayload(null, new Error("boom")), { action: null, ok: false, errorKind: "unknown", message: "boom" });
});
