# Manual test plan

The automated tests exercise the plugin against fake `sbx` and `herdr`
executables. This checklist covers what only a real host can verify: the exact
`sbx` command syntax, the shape of `sbx ls --json`, Herdr's pane handling, and
the agent's behaviour inside the VM. Work through it top to bottom; each step
says what to run, what should happen, and what to write down when it does not.

## Helper

Actions return as soon as Herdr has started them; the outcome lands in the
plugin log. This shell function invokes an action and waits for its result
line. Define it in every pane you test from, or add it to your shell rc file:

```bash
sbxrun() {
  herdr plugin action invoke "$1" --plugin sbx.sandbox >/dev/null
  for i in $(seq 1 120); do
    sleep 1
    out=$(herdr plugin log list --plugin sbx.sandbox --limit 1 | node -e '
      const log = JSON.parse(require("fs").readFileSync(0, "utf8")).result.logs[0];
      if (log.status === "running") process.exit(3);
      console.log(log.status, "-", (log.stdout || "").split("\n")[0]);
      if (log.stderr) console.log(log.stderr.trim());') && { printf "%s\n" "$out"; return; }
  done
  echo "still running after 120s"
}
```

Pane-scoped actions use the focused pane, or the workspace's only sandbox when
the focused pane has none. With several sandboxes in a workspace, run the
action from the pane of the sandbox you mean.

## 0. Prerequisites

Run these on the host, not inside a sandbox.

```bash
sw_vers || cat /etc/os-release          # macOS 14+ on Apple silicon, or Ubuntu 24.04+ with /dev/kvm
node --version                          # v20 or newer
herdr --version                         # 0.9.0 or newer
sbx version --json                      # 0.42 or newer; "server" must be present
sbx daemon status                       # running; otherwise: sbx daemon start
sbx secret ls                           # an entry for your agent's API (anthropic, openai, ...)
sbx policy ls                           # deny-all needs: sbx policy allow network api.anthropic.com
```

If `sbx secret ls` is empty:

```bash
sbx secret set anthropic -t "$ANTHROPIC_API_KEY"     # Claude Code
sbx secret set github --command 'gh auth token'      # optional, for git pushes from the VM
```

Create a throwaway repository to use as the workspace:

```bash
mkdir -p ~/tmp/sbx-plugin-demo && cd ~/tmp/sbx-plugin-demo
git init -q && printf 'demo\n' > README.md && git add README.md && git commit -q -m init
```

## 1. Link the plugin and check the manifest

```bash
herdr plugin link /path/to/herdr-sbx-plugin
herdr plugin list
herdr plugin action list --plugin sbx.sandbox
CONFIG_DIR="$(herdr plugin config-dir sbx.sandbox)"
printf '{ "agentKind": "claude-code" }\n' > "$CONFIG_DIR/config.json"
```

Expect: `plugin list` shows `sbx.sandbox` enabled, `action list` shows fourteen
actions (`doctor` through `forget-mapping`). If linking fails with a version
message, note the Herdr version: the manifest requires 0.9.0.

## 2. doctor

```bash
herdr plugin action invoke doctor --plugin sbx.sandbox
sleep 2
herdr plugin log list --plugin sbx.sandbox --limit 1
```

Expect: status `succeeded` and a first stdout line starting with
`HERDR_SANDBOX_RESULT: {"schemaVersion":1,"plugin":"sbx.sandbox","action":"doctor","ok":true`
followed by `version` and `daemon` fields. Nothing is created.

If `ok` is false: `errorKind: "startup"` means `sbx` is not on the `PATH` Herdr
started with (set `sbxBin` in `config.json`); `"daemon"` means `sandboxd` is not
running.

## 3. start-agent from the TUI

Herdr has no menu for plugin actions; they run from a key binding or from the
CLI. Add the plugin's four bindings and reload:

```bash
herdr plugin action invoke install-keybindings --plugin sbx.sandbox
herdr plugin log list --plugin sbx.sandbox --limit 1   # "added" lists four bindings the first time
```

The same thing by hand, for one binding, is a block in Herdr's `config.toml`
followed by a reload:

```toml
[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "sbx.sandbox.start-agent"
description = "start an agent in a Docker Sandbox"
```

```bash
herdr config check && herdr server reload-config
```

Start Herdr and give it a workspace rooted at the demo repository. A workspace
rooted at your home directory is refused by the plugin.

```bash
cd ~/tmp/sbx-plugin-demo && herdr
# in a second terminal, if the first pane's directory is not the demo repo:
herdr workspace create --cwd ~/tmp/sbx-plugin-demo --label demo --focus
```

Press `ctrl+b`, release, then `shift+a` in the demo workspace (`prefix+?`
shows the binding). Or trigger it from the second terminal, which uses the
focused workspace as context:

```bash
herdr plugin action invoke start-agent --plugin sbx.sandbox
```

Expect, within a minute or two:

1. A new pane to the right titled `sbx claude-code`.
2. The pane prints `Creating Docker Sandbox herdr-claude-code-<12 hex> for
   ~/tmp/sbx-plugin-demo (agent claude, mount mode)...` followed by
   the `sbx create` output.
3. Claude Code's interface appears, and Herdr's pane status turns idle or
   working after a few seconds.

From another terminal:

```bash
sbx ls
sbx ls --json | head -c 600; echo
```

Write down the `sbx ls --json` output. The plugin's parser accepts a bare
array, `{"sandboxes": [...]}` and a map keyed by name; anything else makes
`list-sandboxes` report an error and this is the single most likely mismatch.

What to record if it fails:

- The pane shows an `unknown flag` or `unknown shorthand flag` error from
  `sbx exec`: copy the full command line. The bridge separates agent flags
  from `sbx` flags with `--`; this would mean the real CLI rejects that.
- The pane shows `not available inside sandbox`: the template does not put
  the agent on `PATH` for a login shell. Run step 7 and check
  `command -v claude` by hand.
- Claude Code starts but Herdr's status never changes: run `info` (step 5)
  and check `herdrDetectionKind` is `claude`; then confirm the pane's
  foreground process carries `HERDR_AGENT` (`herdr agent explain <pane_id>`).

## 4. Work inside the sandbox

Ask the agent to create a file, for example "create hello.txt containing hi".
On the host:

```bash
ls ~/tmp/sbx-plugin-demo          # hello.txt is there immediately (mount mode)
git -C ~/tmp/sbx-plugin-demo status
```

Exit the agent. The pane prints `Claude Code exited with code <n>. Use
reconnect to start it again or open-shell to inspect the sandbox.` and the
shell prompt returns.

## 5. info and list-sandboxes

With the agent pane focused, run the `info` action, then `list-sandboxes`.

Expect: `info` prints the mapping (sandbox name, `localPath`, `workdir`,
`lifecycleState: "ready"`), the resolved `launchArgv`, and `sandbox.status`.
`list-sandboxes` prints one tab-separated line per mapping ending in the
sandbox status. `MISSING` next to a sandbox that `sbx ls` still shows means the
JSON shape was not understood; attach the output from step 3.

## 5b. The overlay and port links

Run the `sandboxes` action (or `herdr plugin action invoke sandboxes --plugin
sbx.sandbox`). Expect an overlay listing the sandbox with `running`, its pane
id and `-` under PORTS; `q` closes it. Then publish a port and check the link:

```bash
sbx ports <sandbox name> --publish 8080:3000
```

Run `info` from the agent pane: the output ends with a `port 3000:` line. In
the overlay the PORTS column shows `8080->3000`; Ctrl-click it. Expect the
browser to open `http://localhost:8080` (nothing listens there yet, which is
fine) and a log entry for `open-port` with `"opened":true`. If Ctrl-click does
nothing, note whether Herdr underlines the link at all: the OSC 8 hyperlink
may not be recognized in your terminal.

## 6. reconnect

Focus the agent pane (agent exited) and run `reconnect`. Expect the agent to
start again in the same sandbox with `hello.txt` still present. Running
`reconnect` while the agent is still up must be refused with
`errorKind: "conflict"`.

## 7. open-shell

Run `open-shell` from the agent pane. Expect a pane below titled
`sbx shell herdr-claude-code-...` with a bash login shell inside the VM.

```bash
pwd                    # the demo repository path
command -v claude      # the agent binary
env | grep -c SANDBOX  # sandbox environment variables are present
exit
```

## 8. stop, then reconnect

Run `stop` from the agent pane. Expect a toast "Docker Sandbox stopped" and
`sbx ls` showing the sandbox stopped. Run `reconnect`: the sandbox must start
again on its own because `sbx exec` starts stopped sandboxes.

## 9. replace-sandbox

Exit the agent, then run `replace-sandbox`. A popup asks you to type `DELETE`.

- Type anything else first: the popup prints `Cancelled`, the action result
  has `errorKind: "cancelled"`, and `sbx ls` is unchanged.
- Run it again and press Ctrl-C in the popup: same outcome.
- Run it again and type `DELETE`: the old sandbox disappears from `sbx ls`, a
  new name appears, and the agent starts in the same pane.

## 10. forget-mapping

Exit the agent and run `forget-mapping`, confirm with `DELETE`. Expect the
sandbox gone from `sbx ls`, a toast "Docker Sandbox deleted", and
`list-sandboxes` reporting `No sandbox mappings.`

## 11. The worktree.removed hook

```bash
herdr worktree create --cwd ~/tmp/sbx-plugin-demo --branch hook-test --focus
```

In the new worktree workspace run `start-agent`, wait for the agent, exit it,
then remove the worktree:

```bash
herdr workspace list                      # find the worktree workspace id
herdr worktree remove --workspace <id> --force
#   a popup asks to type DELETE; type it
sbx ls                                    # the hook deleted the sandbox
herdr plugin log list --plugin sbx.sandbox --limit 1
```

Expect a toast "Docker Sandboxes removed" and a log entry from `src/events.mjs`
with `forgot mapping for pane ...`. To keep sandboxes on worktree removal, set
`"cleanupOnWorktreeRemoved": false` and repeat: the log then says
`leaving sandboxes alone`.

## 11b. Tab mode

```bash
printf '{ "agentKind": "claude-code", "openIn": "tab" }\n' > "$CONFIG_DIR/config.json"
```

Run `start-agent`. Expect a new tab in the workspace, labelled like the pane,
with the agent inside; `reconnect` from that tab works as before.

## 12. Clone mode and fetch-changes

```bash
printf '{ "agentKind": "claude-code", "workspaceMode": "clone" }\n' > "$CONFIG_DIR/config.json"
```

Run `start-agent` in the demo repository. In the agent pane, note the
directory the agent reports as its working directory, then ask the agent to
commit a change on a new branch called `agent-work`. Exit the agent and run
`fetch-changes` from that pane.

```bash
git -C ~/tmp/sbx-plugin-demo branch -r    # sandbox-herdr-claude-code-.../agent-work
```

Record the working directory the agent started in. The plugin passes no
`--workdir` in clone mode; if the agent did not start inside the clone, that
assumption needs a fix. Running `fetch-changes` while the sandbox is stopped
must fail with `errorKind: "network"` and a hint to start it first.

## 13. Driving the plugin from a script

With a Herdr workspace focused on the demo repository:

```bash
herdr plugin action invoke start-agent --plugin sbx.sandbox
until herdr plugin log list --plugin sbx.sandbox --limit 1 | grep -q '"status": *"\(succeeded\|failed\)"'; do sleep 1; done
herdr plugin log list --plugin sbx.sandbox --limit 1 | grep -o 'HERDR_SANDBOX_RESULT: .*'
```

Expect the marker line with `paneId`, `sandboxName`, `localPath` and
`workdir`. The action returns as soon as the bridge is typed into the pane;
the agent itself starts a little later.

## 14. Failure classification

These confirm the error kinds against real `sbx` wording.

```bash
sbx rm -f <sandbox name from list-sandboxes>       # delete behind the plugin's back
```

Run `stop` from that pane: expect `errorKind: "not-found"` and
`lifecycleState: "missing"` in `info`. If the kind is `unknown`, copy the
`output` field from the result line; the classifier needs that wording.

```bash
sbx daemon stop
```

Run `doctor`: expect `errorKind: "daemon"`. Start the daemon again afterwards.

## 15. Cleanup

```bash
sbx ls
sbx rm -f <any leftover herdr-* sandbox>
herdr plugin unlink sbx.sandbox
rm -rf ~/tmp/sbx-plugin-demo
```

## What to report

For every step that deviates: the step number, the `HERDR_SANDBOX_RESULT`
line, stderr from `herdr plugin log list`, the raw `sbx` output, and the
versions from step 0. The three facts that matter most are the `sbx ls --json`
shape (step 3), whether `sbx exec` accepted the `--` separator (step 3), and
the clone-mode working directory (step 12).
