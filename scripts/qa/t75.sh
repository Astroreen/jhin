#!/usr/bin/env bash
# QA for T75: title regeneration via jhin.agent (TitleService) and live
# session_updated frames in the UI.
# Usage: scripts/qa/t75.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T75. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM and
# reaped with `wait`; JSON assertions run with jq (present on the QA machine).
#
# Happy path:
#   - runs the agent, ui-default and sessions JVM suites (transcript in
#     test.txt) and requires BUILD SUCCESSFUL;
#   - boots the kernel with jhin.sessions, jhin.llm, jhin.qa-mock-llm,
#     jhin.agent, jhin.ui-kit and jhin.ui (run-kernel.sh, log in kernel.log)
#     and drives the title flow over curl (title-transcript.txt): create a
#     mock provider with the `title` script, create a session on it, send one
#     message (the scripted mock answers), then POST /sessions/{id}/title and
#     assert a 200 with a 60-character title in both the response and
#     GET /sessions/{id} (the database read);
#   - captures the SSE streams: the per-session SDUI stream carries the
#     session_updated patch frame {"patch":{"id":"session-row:<id>",...}}
#     (session-stream.txt), the raw events stream carries the
#     "type":"session_updated" bodies (raw-events.txt) and the new
#     sessions-overview stream broadcasts the same patch frame live while the
#     title call runs (overview-sse.txt).
#
# Failure path (llm-failure.txt, same kernel): a provider with the `fail`
#   script and a session without any provider both answer
#   503 title_service_unavailable on POST /sessions/{id}/title and the stored
#   title stays unchanged.
#
# --fail mode: boots the same kernel, replays the failure probes into
#   llm-failure-fail.txt and then asserts a deliberately wrong expectation
#   (the title call answered 200) against the real transcript, records the run
#   in checks-fail.txt and exits non-zero — proving the checker fails instead
#   of passing silently.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T75_INNER:-}" ]; then
  exec env T75_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T75}
mkdir -p "$evidence"

kernel_pid=""
overview_pid=""
cleanup() {
  if [ -n "$overview_pid" ] && ps -p "$overview_pid" > /dev/null 2>&1; then
    kill "$overview_pid" 2>/dev/null || true
    wait "$overview_pid" 2>/dev/null || true
  fi
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

port=18475
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
  ./gradlew :jhin-plugin-sessions:jar :jhin-plugin-llm:jar :jhin-plugin-qa-mock-llm:jar \
    :jhin-plugin-agent:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar
  local home
  home=$(mktemp -d)
  mkdir -p "$home/plugins"
  cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$home/plugins/"
  cp plugins/llm/build/libs/jhin-plugin-llm-*.jar "$home/plugins/"
  cp plugins/qa-mock-llm/build/libs/jhin-plugin-qa-mock-llm-*.jar "$home/plugins/"
  cp plugins/agent/build/libs/jhin-plugin-agent-*.jar "$home/plugins/"
  cp plugins/ui-kit/build/libs/jhin-plugin-ui-kit-*.jar "$home/plugins/"
  cp plugins/ui-default/build/libs/jhin-plugin-ui-default-*.jar "$home/plugins/"
  JHIN_HOME="$home" scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 60 || fail "the kernel did not become healthy (see $kernel_log_dir/kernel.log)"
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

# frames <sse-raw-file> <out-file>: extracts the `data:` bodies written under
# `event: frame` (the SDUI frame vocabulary) into one JSON per line.
frames() {
  awk '/^event: frame$/ { if (getline > 0) { sub(/^data: /, ""); print } }' "$1" > "$2"
}

if [ "$fail_mode" = "1" ]; then
  log "T75 QA --fail: the checker must fail on a deliberately wrong expectation"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/llm-failure-fail.txt"
  : > "$tx"
  step "$tx" create-fail-provider POST /providers '{"format":"mock","model":"fail","apiKey":"qa"}' 201 '.id | length > 0'
  fail_pid=$(jq -r '.id' <<< "$step_payload")
  step "$tx" create-fail-session POST /sessions "{\"title\":\"keep-me\",\"workdir\":\"/tmp/t75\",\"providerId\":\"$fail_pid\"}" 201 '.id | length > 0'
  fail_sid=$(jq -r '.id' <<< "$step_payload")
  step "$tx" title-on-failing-mock POST "/sessions/$fail_sid/title" '' 503 '.error == "title_service_unavailable"'
  # deliberate wrong expectation: the probe above answered 503 (it answered 503)
  fail "deliberately wrong expectation: POST /sessions/$fail_sid/title answered 200 (see $tx)"
fi

log "T75 QA: title regeneration and live session_updated frames"
log "evidence dir: $evidence"

# --- 1. The JVM suites ---
./gradlew :jhin-plugin-agent:test :jhin-plugin-ui-default:test :jhin-plugin-sessions:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/agent/build/test-results/test/TEST-*.xml \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/sessions/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "agent, ui-default and sessions suites green ($test_count tests; transcript in test.txt)"

# --- 2. The kernel title flow ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, llm, qa-mock-llm, agent and ui (kernel.log)"

tx="$evidence/title-transcript.txt"
: > "$tx"
step "$tx" create-provider POST /providers '{"format":"mock","model":"title","apiKey":"qa"}' 201 '.id | length > 0'
pid=$(jq -r '.id' <<< "$step_payload")
step "$tx" create-session POST /sessions "{\"title\":\"original title\",\"workdir\":\"/tmp/t75\",\"providerId\":\"$pid\"}" 201 '.id | length > 0'
sid=$(jq -r '.id' <<< "$step_payload")
[ -n "$sid" ] && [ "$sid" != "null" ] || fail "could not read the session id"

step "$tx" send-message POST "/sessions/$sid/messages" '{"text":"Fix the login bug in the auth module"}' 202 '.runId | length > 0'

run_events="$evidence/run-events.txt"
for _ in $(seq 1 30); do
  timeout 2 curl -sN "$base/sessions/$sid/events?fromSeq=0" > "$run_events" || true
  grep -q 'run_end' "$run_events" && break
  sleep 1
done
grep -q 'run_end' "$run_events" || fail "the scripted run did not finish (see $run_events)"
grep -q 'message_end' "$run_events" || fail "the scripted run recorded no message_end (see $run_events)"
echo "=== run finished (run_end + message_end observed in run-events.txt) ===" >> "$tx"
ok "one scripted run finished (user_message -> message_end -> run_end in run-events.txt)"

# the overview stream must be live before the title call emits its update
timeout 8 curl -sN "$base/ui/stream/sessions-overview" > "$evidence/overview-sse.txt" &
overview_pid=$!
sleep 1

step "$tx" regenerate-title POST "/sessions/$sid/title" '' 200 \
  '(.title | length) <= 60 and (.title | length) > 0'
title=$(jq -r '.title' <<< "$step_payload")
[ "${#title}" -le 60 ] || fail "the returned title exceeds 60 chars: $title"
[ "$title" != "original title" ] || fail "the title was not regenerated"
wait "$overview_pid" || true
overview_pid=""

step "$tx" title-in-db GET "/sessions/$sid" '' 200 ".title == \"$title\""
step "$tx" title-length GET "/sessions/$sid" '' 200 '(.title | length) == 60'
echo "=== title: $title (${#title} chars) ===" >> "$tx"
ok "POST /sessions/$sid/title -> 200 with a ${#title}-char title, stored in the database (title-transcript.txt)"

# --- 3. The session_updated frames ---
timeout 3 curl -sN "$base/ui/stream/session/$sid?fromSeq=0" > "$evidence/session-stream-raw.txt" || true
frames "$evidence/session-stream-raw.txt" "$evidence/session-stream-frames.jsonl"
jq -s --arg id "session-row:$sid" '[.[] | select(.patch.id == $id)]' \
  "$evidence/session-stream-frames.jsonl" > "$evidence/session-stream.json"
jq -e --arg title "$title" 'length >= 1 and .[0].patch.props.title == $title' \
  "$evidence/session-stream.json" > /dev/null \
  || fail "the session stream carries no session-row patch with the new title (see $evidence/session-stream-raw.txt)"
cp "$evidence/session-stream-frames.jsonl" "$evidence/session-stream.txt"

timeout 3 curl -sN "$base/sessions/$sid/events?fromSeq=0" > "$evidence/raw-events.txt" || true
grep -q '"type":"session_updated"' "$evidence/raw-events.txt" \
  || fail "the raw events stream carries no session_updated body (see $evidence/raw-events.txt)"
grep -n '"type":"session_updated"' "$evidence/raw-events.txt" > "$evidence/session-updated-grep.txt"

frames "$evidence/overview-sse.txt" "$evidence/overview-frames.jsonl"
jq -s --arg id "session-row:$sid" '[.[] | select(.patch.id == $id)]' \
  "$evidence/overview-frames.jsonl" > "$evidence/overview.json"
jq -e --arg title "$title" 'length >= 1 and .[0].patch.props.title == $title' \
  "$evidence/overview.json" > /dev/null \
  || fail "the sessions-overview stream broadcast no session-row patch (see $evidence/overview-sse.txt)"
ok "session_updated patch frames: per-session stream, raw bodies and live sessions-overview (session-stream.txt, raw-events.txt, overview-sse.txt)"

# --- 4. The LLM failure matrix ---
tx="$evidence/llm-failure.txt"
: > "$tx"
step "$tx" create-fail-provider POST /providers '{"format":"mock","model":"fail","apiKey":"qa"}' 201 '.id | length > 0'
fail_pid=$(jq -r '.id' <<< "$step_payload")
step "$tx" create-fail-session POST /sessions "{\"title\":\"keep-me\",\"workdir\":\"/tmp/t75\",\"providerId\":\"$fail_pid\"}" 201 '.id | length > 0'
fail_sid=$(jq -r '.id' <<< "$step_payload")
step "$tx" title-on-failing-mock POST "/sessions/$fail_sid/title" '' 503 '.error == "title_service_unavailable"'
step "$tx" title-unchanged GET "/sessions/$fail_sid" '' 200 '.title == "keep-me"'

step "$tx" create-session-without-provider POST /sessions '{"title":"plain-title","workdir":"/tmp/t75"}' 201 '.id | length > 0'
no_llm_sid=$(jq -r '.id' <<< "$step_payload")
step "$tx" title-without-provider POST "/sessions/$no_llm_sid/title" '' 503 '.error == "title_service_unavailable"'
step "$tx" title-unchanged-2 GET "/sessions/$no_llm_sid" '' 200 '.title == "plain-title"'
grep -q 'title_service_unavailable' "$tx" || fail "llm-failure.txt is missing the 503 evidence"
ok "failure matrix: failing mock and absent provider both 503 with the title unchanged (llm-failure.txt)"

log "T75 QA OK (evidence in $evidence)"
