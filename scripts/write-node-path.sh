#!/bin/sh
# Records the absolute path of a node binary so plugin commands keep working
# when Herdr's server has a different PATH. Looks on PATH first, then in the
# usual version-manager and package-manager locations.
# Usage: scripts/write-node-path.sh [output-file]   (default: bin/node-path)
set -eu
out="${1:-$(dirname "$0")/../bin/node-path}"
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
  # Newest installed nvm version wins.
  for candidate in $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV); do
    if [ -x "$candidate" ]; then
      node_bin="$candidate"
      break
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
