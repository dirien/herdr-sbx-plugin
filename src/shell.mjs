/**
 * Quoting helpers for the command string typed into a Herdr pane shell.
 * The string is executed by the user's interactive shell, so it must be valid
 * for bash, zsh and fish alike. `env KEY=VALUE cmd` is used instead of the
 * `KEY=VALUE cmd` prefix form because fish does not support the latter.
 * @module shell
 */
import { PluginError } from "./errors.mjs";

// A bare word may not start with `=` (zsh expands `=cmd`) or `%` (fish expands `%job`);
// `~` is never in the set, so home-directory expansion cannot happen either.
const SAFE_WORD = /^[A-Za-z0-9_/.:@+,-][A-Za-z0-9_/.:=@%+,-]*$/;

/**
 * Quotes one word for a POSIX or fish shell.
 * @param {unknown} value
 * @returns {string}
 */
export function shellQuote(value) {
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new PluginError("target", "A path or argument contains control characters and cannot be typed into the pane shell.");
    }
    if (code === 92) {
      throw new PluginError("target", `A path or argument contains a backslash (${JSON.stringify(text)}), which bash and fish quote differently. Rename it before using it with this plugin.`);
    }
  }
  if (text === "") {
    return "''";
  }
  if (SAFE_WORD.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the single-line command Herdr submits into a pane.
 * @param {{argv: string[], env?: Record<string, string>}} input
 * @returns {string}
 */
export function buildPaneCommand({ argv, env = {} }) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new PluginError("startup", "buildPaneCommand needs a non-empty argv.");
  }
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new PluginError("startup", `Invalid environment variable name for the pane command: ${key}`);
    }
    return `${key}=${shellQuote(value)}`;
  });
  const words = argv.map(shellQuote);
  return assignments.length > 0 ? ["env", ...assignments, ...words].join(" ") : words.join(" ");
}
