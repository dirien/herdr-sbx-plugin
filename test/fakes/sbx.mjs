#!/usr/bin/env node
/**
 * Fake `sbx` CLI for tests. Logs every invocation as a JSON line to
 * FAKE_SBX_LOG, keeps sandboxes in FAKE_SBX_STATE, and injects failures
 * listed in FAKE_SBX_FAIL (comma-separated `subcommand[:mode][@sandbox]`; a
 * rule with `@sandbox` only fires for that sandbox name). FAKE_SBX_SLEEP_MS
 * delays every invocation, which is how the timeout tests wedge the daemon.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const logFile = process.env.FAKE_SBX_LOG;
const stateFile = process.env.FAKE_SBX_STATE;
if (logFile) {
  appendFileSync(logFile, `${JSON.stringify({ argv, cwd: process.cwd(), herdrAgent: process.env.HERDR_AGENT ?? null })}\n`);
}
if (process.env.FAKE_SBX_SLEEP_MS) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SBX_SLEEP_MS));
}

function loadState() {
  if (stateFile && existsSync(stateFile)) {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  }
  return { sandboxes: [] };
}

function saveState(state) {
  if (stateFile) {
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }
}

function failureFor(subcommand, sandboxName = null) {
  const rules = (process.env.FAKE_SBX_FAIL ?? "").split(",").map((rule) => rule.trim()).filter(Boolean);
  for (const rule of rules) {
    const [spec, onlyFor = null] = rule.split("@");
    const [name, mode = "generic"] = spec.split(":");
    if (name === subcommand && (onlyFor === null || onlyFor === sandboxName)) {
      return mode;
    }
  }
  return null;
}

function fail(mode, name = "unknown") {
  const messages = {
    "not-found": `Error: sandbox "${name}" not found`,
    conflict: `Error: sandbox "${name}" already exists`,
    busy: `Error: sandbox "${name}" has an active session; close it first`,
    daemon: "Error: cannot connect to the daemon at /tmp/sandboxd.sock: is the daemon running?",
    auth: 'Error: not logged in; run "sbx login" first',
    generic: "Error: something went wrong",
  };
  process.stderr.write(`${messages[mode] ?? messages.generic}\n`);
  process.exit(1);
}

const [subcommand, ...rest] = argv;
const injected = failureFor(subcommand);
const state = loadState();

switch (subcommand) {
  case "version": {
    if (injected) fail(injected);
    const fakeVersion = process.env.FAKE_SBX_VERSION ?? "0.42.1";
    process.stdout.write(`${JSON.stringify({ client: { version: fakeVersion }, server: { version: fakeVersion, state: "running" } })}\n`);
    break;
  }
  case "daemon": {
    if (injected) fail(injected);
    process.stdout.write(`${JSON.stringify({ running: true, socket: "/tmp/fake-sandboxd.sock" })}\n`);
    break;
  }
  case "ls": {
    if (injected) fail(injected);
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ sandboxes: state.sandboxes })}\n`);
    } else {
      process.stdout.write(`${state.sandboxes.map((item) => item.name).join("\n")}\n`);
    }
    break;
  }
  case "create": {
    const nameIndex = rest.indexOf("--name");
    const name = nameIndex === -1 ? "unnamed" : rest[nameIndex + 1];
    if (injected) fail(injected, name);
    const valued = new Set(["--name", "--template", "--kit", "--kit-arg", "--env", "--env-file", "--publish", "--cpus", "--memory", "--deny-network"]);
    const positionals = [];
    for (let index = 0; index < rest.length; index += 1) {
      if (valued.has(rest[index])) {
        index += 1;
      } else if (!rest[index].startsWith("--")) {
        positionals.push(rest[index]);
      }
    }
    state.sandboxes.push({ name, status: "running", agent: positionals[0] ?? null, workspaces: positionals.slice(1), clone: rest.includes("--clone") });
    saveState(state);
    process.stdout.write(`Created sandbox ${name}\n`);
    break;
  }
  case "exec": {
    const valued = new Set(["--workdir", "--env", "--user"]);
    let index = 0;
    while (index < rest.length && rest[index].startsWith("--")) {
      index += valued.has(rest[index]) ? 2 : 1;
    }
    const name = rest[index];
    let commandStart = index + 1;
    if (rest[commandStart] === "--") {
      commandStart += 1;
    }
    const command = rest.slice(commandStart);
    if (injected) fail(injected, name);
    const sandbox = state.sandboxes.find((item) => item.name === name);
    if (!sandbox) fail("not-found", name);
    sandbox.status = "running";
    saveState(state);
    if (process.env.FAKE_SBX_EXEC_RUN === "1") {
      // Run the command on the host: in tests the "sandbox" filesystem is the host filesystem.
      const ran = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
      process.exit(ran.status ?? 1);
    }
    process.stdout.write(`exec ${name}: ${command.join(" ")}\n`);
    process.exit(Number(process.env.FAKE_SBX_EXEC_EXIT ?? "0"));
    break;
  }
  case "stop": {
    const name = rest[0];
    if (injected) fail(injected, name);
    const sandbox = state.sandboxes.find((item) => item.name === name);
    if (!sandbox) fail("not-found", name);
    sandbox.status = "stopped";
    saveState(state);
    process.stdout.write(`Stopped ${name}\n`);
    break;
  }
  case "rm": {
    const names = rest.filter((item) => !item.startsWith("--"));
    for (const name of names) {
      const rule = failureFor("rm", name);
      if (rule) fail(rule, name);
      const index = state.sandboxes.findIndex((item) => item.name === name);
      if (index === -1) fail("not-found", name);
      state.sandboxes.splice(index, 1);
      process.stdout.write(`Removed ${name}\n`);
    }
    saveState(state);
    break;
  }
  case "cp": {
    if (injected) fail(injected);
    const [source, destination] = rest.filter((item) => !item.startsWith("-"));
    const [name, sourcePath] = source.includes(":") ? [source.split(":")[0], source.slice(source.indexOf(":") + 1)] : [null, source];
    if (name && !state.sandboxes.some((item) => item.name === name)) fail("not-found", name);
    copyFileSync(sourcePath, destination.includes(":") ? destination.slice(destination.indexOf(":") + 1) : destination);
    break;
  }
  case "ports": {
    const name = rest.find((item) => !item.startsWith("--"));
    if (injected) fail(injected, name);
    const sandbox = state.sandboxes.find((item) => item.name === name);
    if (!sandbox) fail("not-found", name);
    process.stdout.write(`${JSON.stringify({ ports: sandbox.ports ?? [] })}\n`);
    break;
  }
  default: {
    process.stderr.write(`fake sbx: unsupported subcommand ${subcommand}\n`);
    process.exit(2);
  }
}
