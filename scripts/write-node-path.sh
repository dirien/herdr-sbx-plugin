#!/bin/sh
# Records the absolute path of a node binary so plugin commands keep working
# when Herdr's server has a different PATH. Looks on PATH first, then in the
# usual version-manager and package-manager locations.
# Usage: scripts/write-node-path.sh [output-file]   (default: bin/node-path)
# Only shell builtins are used, so it also works from a PATH without coreutils.
set -eu
case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
out="${1:-$script_dir/../bin/node-path}"
node_bin=$(command -v node 2>/dev/null || true)
candidates="${HERDR_SBX_NODE_CANDIDATES:-${HOME:-/nonexistent}/.volta/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node}"
if [ -z "$node_bin" ]; then
  for candidate in $candidates; do
    if [ -x "$candidate" ]; then
      node_bin="$candidate"
      break
    fi
  done
fi
if [ -z "$node_bin" ] && [ -d "${HOME:-/nonexistent}/.nvm/versions/node" ]; then
  # Newest installed nvm version wins; versions are compared numerically
  # (v20.11.0 beats v9.11.2) without sort, which is not the same on every OS.
  best_key=0
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] || continue
    version=${candidate%/bin/node}
    version=${version##*/}
    version=${version#v}
    case "$version" in
      *[!0-9.]*|"") continue ;;
    esac
    major=${version%%.*}
    rest=${version#"$major"}
    rest=${rest#.}
    minor=${rest%%.*}
    rest=${rest#"$minor"}
    patch=${rest#.}
    key=$(( ${major:-0} * 1000000 + ${minor:-0} * 1000 + ${patch:-0} ))
    if [ "$key" -gt "$best_key" ]; then
      best_key=$key
      node_bin="$candidate"
    fi
  done
fi
if [ -z "$node_bin" ]; then
  printf 'node was not found on PATH or in the usual locations; plugin commands will look for node at run time\n' >&2
  exit 0
fi
case "$out" in
  */*) out_dir=${out%/*} ;;
  *) out_dir=. ;;
esac
[ -d "$out_dir" ] || mkdir -p "$out_dir"
printf '%s\n' "$node_bin" > "$out"
printf 'recorded %s in %s\n' "$node_bin" "$out"
