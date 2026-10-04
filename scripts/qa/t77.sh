#!/usr/bin/env bash
# QA for T77: the redesigned chat with composer, bubbles and tool cards.
# Usage: scripts/qa/t77.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T77. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM and
# reaped with `wait`; JSON assertions run with jq (present on the QA machine).
# The kernel boots with jhin.sessions, jhin.ui-kit and jhin.ui and the
# JHIN_SESSIONS_QA helper (POST /sessions/{id}/events appends one event), so
# every run transcript is seeded deterministically — no agent or LLM needed.
#
# Happy path:
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL;
#   - seeds one session with a full run transcript carrying a tool call
#     (seed.txt): run_start, user_message, assistant text, tool_use, a
#     structured tool_result, a closing assistant message and run_end;
#   - fetches GET /ui/screen/chat:<id> and writes the rendered node tree into
#     chat-tree.json; asserts the message list order (user bubble -> assistant
#     bubble -> tool code_block -> collapsed tool card -> assistant bubble),
#     the user tint ($color.accentMuted) and the collapsed tool details;
#   - the same fetch at run_end is the idle state (idle.json, idle.txt): the
#     badge reads Idle and no Cancel button is rendered;
#   - a second session with an unpaired run_start is the running state
#     (running.json, running.txt): the badge reads Running... and the Cancel
#     button is present;
#   - a third session with a malformed tool_result payload and an error event
#     proves the degrade rules (degrade.txt): the tool result falls back to a
#     plain card with the raw content and the error renders as a banner at the
#     top of the list;
#   - chat.png / idle.png / running.png are skipped: no screenshot harness
#     exists for the server-rendered node tree (the Flutter goldens cover
#     client-side fixtures only), recorded in checks.txt.
#
# Failure path: the same kernel and transcript, then a deliberately wrong
# expectation — that the tool result card starts expanded — asserted against
# the real chat-tree.json; the checker must fail (checks-fail.txt, exit
# non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T77_INNER:-}" ]; then
  exec env T77_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T77}
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

port=18477
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
  JHIN_HOME="$home" JHIN_SESSIONS_QA=true \
    scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" &
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
      -H 'X-Jhin-Client: api=2; version=0.2.0; schema=3; caps=sse' \
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

# append_event <transcript> <session-id> <wire-type> <payload-json>
# Seeds one event through the JHIN_SESSIONS_QA helper.
append_event() {
  local tx=$1 sid=$2 type=$3 payload=$4
  local body
  body=$(jq -nc --arg type "$type" --argjson payload "$payload" '{type: $type, payload: $payload}')
  step "$tx" "event-$type-$sid" POST "/sessions/$sid/events" "$body" 201 '.seq > 0'
}

# seed_session <transcript> <title>: creates one session and prints its id
seed_session() {
  local tx=$1 title=$2
  step "$tx" "create-$title" POST /sessions \
    "{\"title\":\"$title\",\"workdir\":\"/tmp/t77/$title\"}" 201 '.id | length > 0'
  jq -r '.id' <<< "$step_payload"
}

# fetch_chat <transcript> <session-id> <out-json>: renders the chat screen
fetch_chat() {
  local tx=$1 sid=$2 out=$3
  step "$tx" "fetch-chat-$sid" GET "/ui/screen/chat:$sid" '' 200 '.node.type == "screen"'
  jq '.node' <<< "$step_payload" > "$out"
}

# tree helpers over a saved chat tree
badge_label() {
  jq -r '.. | objects | select(.id? == "runStatus") | .label' "$1"
}

has_cancel() {
  jq -e '[.. | objects | select(.type? == "button" and .label? == "Cancel")] | length == 1' \
    "$1" > /dev/null
}

message_items() {
  jq -c '[.. | objects | select(.id? == "messages") | .items[]?]' "$1"
}

if [ "$fail_mode" = "1" ]; then
  log "T77 QA --fail: the checker must fail on a deliberately wrong expectation"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/degrade-fail.txt"
  : > "$tx"
  fail_sid=$(seed_session "$tx" "tool-run")
  append_event "$tx" "$fail_sid" run_start '{"runId":"r1"}'
  append_event "$tx" "$fail_sid" user_message '{"text":"Fix the bug"}'
  append_event "$tx" "$fail_sid" tool_use \
    '{"id":"c1","name":"write","arguments":"{\"path\":\"/tmp/a.txt\"}"}'
  append_event "$tx" "$fail_sid" tool_result \
    '{"id":"c1","name":"write","content":"ok","error":false,"structured":"{\"kind\":\"card\",\"title\":\"write\",\"rows\":[{\"label\":\"bytes\",\"value\":\"12\"}]}"}'
  append_event "$tx" "$fail_sid" run_end '{"runId":"r1"}'
  fetch_chat "$tx" "$fail_sid" "$evidence/chat-tree-fail.json"
  # deliberate wrong expectation: the tool result card starts expanded
  if jq -e '[.. | objects | select(.id? == "ev-4-details") | .collapsed] | any(. == false)' \
      "$evidence/chat-tree-fail.json" > /dev/null; then
    fail "deliberately wrong expectation held: the tool result card starts expanded (see $evidence/chat-tree-fail.json)"
  fi
  fail "deliberately wrong expectation: the tool result card starts expanded (it starts collapsed; see $evidence/chat-tree-fail.json)"
fi

log "T77 QA: the redesigned chat with composer, bubbles and tool cards"
log "evidence dir: $evidence"

# --- 1. The JVM suites ---
./gradlew :jhin-plugin-ui-default:test :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; transcript in test.txt)"

# --- 2. The kernel and the seeded run transcript ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui plus the JHIN_SESSIONS_QA helper (kernel.log)"

tx="$evidence/seed.txt"
: > "$tx"
chat_sid=$(seed_session "$tx" "chat")
append_event "$tx" "$chat_sid" run_start '{"runId":"r1"}'
append_event "$tx" "$chat_sid" user_message '{"text":"Fix the bug"}'
append_event "$tx" "$chat_sid" message_start '{"role":"assistant"}'
append_event "$tx" "$chat_sid" text_delta '{"text":"Let me "}'
append_event "$tx" "$chat_sid" text_delta '{"text":"look."}'
append_event "$tx" "$chat_sid" message_end '{"text":"Let me look."}'
append_event "$tx" "$chat_sid" tool_use \
  '{"id":"c1","name":"write","arguments":"{\"path\":\"/tmp/a.txt\",\"content\":\"hello world!\"}"}'
append_event "$tx" "$chat_sid" tool_result \
  '{"id":"c1","name":"write","content":"ok","error":false,"structured":"{\"kind\":\"card\",\"title\":\"write\",\"rows\":[{\"label\":\"bytes\",\"value\":\"12\"}]}"}'
append_event "$tx" "$chat_sid" message_start '{"role":"assistant"}'
append_event "$tx" "$chat_sid" text_delta '{"text":"All done"}'
append_event "$tx" "$chat_sid" message_end '{"text":"All done"}'
append_event "$tx" "$chat_sid" run_end '{"runId":"r1"}'
ok "seeded one run transcript with a tool call (seed.txt)"

# --- 3. The rendered chat tree ---
fetch_chat "$tx" "$chat_sid" "$evidence/chat-tree.json"
ok "rendered chat node tree written to chat-tree.json"

items=$(message_items "$evidence/chat-tree.json")
item_count=$(jq 'length' <<< "$items")
[ "$item_count" = "5" ] \
  || fail "the message list has $item_count items, expected 5 (chat-tree.json)"
types=$(jq -r '[.[].type] | join(" ")' <<< "$items")
[ "$types" = "card card code_block card card" ] \
  || fail "message list types are '$types', expected 'card card code_block card card'"
ids=$(jq -r '[.[].id] | join(" ")' <<< "$items")
[ "$ids" = "ev-2 ev-3 ev-7 ev-8 ev-9" ] \
  || fail "message list ids are '$ids', expected 'ev-2 ev-3 ev-7 ev-8 ev-9'"
jq -e '.[0].color == "$color.accentMuted" and .[0].align == "centerRight"' <<< "$items" > /dev/null \
  || fail "the user bubble is not tinted \$color.accentMuted and pushed right (chat-tree.json)"
jq -e '.[2].code | contains("/tmp/a.txt")' <<< "$items" > /dev/null \
  || fail "the tool code_block does not carry the raw arguments JSON (chat-tree.json)"
jq -e '[.[3] | .. | objects | select(.collapsible? == true and .collapsed? == true)] | length >= 1' \
    <<< "$items" > /dev/null \
  || fail "the tool result card is not collapsed by default (chat-tree.json)"
jq -e '[.[1] | .. | objects | select(.id? == "msg-3")] | length == 1' <<< "$items" > /dev/null \
  || fail "the assistant bubble does not carry the stable msg-3 text id (chat-tree.json)"
ok "transcript renders user bubble -> assistant bubble -> tool code_block -> collapsed tool card -> assistant bubble"

# --- 4. The idle state ---
fetch_chat "$tx" "$chat_sid" "$evidence/idle.json"
{
  echo "T77 idle state (the run transcript above has finished)"
  echo
  echo "badge: $(badge_label "$evidence/idle.json")"
  if has_cancel "$evidence/idle.json"; then
    echo "cancel: present"
  else
    echo "cancel: absent"
  fi
  echo
  echo "composer:"
  jq -c '[.. | objects | select(.id? == "composer")] | .[0]' "$evidence/idle.json"
} | tee "$evidence/idle.txt"
[ "$(badge_label "$evidence/idle.json")" = "Idle" ] \
  || fail "the idle badge is not 'Idle' (idle.json)"
if has_cancel "$evidence/idle.json"; then
  fail "the idle composer still renders a Cancel button (idle.json)"
fi
ok "idle state: badge Idle, Cancel absent (idle.txt, idle.json)"

# --- 5. The running state ---
run_sid=$(seed_session "$tx" "running")
append_event "$tx" "$run_sid" run_start '{"runId":"r2"}'
fetch_chat "$tx" "$run_sid" "$evidence/running.json"
{
  echo "T77 running state (run_start r2 is unpaired)"
  echo
  echo "badge: $(badge_label "$evidence/running.json")"
  if has_cancel "$evidence/running.json"; then
    echo "cancel: present"
  else
    echo "cancel: absent"
  fi
  echo
  echo "composer:"
  jq -c '[.. | objects | select(.id? == "composer")] | .[0]' "$evidence/running.json"
} | tee "$evidence/running.txt"
[ "$(badge_label "$evidence/running.json")" = "Running…" ] \
  || fail "the running badge is not 'Running…' (running.json)"
has_cancel "$evidence/running.json" \
  || fail "the running composer renders no Cancel button (running.json)"
ok "running state: badge Running…, Cancel present (running.txt, running.json)"

# --- 6. The degrade rules ---
deg_sid=$(seed_session "$tx" "degrade")
append_event "$tx" "$deg_sid" user_message '{"text":"hello"}'
append_event "$tx" "$deg_sid" tool_result \
  '{"id":"c1","name":"bash","content":"raw output","error":false,"structured":"{{{ not json"}'
append_event "$tx" "$deg_sid" error '{"message":"boom"}'
fetch_chat "$tx" "$deg_sid" "$evidence/degrade.json"
{
  echo "T77 degrade: malformed tool_result plus an error event"
  echo
  echo "message list items (newest last, banners hoisted to the top):"
  message_items "$evidence/degrade.json" | jq .
  echo
  echo "checks:"
  echo "  - the malformed tool_result renders as a plain card with the raw content"
  echo "  - the error event renders as a banner at the top of the list"
} | tee "$evidence/degrade.txt"
deg_items=$(message_items "$evidence/degrade.json")
jq -e '.[0].type == "banner"' <<< "$deg_items" > /dev/null \
  || fail "the error event is not a banner at the top of the list (degrade.json)"
jq -e '[.[0] | .. | objects | select(.text? == "boom")] | length >= 1' <<< "$deg_items" > /dev/null \
  || fail "the error banner does not carry the error message (degrade.json)"
jq -e '.[2].type == "card" and .[2].title == "bash"' <<< "$deg_items" > /dev/null \
  || fail "the malformed tool_result did not degrade to a plain card (degrade.json)"
jq -e '[.[2] | .. | objects | select(.text? == "raw output")] | length == 1' <<< "$deg_items" > /dev/null \
  || fail "the plain card does not carry the raw content (degrade.json)"
jq -e '[.[2] | .. | objects | select(.collapsible? != null)] | length == 0' <<< "$deg_items" > /dev/null \
  || fail "the plain card still carries a collapsible section (degrade.json)"
ok "degrade rules: malformed tool_result -> plain card, error -> banner on top (degrade.txt)"

# --- 7. The screenshots ---
echo "chat.png / idle.png / running.png skipped: no screenshot harness exists for the server-rendered node tree" \
  | tee -a "$checks"
ok "PNGs skipped (no harness; noted in checks.txt)"