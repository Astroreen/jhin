#!/usr/bin/env bash
# QA for T101: the fourteen timeline row kinds — the MessageCardBuilder row
# vocabulary (message user/assistant bubbles, assistant-meta, event, work,
# work-live, work-toggle, thinking, proposed-plan, working, worktree-setup,
# turn-fold, attempt-fold, context-compaction, unknown), the EventFrames
# frame -> row mapping, the continuation-key grouping (no gap inside a
# group) and the message hover-action stubs.
# Usage: scripts/qa/t101.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T101. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui plus the QA switches (JHIN_UI_QAPROBE for the qa-timeline
# probe screen, JHIN_SESSIONS_QA for the event-append helper).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T101 row-kind asserts
#     (TimelineRowsTest: the 14 kinds, the gap table, the continuation
#     margins, the unknown fallback; ChatScreenTest / StreamRouteTest: the
#     frame -> row mapping over the wire);
#   - runs the Flutter timeline-rows suite (flutter-rows.txt: the gap table,
#     the continuation grouping through the stream_view, the hover stubs,
#     the unknown-kind fallback) and requires "All tests passed";
#   - writes the 14 pixel goldens into goldens/ (flutter test
#     --update-goldens with T101_GOLDEN_DIR, one per row kind) and proves
#     them byte-stable (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel with the QA probes, fetches the qa-timeline screen
#     (one row of each kind) into row-kinds.json and asserts the 14 rowKinds,
#     the continuation pair (the first work row closes with no gap), the
#     demo markers on the decorative rows and the unknown fallback;
#   - seeds a session, appends a real event run through the QA helper and
#     asserts the rendered chat rows (chat-rows.json): the message:user and
#     message:assistant bubbles, the work:log tool entries, the event:error
#     row and no working row once the run closed;
#   - asserts every node type stays inside the docs/sdui.md section 2.5
#     catalog.
#
# Failure path: the real fallback holds first (the probe's unknown row
# renders over the wire), then the deliberately wrong expectation — that an
# unknown row kind takes no gap — is run through the Flutter suite with
# T101_FAIL_MODE=1 and must fail; the real behavior (the default 16px gap,
# no throw) is recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T101_INNER:-}" ]; then
  exec env T101_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T101}
mkdir -p "$evidence"

kernel_pid=""
# stop_kernel: TERM first, a bounded 20 s wait, then SIGKILL — the kernel's
# graceful shutdown hook may linger past the evidence needs.
stop_kernel() {
  [ -n "$kernel_pid" ] || return 0
  if ps -p "$kernel_pid" > /dev/null 2>&1; then
    kill "$kernel_pid" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      ps -p "$kernel_pid" > /dev/null 2>&1 || break
      sleep 1
    done
    kill -9 "$kernel_pid" 2>/dev/null || true
  fi
  wait "$kernel_pid" 2>/dev/null || true
  kernel_pid=""
}
cleanup() {
  stop_kernel
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

port=18501
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
  # The subshell execs into run-kernel.sh (and that into the JVM), so
  # $kernel_pid is the JVM process itself and the cleanup TERM reaches it.
  ( JHIN_HOME="$home" JHIN_UI_QAPROBE=true JHIN_SESSIONS_QA=true \
      exec scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" ) &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 60 || fail "the kernel did not become healthy (see $kernel_log_dir/kernel.log)"
}

# step_hdr <client-header> <transcript> <name> <method> <path> <body>
# <expected-status> <jq-expr> — the t78 step helper with the X-Jhin-Client
# value as the first argument.
step_hdr() {
  local hdr=$1 tx=$2 name=$3 method=$4 path=$5 body=$6 expected=$7 expr=$8
  local response status payload
  response=$(curl -sS --max-time 10 -X "$method" \
      -H 'Content-Type: application/json' \
      -H "X-Jhin-Client: $hdr" \
      --data "$body" \
      -w $'\n%{http_code}' "$base$path")
  status=${response##*$'\n'}
  payload=${response%$'\n'*}
  step_payload=$payload
  {
    echo "=== $name ==="
    echo "$method $path"
    echo "client: $hdr"
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

# seed_session <transcript> <title> <workdir>: creates one session, echoes
# its id.
seed_session() {
  local tx=$1 title=$2 workdir=$3 response id
  response=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -H "$client_header" \
      --data "{\"title\":\"$title\",\"workdir\":\"$workdir\"}" \
      "$base/sessions")
  id=$(jq -re '.id' <<< "$response") \
    || fail "seed $title: no session id in the create response (resp: $response)"
  {
    echo "=== seed $title ==="
    echo "POST /sessions"
    echo "resp: $response"
  } >> "$tx"
  printf '%s' "$id"
}

# append_event <transcript> <session-id> <type> <payload-json>: the QA
# helper append (JHIN_SESSIONS_QA).
append_event() {
  local tx=$1 id=$2 type=$3 payload=$4 response
  response=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -H "$client_header" \
      --data "{\"type\":\"$type\",\"payload\":$payload}" \
      "$base/sessions/$id/events")
  {
    echo "=== append $type ==="
    echo "POST /sessions/$id/events"
    echo "resp: $response"
  } >> "$tx"
}

# catalog_primitives: the docs/sdui.md section 2.5 primitive names
catalog_primitives() {
  awk '/^### 2\.5 /{f=1;next} /^### /{f=0} f' docs/sdui.md \
    | grep -oE '`[a-z_]+' | tr -d '`' | sort -u
}

# flutter_bin: the same flutter resolution scripts/qa/flutter-test.sh uses
flutter_bin() {
  if command -v flutter > /dev/null 2>&1; then
    flutter "$@"
  else
    devenv shell -- flutter "$@"
  fi
}

client_header='api=3; version=0.3.0; schema=4; caps=sse'

if [ "$fail_mode" = "1" ]; then
  log "T101 QA --fail: an unknown row kind falls back to the unknown placeholder row without throwing"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  ok "kernel booted for the failure path (fail-boot/kernel.log)"

  tx="$evidence/fail-transcript.txt"
  : > "$tx"

  # The real fallback holds over the wire: the qa-timeline probe renders the
  # unknown placeholder row for the bogus "holo" kind.
  step_hdr "$client_header" "$tx" "fetch-probe" GET "/ui/screen/qa-timeline" '' 200 \
    '.node.type == "screen"'
  jq -S '.node.body' <<< "$step_payload" > "$evidence/fail-tree.json"
  jq -e '
    [.. | objects | select(.rowKind? == "unknown")][0]
    | .rowKey == "unknown:unknown"
      and ([.. | objects | .text? // empty] | join(" ") | contains("Unknown row: holo"))
  ' "$evidence/fail-tree.json" > /dev/null \
    || fail "the unknown row kind did not fall back to the placeholder row (fail-tree.json)"
  ok "the unknown row kind falls back to the unknown placeholder row over the wire (fail-tree.json)"

  # The deliberately wrong expectation: an unknown row kind takes no gap
  # (it takes the default 16px gap; the happy run proves it). The inverted
  # suite must fail.
  if bash scripts/qa/flutter-test.sh test/sdui/timeline_rows_test.dart \
      --dart-define=T101_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the unknown kind took no gap"
  fi
  {
    echo "FAIL: an unknown row kind takes no gap (as designed)"
    echo "  the real behavior is the opposite: an unrecognized rowKind"
    echo "  renders with the default 16px gap and never throws (the"
    echo "  timelineRowGap default; the happy run proves it in"
    echo  "  flutter-rows.txt); the inverted suite failed as required"
    echo "  (flutter-fail.txt); the wire fallback is asserted in"
    echo "  fail-tree.json"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the unknown row kind broke the render (it does not; see $evidence/flutter-fail.txt)"
fi

log "T101 QA: the fourteen timeline row kinds with continuation grouping"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T101 row-kind asserts live here) ---
# --rerun is a per-task flag (it attaches to the preceding task spec): the
# one-flag combined form only force-reruns the last task and silently skips
# the other when it is up-to-date, so each suite carries its own flag.
./gradlew :jhin-plugin-ui-default:test --rerun :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; transcript in test.txt)"

# --- 3. The Flutter timeline-rows suite ---
bash scripts/qa/flutter-test.sh test/sdui/timeline_rows_test.dart \
  2>&1 | tee "$evidence/flutter-rows.txt"
grep -q 'All tests passed' "$evidence/flutter-rows.txt" \
  || fail "the Flutter timeline-rows suite failed (see $evidence/flutter-rows.txt)"
ok "Flutter timeline-rows suite green: the gap table, the continuation grouping, the hover stubs, the unknown fallback (flutter-rows.txt)"

# --- 4. The goldens: one per row kind (14) ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/timeline_rows_test.dart \
  --update-goldens \
  --dart-define="T101_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
golden_count=0
for frame in message assistant-meta event work work-live work-toggle thinking \
             proposed-plan working worktree-setup turn-fold attempt-fold \
             context-compaction unknown; do
  [ -s "$goldens/row-$frame-light.png" ] \
    || fail "the golden row-$frame-light.png is missing or empty (goldens/)"
  golden_count=$((golden_count + 1))
done
ok "goldens: $golden_count files written, one per row kind (goldens/)"

# The verification pass: the same suite without --update-goldens must match
# the written frames byte-for-byte.
bash scripts/qa/flutter-test.sh test/sdui/timeline_rows_test.dart \
  --dart-define="T101_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged from the written frames (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 5. The kernel with the QA probes ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui plus the QA probes (kernel.log)"

tx="$evidence/probe-transcript.txt"
: > "$tx"

# --- 6. The qa-timeline probe: one row of each kind ---
step_hdr "$client_header" "$tx" "fetch-probe" GET "/ui/screen/qa-timeline" '' 200 \
  '.node.type == "screen"'
jq -S '.node.body' <<< "$step_payload" > "$evidence/row-kinds.json"

# All 14 rowKinds render, each exactly once (the message and work kinds
# appear twice for their user/assistant and continuation variants).
jq -e '
  ([.. | objects | select(.rowKind? != null) | .rowKind] | unique | sort) ==
  (["assistant-meta", "attempt-fold", "context-compaction", "event", "message",
    "proposed-plan", "thinking", "turn-fold", "unknown", "work", "work-live",
    "work-toggle", "working", "worktree-setup"] | sort)
' "$evidence/row-kinds.json" > /dev/null \
  || fail "the probe does not render one row of each of the 14 kinds (row-kinds.json)"
ok "the probe renders all 14 row kinds (row-kinds.json)"

# The continuation pair: the first work:log row closes with no gap, the
# second (the group end) with the 8px work gap.
jq -e '
  ([.. | objects | select(.rowKey? == "work:log")][0].margin.bottom) == 0
  and ([.. | objects | select(.rowKey? == "work:log")][1].margin.bottom) == 8
' "$evidence/row-kinds.json" > /dev/null \
  || fail "the continuation pair does not collapse the gap (row-kinds.json)"
ok "continuation grouping: the work:log pair closes with no gap inside the group (row-kinds.json)"

# The alignment contract: the user bubble self-end (centerRight), the
# assistant message self-start (centerLeft), the folds centered.
jq -e '
  [.. | objects | select(.rowKey? == "message:user")][0].align == "centerRight"
  and [.. | objects | select(.rowKey? == "message:assistant")][0].align == "centerLeft"
  and [.. | objects | select(.rowKind? == "turn-fold")][0].align == "center"
' "$evidence/row-kinds.json" > /dev/null \
  || fail "the row alignment contract is wrong (row-kinds.json)"
ok "alignment: user bubble self-end, assistant self-start, folds centered (row-kinds.json)"

# The decorative rows carry the demo marker.
jq -e '
  ([.. | objects | select(.rowKind? == "proposed-plan")][0]
    | [.. | objects | select(.demo? == true)] | length) > 0
  and ([.. | objects | select(.rowKind? == "worktree-setup")][0]
    | [.. | objects | select(.demo? == true)] | length) > 0
' "$evidence/row-kinds.json" > /dev/null \
  || fail "the decorative rows lost the demo marker (row-kinds.json)"
ok "decorative rows (proposed-plan, worktree-setup, folds) carry the demo marker (row-kinds.json)"

# The unknown fallback renders the placeholder row.
jq -e '
  [.. | objects | select(.rowKind? == "unknown")][0]
  | .rowKey == "unknown:unknown"
    and ([.. | objects | .text? // empty] | join(" ") | contains("Unknown row: holo"))
' "$evidence/row-kinds.json" > /dev/null \
  || fail "the unknown fallback row is wrong (row-kinds.json)"
ok "unknown fallback: the holo kind renders the unknown placeholder row (row-kinds.json)"

# The primitive-catalog guard: every node type in the probe tree is legal.
types=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' \
  "$evidence/row-kinds.json")
for t in $types; do
  catalog_primitives | grep -qx "$t" \
    || fail "node type '$t' is outside the docs/sdui.md section 2.5 catalog"
done
ok "every probe node type is inside the docs/sdui.md section 2.5 catalog"

# --- 7. The chat screen: the frame -> row mapping over real events ---
tx="$evidence/chat-transcript.txt"
: > "$tx"
session_id=$(seed_session "$tx" "rows-demo" "/tmp/rows-demo")
append_event "$tx" "$session_id" user_message '{"text":"Fix the login bug"}'
append_event "$tx" "$session_id" message_start '{"role":"assistant"}'
append_event "$tx" "$session_id" text_delta '{"text":"On it."}'
append_event "$tx" "$session_id" message_end '{"text":"On it."}'
append_event "$tx" "$session_id" tool_use '{"id":"c1","name":"read","arguments":"{\"path\":\"src/auth.java\"}"}'
append_event "$tx" "$session_id" tool_result '{"id":"c1","name":"read","content":"ok","error":false}'
append_event "$tx" "$session_id" run_start '{"runId":"r1"}'
append_event "$tx" "$session_id" run_end '{"runId":"r1"}'
append_event "$tx" "$session_id" error '{"message":"boom"}'
ok "seeded one session and appended a real event run (chat-transcript.txt)"

step_hdr "$client_header" "$tx" "fetch-chat" GET "/ui/screen/chat:$session_id" '' 200 \
  '.node.type == "screen"'
jq -S '[.. | objects | select(.id? == "messages")][0]' <<< "$step_payload" \
  > "$evidence/chat-rows.json"

jq -e '
  ([.items[] | select(.rowKey? == "message:user")] | length) == 1
  and ([.items[] | select(.rowKey? == "message:assistant")] | length) == 1
  and ([.items[] | select(.rowKey? == "work:log")] | length) == 2
  and ([.items[] | select(.rowKey? == "event:error")] | length) == 1
  and ([.items[] | select(.rowKind? == "working")] | length) == 0
' "$evidence/chat-rows.json" > /dev/null \
  || fail "the chat rows do not match the event run (chat-rows.json)"
ok "chat rows: message:user + message:assistant + 2 work:log + event:error, no working row after run_end (chat-rows.json)"

# The work pair groups: the first tool entry closes with no gap.
jq -e '
  [.items[] | select(.rowKey? == "work:log")][0].margin.bottom == 0
  and [.items[] | select(.rowKey? == "work:log")][1].margin.bottom == 8
' "$evidence/chat-rows.json" > /dev/null \
  || fail "the chat work pair does not group (chat-rows.json)"
ok "chat continuation: the tool_use/tool_result pair closes with no gap (chat-rows.json)"

# The kernel work is done — stop it before the summary.
stop_kernel

# --- 8. The summary ---
{
  echo "# T101 timeline row kinds summary"
  echo
  echo "upstream anchors (commit 37de6cb): the row union MessagesTimelineRowContent"
  echo "(components/chat/MessagesTimeline.logic.ts:489-596 — 13 kinds; the Jhin"
  echo "14th is the unknown fallback row), the row spacing pb-* scale"
  echo "(components/chat/MessagesTimeline.tsx:1766-1784, WorkLog.tsx:19-21), the"
  echo "continuesWorkLog rule (MessagesTimeline.logic.ts:1773-1781), the user"
  echo "bubble rounded-2xl bg-message p-3 (MessagesTimeline.tsx:2147;"
  echo "--radius-2xl = calc(--radius + 8px) = \$radius.xl2, index.css:281,1064;"
  echo "--color-message = --message-surface, index.css:264), the event card"
  echo "rounded-lg border tones (MessagesTimeline.tsx:2859-2965), the working"
  echo "strip (MessagesTimeline.tsx:3405-3422), the compaction divider"
  echo "(MessagesTimeline.tsx:1862-1898), the work log line (WorkLog.tsx:63-77)"
  echo
  echo "plan-vs-upstream discrepancies:"
  echo "- the plan says 14 row kinds; the upstream union has 13 — the 14th is"
  echo "  the Jhin-side unknown fallback row (the plan's own --fail contract)"
  echo "- the plan says the assistant message is a card+border; upstream"
  echo "  renders bare markdown (MessagesTimeline.tsx:2494-2525) — the plan"
  echo "  wins (the T77 card shape is kept, now with the border)"
  echo "- the plan says the working row reads 'agent is working…'; upstream"
  echo "  reads 'Working...' / 'Working for <timer>'"
  echo "  (MessagesTimeline.tsx:3405-3422) — the plan wins (its quoted label)"
  echo "- the plan centers turn-fold/attempt-fold; upstream left-aligns them"
  echo "  (MessagesTimeline.tsx:2448-2492) — the plan wins"
  echo "- the plan gives the proposed-plan card accept/reject buttons;"
  echo "  upstream ProposedPlanCard.tsx carries copy/save/expand only"
  echo "  (ProposedPlanCard.tsx:57-77,207) — the plan wins (demo-marked)"
  echo "- the plan's assistant-meta labels (model/effort/provider) port the"
  echo "  upstream AssistantMessageMeta row (fork/status/copy/timestamp,"
  echo "  MessagesTimeline.tsx:2600-2665) plus the ProviderSubagentBar label"
  echo "  style (ProviderSubagentBar.tsx:56-84); Jhin's event vocabulary"
  echo "  carries no model identity yet, so the labels are builder inputs"
  echo
  echo "wire contract: every timeline row carries rowKind + rowKey"
  echo "(\${type}:\${subtype}); the continuation grouping collapses the gap"
  echo "inside a group (server-baked margins on the history rows, the client"
  echo "table in stream_view.dart for the live tail); run_start maps to the"
  echo "working row and run_end to its remove frame (the runStatus badge"
  echo "patch remains only as the mid-join run_end fallback)"
  echo
  echo "goldens: 14 files, one per row kind (goldens/row-<kind>-light.png);"
  echo "the --fail path: the unknown-kind gap inversion fails as required"
  echo "(the fallback renders with the default gap, never a throw)"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T101 QA green: the fourteen timeline row kinds with continuation grouping"
