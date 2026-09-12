/**
 * Thin wrapper around the `sbx` CLI plus the pure argument builders the
 * lifecycle uses. Every failure is classified into a stable error kind by
 * inspecting the CLI output, because exit codes alone do not say why.
 * @module sbx
 */
import { spawnSync } from "node:child_process";
import { SBX_CALL_TIMEOUT_ENV, SBX_CALL_TIMEOUT_MS, SBX_SLOW_CALL_TIMEOUT_ENV, SBX_SLOW_CALL_TIMEOUT_MS } from "./constants.mjs";
import { PluginError } from "./errors.mjs";

const MAX_BUFFER = 16 * 1024 * 1024;

const NOT_FOUND_PATTERN = /no such sandbox|not found|does not exist|unknown sandbox|no sandbox (?:named|with|called)/i;
const DAEMON_PATTERN = /sandboxd|daemon (?:is )?not running|(?:cannot|could not|can't|unable to) connect to (?:the )?daemon|is the daemon running/i;
const AUTH_PATTERN = /not logged in|sbx login|unauthori[sz]ed|authentication (?:required|failed)|\b401\b/i;
const PERMISSION_PATTERN = /permission denied|forbidden|operation not permitted|\b403\b/i;
const CONFLICT_PATTERN = /already exists|already in use|in use by|is in use|active session|has (?:an? )?(?:open|active)|conflict/i;
const NETWORK_PATTERN = /connection refused|network is unreachable|no such host|timed out|timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|proxy/i;

/**
 * Maps CLI output to an error kind.
 * @param {string} output Combined stdout and stderr.
 * @returns {string}
 */
export function classifyFailure(output) {
  const text = String(output ?? "");
  // Daemon, credential and permission failures are checked before the broad
  // "not found" wording: a missing daemon socket must not read as a missing sandbox.
  if (DAEMON_PATTERN.test(text)) return "daemon";
  if (AUTH_PATTERN.test(text)) return "authentication";
  if (PERMISSION_PATTERN.test(text)) return "permission";
  if (NOT_FOUND_PATTERN.test(text)) return "not-found";
  if (CONFLICT_PATTERN.test(text)) return "conflict";
  if (NETWORK_PATTERN.test(text)) return "network";
  return "unknown";
}

/**
 * Reads a millisecond timeout from an environment value, falling back when it
 * is unset, empty or not a positive number.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
export function timeoutFromEnv(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Builds the argv for `sbx create`.
 * @param {{config: Record<string, any>, sandboxName: string, agent: {sbxAgent: string}, localPath: string}} input
 * @returns {string[]}
 */
export function buildCreateArgs({ config, sandboxName, agent, localPath }) {
  const args = ["create", "--name", sandboxName];
  if (config.template) args.push("--template", config.template);
  for (const kit of config.kits) args.push("--kit", kit);
  for (const kitArg of config.kitArgs) args.push("--kit-arg", kitArg);
  for (const item of config.env) args.push("--env", item);
  for (const file of config.envFiles) args.push("--env-file", file);
  for (const spec of config.publish) args.push("--publish", spec);
  if (config.cpus !== null && config.cpus !== undefined) args.push("--cpus", String(config.cpus));
  if (config.memory) args.push("--memory", config.memory);
  for (const rule of config.denyNetwork) args.push("--deny-network", rule);
  if (config.workspaceMode === "clone") args.push("--clone");
  args.push(agent.sbxAgent, localPath, ...config.extraWorkspaces);
  return args;
}

/**
 * Builds the argv for `sbx exec`. The command is separated from the sbx flags
 * with `--` so agent flags such as `--dangerously-skip-permissions` are never
 * parsed by sbx itself.
 * @param {{sandboxName: string, argv: string[], workdir?: string|null, interactive?: boolean, tty?: boolean, env?: string[]}} input
 * @returns {string[]}
 */
export function buildExecArgs({ sandboxName, argv, workdir = null, interactive = false, tty = false, env = [] }) {
  const args = ["exec"];
  if (interactive) args.push("--interactive");
  if (tty) args.push("--tty");
  if (workdir) args.push("--workdir", workdir);
  for (const item of env) args.push("--env", item);
  args.push(sandboxName, "--", ...argv);
  return args;
}

const SANDBOX_FIELDS = ["name", "Name", "id", "status", "state", "Status", "agent", "workspaces", "created_at"];

function looksLikeSandbox(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && SANDBOX_FIELDS.some((field) => field in value);
}

/**
 * Normalizes the JSON printed by `sbx ls --json`, whose exact shape is not
 * documented. Accepts a bare array, an object wrapping an array under
 * `sandboxes`/`items`, or a map keyed by sandbox name. Anything else throws so
 * an unparsed payload is never mistaken for "no sandboxes".
 * @param {unknown} parsed
 * @returns {Array<{name: string, status: string|null, raw: any}>}
 */
export function normalizeSandboxList(parsed) {
  let items;
  if (parsed === null || parsed === undefined) {
    items = [];
  } else if (Array.isArray(parsed)) {
    items = parsed;
  } else if (typeof parsed === "object") {
    const container = /** @type {any} */ (parsed);
    const wrapperKey = ["sandboxes", "items", "Sandboxes"].find((key) => key in container);
    const wrapped = wrapperKey === undefined ? undefined : container[wrapperKey];
    const values = Object.values(container);
    if (Array.isArray(wrapped)) {
      items = wrapped;
    } else if (wrapperKey !== undefined && (wrapped === null || wrapped === undefined)) {
      // Go marshals an empty slice as null; an explicit empty wrapper is an empty list.
      items = [];
    } else if (values.length === 0) {
      items = [];
    } else if (values.every(looksLikeSandbox)) {
      items = Object.entries(container).map(([key, value]) => ({ ...value, name: value.name ?? value.Name ?? key }));
    } else {
      throw new PluginError("unknown", `sbx ls --json printed a shape this plugin does not understand (top-level keys: ${Object.keys(container).join(", ")}). Please report it.`);
    }
  } else {
    throw new PluginError("unknown", `sbx ls --json printed ${typeof parsed} instead of a list.`);
  }
  const normalized = items.map((item) => ({
    name: item?.name ?? item?.Name ?? item?.id ?? null,
    status: item?.status ?? item?.state ?? item?.Status ?? null,
    raw: item,
  }));
  // A partially readable inventory is as dangerous as an unreadable one: a
  // sandbox dropped here would look deleted. Reject the whole response.
  const unnamed = normalized.filter((item) => typeof item.name !== "string" || item.name === "");
  if (unnamed.length > 0) {
    throw new PluginError("unknown", `sbx ls --json listed ${unnamed.length} sandbox entr${unnamed.length === 1 ? "y" : "ies"} without a recognizable name field. Please report it.`);
  }
  return normalized;
}

const PORT_FIELDS = {
  host: ["host_port", "hostPort", "host", "published", "local_port", "localPort"],
  sandbox: ["sandbox_port", "sandboxPort", "container_port", "containerPort", "target", "port"],
  spec: ["spec", "mapping", "publish"],
};

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}

/**
 * Parses an sbx port spec `[[HOST_IP:]HOST_PORT:]SANDBOX_PORT[/PROTOCOL]`.
 * A bare number is a single port (`single`), and `address:port` with a
 * non-numeric address is reported as `single` too, with the address kept.
 * @param {unknown} value
 * @returns {{hostPort: number|null, sandboxPort: number|null, single: number|null, address: string|null}|null}
 */
export function parsePortSpec(value) {
  if (typeof value === "number") {
    return { hostPort: null, sandboxPort: null, single: validPort(value), address: null };
  }
  if (typeof value !== "string") {
    return null;
  }
  const parts = value.trim().replace(/\/[A-Za-z0-9]+$/, "").split(":");
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : null));
  if (parts.length === 1) {
    return { hostPort: null, sandboxPort: null, single: validPort(numbers[0]), address: null };
  }
  if (parts.length === 2) {
    if (numbers[0] === null) {
      return { hostPort: null, sandboxPort: null, single: validPort(numbers[1]), address: parts[0] };
    }
    return { hostPort: validPort(numbers[0]), sandboxPort: validPort(numbers[1]), single: null, address: null };
  }
  if (parts.length === 3) {
    return { hostPort: validPort(numbers[1]), sandboxPort: validPort(numbers[2]), single: null, address: parts[0] };
  }
  return null;
}

function portFromFields(item, names, role) {
  for (const name of names) {
    const parsed = parsePortSpec(item?.[name]);
    if (!parsed) continue;
    // A single port in a field is that field's port; a full spec carries both roles.
    const value = parsed.single ?? parsed[`${role}Port`];
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/**
 * Normalizes the JSON printed by `sbx ports NAME --json`, whose schema is not
 * documented. Accepts a bare array or an object wrapping it under `ports`,
 * `items` or `published`, with numeric fields or docker-style spec strings.
 * A payload that lists entries without a recognizable sandbox port throws, so
 * an unparsed shape is never mistaken for "no ports".
 * @param {unknown} parsed
 * @returns {Array<{hostPort: number|null, sandboxPort: number, raw: any}>}
 */
export function normalizePortList(parsed) {
  let items;
  if (parsed === null || parsed === undefined) {
    items = [];
  } else if (Array.isArray(parsed)) {
    items = parsed;
  } else if (typeof parsed === "object") {
    const container = /** @type {any} */ (parsed);
    const wrapperKey = ["ports", "items", "published"].find((key) => key in container);
    const wrapped = wrapperKey === undefined ? undefined : container[wrapperKey];
    if (Array.isArray(wrapped)) {
      items = wrapped;
    } else if (wrapperKey !== undefined && (wrapped === null || wrapped === undefined)) {
      items = [];
    } else if (Object.keys(container).length === 0) {
      items = [];
    } else {
      throw new PluginError("unknown", `sbx ports --json printed a shape this plugin does not understand (top-level keys: ${Object.keys(container).join(", ")}). Please report it.`);
    }
  } else {
    throw new PluginError("unknown", `sbx ports --json printed ${typeof parsed} instead of a list.`);
  }
  const normalized = items
    .map((item) => {
      // Any spec string such as "8080:3000/tcp" carries both ports, whatever the field is called.
      const spec = [...PORT_FIELDS.spec, ...PORT_FIELDS.host]
        .map((name) => item?.[name])
        .filter((value) => typeof value === "string" && value.includes(":"))
        .map(parsePortSpec)
        .find((value) => value && value.sandboxPort !== null) ?? null;
      return {
        hostPort: portFromFields(item, PORT_FIELDS.host, "host") ?? spec?.hostPort ?? null,
        sandboxPort: portFromFields(item, PORT_FIELDS.sandbox, "sandbox") ?? spec?.sandboxPort ?? null,
        raw: item,
      };
    })
    .filter((item) => item.sandboxPort !== null);
  if (items.length > 0 && normalized.length === 0) {
    throw new PluginError("unknown", "sbx ports --json listed entries without a recognizable sandbox port. Please report it.");
  }
  return normalized;
}

/**
 * Creates a client bound to one sbx executable.
 * @param {{bin?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function createSbxClient({ bin = "sbx", env = process.env } = {}) {
  const spawnError = (args, error) => {
    if (error.code === "ENOENT") {
      return new PluginError("startup", `The sbx CLI was not found (looked for "${bin}"). Install Docker Sandboxes (for example "brew install docker/tap/sbx") or set config.sbxBin.`, { cause: error });
    }
    return new PluginError("unknown", `Could not run "${bin} ${args.join(" ")}": ${error.message}`, { cause: error });
  };

  const timeouts = {
    call: timeoutFromEnv(env?.[SBX_CALL_TIMEOUT_ENV], SBX_CALL_TIMEOUT_MS),
    slow: timeoutFromEnv(env?.[SBX_SLOW_CALL_TIMEOUT_ENV], SBX_SLOW_CALL_TIMEOUT_MS),
  };

  /**
   * Runs sbx with captured output. A call that outlives its timeout is killed
   * and reported as a daemon failure, so a wedged sandboxd cannot hang an
   * action forever; `slow` selects the long timeout for image pulls and setup scripts.
   * @param {string[]} args
   * @param {{cwd?: string, extraEnv?: Record<string, string>, input?: string, slow?: boolean, timeout?: number}} [options]
   */
  function run(args, options = {}) {
    const timeout = options.timeout ?? (options.slow ? timeouts.slow : timeouts.call);
    const result = spawnSync(bin, args, {
      encoding: "utf8",
      cwd: options.cwd,
      input: options.input,
      env: { ...env, ...(options.extraEnv ?? {}) },
      maxBuffer: MAX_BUFFER,
      timeout,
      killSignal: "SIGKILL",
    });
    if (result.error) {
      if (/** @type {any} */ (result.error).code === "ETIMEDOUT") {
        const variable = options.slow ? SBX_SLOW_CALL_TIMEOUT_ENV : SBX_CALL_TIMEOUT_ENV;
        throw new PluginError("daemon", `sbx ${args[0]} did not finish within ${Math.round(timeout / 1000)}s and was killed. The sandbox daemon may be wedged (try "sbx daemon status"); ${variable} raises the limit.`, { output: `${result.stdout ?? ""}${result.stderr ?? ""}` });
      }
      throw spawnError(args, result.error);
    }
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    return { status: result.status, signal: result.signal, stdout, stderr, output: `${stdout}${stderr}` };
  }

  /**
   * Runs sbx and throws a classified error on a non-zero exit.
   * @param {string[]} args
   * @param {string} step Human description used in the error message.
   * @param {Parameters<typeof run>[1]} [options]
   */
  function runChecked(args, step, options = {}) {
    const result = run(args, options);
    if (result.status !== 0) {
      const exit = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
      throw new PluginError(classifyFailure(result.output), `sbx ${args[0]} failed while ${step} (${exit}).`, { output: result.output });
    }
    return result;
  }

  /**
   * Runs sbx attached to the current terminal (for interactive sessions).
   * @param {string[]} args
   * @param {{cwd?: string, extraEnv?: Record<string, string>}} [options]
   * @returns {{status: number|null, signal: string|null}}
   */
  function runInteractive(args, options = {}) {
    const result = spawnSync(bin, args, {
      stdio: "inherit",
      cwd: options.cwd,
      env: { ...env, ...(options.extraEnv ?? {}) },
    });
    if (result.error) {
      throw spawnError(args, result.error);
    }
    return { status: result.status, signal: result.signal };
  }

  /**
   * Lists sandboxes known to the local daemon.
   * @returns {ReturnType<typeof normalizeSandboxList>}
   */
  function listSandboxes() {
    const result = runChecked(["ls", "--json"], "listing sandboxes");
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new PluginError("unknown", `sbx ls --json printed invalid JSON: ${error.message}`, { output: result.output, cause: error });
    }
    return normalizeSandboxList(parsed);
  }

  /**
   * Finds one sandbox by name, or null when absent.
   * @param {string} name
   */
  function findSandbox(name) {
    return listSandboxes().find((item) => item.name === name) ?? null;
  }

  /**
   * Lists the ports a sandbox publishes to the host.
   * @param {string} name
   * @returns {ReturnType<typeof normalizePortList>}
   */
  function listPorts(name) {
    const result = runChecked(["ports", name, "--json"], `listing the ports of ${name}`);
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new PluginError("unknown", `sbx ports --json printed invalid JSON: ${error.message}`, { output: result.output, cause: error });
    }
    return normalizePortList(parsed);
  }

  /**
   * Reads `sbx version --json`.
   * @returns {{raw: string, json: any}}
   */
  function version() {
    const result = runChecked(["version", "--json"], "reading the sbx version");
    let json = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = null;
    }
    return { raw: result.stdout.trim(), json };
  }

  /**
   * Reads `sbx daemon status --json` without throwing.
   * @returns {{ok: boolean, json: any, output: string}}
   */
  function daemonStatus() {
    const result = run(["daemon", "status", "--json"]);
    let json = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = null;
    }
    return { ok: result.status === 0, json, output: result.output.trim() };
  }

  return { bin, run, runChecked, runInteractive, listSandboxes, findSandbox, listPorts, version, daemonStatus };
}
