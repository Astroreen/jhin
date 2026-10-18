#!/usr/bin/env bash
# Stops whatever serve.sh and dev.sh started.
source "$(dirname "$0")/env.sh"

kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$1" 2>/dev/null || true
}

shopt -s nullglob
for file in "$JHIN_DEV_DIR"/pids/*.pid; do
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid"
    echo "jhin: stopped $(basename "$file" .pid) ($pid)"
  fi
  rm -f "$file"
done
