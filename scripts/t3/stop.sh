#!/usr/bin/env bash
# Stops whatever serve.sh and dev.sh started and returns once all of it has
# exited, so the ports are free and nothing is left running.
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"

shopt -s nullglob
for file in "$JHIN_DEV_DIR"/pids/*.pid; do
  name="$(basename "$file" .pid)"
  pid="$(cat "$file")"
  if is_ours "$pid" "$name"; then
    stop_tree "$pid"
    echo "jhin: stopped $name ($pid)"
  fi
  rm -f "$file"
done
