#!/bin/sh
# Adds key bindings for the sbx.sandbox plugin to the Herdr config and reloads it.
# Usage: scripts/install-keybindings.sh
#
# The config file is resolved the way Herdr resolves it: HERDR_CONFIG_PATH,
# then $XDG_CONFIG_HOME/herdr/config.toml, then ~/.config/herdr/config.toml.
# A binding is appended only when its action is not bound yet, so the script
# can run any number of times. A binding that sits on a chord Herdr 0.9 uses
# itself is reported, not changed. HERDR_BIN_PATH names the herdr binary to
# reload with (Herdr sets it for plugin actions); otherwise herdr on PATH.
#
# Output lines, one per event, are read by the install-keybindings action:
#   config: PATH
#   bound KEY -> sbx.sandbox.ACTION
#   already bound: sbx.sandbox.ACTION (KEY)
#   warning: TEXT
#   reloaded
set -eu

if [ -n "${HERDR_CONFIG_PATH:-}" ]; then
  config=$HERDR_CONFIG_PATH
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  config=$XDG_CONFIG_HOME/herdr/config.toml
else
  config=$HOME/.config/herdr/config.toml
fi
config_dir=${config%/*}
[ -d "$config_dir" ] || mkdir -p "$config_dir"
[ -f "$config" ] || : > "$config"
printf 'config: %s\n' "$config"

# Chords Herdr 0.9 binds by default (keys.* in its config model); never take one.
herdr_defaults=" prefix+shift+d prefix+shift+g prefix+shift+h prefix+shift+j prefix+shift+k prefix+shift+l prefix+shift+n prefix+shift+p prefix+shift+r prefix+shift+t prefix+shift+tab prefix+shift+w prefix+shift+x prefix+b prefix+c prefix+e prefix+g prefix+h prefix+j prefix+k prefix+l prefix+n prefix+o prefix+p prefix+q prefix+r prefix+s prefix+v prefix+w prefix+x prefix+z prefix+tab prefix+minus prefix+? prefix+[ "

bound_key() {
  # Prints the key of the first [[keys.command]] block bound to an action.
  awk -v target="sbx.sandbox.$1" '
    function flush() { if (!found && cmd == target && key != "") { print key; found = 1 } key = ""; cmd = "" }
    /^[[:space:]]*\[\[/ { flush() }
    /^[[:space:]]*key[[:space:]]*=/ { key = $0; sub(/^[^"]*"/, "", key); sub(/".*$/, "", key) }
    /^[[:space:]]*command[[:space:]]*=/ { cmd = $0; sub(/^[^"]*"/, "", cmd); sub(/".*$/, "", cmd) }
    END { flush() }
  ' "$config"
}

add_binding() {
  key=$1
  action=$2
  description=$3
  existing=$(bound_key "$action")
  if [ -n "$existing" ]; then
    case "$herdr_defaults" in
      *" $existing "*)
        printf 'warning: sbx.sandbox.%s is bound to %s, which Herdr uses itself; change that entry in %s to %s\n' "$action" "$existing" "$config" "$key" ;;
      *)
        printf 'already bound: sbx.sandbox.%s (%s)\n' "$action" "$existing" ;;
    esac
    return 0
  fi
  printf '\n[[keys.command]]\nkey = "%s"\ntype = "plugin_action"\ncommand = "sbx.sandbox.%s"\ndescription = "%s"\n' "$key" "$action" "$description" >> "$config"
  printf 'bound %s -> sbx.sandbox.%s\n' "$key" "$action"
}

add_binding "prefix+shift+a" "start-agent" "start an agent in a Docker Sandbox"
add_binding "prefix+shift+b" "reconnect" "bring the agent back in its Docker Sandbox"
add_binding "prefix+shift+s" "open-shell" "open a shell in the Docker Sandbox"
add_binding "prefix+shift+o" "sandboxes" "show the Docker Sandboxes overlay"

herdr=${HERDR_BIN_PATH:-herdr}
if ! command -v "$herdr" >/dev/null 2>&1; then
  printf 'warning: %s is not available; run "herdr config check" and "herdr server reload-config" yourself\n' "$herdr"
  exit 0
fi
"$herdr" config check
"$herdr" server reload-config
printf 'reloaded\n'
