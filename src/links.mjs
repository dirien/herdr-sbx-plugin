/**
 * The `sbx://<sandbox>/<port>` link scheme the plugin prints for published
 * ports, matched by the manifest's link handler, plus OSC 8 hyperlink output.
 * @module links
 */
import { assertSandboxName } from "./naming.mjs";

const ESC = String.fromCharCode(27);
const LINK_PATTERN = /^sbx:\/\/([A-Za-z0-9][A-Za-z0-9.-]+)\/([0-9]+)$/;

/**
 * Builds the link for a sandbox port.
 * @param {string} sandboxName
 * @param {number} port
 * @returns {string}
 */
export function sandboxPortUrl(sandboxName, port) {
  assertSandboxName(sandboxName);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError(`Invalid port ${port}`);
  }
  return `sbx://${sandboxName}/${port}`;
}

/**
 * Parses a link produced by {@link sandboxPortUrl}; returns null for anything else.
 * @param {unknown} url
 * @returns {{sandboxName: string, port: number}|null}
 */
export function parseSandboxPortUrl(url) {
  const match = typeof url === "string" ? url.match(LINK_PATTERN) : null;
  if (!match) {
    return null;
  }
  try {
    assertSandboxName(match[1]);
  } catch {
    return null;
  }
  const port = Number(match[2]);
  return port > 0 && port <= 65535 ? { sandboxName: match[1], port } : null;
}

/**
 * Wraps text in an OSC 8 terminal hyperlink so Herdr can offer it for Ctrl-click.
 * @param {string} url
 * @param {string} text
 * @returns {string}
 */
export function hyperlink(url, text) {
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}
