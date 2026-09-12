#!/usr/bin/env node
/**
 * Fake `herdr` CLI for tests. Logs argv to FAKE_HERDR_LOG and answers with
 * the JSON shapes the plugin relies on. FAKE_HERDR_FAIL="pane split" makes
 * that command exit 1. FAKE_POPUP_DECISION=confirmed|cancelled answers a
 * confirmation popup immediately by writing the decision file.
 * `pane list` answers with every pane id in FAKE_HERDR_PANES plus every mapped
 * pane in the state dir, minus FAKE_HERDR_MISSING_PANES. FAKE_HERDR_ACK_ON_SPLIT=1
 * makes `pane split` acknowledge the last `pane run` launch, emulating a bridge
 * that starts while the action is already opening a replacement pane.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPaneEntry, loadState, savePaneEntry } from "../../src/state.mjs";

const argv = process.argv.slice(2);
const logFile = process.env.FAKE_HERDR_LOG;
let previous = [];
if (logFile && existsSync(logFile)) {
  previous = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
if (logFile) {
  appendFileSync(logFile, `${JSON.stringify({ argv })}\n`);
}

const command = argv.slice(0, 2).join(" ");
const failing = (process.env.FAKE_HERDR_FAIL ?? "").split(",").map((item) => item.trim()).filter(Boolean);
if (failing.includes(command) || failing.includes(argv.slice(0, 3).join(" "))) {
  process.stdout.write(`${JSON.stringify({ error: { code: "fake_failure", message: `fake herdr refuses ${command}` } })}\n`);
  process.exit(1);
}

if (command === "pane run" && process.env.FAKE_HERDR_BRIDGE_STARTS === "1" && process.env.HERDR_PLUGIN_STATE_DIR) {
  // Emulate the bridge starting in the pane: it updates the mapping right away.
  const entry = getPaneEntry(process.env.HERDR_PLUGIN_STATE_DIR, argv[2]);
  if (entry) {
    const commandText = String(argv[3] ?? "");
    const connecting = commandText.includes("bridge.mjs connect ");
    const launchId = commandText.match(/--launch-id (\S+)/)?.[1] ?? null;
    const ackOnly = process.env.FAKE_HERDR_BRIDGE_ACK_ONLY === "1";
    savePaneEntry(process.env.HERDR_PLUGIN_STATE_DIR, argv[2], ackOnly
      ? { ...entry, bridgeStartedAt: new Date().toISOString(), bridgeLaunchId: launchId }
      : { ...entry, bridgeStartedAt: new Date().toISOString(), bridgeLaunchId: launchId, lifecycleState: connecting ? "ready" : "creating", lastConnectedAt: new Date().toISOString() });
  }
  process.stdout.write(`${JSON.stringify({ result: { ok: true } })}\n`);
} else if (command === "pane get") {
  const paneId = argv[2];
  const missing = (process.env.FAKE_HERDR_MISSING_PANES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (missing.includes(paneId)) {
    process.stderr.write(`${JSON.stringify({ error: { code: "pane_not_found", message: `pane ${paneId} not found` } })}\n`);
    process.exit(1);
  }
  const agent = process.env.FAKE_HERDR_PANE_AGENT;
  process.stdout.write(`${JSON.stringify({ result: { pane: { pane_id: paneId, agent_status: agent ? "working" : "unknown", ...(agent ? { agent } : {}) } } })}\n`);
} else if (command === "pane list") {
  const missing = (process.env.FAKE_HERDR_MISSING_PANES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const ids = new Set((process.env.FAKE_HERDR_PANES ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  if (process.env.HERDR_PLUGIN_STATE_DIR && existsSync(process.env.HERDR_PLUGIN_STATE_DIR)) {
    for (const paneId of Object.keys(loadState(process.env.HERDR_PLUGIN_STATE_DIR).panes)) ids.add(paneId);
  }
  const panes = [...ids].filter((id) => !missing.includes(id)).map((pane_id) => ({ pane_id, workspace_id: pane_id.split(":")[0] }));
  process.stdout.write(`${JSON.stringify({ result: { panes } })}\n`);
} else if (command === "pane split" || command === "tab create") {
  if (process.env.FAKE_HERDR_ACK_ON_SPLIT === "1" && process.env.HERDR_PLUGIN_STATE_DIR) {
    const lastRun = [...previous].reverse().find((entry) => entry.argv.slice(0, 2).join(" ") === "pane run");
    const launchId = lastRun ? String(lastRun.argv[3] ?? "").match(/--launch-id (\S+)/)?.[1] ?? null : null;
    const entry = lastRun ? getPaneEntry(process.env.HERDR_PLUGIN_STATE_DIR, lastRun.argv[2]) : null;
    if (entry && launchId) {
      savePaneEntry(process.env.HERDR_PLUGIN_STATE_DIR, lastRun.argv[2], { ...entry, bridgeStartedAt: new Date().toISOString(), bridgeLaunchId: launchId });
    }
  }
  const created = previous.filter((entry) => ["pane split", "tab create"].includes(entry.argv.slice(0, 2).join(" "))).length + 1;
  const newPaneId = process.env.FAKE_HERDR_NEW_PANE_ID || `pane-new-${created}`;
  if (command === "tab create") {
    process.stdout.write(`${JSON.stringify({ result: { tab: { tab_id: `tab-new-${created}` }, root_pane: { pane_id: newPaneId } } })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ result: { pane: { pane_id: newPaneId } } })}\n`);
  }
} else if (command === "plugin pane") {
  const decision = process.env.FAKE_POPUP_DECISION;
  const envArg = argv.find((item) => item.startsWith("HERDR_SBX_CONFIRMATION_ID="));
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (envArg && stateDir && process.env.FAKE_HERDR_CONFIRMATION_LOG) {
    const requestFile = path.join(stateDir, "confirmations", `${envArg.split("=")[1]}.request.json`);
    if (existsSync(requestFile)) {
      appendFileSync(process.env.FAKE_HERDR_CONFIRMATION_LOG, `${JSON.stringify(JSON.parse(readFileSync(requestFile, "utf8")))}\n`);
    }
  }
  if (decision && envArg && stateDir) {
    const requestId = envArg.split("=")[1];
    const dir = path.join(stateDir, "confirmations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${requestId}.decision.json`), JSON.stringify({ requestId, decision, decidedAt: new Date().toISOString() }));
  }
  process.stdout.write(`${JSON.stringify({ result: { ok: true } })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ result: { ok: true } })}\n`);
}
