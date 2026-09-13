/**
 * The sandboxes overlay: a live table of every mapping with its pane, sandbox
 * status and published ports, refreshed until `q` is pressed.
 * @module sandboxes-pane-main
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.mjs";
import { readPluginEnv, requirePluginDirs } from "./context.mjs";
import { PluginError, errorMessageOf } from "./errors.mjs";
import { PANE_NOT_FOUND_PATTERN } from "./herdr.mjs";
import { hyperlink, sandboxPortUrl } from "./links.mjs";
import { classifyFailure, normalizePortList, normalizeSandboxList } from "./sbx.mjs";
import { loadState } from "./state.mjs";

const ESC = String.fromCharCode(27);
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const CTRL_C = String.fromCharCode(3);
const SBX_TIMEOUT_MS = 15_000;
const HERDR_TIMEOUT_MS = 10_000;

/**
 * Runs a CLI without blocking the event loop, so a keypress can cancel it.
 * The child is killed on abort or after `timeoutMs`.
 * @param {string} bin
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, signal?: AbortSignal|null, timeoutMs?: number}} [options]
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, output: string}>}
 */
export function runCli(bin, args, { env = process.env, signal = null, timeoutMs = SBX_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PluginError("cancelled", "cancelled before start"));
      return;
    }
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    // Decoded as streams, so a multi-byte character split across two chunks is not garbled.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Killing the child is not enough when it spawned grandchildren that keep
    // the pipes open; destroying our ends makes "close" fire right away.
    const terminate = () => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => terminate();
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      done();
      reject(new PluginError(/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT" ? "startup" : "unknown", `Could not run ${bin}: ${error.message}`, { cause: error }));
    });
    child.on("close", (status) => {
      done();
      if (signal?.aborted) {
        reject(new PluginError("cancelled", `${bin} ${args[0]} cancelled`));
      } else if (timedOut) {
        reject(new PluginError("network", `${bin} ${args.join(" ")} did not answer within ${Math.round(timeoutMs / 1000)}s`, { output: stdout + stderr }));
      } else {
        resolve({ status, stdout, stderr, output: stdout + stderr });
      }
    });
  });
}

/**
 * Non-blocking clients for the overlay. They mirror the parsing of the
 * synchronous clients but never stall the terminal.
 * @param {{sbxBin: string, herdrBin: string, env?: NodeJS.ProcessEnv}} input
 */
export function createOverlayClients({ sbxBin, herdrBin, env = process.env }) {
  const parseJson = (text, what) => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new PluginError("unknown", `${what} printed invalid JSON: ${error.message}`, { cause: error });
    }
  };
  return {
    sbx: {
      async listSandboxes(signal) {
        const result = await runCli(sbxBin, ["ls", "--json"], { env, signal });
        if (result.status !== 0) {
          throw new PluginError(classifyFailure(result.output), `sbx ls failed (exit ${result.status})`, { output: result.output });
        }
        return normalizeSandboxList(parseJson(result.stdout, "sbx ls --json"));
      },
      async listPorts(name, signal) {
        const result = await runCli(sbxBin, ["ports", name, "--json"], { env, signal });
        if (result.status !== 0) {
          throw new PluginError(classifyFailure(result.output), `sbx ports ${name} failed (exit ${result.status})`, { output: result.output });
        }
        return normalizePortList(parseJson(result.stdout, "sbx ports --json"));
      },
    },
    herdr: {
      async listPaneIds(signal) {
        const result = await runCli(herdrBin, ["pane", "list"], { env, signal, timeoutMs: HERDR_TIMEOUT_MS });
        if (result.status !== 0) {
          throw new PluginError("unknown", `herdr pane list failed (exit ${result.status})`, { output: result.output });
        }
        const parsed = parseJson(result.stdout, "herdr pane list");
        const panes = parsed?.result?.panes ?? parsed?.panes;
        if (!Array.isArray(panes)) {
          throw new PluginError("unknown", "herdr pane list did not return a pane list.", { output: result.stdout });
        }
        return panes.map((pane) => pane?.pane_id).filter((id) => typeof id === "string" && id !== "");
      },
      async getPane(paneId, signal) {
        const result = await runCli(herdrBin, ["pane", "get", paneId], { env, signal, timeoutMs: HERDR_TIMEOUT_MS });
        if (result.status !== 0) {
          if (PANE_NOT_FOUND_PATTERN.test(result.output)) {
            return null;
          }
          throw new PluginError("unknown", `herdr pane get ${paneId} failed (exit ${result.status})`, { output: result.output });
        }
        return parseJson(result.stdout, "herdr pane get")?.result?.pane ?? null;
      },
    },
  };
}

/**
 * Gathers one row per mapping, merging live sbx and Herdr information.
 * `cache` keeps port lists between frames so a refresh does not spawn one
 * process per mapping every time, and `signal` cancels in-flight calls.
 * Pane existence comes from one `herdr pane list` call per frame rather than
 * one `pane get` per mapping.
 * @param {{stateDir: string, sbx: {listSandboxes: (signal?: AbortSignal|null) => Promise<Array<{name: string, status: string|null}>>, listPorts: (name: string, signal?: AbortSignal|null) => Promise<Array<{hostPort: number|null, sandboxPort: number}>>}, herdr: {listPaneIds: (signal?: AbortSignal|null) => Promise<string[]>}, cache?: Map<string, any>, refreshPorts?: boolean, signal?: AbortSignal|null}} input
 */
export async function collectSandboxes({ stateDir, sbx, herdr, cache = new Map(), refreshPorts = true, signal = null }) {
  const state = loadState(stateDir);
  let live = null;
  let sandboxError = null;
  try {
    live = new Map((await sbx.listSandboxes(signal)).map((item) => [item.name, item]));
  } catch (error) {
    sandboxError = errorMessageOf(error);
  }
  let paneIds = null;
  let paneError = null;
  try {
    paneIds = new Set(await herdr.listPaneIds(signal));
  } catch (error) {
    paneError = errorMessageOf(error);
  }
  const rows = [];
  for (const entry of Object.values(state.panes)) {
    if (signal?.aborted) {
      break;
    }
    const item = live?.get(entry.sandboxName) ?? null;
    const cached = cache.get(entry.paneId) ?? { ports: [], portsError: null };
    let { ports, portsError } = cached;
    if (live && !item) {
      // A sandbox that vanished has no ports; stale cached ones must not sit next to MISSING.
      ports = [];
      portsError = null;
    } else if (item && (refreshPorts || !cache.has(entry.paneId))) {
      try {
        ports = await sbx.listPorts(entry.sandboxName, signal);
        portsError = null;
      } catch (error) {
        ports = [];
        portsError = errorMessageOf(error);
      }
    }
    const paneExists = paneIds ? paneIds.has(entry.paneId) : null;
    cache.set(entry.paneId, { ports, portsError });
    rows.push({
      paneId: entry.paneId,
      paneExists,
      paneError,
      sandboxName: entry.sandboxName,
      agentKind: entry.agentKind,
      lifecycleState: entry.lifecycleState,
      exists: live ? item !== null : null,
      status: item?.status ?? null,
      localPath: entry.localPath,
      ports,
      portsError,
    });
  }
  return { rows, sandboxError };
}

function pad(visible, width, rendered = visible) {
  const text = String(visible ?? "");
  return text.length >= width ? rendered : rendered + " ".repeat(width - text.length);
}

function portCell(row, links) {
  if (row.ports.length === 0) {
    return { plain: row.portsError ? "error" : "-", rendered: row.portsError ? "error" : "-" };
  }
  const plainParts = [];
  const renderedParts = [];
  for (const port of row.ports) {
    const text = `${port.hostPort ?? "?"}->${port.sandboxPort}`;
    plainParts.push(text);
    let rendered = text;
    if (links) {
      try {
        rendered = hyperlink(sandboxPortUrl(row.sandboxName, port.sandboxPort), text);
      } catch {
        rendered = text;
      }
    }
    renderedParts.push(rendered);
  }
  return { plain: plainParts.join(" "), rendered: renderedParts.join(" ") };
}

/**
 * Renders the overlay text. Escape sequences never count towards column widths.
 * @param {{rows: any[], sandboxError: string|null}} data
 * @param {{at?: Date, links?: boolean, intervalMs?: number}} [options]
 * @returns {string[]}
 */
export function renderSandboxes({ rows, sandboxError }, { at = new Date(), links = true, intervalMs = 3000 } = {}) {
  const lines = [`Docker Sandboxes  ${rows.length} mapping${rows.length === 1 ? "" : "s"}  ${at.toLocaleTimeString()}  (q closes, refreshes every ${Math.round(intervalMs / 1000)}s)`, ""];
  if (rows.length === 0) {
    lines.push("No sandboxes are mapped. Run start-agent from a workspace.");
  } else {
    const widths = { pane: 14, sandbox: 30, agent: 12, state: 12, status: 10, ports: 18 };
    lines.push(`${pad("PANE", widths.pane)} ${pad("SANDBOX", widths.sandbox)} ${pad("AGENT", widths.agent)} ${pad("STATE", widths.state)} ${pad("STATUS", widths.status)} ${pad("PORTS", widths.ports)} DIRECTORY`);
    for (const row of rows) {
      const pane = row.paneExists === false ? `${row.paneId} (gone)` : row.paneError ? `${row.paneId} (?)` : row.paneId;
      const status = row.exists === null ? "unknown" : row.exists ? row.status ?? "exists" : "MISSING";
      const cell = portCell(row, links);
      lines.push(`${pad(pane, widths.pane)} ${pad(row.sandboxName, widths.sandbox)} ${pad(row.agentKind, widths.agent)} ${pad(row.lifecycleState, widths.state)} ${pad(status, widths.status)} ${pad(cell.plain, widths.ports, cell.rendered)} ${row.localPath}`);
    }
    const paneErrors = rows.filter((row) => row.paneError).map((row) => `${row.paneId}: ${row.paneError}`);
    if (paneErrors.length > 0) {
      lines.push("", `pane check failed: ${paneErrors.join("; ")}`);
    }
    const stale = rows.filter((row) => row.paneExists === false && row.exists === false).length;
    if (stale > 0) {
      lines.push("", `${stale} stale mapping${stale === 1 ? "" : "s"} (pane gone, sandbox missing): run prune-mappings to drop them`);
    }
  }
  if (sandboxError) {
    lines.push("", `sbx ls failed: ${sandboxError}`);
  }
  return lines;
}

/**
 * Keeps an error on screen until a key is pressed or the time is up, because an
 * overlay closes together with its process.
 * @param {any} input
 * @param {any} output
 * @param {number} holdMs
 */
export async function holdForKey(input, output, holdMs) {
  output.write(`press any key to close (closes by itself in ${Math.round(holdMs / 1000)}s)\n`);
  const controller = new AbortController();
  const onKey = () => controller.abort();
  let rawCapable = false;
  try {
    if (typeof input.setRawMode === "function" && input.isTTY) {
      input.setRawMode(true);
      rawCapable = true;
    }
  } catch {
    rawCapable = false;
  }
  input.on("data", onKey);
  if (typeof input.resume === "function") {
    input.resume();
  }
  try {
    await sleep(holdMs, null, { signal: controller.signal });
  } catch {
    // A key was pressed.
  } finally {
    input.off("data", onKey);
    if (rawCapable) {
      try {
        input.setRawMode(false);
      } catch {
        // The terminal is gone.
      }
    }
    if (typeof input.pause === "function") {
      input.pause();
    }
  }
}

/**
 * Runs the overlay. With `once` it renders a single frame and returns.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{once?: boolean, intervalMs?: number, output?: NodeJS.WritableStream & {isTTY?: boolean}, input?: NodeJS.ReadableStream & {isTTY?: boolean, setRawMode?: (mode: boolean) => unknown}, holdMs?: number}} [options] `holdMs` is how long a startup error stays on screen.
 * @returns {Promise<number>}
 */
export async function runSandboxesPane(env = process.env, { once = false, intervalMs = 3000, output = process.stdout, input = process.stdin, holdMs = 15_000 } = {}) {
  let pluginEnv;
  let config;
  try {
    pluginEnv = requirePluginDirs(readPluginEnv(env));
    config = loadConfig(pluginEnv.configDir, env);
  } catch (error) {
    output.write(`${errorMessageOf(error)}\n`);
    if (!once) {
      await holdForKey(input, output, holdMs);
    }
    return 1;
  }
  const { sbx, herdr } = createOverlayClients({ sbxBin: config.sbxBin, herdrBin: pluginEnv.herdrBin, env });
  const links = Boolean(output.isTTY) || once;
  const cache = new Map();
  const controller = new AbortController();
  let frame = 0;
  const draw = async () => {
    let lines;
    try {
      // Ports rarely change; refresh them every third frame to keep the overlay responsive.
      lines = renderSandboxes(await collectSandboxes({ stateDir: pluginEnv.stateDir, sbx, herdr, cache, refreshPorts: frame % 3 === 0, signal: controller.signal }), { links, intervalMs });
    } catch (error) {
      lines = [`could not read the sandboxes: ${errorMessageOf(error)}`];
    }
    frame += 1;
    if (!controller.signal.aborted) {
      output.write(`${once ? "" : CLEAR_SCREEN}${lines.join("\n")}\n`);
    }
  };
  if (once) {
    await draw();
    return 0;
  }
  const onKey = (chunk) => {
    const text = String(chunk);
    if (text === "q" || text === "Q" || text === CTRL_C) {
      controller.abort();
    }
  };
  let rawCapable = false;
  try {
    if (typeof input.setRawMode === "function" && input.isTTY) {
      input.setRawMode(true);
      rawCapable = true;
    }
  } catch (error) {
    output.write(`raw input unavailable (${errorMessageOf(error)}); press Ctrl-C or close the pane to leave\n`);
  }
  input.on("data", onKey);
  if (typeof input.resume === "function") {
    input.resume();
  }
  try {
    while (!controller.signal.aborted) {
      await draw();
      if (controller.signal.aborted) {
        break;
      }
      try {
        await sleep(intervalMs, null, { signal: controller.signal });
      } catch {
        break;
      }
    }
  } finally {
    input.off("data", onKey);
    if (rawCapable) {
      try {
        input.setRawMode(false);
      } catch {
        // The terminal is gone; nothing to restore.
      }
    }
    if (typeof input.pause === "function") {
      input.pause();
    }
  }
  return 0;
}
