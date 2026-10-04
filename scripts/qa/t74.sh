#!/usr/bin/env bash
# QA for T74: the server-owned auto-settle sweep.
# Usage: scripts/qa/t74.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T74. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM and
# reaped with `wait`; JSON assertions run with jq and the `updated_at`
# backdating runs through sqlite3 against the kernel's database in JHIN_HOME
# (both present on the QA machine).
#
# Happy path:
#   - runs ./gradlew :jhin-plugin-sessions:test --rerun (transcript in
#     test.txt) and requires BUILD SUCCESSFUL;
#   - boots the kernel with only jhin.sessions (run-kernel.sh, log in
#     kernel.log) with jhin.sessions.inactivityMs=1000 and short sweep delays
#     (sweepInitialDelayMs=1000, sweepIntervalMs=2000) and seeds three
#     sessions whose updated_at is backdated to now-10s:
#     sweep-transcript.txt — one idle session settles with
#     settled_reason=inactive; one pinned session settles AND keeps
#     pinned/pinned_order (T3: pinning does not prevent auto-settle — the
#     pinned case); one session with a live run row (jhin_sessions_runs.
#     ended_at IS NULL) does not settle;
#   - boots a second kernel with jhin.sessions.inactivityMs=Long.MAX_VALUE:
#     no-settle.txt — nothing settles (plain and pinned sessions stay active);
#   - greps kernel.log for the sweep lines.
#   Evidence: test.txt, kernel.log, sweep-transcript.txt, no-settle.txt,
#   checks.txt.
#
# --fail mode: boots a kernel with inactivityMs=Long.MAX_VALUE, seeds and
#   backdates one session and records the non-settlement probe into
#   no-settle-fail.txt, then asserts a deliberately wrong expectation (the
#   huge-threshold sweep settled the session) against the real transcript,
#   records the run in checks-fail.txt and exits non-zero — proving the
#   checker fails instead of passing silently.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T74_INNER:-}" ]; then
  exec env T74_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T74}
mkdir -p "$evidence"

kernel_pid=""
home=""
cleanup() {
  if [ -n "$kernel_pid" ] && ps -p "$kernel_pid" > /dev/null 2>&1; then
    kill "$kernel_pid" 2>/dev/null || true
    wait "$kernel_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT

if [ "$fail_mode" = "1" ]; then
  checks="$evidence/checks-fail.txt"
else
  checks="$evidence/checks.txt"
fi
: > "$checks"

log() {
  printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$checks"
}

ok() {
  printf 'ok: %s\n' "$*" | tee -a "$checks"
}

fail() {
  printf 'FAIL: %s\n' "$*" | tee -a "$checks" >&2
  exit 1
}

command -v jq > /dev/null || fail "jq is required"
command -v sqlite3 > /dev/null || fail "sqlite3 is required to backdate updated_at"

port=18474
base="http://localhost:$port"

# wait_health <url> <timeout-seconds>: poll until the health endpoint answers
wait_health() {
  local url=$1 deadline=$(( $(date +%s) + $2 ))
  until curl -sf --max-time 3 "$url" > /dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

stop_kernel() {
  if [ -n "$kernel_pid" ] && ps -p "$kernel_pid" > /dev/null 2>&1; then
    kill "$kernel_pid" 2>/dev/null || true
    wait "$kernel_pid" 2>/dev/null || true
  fi
  kernel_pid=""
}

# boot_kernel <kernel-log-dir> <inactivity-ms>: builds the sessions jar, writes
# a JHIN_HOME holding the plugin and a config.json (short sweep delays so QA
# sees sweeps in seconds) and starts the kernel in the background. Leaves $home
# pointing at the JHIN_HOME for the SQL helpers below.
boot_kernel() {
  local log_dir=$1 inactivity_ms=$2
  ./gradlew :jhin-plugin-sessions:jar
  home=$(mktemp -d)
  mkdir -p "$home/plugins"
  cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$home/plugins/"
  cat > "$home/config.json" <<EOF
{
  "jhin.sessions": {
    "inactivityMs": $inactivity_ms,
    "sweepInitialDelayMs": 1000,
    "sweepIntervalMs": 2000
  }
}
EOF
  JHIN_HOME="$home" scripts/qa/run-kernel.sh "$log_dir" --server.port="$port" &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 30 \
    || fail "the kernel did not become healthy (see $log_dir/kernel.log)"
}

now_ms() {
  date +%s%3N
}

# create_session <title>: creates one session and prints its id
create_session() {
  local title=$1 response status payload
  response=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      --data "{\"title\":\"$title\",\"workdir\":\"/tmp/t74\"}" \
      -w $'\n%{http_code}' "$base/sessions")
  status=${response##*$'\n'}
  payload=${response%$'\n'*}
  [ "$status" = "201" ] || fail "create $title: expected 201, got $status ($payload)"
  jq -r '.id' <<< "$payload"
}

# pin_session <id> <order>: pins and asserts the response
pin_session() {
  local id=$1 order=$2 payload
  payload=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      --data "{\"order\":$order}" "$base/sessions/$id/pin")
  jq -e --argjson order "$order" '.pinned == true and .pinnedOrder == $order' \
      <<< "$payload" > /dev/null \
    || fail "pinning session $id to $order failed ($payload)"
  echo "$payload"
}

# session_json <id>: the session object out of GET /sessions
session_json() {
  curl -sS --max-time 10 "$base/sessions" | jq -c --arg id "$1" '.[] | select(.id == $id)'
}

# backdate <id> <ms-ago>: ages updated_at so the inactivity threshold is met
backdate() {
  local id=$1
  local ms_ago=$2
  local ts
  ts=$(( $(now_ms) - ms_ago ))
  sqlite3 "$home/data/jhin.db" \
    "UPDATE jhin_sessions_sessions SET updated_at = $ts WHERE id = '$id';"
  [ "$(sqlite3 "$home/data/jhin.db" \
      "SELECT updated_at FROM jhin_sessions_sessions WHERE id = '$id';")" = "$ts" ] \
    || fail "backdate did not stick for $id"
}

# insert_live_run <run-id> <session-id>: one run row that has not ended
insert_live_run() {
  local run_id=$1 session_id=$2 ts
  ts=$(now_ms)
  sqlite3 "$home/data/jhin.db" \
    "INSERT INTO jhin_sessions_runs(id, session_id, status, started_at, ended_at, error) VALUES ('$run_id', '$session_id', 'running', $ts, NULL, NULL);"
}

if [ "$fail_mode" = "1" ]; then
  log "T74 QA --fail: the checker must fail on a deliberately wrong expectation"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel "$kernel_log_dir" 9223372036854775807
  fail_tx="$evidence/no-settle-fail.txt"
  : > "$fail_tx"
  id=$(create_session t74-fail)
  backdate "$id" 10000
  sleep 6
  status_json=$(session_json "$id")
  {
    echo "=== no-settle probe (inactivityMs=Long.MAX_VALUE) ==="
    echo "session: $status_json"
    echo "assert: .settledAt == null (the huge threshold settles nothing)"
  } >> "$fail_tx"
  jq -e '.settledAt == null' <<< "$status_json" > /dev/null \
    || fail "the huge-threshold sweep settled session $id (see $fail_tx)"
  echo "assert: ok" >> "$fail_tx"
  # deliberate wrong expectation: the probe above left the session unsettled
  fail "deliberately wrong expectation: the huge-threshold sweep settled session $id (see $fail_tx)"
fi

log "T74 QA: server-owned auto-settle sweep"
log "evidence dir: $evidence"

# --- 1. The sessions JVM suite ---
./gradlew :jhin-plugin-sessions:test --rerun 2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-sessions:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' plugins/sessions/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok ":jhin-plugin-sessions:test green ($test_count tests; transcript in test.txt)"

# --- 2. The sweep settles idle sessions in place, keeps the pin, skips live runs ---
kernel_log_dir="$evidence"
boot_kernel "$kernel_log_dir" 1000
ok "kernel booted with only jhin.sessions (kernel.log; inactivityMs=1000, sweep delays 1s/2s)"

tx="$evidence/sweep-transcript.txt"
: > "$tx"
id_idle=$(create_session t74-idle)
id_pinned=$(create_session t74-pinned)
id_live=$(create_session t74-live-run)
pin_payload=$(pin_session "$id_pinned" 2)
{
  echo "=== seed ==="
  echo "idle:   $id_idle (no pin, no run)"
  echo "pinned: $id_pinned (pinned order=2, no run)"
  echo "pin:    $pin_payload"
  echo "live:   $id_live (run row t74-run-1, ended_at IS NULL)"
} >> "$tx"

backdate "$id_idle" 10000
backdate "$id_pinned" 10000
backdate "$id_live" 10000
insert_live_run t74-run-1 "$id_live"
{
  echo "=== backdate ==="
  echo "updated_at of the three sessions set to now-10s via sqlite3 on $home/data/jhin.db"
  echo "live run row t74-run-1 inserted for $id_live (ended_at NULL)"
} >> "$tx"

sleep 8

{
  echo "=== sweep result (after 8 s, sweeps every 2 s) ==="
} >> "$tx"
idle_json=$(session_json "$id_idle")
pinned_json=$(session_json "$id_pinned")
live_json=$(session_json "$id_live")
{
  echo "idle:   $idle_json"
  echo "pinned: $pinned_json"
  echo "live:   $live_json"
} >> "$tx"
jq -e '.settledAt != null and .settledReason == "inactive"' <<< "$idle_json" > /dev/null \
  || fail "the idle session did not settle with settled_reason=inactive (see $tx)"
echo "assert idle: settled with settled_reason=inactive -- ok" >> "$tx"
jq -e '.settledAt != null and .settledReason == "inactive"
       and .pinned == true and .pinnedOrder == 2' <<< "$pinned_json" > /dev/null \
  || fail "the pinned session did not settle or lost its pin (see $tx)"
echo "assert pinned: settled with settled_reason=inactive AND kept pinned/pinned_order -- ok" >> "$tx"
jq -e '.settledAt == null' <<< "$live_json" > /dev/null \
  || fail "the live-run session settled despite its unfinished run (see $tx)"
echo "assert live-run: not settled (blocked by the unfinished run) -- ok" >> "$tx"
grep -q 'settlement sweep' "$evidence/kernel.log" \
  || fail "kernel.log carries no sweep lines (see $evidence/kernel.log)"
grep -q "settled $id_idle (inactive)" "$evidence/kernel.log" \
  || fail "kernel.log misses the settle line of the idle session (see $evidence/kernel.log)"
ok "sweep settles idle and pinned sessions (pin kept) and skips the live run (sweep-transcript.txt)"
ok "kernel.log carries the settlement sweep lines"

stop_kernel

# --- 3. The huge threshold settles nothing ---
kernel_log_dir="$evidence/no-settle-boot"
mkdir -p "$kernel_log_dir"
boot_kernel "$kernel_log_dir" 9223372036854775807
ok "kernel booted with jhin.sessions.inactivityMs=Long.MAX_VALUE (no-settle-boot/kernel.log)"

ns="$evidence/no-settle.txt"
: > "$ns"
id_ns=$(create_session t74-no-settle)
id_ns_pin=$(create_session t74-no-settle-pinned)
pin_session "$id_ns_pin" 1 > /dev/null
backdate "$id_ns" 10000
backdate "$id_ns_pin" 10000
sleep 8
ns_json=$(session_json "$id_ns")
ns_pin_json=$(session_json "$id_ns_pin")
{
  echo "=== no-settle run (inactivityMs=Long.MAX_VALUE) ==="
  echo "plain:  $ns_json"
  echo "pinned: $ns_pin_json"
  echo "updated_at of both set to now-10s; several sweeps ran"
} >> "$ns"
jq -e '.settledAt == null' <<< "$ns_json" > /dev/null \
  || fail "the huge-threshold sweep settled the plain session (see $ns)"
jq -e '.settledAt == null' <<< "$ns_pin_json" > /dev/null \
  || fail "the huge-threshold sweep settled the pinned session (see $ns)"
{
  echo "assert plain:  not settled -- ok"
  echo "assert pinned: not settled -- ok"
  echo "the pinned case (auto-settle keeps the pin) is asserted in sweep-transcript.txt"
} >> "$ns"
ok "inactivityMs=Long.MAX_VALUE settles nothing (no-settle.txt)"

stop_kernel
log "T74 QA OK (evidence in $evidence)"
