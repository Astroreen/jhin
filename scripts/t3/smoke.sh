#!/usr/bin/env bash
# CI check of the dev scripts: serve.sh starts a node that answers, a second
# instance is refused, stop.sh ends it and leaves no process behind.
# Linux only (GNU `tail --pid`); CI runs it on Ubuntu.
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
cd "$JHIN_ROOT" || exit 1
log="$(mktemp)"
trap 'bash scripts/t3/stop.sh >/dev/null; rm -f "$log"' EXIT

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

# A process that ignores SIGTERM and, when signalled, starts a child that
# ignores it too: stop.sh must catch the late child and reach SIGKILL.
stub="$(mktemp -d)"
touch "$stub/ready"
cat >"$stub/stubborn.sh" <<'STUB'
trap 'bash -c "trap \"\" TERM; exec sleep 1000" & echo $! >"$1/child"' TERM
echo ready >"$1/ready"
# `wait` returns when the TERM trap runs, so the loop only turns on signals.
while :; do
  sleep 1000 &
  wait "$!"
done
STUB
bash "$stub/stubborn.sh" "$stub" &
stubborn=$!
trap 'kill -9 "$stubborn" $(cat "$stub/child" 2>/dev/null) 2>/dev/null || true; rm -rf "$stub" "$log"; bash scripts/t3/stop.sh >/dev/null' EXIT
# Until the stub has installed its trap, or fails if the stub exits first.
grep -m1 -q ready < <(tail -n +1 -f --pid="$stubborn" "$stub/ready")
kill "$!" 2>/dev/null || true # the tail behind the process substitution
echo "$stubborn" >"$JHIN_DEV_DIR/pids/stubborn.pid"
JHIN_STOP_GRACE=20 bash scripts/t3/stop.sh
child="$(cat "$stub/child")"
if is_running "$stubborn" || is_running "$child"; then
  echo "smoke: stop.sh left a SIGTERM-ignoring process or its late child running" >&2
  exit 1
fi
echo "smoke: stop.sh ended a SIGTERM-ignoring process and its late child"
