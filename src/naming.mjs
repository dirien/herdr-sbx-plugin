/**
 * Sandbox naming that satisfies the sbx CLI rules: at least two characters,
 * starting with a letter or digit, only letters, digits, hyphens and periods,
 * and never the reserved word `default`.
 * @module naming
 */
import { createHash, randomBytes } from "node:crypto";
import { PluginError } from "./errors.mjs";

/** Pattern every sandbox name produced or accepted by the plugin must match. */
export const SANDBOX_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]+$/;

/**
 * Lower-cases a label and replaces everything outside [a-z0-9] with hyphens.
 * @param {string} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function slugify(value, fallback = "agent") {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
}

/**
 * Throws when a name would be rejected by `sbx create --name`.
 * @param {string} name
 */
export function assertSandboxName(name) {
  if (name === "default" || !SANDBOX_NAME_PATTERN.test(name)) {
    throw new PluginError("config", `Invalid sandbox name "${name}": use at least two characters, start with a letter or digit, and only use letters, digits, hyphens and periods.`);
  }
}

/**
 * Produces a fresh unique sandbox name such as `herdr-claude-code-3f9a1c0b2d4e`.
 * The random component guarantees that replacing a sandbox yields a new name.
 * @param {{prefix?: string, agentKind: string, localPath: string, paneId: string|null}} input
 * @returns {string}
 */
export function sandboxNameFor({ prefix = "herdr", agentKind, localPath, paneId }) {
  const digest = createHash("sha256")
    .update(`${localPath}\n${paneId ?? ""}\n${randomBytes(8).toString("hex")}`)
    .digest("hex")
    .slice(0, 12);
  const name = `${slugify(prefix, "herdr")}-${slugify(agentKind)}-${digest}`;
  assertSandboxName(name);
  return name;
}

/**
 * Name of the git remote sbx adds to the host repository for a clone-mode sandbox.
 * @param {string} sandboxName
 * @returns {string}
 */
export function sandboxGitRemote(sandboxName) {
  return `sandbox-${sandboxName}`;
}
