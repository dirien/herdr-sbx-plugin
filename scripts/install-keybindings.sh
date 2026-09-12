#!/bin/sh
# Adds key bindings for the sbx.sandbox plugin to the Herdr config and reloads it.
# Usage: scripts/install-keybindings.sh
#
# The config file is resolved the way Herdr resolves it: HERDR_CONFIG_PATH,
# then $XDG_CONFIG_HOME/herdr/config.toml, then ~/.config/herdr/config.toml.
# A binding is appended only when its action is not bound yet and its chord is
# free, so the script can run any number of times. A binding that sits on a
# chord Herdr 0.9 uses itself is reported, not changed. The file is validated
# with "herdr config check" afterwards and restored from a backup when Herdr
# rejects it. HERDR_BIN_PATH names the herdr binary (Herdr sets it for plugin
# actions); otherwise herdr on PATH.
#
# Report lines on stdout, one per event, read by the install-keybindings action:
#   config: PATH
#   bound KEY -> sbx.sandbox.ACTION
#   already bound: sbx.sandbox.ACTION (KEY)
#   warning: TEXT
#   reloaded
# Everything Herdr itself prints goes to stderr so it cannot be mistaken for a report line.
set -eu

if [ -n "${HERDR_CONFIG_PATH:-}" ]; then
  config=$HERDR_CONFIG_PATH
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  config=$XDG_CONFIG_HOME/herdr/config.toml
elif [ -n "${HOME:-}" ]; then
  config=$HOME/.config/herdr/config.toml
else
  printf 'warning: neither HERDR_CONFIG_PATH, XDG_CONFIG_HOME nor HOME is set; cannot find the Herdr config\n'
  exit 1
fi
case "$config" in
  */*) config_dir=${config%/*} ;;
  *) config_dir=. ;;
esac
[ -n "$config_dir" ] || config_dir=/
[ -d "$config_dir" ] || mkdir -p "$config_dir"
[ -f "$config" ] || : > "$config"
printf 'config: %s\n' "$config"

# Chords Herdr 0.9 binds by default (keys.* in its config model); never take one.
herdr_defaults=" prefix+shift+d prefix+shift+g prefix+shift+h prefix+shift+j prefix+shift+k prefix+shift+l prefix+shift+n prefix+shift+p prefix+shift+r prefix+shift+t prefix+shift+tab prefix+shift+w prefix+shift+x prefix+b prefix+c prefix+e prefix+g prefix+h prefix+j prefix+k prefix+l prefix+n prefix+o prefix+p prefix+q prefix+r prefix+s prefix+v prefix+w prefix+x prefix+z prefix+tab prefix+minus prefix+? prefix+[ "

# Walks the [[keys.command]] blocks of the config. Each block ends at the next
# table header. Values may be double- or single-quoted TOML strings.
scan_blocks='
  function value(line,   v) { v = line; sub(/^[^"\x27]*["\x27]/, "", v); sub(/["\x27].*$/, "", v); return v }
  /^[[:space:]]*\[/ { flush(); block = ($0 ~ /^[[:space:]]*\[\[[[:space:]]*keys\.command[[:space:]]*\]\]/) }
  block && /^[[:space:]]*key[[:space:]]*=/ { key = value($0) }
  block && /^[[:space:]]*command[[:space:]]*=/ { cmd = value($0) }
  END { flush() }
'

bound_key() {
  # Prints the chord of the first block bound to a plugin action.
  awk -v target="sbx.sandbox.$1" "function flush() { if (!found && block && cmd == target && key != \"\") { print key; found = 1 } key = \"\"; cmd = \"\" } $scan_blocks" "$config"
}

command_for_key() {
  # Prints the command of the first block bound to a chord.
  awk -v target="$1" "function flush() { if (!found && block && key == target) { print (cmd == \"\" ? \"(a command without a name)\" : cmd); found = 1 } key = \"\"; cmd = \"\" } $scan_blocks" "$config"
}

added=0
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
  taken=$(command_for_key "$key")
  if [ -n "$taken" ]; then
    printf 'warning: %s is already bound to %s in %s; sbx.sandbox.%s was not added, pick another chord for one of them\n' "$key" "$taken" "$config" "$action"
    return 0
  fi
  printf '\n[[keys.command]]\nkey = "%s"\ntype = "plugin_action"\ncommand = "sbx.sandbox.%s"\ndescription = "%s"\n' "$key" "$action" "$description" >> "$config"
  printf 'bound %s -> sbx.sandbox.%s\n' "$key" "$action"
  added=$((added + 1))
}

backup="$config.sbx-backup.$$"
cp "$config" "$backup"
add_binding "prefix+shift+a" "start-agent" "start an agent in a Docker Sandbox"
add_binding "prefix+shift+b" "reconnect" "bring the agent back in its Docker Sandbox"
add_binding "prefix+shift+s" "open-shell" "open a shell in the Docker Sandbox"
add_binding "prefix+shift+o" "sandboxes" "show the Docker Sandboxes overlay"

herdr=${HERDR_BIN_PATH:-herdr}
if ! command -v "$herdr" >/dev/null 2>&1; then
  rm -f "$backup"
  printf 'warning: %s is not available; run "herdr config check" and "herdr server reload-config" yourself\n' "$herdr"
  exit 0
fi
if ! "$herdr" config check >&2; then
  if [ "$added" -gt 0 ]; then
    cp "$backup" "$config"
    printf 'warning: herdr config check rejected the config; %s was restored to its previous content and the %s new binding(s) were dropped\n' "$config" "$added"
  else
    printf 'warning: herdr config check rejected the config; nothing was added to %s\n' "$config"
  fi
  rm -f "$backup"
  exit 1
fi
rm -f "$backup"
"$herdr" server reload-config >&2
printf 'reloaded\n'
