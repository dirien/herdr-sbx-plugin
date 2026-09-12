import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { ROOT } from "./helpers.mjs";
import { createConfirmationRequest, readConfirmationDecision, requestDeletionConfirmation, sweepStaleConfirmations, writeConfirmationDecision } from "../src/confirm.mjs";
import { utimesSync, writeFileSync } from "node:fs";
import { runConfirmationPopup } from "../src/confirmation-pane.mjs";

const DETAILS = { action: "forget-mapping", sandboxName: "herdr-x-1", localPath: "/w", paneId: "pane-1", consequence: "It is gone." };

async function popup({ answer = null, endInput = false, ttlMs = 60_000 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-popup-"));
  const requestId = createConfirmationRequest(dir, DETAILS, ttlMs);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });
  const running = runConfirmationPopup({ HERDR_SBX_CONFIRMATION_ID: requestId, HERDR_PLUGIN_STATE_DIR: dir }, { input, output });
  if (answer !== null) {
    input.write(`${answer}\n`);
  }
  if (endInput) {
    input.end();
  }
  const code = await running;
  return { code, text, decision: readConfirmationDecision(dir, requestId) };
}

test("typing DELETE confirms", async () => {
  const outcome = await popup({ answer: "DELETE" });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.decision.decision, "confirmed");
  assert.match(outcome.text, /herdr-x-1/);
  assert.match(outcome.text, /Confirmed/);
});

test("any other answer cancels", async () => {
  const outcome = await popup({ answer: "delete please" });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.decision.decision, "cancelled");
  assert.match(outcome.text, /Cancelled/);
});

test("closing the input cancels", async () => {
  const outcome = await popup({ endInput: true });
  assert.equal(outcome.decision.decision, "cancelled");
});

test("running out of time cancels", async () => {
  const outcome = await popup({ ttlMs: 60 });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.decision.decision, "cancelled");
});

test("a request without a valid expiry cancels immediately", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-popup-"));
  const requestId = createConfirmationRequest(dir, DETAILS);
  writeFileSync(path.join(dir, "confirmations", `${requestId}.request.json`), JSON.stringify({ requestId, ...DETAILS }));
  const output = new PassThrough();
  const code = await runConfirmationPopup({ HERDR_SBX_CONFIRMATION_ID: requestId, HERDR_PLUGIN_STATE_DIR: dir }, { input: new PassThrough(), output });
  assert.equal(code, 0);
  assert.equal(readConfirmationDecision(dir, requestId).decision, "cancelled");
});

test("stale confirmation files are swept when a new request is created", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-popup-"));
  const stale = createConfirmationRequest(dir, DETAILS);
  writeConfirmationDecision(dir, stale, "cancelled");
  const old = new Date(Date.now() - 10 * 60_000);
  for (const suffix of ["request", "decision"]) {
    utimesSync(path.join(dir, "confirmations", `${stale}.${suffix}.json`), old, old);
  }
  assert.equal(sweepStaleConfirmations(dir, 60_000), 2);
  const fresh = createConfirmationRequest(dir, DETAILS);
  assert.deepEqual(readdirSync(path.join(dir, "confirmations")), [`${fresh}.request.json`]);
});

test("the popup fails without its environment", async () => {
  const output = new PassThrough();
  const code = await runConfirmationPopup({}, { input: new PassThrough(), output });
  assert.equal(code, 1);
});

function spawnPopup(dir, requestId) {
  const child = spawn(process.execPath, [path.join(ROOT, "src", "deletion-confirmation.mjs")], {
    env: { PATH: process.env.PATH, HERDR_SBX_CONFIRMATION_ID: requestId, HERDR_PLUGIN_STATE_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  const prompted = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("Type DELETE")) {
        resolve();
      }
    });
  });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  return { child, prompted, closed, output: () => stdout };
}

test("the popup entry point records a cancellation on SIGINT", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-popup-"));
  const requestId = createConfirmationRequest(dir, DETAILS);
  const popup = spawnPopup(dir, requestId);
  await popup.prompted;
  popup.child.kill("SIGINT");
  const { code } = await popup.closed;
  assert.equal(code, 130);
  assert.equal(readConfirmationDecision(dir, requestId).decision, "cancelled");
});

test("the popup entry point confirms when DELETE is typed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-popup-"));
  const requestId = createConfirmationRequest(dir, DETAILS);
  const popup = spawnPopup(dir, requestId);
  await popup.prompted;
  popup.child.stdin.write("DELETE\n");
  popup.child.stdin.end();
  const { code } = await popup.closed;
  assert.equal(code, 0);
  assert.equal(readConfirmationDecision(dir, requestId).decision, "confirmed");
  assert.match(popup.output(), /Confirmed/);
});

test("requestDeletionConfirmation resolves on a decision and cleans up", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-confirm-"));
  const herdr = {
    openPluginPane({ env }) {
      setTimeout(() => writeConfirmationDecision(dir, env.HERDR_SBX_CONFIRMATION_ID, "confirmed"), 30);
    },
  };
  assert.equal(await requestDeletionConfirmation({ stateDir: dir, herdr, pluginId: "sbx.sandbox", details: DETAILS, timeoutMs: 2000, pollMs: 10 }), true);
  assert.deepEqual(readdirSync(path.join(dir, "confirmations")), []);
  const silent = { openPluginPane() {} };
  assert.equal(await requestDeletionConfirmation({ stateDir: dir, herdr: silent, pluginId: "sbx.sandbox", details: DETAILS, timeoutMs: 80, pollMs: 10 }), false);
  assert.deepEqual(readdirSync(path.join(dir, "confirmations")), []);
});

test("the popup strips control characters from the names it displays", async () => {
  const ESC = String.fromCharCode(27);
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-sbx-popup-"));
  const requestId = createConfirmationRequest(dir, { ...DETAILS, localPath: `/w/${ESC}[2J${ESC}[Hfake`, sandboxName: `herdr-x-1\r\n  consequence: nothing happens` }, 60_000);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });
  const running = runConfirmationPopup({ HERDR_SBX_CONFIRMATION_ID: requestId, HERDR_PLUGIN_STATE_DIR: dir }, { input, output });
  input.write("no\n");
  await running;
  assert.ok(!text.includes(ESC), "no escape byte reaches the terminal");
  assert.match(text, /worktree: \/w\/\?\[2J\?\[Hfake/);
  assert.match(text, /sandbox:  herdr-x-1\?\?  consequence: nothing happens/);
});
