#!/usr/bin/env bash
# CI check of the dev scripts: serve.sh starts a node that answers, a second
# instance is refused, stop.sh ends it and leaves no process behind.
# Linux only (GNU `tail --pid`); CI runs it on Ubuntu.
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
cd "$JHIN_ROOT" || exit 1
log="$(mktemp)"
trap 'bash scripts/t3/stop.sh >/dev/null' EXIT

bash scripts/t3/serve.sh >"$log" 2>&1 &
# Wait for the concrete "open" line (or serve.sh exiting), not for a time.
grep -m1 -q "jhin: open" < <(tail -n +1 -f --pid=$! "$log") || { cat "$log"; exit 1; }
url="$(grep -m1 -o 'http://[^#]*' <(grep "jhin: open" "$log"))"

curl -fsS "$url" | grep -q "<title>Jhin</title>"
echo "smoke: $url serves the web client"

second="$(bash scripts/t3/serve.sh 2>&1 || true)"
if [[ "$second" == *"already running"* ]]; then
  echo "smoke: a second instance is refused"
else
  echo "smoke: a second instance was not refused" >&2
  exit 1
fi

bash scripts/t3/stop.sh
if pgrep -f "apps/jhin/bin/jhin.js --home $JHIN_DEV_HOME" >/dev/null; then
  echo "smoke: a node is still running after stop.sh" >&2
  exit 1
fi
echo "smoke: stop.sh left no node running"
