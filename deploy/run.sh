#!/usr/bin/env bash
# Restart loop for the Jhin hub: runs the kernel jar and brings it back up
# after any exit. Exit code 0 means "restart requested": POST /admin/reload
# (plugin jhin.reload) acknowledges with 202 and exits the JVM with code 0
# after a short delay, and this loop starts a fresh process so the host comes
# back with freshly loaded plugins. Any other exit code is treated as a crash
# and restarted the same way (the same policy as systemd Restart=always).
#
# Usage: deploy/run.sh [kernel.jar] [kernel-args...]
# The jar path defaults to the boot jar built under kernel/build/libs; extra
# arguments (for example --server.port=8443) are passed to the kernel.
set -u

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ $# -ge 1 ]; then
  jar=$1
  shift
else
  jar=$(ls "$script_dir/../kernel/build/libs"/kernel-*.jar 2>/dev/null | grep -v -- '-plain\.jar$' | head -1)
fi
if [ -z "${jar:-}" ] || [ ! -f "$jar" ]; then
  echo "kernel jar not found; pass its path as the first argument" >&2
  exit 1
fi

echo "jhin restart loop on $jar"
while true; do
  java -jar "$jar" "$@"
  status=$?
  echo "jhin exited with code $status; restarting in 1s"
  sleep 1
done
