# Changelog

## 0.1.0 - 2026-09-12

Initial release.

- Actions: `doctor`, `install-keybindings`, `start-agent`, `reconnect`, `open-shell`, `fetch-changes`,
  `stop`, `info`, `list-sandboxes`, `prune-mappings`, `sandboxes`, `open-port`, `replace-sandbox`,
  `forget-mapping`.
- `worktree.removed` hook that offers to delete the sandboxes of a removed worktree.
- Built-in adapters for Claude Code, Codex, Gemini CLI, OpenCode, Copilot CLI
  and Cursor Agent, plus custom agents with setup scripts.
- Mount and clone workspace modes.
- A `deletion-confirmation` popup pane that guards every deletion.
- Result marker line and stable error kinds for orchestration.
- `HERDR_SBX_BIN` and `HERDR_SBX_CONFIRMATION_TIMEOUT_MS` overrides.
- A manual test plan for real hosts in `docs/manual-testing.md`.
- A `prune-mappings` action for mappings whose pane and sandbox are both gone.
- A `sandboxes` overlay pane, `sbx://<sandbox>/<port>` links with an `open-port`
  action and link handler, `openIn` tab mode, agent reporting to Herdr for
  agents without a screen manifest, and a node shim recorded at install.
- An `install-keybindings` action and `scripts/install-keybindings.sh` that add
  the plugin's key bindings on chords Herdr 0.9 leaves free and refuse to touch
  a binding that sits on one of Herdr's own chords.
