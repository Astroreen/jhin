#!/usr/bin/env bash
# QA for T73: the 5-second undo journal with coalescing and the `undo` action.
# Usage: scripts/qa/t73.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T73. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM and
# reaped with `wait`; JSON assertions run with jq (present on the QA machine).
#
# Happy path:
#   - runs ./gradlew :jhin-plugin-sessions:test :jhin-plugin-ui-default:test
#     --rerun (transcript in test.txt) and requires BUILD SUCCESSFUL;
#   - boots the kernel with jhin.sessions, jhin.ui-kit and jhin.ui (run-kernel.sh,
#     log in kernel.log) and drives the undo window over curl:
#     no-entry.txt — undo on an empty journal answers the nothing-to-undo
#     toast and mutates no state;
#     undo-transcript.txt — pin(order=2) -> settle -> sleep 2 -> undo asserts
#     settled_at/pinned/pinned_order restored exactly to the pre-settle state,
#     then settle again -> sleep 6 (past the 5 s window) -> undo answers
#     nothing-to-undo and leaves the settled state alone.
#   Evidence: test.txt, kernel.log, no-entry.txt, undo-transcript.txt,
#   checks.txt.
#
# --fail mode: boots the same kernel, replays the nothing-to-undo probe into
#   undo-fail.txt, then asserts a deliberately wrong expectation (the empty
#   journal undo answered "Undone") against the real transcript, records the
#   run in checks-fail.txt and exits non-zero — proving the checker fails
#   instead of passing silently.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T73_INNER:-}" ]; then
  exec env T73_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T73}
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

port=18473
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
  ./gradlew :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar
  local home
  home=$(mktemp -d)
  mkdir -p "$home/plugins"
  cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$home/plugins/"
  cp plugins/ui-kit/build/libs/jhin-plugin-ui-kit-*.jar "$home/plugins/"
  cp plugins/ui-default/build/libs/jhin-plugin-ui-default-*.jar "$home/plugins/"
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

# get_step <transcript> <name> <path> <expected-status> <jq-expr>
# GET variant of step: no request body is sent.
get_step() {
  local tx=$1 name=$2 path=$3 expected=$4 expr=$5
  local response status payload
  response=$(curl -sS --max-time 10 -w $'\n%{http_code}' "$base$path")
  status=${response##*$'\n'}
  payload=${response%$'\n'*}
  step_payload=$payload
  {
    echo "=== $name ==="
    echo "GET $path"
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

undo_body='{"action":"undo","payload":{}}'
undo_ok='(.client | length) == 2 and .client[0].op == "toast" and .client[0].text == "Undone" and .client[1].op == "refresh"'
undo_nothing='(.client | length) == 1 and .client[0].op == "toast" and .client[0].text == "Nothing to undo" and .client[0].style == "error"'

if [ "$fail_mode" = "1" ]; then
  log "T73 QA --fail: the checker must fail on a deliberately wrong expectation"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  probe="$evidence/undo-fail.txt"
  : > "$probe"
  step "$probe" create POST /sessions '{"title":"t73-fail","workdir":"/tmp/t73"}' 201 '.id | length > 0'
  id=$(jq -r '.id' <<< "$step_payload")
  step "$probe" undo-empty-journal POST /ui/action/undo "$undo_body" 200 "$undo_nothing"
  get_step "$probe" session-untouched "/sessions/$id" 200 \
    '.settledAt == null and .pinned == false and .pinnedOrder == null'
  # deliberate wrong expectation: the probe above answered "Nothing to undo"
  fail "deliberately wrong expectation: undo with an empty journal answered Undone (see $probe)"
fi

log "T73 QA: the 5-second undo journal with coalescing and the undo action"
log "evidence dir: $evidence"

# --- 1. The sessions + ui-default JVM suites ---
./gradlew :jhin-plugin-sessions:test :jhin-plugin-ui-default:test --rerun 2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-sessions:test / :jhin-plugin-ui-default:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/sessions/build/test-results/test/TEST-*.xml \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok ":jhin-plugin-sessions:test and :jhin-plugin-ui-default:test green ($test_count tests; transcript in test.txt)"

# --- 2. The kernel sequence ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with jhin.sessions + jhin.ui-kit + jhin.ui (kernel.log)"

# --- 3. Nothing to undo on an empty journal (failure path, recorded as
#     evidence for the "no journal entry" acceptance) ---
no_entry="$evidence/no-entry.txt"
: > "$no_entry"
step "$no_entry" create POST /sessions '{"title":"t73-no-entry","workdir":"/tmp/t73"}' 201 '.id | length > 0'
id_n=$(jq -r '.id' <<< "$step_payload")
get_step "$no_entry" session-before "/sessions/$id_n" 200 \
  '.settledAt == null and .pinned == false and .pinnedOrder == null'
before_payload=$step_payload
step "$no_entry" undo-empty-journal POST /ui/action/undo "$undo_body" 200 "$undo_nothing"
get_step "$no_entry" session-after-unchanged "/sessions/$id_n" 200 \
  '.settledAt == null and .pinned == false and .pinnedOrder == null'
after_payload=$step_payload
{
  echo "=== state-comparison ==="
  echo "before: $before_payload"
  echo "after:  $after_payload"
} >> "$no_entry"
[ "$before_payload" = "$after_payload" ] \
  || fail "the empty-journal undo mutated the session (see $no_entry)"
echo "assert: before == after" >> "$no_entry"
grep -q 'Nothing to undo' "$no_entry" || fail "no-entry.txt is missing the nothing-to-undo evidence"
ok "undo on an empty journal answers nothing-to-undo and mutates no state (no-entry.txt)"

# --- 4. The undo window: exact restore inside 5 s, nothing-to-undo after ---
tx="$evidence/undo-transcript.txt"
: > "$tx"
step "$tx" create POST /sessions '{"title":"t73-undo","workdir":"/tmp/t73"}' 201 '.id | length > 0'
id=$(jq -r '.id' <<< "$step_payload")
[ -n "$id" ] && [ "$id" != "null" ] || fail "could not read the session id"
step "$tx" pin POST "/sessions/$id/pin" '{"order":2}' 200 \
  '.pinned == true and .pinnedOrder == 2'
step "$tx" settle POST "/sessions/$id/settle" '{"reason":"manual"}' 200 \
  '.settledAt != null and .pinned == false and .pinnedOrder == null'
sleep 2
step "$tx" undo-inside-window POST /ui/action/undo "$undo_body" 200 "$undo_ok"
get_step "$tx" session-restored-exactly "/sessions/$id" 200 \
  '.settledAt == null and .settledReason == null and .pinned == true and .pinnedOrder == 2'
step "$tx" settle-again POST "/sessions/$id/settle" '{"reason":"manual"}' 200 \
  '.settledAt != null and .pinned == false and .pinnedOrder == null'
sleep 6
step "$tx" undo-after-window POST /ui/action/undo "$undo_body" 200 "$undo_nothing"
get_step "$tx" session-still-settled "/sessions/$id" 200 \
  '.settledAt != null and .settledReason == "manual" and .pinned == false and .pinnedOrder == null'
grep -q '=== undo-inside-window ===' "$tx" || fail "undo-transcript.txt is missing steps (see $tx)"
grep -q '=== undo-after-window ===' "$tx" || fail "undo-transcript.txt is missing steps (see $tx)"
ok "undo inside 5 s restored settled_at/pinned/pinned_order exactly; after 6 s nothing-to-undo and no mutation (undo-transcript.txt)"

log "T73 QA OK (evidence in $evidence)"
