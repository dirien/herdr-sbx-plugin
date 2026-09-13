# Design notes

## Two processes

Herdr runs plugin actions as short-lived child processes without a TTY and
caps their captured output at 64 KiB. Anything interactive therefore has to
move into a pane. The plugin is split accordingly:

- `src/action.mjs` is what Herdr spawns. It resolves the invocation context,
  talks to Herdr through `HERDR_BIN_PATH`, updates the mapping store, and prints
  the result marker line. It never blocks on a terminal.
- `src/bridge.mjs` is typed into a pane by `herdr pane run`. It creates the
  sandbox, verifies the agent binary, and attaches `sbx exec --interactive --tty`
  to the pane. When the agent exits, the pane's shell is back.

The command typed into the pane is `env HERDR_AGENT=<kind> <node> <bridge> start ...`.
It starts with `env` rather than the `KEY=VALUE cmd` prefix because fish does
not support that form, and `HERDR_AGENT` tells Herdr which screen manifest to
apply to a process it cannot see through the sandbox boundary.

## Start sequence

1. Pick the mount root: the workspace's worktree checkout, else the workspace
   directory, else the git top level of the pane's directory, else that
   directory. The pane's directory only decides where the agent starts, and
   `/` and the home directory are refused outright.
2. `sbx version --json` as a reachability probe. Fail before touching Herdr.
3. `herdr pane split <pane> --direction right --ratio 0.5 --cwd <worktree> --focus`.
4. Store a `provisional` mapping for the new pane id.
5. `herdr pane rename`, then `herdr pane run` with the bridge command.
6. Bridge: `sbx ls --json` (reuse if the name exists), `sbx create`, the
   custom agent's setup script on the first preparation of that sandbox,
   `command -v <agent>` probe, then the interactive exec.

The mapping moves through `provisional`, `creating`, `created`, `prepared`,
`ready`, and later `stopped`, `missing` or `failed`. `lastError` keeps the
classified error of the last failed step so `info` can show it. Each pane has
its own JSON file under `panes/`, written by temp file and rename, so a bridge
updating one pane can never overwrite another pane's mapping. `missing` is
recorded when `sbx stop` or `sbx rm` report the sandbox as unknown, or when a
strict parse of `sbx ls --json` omits it after an attached session ended. The
plugin never checks with `sbx exec`, because `sbx exec` starts a stopped
sandbox, which would undo a `stop`.

## Confirmation popup

Destructive actions open a `[[panes]]` entry with `placement = "popup"`. The
action writes a request file, passes its id through `--env`, and polls for a
decision file. The popup reads the request, asks the user to type `DELETE`,
writes the decision, and exits; Ctrl-C in the popup records a cancellation.
The action removes both files in a `finally` block, and every new request
sweeps files older than twice the timeout, so a crashed popup leaves nothing
behind. `replace-sandbox` resolves the agent, the mount root and the new name
before it opens the popup, so nothing is deleted unless the replacement can be
created.

## Why these choices

- The plugin is plain Node with no dependencies. Every supported agent CLI is
  an npm package, so Node is already on the machine, and the only build step
  `herdr plugin install` runs records where that Node lives for the shim.
- Mount mode is the default because the bind mount removes the upload and
  patch round trip other sandbox plugins need. Clone mode is one config key away
  for people who want the agent isolated from the checkout.
- The bridge calls `sbx create` and then `sbx exec` instead of `sbx run`.
  `sbx run` couples creation and attachment and re-attaches with different
  semantics, while separate calls give the plugin a place to verify the agent
  binary and to classify failures.
- Nothing gets installed inside the VM at start time. Docker ships a template
  per agent and the network blocks egress by default, so a runtime install would
  fail or need allow rules. Custom agents can still run a `setupScript`.
- The plugin classifies failures from the CLI output because `sbx` exit codes
  are not documented. The regexes are deliberately loose, and everything else
  lands in `unknown` with the captured output attached. Daemon and credential
  wording is checked before the broad "not found" wording, and a "not found"
  from `sbx rm` counts only once `sbx ls` agrees, so a sandbox is never recorded
  as deleted while it still exists.
- Every captured `sbx` call has a timeout (two minutes; thirty for `create`
  and setup scripts, which may pull an image) and is reported as a `daemon`
  failure when it expires. The interactive agent session is the one call that
  may run for hours, so it has none.
- Key bindings are added by an action the user invokes, not by the build step.
  AgentBox splices its bindings into `config.toml` during `herdr plugin
  install`; here a file the user owns changes only when they ask, the installer
  refuses chords Herdr or another command already uses, and it restores the
  file when `herdr config check` rejects the result.
- Pane existence comes from one `herdr pane list` call, not one `pane get` per
  mapping, because the overlay asks every few seconds and a workspace with a
  handful of sandboxes would otherwise spawn a process per row per frame.
- Ownership is explicit. Herdr's agent detection cannot see a bridge that is
  still inside `sbx create`, nor an `open-shell` session, so bridges, shells
  and deletions record their own process (pid plus start time, verified by
  command line) on the mapping. `destroy` claims the mapping before the first
  `sbx rm` and re-reads it before every one; `acknowledgeBridge` and
  `acknowledgeShell` refuse while a claim is live. All of it happens under
  file locks: one per mapping, plus one per sandbox taken first in a fixed
  order, because an interrupted move can leave two mappings for one sandbox.
  Locks are O_EXCL files holding the owner's pid and start time; a lock whose
  owner is gone is reclaimed under a separate guard, so two contenders never
  remove each other's fresh lock, and a waiter always gives up at its deadline.

## Borrowed from other plugins

The agentbox plugin for Herdr showed four things worth copying. Plugin
commands start through `bin/run.sh`, a shim that prefers the node path
recorded at install time, because Herdr's server may not share the shell's
`PATH`. Agents without a screen manifest are announced to Herdr through
`pane report-agent` for the duration of the attach, so Herdr and the plugin's
guards know the pane is taken. The `sandboxes` overlay pane gives a live view
of every mapping, and `sbx://<sandbox>/<port>` links resolve through a
`[[link_handlers]]` entry to the `open-port` action, which asks `sbx ports` for
the host port and opens the browser.

## Relationship to the Vercel plugin

The action set mirrors `vercel-labs/herdr-vercel-sandbox-plugin` so users can
switch between backends without relearning. The code is an independent
implementation: that plugin uploads a tarball, keeps a git baseline inside the
sandbox and ships changes back as a patch, none of which applies to a bind
mount. `connect-vercel` and `link-vercel-project` have no `sbx` equivalent and
were replaced by `doctor`.
