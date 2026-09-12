#!/bin/sh
# Records the absolute path of a node binary so plugin commands keep working
# when Herdr's server has a different PATH. Looks on PATH first, then in the
# usual version-manager and package-manager locations, then in nvm's versions,
# and takes the first node that is new enough (major version 20 or later,
# what package.json requires); an older node is recorded only when nothing
# better exists, with a warning.
# Usage: scripts/write-node-path.sh [output-file]   (default: bin/node-path)
# Nothing but shell builtins and the node candidates themselves run, except
# mkdir when the output directory is missing.
set -eu
min_major=20
case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
out="${1:-$script_dir/../bin/node-path}"
home=${HOME:-/nonexistent}
candidates="${HERDR_SBX_NODE_CANDIDATES:-$home/.volta/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node}"

node_bin=""
fallback=""
fallback_version=""

# Accepts a candidate when it runs and reports a new enough version; remembers
# the first runnable one as a fallback.
consider() {
  [ -z "$node_bin" ] || return 0
  [ -x "$1" ] || return 0
  version=$("$1" -p 'process.versions.node' 2>/dev/null) || return 0
  case "$version" in
    [0-9]*) ;;
    *) return 0 ;;
  esac
  major=${version%%.*}
  if [ "$major" -ge "$min_major" ]; then
    node_bin=$1
  elif [ -z "$fallback" ]; then
    fallback=$1
    fallback_version=$version
  fi
}

on_path=$(command -v node 2>/dev/null || true)
[ -z "$on_path" ] || consider "$on_path"
for candidate in $candidates; do
  consider "$candidate"
done
if [ -z "$node_bin" ] && [ -d "$home/.nvm/versions/node" ]; then
  # Newest installed nvm version first; versions are compared numerically
  # (v20.11.0 beats v9.11.2) without sort, which is not the same on every OS.
  best_key=0
  best=""
  for candidate in "$home"/.nvm/versions/node/*/bin/node; do
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
      best=$candidate
    fi
  done
  [ -z "$best" ] || consider "$best"
fi
if [ -z "$node_bin" ] && [ -n "$fallback" ]; then
  printf 'warning: node %s at %s is older than %s; the plugin needs Node %s or newer, install one and run this script again\n' "$fallback_version" "$fallback" "$min_major" "$min_major" >&2
  node_bin=$fallback
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
