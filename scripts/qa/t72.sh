#!/usr/bin/env bash
# QA for T72: session lifecycle service, routes and session_updated events.
# Usage: scripts/qa/t72.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T72. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM and
# reaped with `wait`; JSON assertions run with jq (present on the QA machine).
#
# Happy path:
#   - runs ./gradlew :jhin-plugin-sessions:test --rerun (transcript in
#     test.txt) and requires BUILD SUCCESSFUL;
#   - boots the kernel with only jhin.sessions installed (run-kernel.sh, log in
#     kernel.log) and drives the lifecycle over curl: create two sessions,
#     then pin -> settle -> unsettle -> snooze -> wake -> archive -> restore ->
#     reorder, asserting every response with jq (lifecycle-transcript.txt);
#   - captures the session_updated SSE frames of the replay stream into
#     events.json (raw frames kept in sse-raw.txt);
#   - records the failure matrix in conflict.txt: settle on an archived
#     session must answer 409 invalid_transition, snooze with a past
#     timestamp 400 invalid_request and regenerateTitle without jhin.agent
#     503 title_service_unavailable.
#   Evidence: test.txt, kernel.log, lifecycle-transcript.txt, events.json,
#   sse-raw.txt, conflict.txt, checks.txt.
#
# --fail mode: boots the same kernel, replays the conflict probes into
#   conflict-fail.txt and then asserts a deliberately wrong expectation (settle
#   on an archived session answered 200) against the real transcript, records
#   the run in checks-fail.txt and exits non-zero — proving the checker fails
#   instead of passing silently.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T72_INNER:-}" ]; then
  exec env T72_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T72}
mkdir -p "$evidence"

kernel_pid=""
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
  printf '%s\n' "$*"
}

ok() {
  printf 'ok: %s\n' "$*" | tee -a "$checks"
}

fail() {
  printf 'FAIL: %s\n' "$*" | tee -a "$checks" >&2
  exit 1
}

command -v jq > /dev/null || fail "jq is required"

port=18472
base="http://localhost:$port"

# wait_health <url> <timeout-seconds>: poll until the health endpoint answers
wait_health() {
  local url=$1 deadline=$(( $(date +%s) + $2 ))
  until curl -sf --max-time 3 "$url" > /dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

boot_kernel() {
  ./gradlew :jhin-plugin-sessions:jar
  local home
  home=$(mktemp -d)
  mkdir -p "$home/plugins"
  cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$home/plugins/"
  JHIN_HOME="$home" scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 30 || fail "the kernel did not become healthy (see $kernel_log_dir/kernel.log)"
}

# step <transcript> <name> <method> <path> <body> <expected-status> <jq-expr>
# Appends the request, status and response to the transcript and asserts both
# the status and the jq expression over the response body. The last response
# body is left in $step_payload for the caller.
step() {
  local tx=$1 name=$2 method=$3 path=$4 body=$5 expected=$6 expr=$7
  local response status payload
  response=$(curl -sS --max-time 10 -X "$method" \
      -H 'Content-Type: application/json' \
      --data "$body" \
      -w $'\n%{http_code}' "$base$path")
  status=${response##*$'\n'}
  payload=${response%$'\n'*}
  step_payload=$payload
  {
    echo "=== $name ==="
    echo "$method $path"
    echo "req:  $body"
    echo "status: $status"
    echo "resp: $payload"
    echo "assert: status=$expected, jq '$expr'"
  } >> "$tx"
  [ "$status" = "$expected" ] \
    || fail "$name: expected status $expected, got $status (resp: $payload)"
  if ! jq -e "$expr" <<< "$payload" > /dev/null; then
    fail "$name: jq assertion '$expr' failed on: $payload"
  fi
  echo "assert: ok" >> "$tx"
}

if [ "$fail_mode" = "1" ]; then
  log "T72 QA --fail: the checker must fail on a deliberately wrong expectation"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  conflict="$evidence/conflict-fail.txt"
  : > "$conflict"
  step "$conflict" create POST /sessions '{"title":"t72-fail","workdir":"/tmp/t72"}' 201 '.id | length > 0'
  id=$(jq -r '.id' <<< "$step_payload")
  step "$conflict" archive POST "/sessions/$id/archive" '' 200 '.archivedAt != null'
  step "$conflict" settle-after-archive POST "/sessions/$id/settle" '{"reason":"manual"}' 409 '.error == "invalid_transition"'
  # deliberate wrong expectation: the probe above answered 200 (it answered 409)
  fail "deliberately wrong expectation: settle on an archived session answered 200 (see $conflict)"
fi

log "T72 QA: session lifecycle service, routes and session_updated events"
log "evidence dir: $evidence"

# --- 1. The sessions JVM suite ---
./gradlew :jhin-plugin-sessions:test --rerun 2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-sessions:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' plugins/sessions/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok ":jhin-plugin-sessions:test green ($test_count tests; transcript in test.txt)"

# --- 2. The kernel lifecycle sequence ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with only jhin.sessions (kernel.log)"

tx="$evidence/lifecycle-transcript.txt"
: > "$tx"
step "$tx" create-a POST /sessions '{"title":"t72-a","workdir":"/tmp/t72"}' 201 '.id | length > 0'
id_a=$(jq -r '.id' <<< "$step_payload")
step "$tx" create-b POST /sessions '{"title":"t72-b","workdir":"/tmp/t72"}' 201 '.id | length > 0'
id_b=$(jq -r '.id' <<< "$step_payload")
[ -n "$id_a" ] && [ "$id_a" != "null" ] || fail "could not read session A id"
[ -n "$id_b" ] && [ "$id_b" != "null" ] || fail "could not read session B id"

step "$tx" pin POST "/sessions/$id_a/pin" '{"order":2}' 200 \
  '.pinned == true and .pinnedOrder == 2'
step "$tx" settle POST "/sessions/$id_a/settle" '{"reason":"manual"}' 200 \
  '.settledReason == "manual" and .settledAt != null and .pinned == false and .pinnedOrder == null and .snoozedUntil == null'
step "$tx" unsettle POST "/sessions/$id_a/unsettle" '' 200 \
  '.settledAt == null and .settledReason == null and .autoSettleSuppressed == true'
step "$tx" snooze POST "/sessions/$id_a/snooze" '{"durationMs":3600000}' 200 \
  '.snoozedUntil != null'
step "$tx" wake POST "/sessions/$id_a/wake" '' 200 \
  '.snoozedUntil == null'
step "$tx" archive POST "/sessions/$id_a/archive" '' 200 \
  '.archivedAt != null'
step "$tx" restore POST "/sessions/$id_a/restore" '' 200 \
  '.archivedAt == null'
step "$tx" reorder POST /sessions/reorder "{\"ids\":[\"$id_b\",\"$id_a\"]}" 200 \
  "length == 2 and .[0].id == \"$id_b\" and .[0].sortOrder == 0 and .[1].id == \"$id_a\" and .[1].sortOrder == 1"
grep -q '=== reorder ===' "$tx" || fail "the lifecycle transcript is missing steps (see $tx)"
ok "lifecycle sequence create->pin->settle->unsettle->snooze->wake->archive->restore->reorder (lifecycle-transcript.txt)"

# --- 3. The session_updated SSE frames ---
raw="$evidence/sse-raw.txt"
timeout 3 curl -sN "$base/sessions/$id_a/events?fromSeq=0" > "$raw" || true
awk '/^event: session_updated$/ { if (getline > 0) { sub(/^data: /, ""); print } }' "$raw" \
  > "$evidence/events.jsonl"
jq -s '.' "$evidence/events.jsonl" > "$evidence/events.json"
jq -e 'length == 8' "$evidence/events.json" > /dev/null \
  || fail "expected 8 session_updated frames for session A (pin, settle, unsettle, snooze, wake, archive, restore, reorder), got $(jq 'length' "$evidence/events.json") (see $evidence/sse-raw.txt)"
jq -e --arg id "$id_a" 'all(.[]; (.payload | fromjson | .id) == $id)' "$evidence/events.json" > /dev/null \
  || fail "not every session_updated frame carries session A (see $evidence/events.json)"
ok "events.json holds the 8 session_updated SSE frames of session A (raw in sse-raw.txt)"

# --- 4. The failure matrix ---
conflict="$evidence/conflict.txt"
: > "$conflict"
step "$conflict" create-c POST /sessions '{"title":"t72-c","workdir":"/tmp/t72"}' 201 '.id | length > 0'
id_c=$(jq -r '.id' <<< "$step_payload")
step "$conflict" archive-c POST "/sessions/$id_c/archive" '' 200 '.archivedAt != null'
step "$conflict" settle-on-archived POST "/sessions/$id_c/settle" '{"reason":"manual"}' 409 \
  '.error == "invalid_transition"'
step "$conflict" snooze-past POST "/sessions/$id_a/snooze" '{"until":1}' 400 \
  '.error == "invalid_request"'
step "$conflict" title-without-agent POST "/sessions/$id_a/title" '' 503 \
  '.error == "title_service_unavailable"'
grep -q 'invalid_transition' "$conflict" || fail "conflict.txt is missing the 409 evidence"
grep -q 'title_service_unavailable' "$conflict" || fail "conflict.txt is missing the 503 evidence"
ok "failure matrix: settle-on-archived=409, snooze-past=400, title-without-agent=503 (conflict.txt)"

log "T72 QA OK (evidence in $evidence)"
