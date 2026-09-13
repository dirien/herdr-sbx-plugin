<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-09-11 | Last verified: 2026-09-11 -->

# AGENTS.md

**Precedence:** the **closest `AGENTS.md`** to the files you're changing wins. This is the only one in the repo.

## Project

Herdr plugin (`herdr-plugin.toml`) that runs coding agents inside Docker Sandboxes by shelling out to the `sbx` CLI.
Dependency-free Node ESM (`.mjs`, Node >= 20). No build step, no TypeScript, no bundler: Herdr runs
`node src/action.mjs` straight from the checkout.

| Fact | Value |
| ------ | ------- |
| Plugin id | `sbx.sandbox` (manifest `id`, `src/constants.mjs`) |
| Entry points | `src/action.mjs`, `src/bridge.mjs`, `src/events.mjs`, `src/deletion-confirmation.mjs`, `src/sandboxes-pane.mjs`; each only imports its `*-main.mjs`/`confirmation-pane.mjs` module; the manifest starts them through `bin/run.sh` (node shim) |
| External CLIs | `sbx` via `HERDR_SBX_BIN`/config `sbxBin`; `herdr` via `HERDR_BIN_PATH` |
| Runtime state | one JSON file per pane under `HERDR_PLUGIN_STATE_DIR/panes/` (`src/state.mjs`, version 1) |
| User config | `HERDR_PLUGIN_CONFIG_DIR/config.json` (`src/config.mjs`, unknown keys rejected) |
| Docs | `README.md` (users), `docs/design.md` (why), `docs/manual-testing.md` (real-host checklist), `CHANGELOG.md` |

## Commands (verified 2026-09-11)
>
> Source: package.json scripts; CI runs `npm run check` on ubuntu/macos x node 20/22

<!-- AGENTS-GENERATED:START commands -->
| Task | Command | ~Time |
| ------ | --------- | ------- |
| Syntax check every module | `npm run syntax` | ~2s |
| Test (all) | `npm test` | ~15s |
| Test (single file) | `node --test test/actions.test.mjs` | ~5s |
| Test (name filter) | `node --test --test-name-pattern="stop" "test/*.test.mjs"` | ~5s |
| Full check (syntax + tests) | `npm run check` | ~20s |
<!-- AGENTS-GENERATED:END commands -->

There is no lint, format or typecheck tool configured. `npm install` is unnecessary (zero dependencies).

## Response Style

- Answer first, elaborate only if needed. No sycophantic openers.
- For yes/no or status questions, lead with the answer.
- Skip preamble. Match response length to task complexity.

## Workflow

1. **Before coding**: read this file and the Golden Samples below. Real `herdr`/`sbx` are not available in CI or
   most dev sandboxes; the tests run the scripts as child processes against `test/fakes/sbx.mjs` and
   `test/fakes/herdr.mjs`.
2. **After each change**: `node --check <file>` then the single test file that covers it.
3. **Before committing**: `npm run check`.
4. **Before claiming done**: paste the `# pass`/`# fail` summary from `npm test` as evidence.

## Golden Samples

| Area | File | Why |
| ------ | ------ | ----- |
| Action handler | `src/action-main.mjs` (`ACTIONS.stop`, `ACTIONS["forget-mapping"]`) | Context resolution, confirmation, result payload |
| Sandbox operation | `src/lifecycle.mjs` (`prepare`, `destroy`) | State transitions + classified errors + checkpointing |
| CLI wrapper | `src/sbx.mjs` | Captured vs interactive runs, output-based failure classification |
| Child-process test | `test/actions.test.mjs` | Fixture, fake CLI logs, result-line assertions |
| Pure unit test | `test/sbx.test.mjs` | Table-driven cases |

## Heuristics (quick decisions)
<!-- AGENTS-GENERATED:START heuristics -->
| When | Do |
| ------ | ----- |
| Adding an action | Add `[[actions]]` in `herdr-plugin.toml`, a handler in `ACTIONS` (`src/action-main.mjs`), a README table row, a test in `test/actions.test.mjs`; `test/docs.test.mjs` enforces parity |
| Adding a config key | Add to `CONFIG_DEFAULTS` + `validateConfig` (`src/config.mjs`), document in README table, test in `test/config.test.mjs` |
| Adding an agent | Add to `BUILTIN_AGENTS` (`src/agents.mjs`) with the documented `sbx run` default flags; README agents table |
| Calling `sbx` | Build argv with `buildCreateArgs`/`buildExecArgs` (exec puts `--` before the command); use `runChecked` (captured, killed after `SBX_CALL_TIMEOUT_MS`; pass `{ slow: true }` for `create` and setup scripts) or `runInteractive` (TTY, no timeout); never a shell string |
| Deciding a mapping is busy | `bridgeIsRunning`, `shellIsRunning` and `deletionInProgress` (`src/lifecycle.mjs`; bridges, shells and deletions record their pid plus `processStartToken` and are verified by command line, so a recycled pid never counts) before Herdr's agent detection, which is asked outside the lock; destructive actions and `reconnect` go through `refuseWhileAgentRuns` before the popup, and `lifecycle.destroy` claims the mapping (`deletingPid`, checked by `deletionInProgress`) and re-reads and re-checks both under `withPaneLock` (`src/state.mjs`) right before every `sbx rm`; `acknowledgeBridge` takes the same lock and refuses while a deletion runs |
| Running `sbx rm` | Only through `lifecycle.destroy` (claim + `assertNoOwners` under `withPaneLock` before every rm); the one exception is `prepare` deleting a sandbox it just created for a mapping that vanished meanwhile, a name no mapping tracks |
| Deciding a sandbox is gone | After `sbx stop` fails with `not-found`, after `sbx rm` fails with `not-found` **and** `sbx ls --json` no longer lists it (`confirmGone` in `src/lifecycle.mjs`), or when a strict `ls` parse omits it (the docs say `ls` lists stopped sandboxes too; a `null` wrapper is an empty list); never probe with `sbx exec`, which starts a stopped sandbox |
| Choosing the mount root | `resolveMountRoot`/`resolveWorkdir` (`src/context.mjs`) then `assertMountRoot`; never mount the pane cwd directly |
| Adding a key binding | An `add_binding` line in `scripts/install-keybindings.sh` (the chord must be absent from its `herdr_defaults` list), the README key bindings table, `docs/manual-testing.md` step 3 |
| Adding a manifest command | Use `["sh", "bin/run.sh", "src/<entry>.mjs"]`; `test/docs.test.mjs` rejects bare `node` |
| Printing a port | `sandboxPortUrl` + `hyperlink` from `src/links.mjs`; the link handler pattern in the manifest must keep matching |
| Calling Herdr | Go through `createHerdrClient` (`src/herdr.mjs`), never the socket; check many panes with one `listPaneIds()` (`pane list`), not a `getPane` per mapping |
| Reporting a failure | Throw `PluginError(kind, message, {output})` with a kind from `ERROR_KINDS` (`src/errors.mjs`) |
| Writing state | `savePaneEntry`/`updatePaneEntry` only (one atomic file per pane, written under the re-entrant `withPaneLock`); never edit `panes/*.json` by hand |
| Printing from an action | stdout is reserved for the result marker line (`emitResult`); diagnostics go to stderr |
| Printing from the bridge | stdout is the pane; use the injected `log` |
| Adding tests | `test/<area>.test.mjs`, `node:test` + `node:assert/strict`; fixtures via `test/helpers.mjs` |
| Adding a dependency | Do not. The plugin ships with zero dependencies so `herdr plugin install` needs no build |
<!-- AGENTS-GENERATED:END heuristics -->

## Boundaries

### Always Do

- Keep every exported symbol documented with a JSDoc comment.
- Keep the result marker `HERDR_SANDBOX_RESULT:` as the first stdout line of every action (`test/docs.test.mjs` and
  `src/action.mjs` guard it).
- Keep `README.md`, `herdr-plugin.toml`, `package.json` version and `CHANGELOG.md` in sync (parity test).
- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Show `npm test` output as evidence before claiming work is complete.

### Ask First

- Changing the manifest `id`, `min_herdr_version` or `platforms`.
- Changing the mapping store format (`STATE_VERSION`) or the result line schema (`RESULT_SCHEMA_VERSION`).
- Changing default agent launch flags (they mirror the Docker template defaults).
- Modifying `.github/workflows/ci.yml`.

### Never Do

- Add npm dependencies or a build step.
- Run destructive `sbx` commands (`rm`, `prune`) without the confirmation popup flow in `src/confirm.mjs`.
- Build shell strings from user paths without `shellQuote` (`src/shell.mjs`); the pane command is executed by the
  user's interactive shell (bash, zsh or fish).
- Read tokens or secrets in the plugin; credentials belong to `sbx secret`.
- Commit secrets or the contents of a real `HERDR_PLUGIN_STATE_DIR`.
- Put raw escape bytes in source; build them with `String.fromCharCode` (see `TERMINAL_RESTORE_SEQUENCE`).

## Contracts this code depends on

| Contract | Where verified | Notes |
| ---------- | ---------------- | ------- |
| Herdr plugin env vars and `HERDR_PLUGIN_CONTEXT_JSON` fields | herdr 0.9.0 docs `plugins.mdx` | `src/context.mjs` |
| `herdr pane split` JSON `.result.pane.pane_id` | herdr 0.9.0 `cli-reference.mdx` | `src/herdr.mjs` |
| `worktree.removed` payload `data.worktree.path` | herdr `src/api/schema/events.rs` | `src/events.mjs` |
| `sbx create/exec/ls/stop/rm` flags | Docker docs `data/sbx_cli/*.yaml` (sbx 0.42) | `src/sbx.mjs` |
| `sbx exec` starts a stopped sandbox before running the command | Docker docs `sbx exec` description (sbx 0.42) | `CONNECTABLE_STATES` includes `stopped` in `src/lifecycle.mjs` |
| `sbx ports NAME --json` schema | **undocumented**; `normalizePortList` accepts several spellings | `src/sbx.mjs`, `open-port` |
| `herdr pane report-agent/release-agent`, `tab create` JSON, `[[link_handlers]]` context | herdr 0.9.0 `cli-reference.mdx`, `plugins.mdx` | `src/herdr.mjs`, `open-port` |
| `sbx ls --json` schema, `sbx` error wording, exec exit codes | schema verified on sbx 0.42.1 (`{"sandboxes":[{name,status,...}]}` parses); error wording and exit codes still **undocumented** | `normalizeSandboxList`, `classifyFailure` |
| Clone-mode checkout location inside the VM | verified on sbx 0.42.1 (2026-09-12): the clone sits at the host path, so no `--workdir` is needed | `execWorkdir` |

<!-- AGENTS-GENERATED:START module-boundaries -->
| Module | May import |
| -------- | ------------ |
| `constants`, `errors` | nothing from `src/` |
| `context`, `shell`, `naming`, `result`, `config`, `agents` | `constants`, `errors` |
| `state` | `constants`, `errors`, `context` (for `canonicalPath`) |
| `sbx`, `herdr` | `constants`, `errors` |
| `confirm` | `constants`, `errors`, `state` |
| `lifecycle` | everything above |
| `links`, `open` | `constants`, `errors`, `naming` |
| `action-main`, `bridge-main`, `events-main`, `confirmation-pane`, `sandboxes-pane-main` | `lifecycle` and below; never each other |
| `action`, `bridge`, `events`, `deletion-confirmation` | only their matching logic module |
<!-- AGENTS-GENERATED:END module-boundaries -->

## Scoped AGENTS.md (MUST read when working in these directories)
<!-- AGENTS-GENERATED:START scope-index -->
- none; this root file covers the whole repository
<!-- AGENTS-GENERATED:END scope-index -->

## When instructions conflict

Explicit user prompts override this file. Where this file and `README.md` disagree, fix whichever is wrong and keep
`test/docs.test.mjs` passing.
