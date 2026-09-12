#!/bin/sh
# Runs a plugin script with a known Node binary. Herdr spawns plugin commands
# with the server's PATH, which may not contain node (nvm, volta, brew in a
# login-only PATH), so the install step records the absolute path in
# bin/node-path and this shim prefers it. Override with HERDR_SBX_NODE, which
# may be an absolute path or a name found on PATH. Only shell builtins are
# used until node runs, so a PATH without coreutils cannot break the shim.
case "$0" in
  */*) dir=${0%/*} ;;
  *) dir=. ;;
esac
node="${HERDR_SBX_NODE:-}"
if [ -z "$node" ] && [ -r "$dir/node-path" ]; then
  read -r node < "$dir/node-path" || node=""
fi
if [ -z "$node" ] || ! command -v "$node" >/dev/null 2>&1; then
  node=node
fi
if ! command -v "$node" >/dev/null 2>&1; then
  if [ -n "${HERDR_PLUGIN_ACTION_ID:-}" ]; then
    printf 'HERDR_SANDBOX_RESULT: {"schemaVersion":1,"plugin":"sbx.sandbox","action":"%s","ok":false,"errorKind":"startup","message":"node was not found; run scripts/write-node-path.sh in the plugin directory or set HERDR_SBX_NODE"}\n' "$HERDR_PLUGIN_ACTION_ID"
  fi
  printf 'herdr-sbx-plugin: node was not found on PATH. Run "sh scripts/write-node-path.sh" in the plugin directory or set HERDR_SBX_NODE to your node binary.\n' >&2
  # In a Herdr pane the pane closes with this process; give the message time to be read.
  if [ -t 1 ] && command -v sleep >/dev/null 2>&1; then sleep 8; fi
  exit 127
fi
exec "$node" "$@"
