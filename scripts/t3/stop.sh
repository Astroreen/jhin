#!/usr/bin/env bash
# Stops whatever serve.sh and dev.sh started and returns once all of it has
# exited, so the ports are free and nothing is left running. Blocks up to
# about 10 s for a process that ignores SIGTERM (then SIGKILL).
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"

status=0
shopt -s nullglob
for file in "$JHIN_DEV_DIR"/pids/*.pid; do
  name="$(basename "$file" .pid)"
  pid="$(cat "$file")"
  if is_ours "$pid" "$name"; then
    if stop_tree "$pid"; then
      echo "jhin: stopped $name ($pid)"
    else
      status=1
    fi
  fi
  rm -f "$file"
done
exit "$status"
