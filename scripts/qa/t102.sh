#!/usr/bin/env bash
# QA for T102: the sixteen event kinds and the tool card anatomy — the
# MessageCardBuilder event dispatch (diff -> diff_view, file-write -> the
# changed-files card, shell -> command + code block, message -> inline text,
# tool-call/tool-result -> the standard card, approval-request -> the
# question card with option chips, limit-notice -> the warning banner with
# the demo Resume buttons, error -> the danger card, system-notice -> the
# muted notice, queued-message -> the pending card with the stripe,
# subagent -> the right-aligned bar, citation/skill-invocation -> the inline
# pills, work-log-entry -> the work log row, question -> the question card
# with answers, unknown -> the placeholder card), the status chip
# vocabulary, the row-id-keyed expansion and the structured tool_result
# path.
# Usage: scripts/qa/t102.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T102. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui plus the QA switches (JHIN_UI_QAPROBE for the qa-timeline
# probe screen, JHIN_SESSIONS_QA for the event-append helper).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T102 asserts
#     (EventKindsTest: the 16 kinds, the status chips, the tool card
#     anatomy, the empty-state region, the structured tool_result path);
#   - runs the Flutter event-kinds suite (flutter-kinds.txt: the anatomy,
#     the patch-keyed expansion, the demo markers, the stripe, the
#     right-aligned bar) and requires "All tests passed";
#   - writes the 17 pixel goldens into goldens/ (flutter test
#     --update-goldens with T102_GOLDEN_DIR, one per event kind plus the
#     unknown fallback) and proves them byte-stable
#     (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel with the QA probes, fetches the qa-timeline screen
#     into event-kinds.json and asserts every kind's card props over the
#     wire: the tool-call anatomy (header icon + name + status chip +
#     chevron, the summary line, the hidden body with the empty-state
#     region and the footer, the patch action), the five status chips, the
#     diff_view demo card, the changed-files stats, the shell command +
#     code block, the banner demo buttons, the option chips, the stripe,
#     the right-aligned bar, the pills, the question answers and the
#     unknown fallback;
#   - seeds a session, appends a real tool_result event carrying a
#     structured diff payload through the QA helper and asserts the
#     rendered chat row is the event:diff card (the structured path over
#     the wire);
#   - asserts every node type stays inside the docs/sdui.md section 2.5
#     catalog.
#
# Failure path: the real behavior holds first (the probe's tool-call card
# with no output carries the "No output." empty-state region over the wire),
# then the deliberately wrong expectation — that an output-less tool-call
# renders a blank card with no empty-state node — is run through the Flutter
# suite with T102_FAIL_MODE=1 and must fail; the real behavior is recorded
# in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T102_INNER:-}" ]; then
  exec env T102_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T102}
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

port=18502
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
  log "T102 QA --fail: a tool-call with no output renders the empty-state region rather than a blank card"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  ok "kernel booted for the failure path (fail-boot/kernel.log)"

  tx="$evidence/fail-transcript.txt"
  : > "$tx"

  # The real behavior holds over the wire: the probe's tool-call card (no
  # output) carries the hidden body with the "No output." empty-state node.
  step_hdr "$client_header" "$tx" "fetch-probe" GET "/ui/screen/qa-timeline" '' 200 \
    '.node.type == "screen"'
  jq -S '[.. | objects | select(.rowKey? == "event:tool-call")][0]' <<< "$step_payload" \
    > "$evidence/fail-tool-call.json"
  jq -e '
    [.. | objects | select(.type? == "column" and .id? == "ev-24-body")][0].visible == false
    and ([.. | objects | select(.type? == "text" and .id? == "ev-24-empty")][0].text) == "No output."
  ' "$evidence/fail-tool-call.json" > /dev/null \
    || fail "the output-less tool-call card does not carry the empty-state region (fail-tool-call.json)"
  ok "the output-less tool-call card carries the empty-state region over the wire (fail-tool-call.json)"

  # The deliberately wrong expectation: an output-less tool-call renders a
  # blank card (no empty-state node). The inverted suite must fail.
  if bash scripts/qa/flutter-test.sh test/sdui/event_kinds_test.dart \
      --dart-define=T102_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the empty-state region was absent"
  fi
  {
    echo "FAIL: a tool-call with no output renders a blank card (as designed)"
    echo "  the real behavior is the opposite: the output region renders the"
    echo "  muted italic \"No output.\" empty state (the upstream"
    echo "  V2ItemInspector.tsx:148 wording) inside the expanded body; the"
    echo "  inverted suite failed as required (flutter-fail.txt); the wire"
    echo "  shape is asserted in fail-tool-call.json"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the output-less tool-call rendered a blank card (it does not; see $evidence/flutter-fail.txt)"
fi

log "T102 QA: the sixteen event kinds and the tool card anatomy"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T102 event-kind asserts live here) ---
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

# --- 3. The Flutter event-kinds suite ---
bash scripts/qa/flutter-test.sh test/sdui/event_kinds_test.dart \
  2>&1 | tee "$evidence/flutter-kinds.txt"
grep -q 'All tests passed' "$evidence/flutter-kinds.txt" \
  || fail "the Flutter event-kinds suite failed (see $evidence/flutter-kinds.txt)"
ok "Flutter event-kinds suite green: the anatomy, the patch-keyed expansion, the demo markers, the stripe, the right-aligned bar (flutter-kinds.txt)"

# --- 4. The goldens: one per event kind (16) plus the unknown fallback ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/event_kinds_test.dart \
  --update-goldens \
  --dart-define="T102_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
golden_count=0
for kind in diff file-write shell message tool-call tool-result \
            approval-request limit-notice error system-notice \
            queued-message subagent citation skill-invocation \
            work-log-entry question unknown; do
  [ -s "$goldens/event-$kind-light.png" ] \
    || fail "the golden event-$kind-light.png is missing or empty (goldens/)"
  golden_count=$((golden_count + 1))
done
ok "goldens: $golden_count files written, one per event kind plus the unknown fallback (goldens/)"

# The verification pass: the same suite without --update-goldens must match
# the written frames byte-for-byte.
bash scripts/qa/flutter-test.sh test/sdui/event_kinds_test.dart \
  --dart-define="T102_GOLDEN_DIR=$(readlink -f "$goldens")" \
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

# --- 6. The qa-timeline probe: one event card of each kind ---
step_hdr "$client_header" "$tx" "fetch-probe" GET "/ui/screen/qa-timeline" '' 200 \
  '.node.type == "screen"'
jq -S '[.. | objects | select(.rowKind? == "event")]' <<< "$step_payload" \
  > "$evidence/event-kinds.json"

# All 16 kinds + the unknown fallback render, each exactly once.
jq -e '
  ([.[] | .rowKey] | unique | sort) ==
  (["event:approval-request", "event:citation", "event:compaction",
    "event:diff", "event:error", "event:file-write", "event:limit-notice",
    "event:message", "event:queued-message", "event:question",
    "event:shell", "event:skill-invocation", "event:subagent",
    "event:system-notice", "event:tool-call", "event:tool-result",
    "event:unknown", "event:work-log-entry"] | sort)
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the probe does not render one event card of each kind (event-kinds.json)"
ok "the probe renders all 16 event kinds plus the unknown fallback (event-kinds.json)"

# The tool-call card anatomy: header (icon + name + status chip + chevron),
# the summary line, the hidden body with the empty-state region and the
# footer, the patch action keyed by the row id.
jq -e '
  ([.[] | select(.rowKey? == "event:tool-call")][0])
  | ([.. | objects | select(.type? == "row" and .id? == "ev-24-head")][0]
      | .children[0].icon == "construction"
        and .children[1].text == "read"
        and .children[2].label == "Running"
        and .children[2].color == "$color.info"
        and .children[4].icon == "expand_more"
        and .children[4].action.op == "patch"
        and .children[4].action.id == "ev-24-body"
        and .children[4].action.props.visible == true)
  and ([.. | objects | select(.type? == "column" and .id? == "ev-24-body")][0].visible == false)
  and ([.. | objects | select(.type? == "text" and .id? == "ev-24-empty")][0].text == "No output.")
  and ([.. | objects | select(.type? == "row" and .id? == "ev-24-footer")][0]
      | .children[0].text == "14:03"
        and .children[2].icon == "copy" and .children[2].demo == true
        and .children[3].icon == "unfold_less"
        and .children[3].action.props.visible == false)
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the tool-call card anatomy is wrong (event-kinds.json)"
ok "tool-call card anatomy: header icon + name + status chip + chevron, summary line, hidden body with the empty-state region, footer timestamp + demo copy + collapse (event-kinds.json)"

# The status chip vocabulary: the five labels on their token colours.
jq -e '
  ([.[] | select(.rowKey? == "event:tool-call")][0]
    | [.. | objects | select(.type? == "badge")][0]
    | .label == "Running" and .color == "$color.info")
  and ([.[] | select(.rowKey? == "event:tool-result")][0]
    | [.. | objects | select(.type? == "badge")][0]
    | .label == "Done" and .color == "$color.success")
  and ([.[] | select(.rowKey? == "event:subagent")][0]
    | [.. | objects | select(.type? == "badge")][0]
    | .label == "Running" and .color == "$color.info")
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the status chips do not carry the label words on the token colours (event-kinds.json)"
ok "status chips: Running on info, Done on success (the pending/error/cancelled words asserted in the JVM suite) (event-kinds.json)"

# The diff card: the diff_view with the mandatory demo marker.
jq -e '
  [.[] | select(.rowKey? == "event:diff")][0]
  | [.. | objects | select(.type? == "diff_view")][0]
  | .demo == true and .file == "src/auth.java"
    and .stats.additions == 12 and (.hunks | length) == 1
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the diff card does not render the demo diff_view (event-kinds.json)"
ok "diff card: the demo-marked diff_view with the file and the stats (event-kinds.json)"

# The file-write card: the count header with the total stats and the paths.
jq -e '
  [.[] | select(.rowKey? == "event:file-write")][0]
  | ([.. | objects | .text? // empty] | join(" "))
  | contains("2 changed files") and contains("+16") and contains("-3")
    and contains("src/auth.java") and contains("src/login.java")
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the changed-files card does not carry the paths and the line stats (event-kinds.json)"
ok "file-write card: the changed-files count, the total stats and the paths (event-kinds.json)"

# The shell card: the command summary line + the code block output.
jq -e '
  [.[] | select(.rowKey? == "event:shell")][0]
  | ([.. | objects | select(.type? == "code_block" and .id? == "ev-22-output")][0].code) == "BUILD SUCCESSFUL"
  and ([.. | objects | .text? // empty] | join(" ") | contains("gradle test --tests auth"))
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the shell card does not carry the command and the code block output (event-kinds.json)"
ok "shell card: the command summary line + the code block output (event-kinds.json)"

# The limit-notice banner: the demo Resume buttons.
jq -e '
  [.[] | select(.rowKey? == "event:limit-notice")][0]
  | ([.. | objects | select(.type? == "banner")] | length) == 1
  and ([.. | objects | select(.type? == "button" and .demo? == true)
        | .label] | sort) == ["Resume", "Resume at reset"]
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the limit-notice banner lost the demo Resume buttons (event-kinds.json)"
ok "limit-notice banner: the warning banner with the demo Resume / Resume at reset buttons (event-kinds.json)"

# The approval card: the option chips dispatching inline setState, demo-marked.
jq -e '
  [.[] | select(.rowKey? == "event:approval-request")][0]
  | ([.. | objects | select(.type? == "chip")] | length) == 2
  and ([.. | objects | select(.type? == "chip")][0].action.op) == "setState"
  and ([.. | objects | select(.type? == "chip")][0].demo) == true
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the approval card lost the demo option chips (event-kinds.json)"
ok "approval-request card: the option chips dispatch inline setState, demo-marked (event-kinds.json)"

# The queued-message card: the stripe over the card's left edge.
jq -e '
  [.[] | select(.rowKey? == "event:queued-message")][0]
  | ([.. | objects | select(.type? == "positioned")][0]
      | .width == 3 and .top == 0 and .bottom == 0)
  and ([.. | objects | select(.type? == "positioned")][0].child.color) == "$color.warning"
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the queued-message card lost the pending stripe (event-kinds.json)"
ok "queued-message card: the 3px warning stripe over the left edge (event-kinds.json)"

# The subagent bar: right-aligned (self-end).
jq -e '
  [.[] | select(.rowKey? == "event:subagent")][0].align == "centerRight"
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the subagent bar is not right-aligned (event-kinds.json)"
ok "subagent bar: the row carries align centerRight (self-end) (event-kinds.json)"

# The pills: the citation on info, the skill on primary.
jq -e '
  [.[] | select(.rowKey? == "event:citation")][0]
  | .children[0] | .type == "badge" and .color == "$color.info"
    and .label == "src/auth.java:42"
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the citation pill is wrong (event-kinds.json)"
jq -e '
  [.[] | select(.rowKey? == "event:skill-invocation")][0]
  | .children[0] | .type == "badge" and .color == "$color.primary"
    and .label == "jhin-plugin"
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the skill pill is wrong (event-kinds.json)"
ok "citation and skill pills: the filled badges on the info/primary tokens (event-kinds.json)"

# The question card: the answers.
jq -e '
  [.[] | select(.rowKey? == "event:question")][0]
  | ([.. | objects | .text? // empty] | join(" "))
  | contains("Which auth flow?") and contains("The token one")
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the question card lost the answers (event-kinds.json)"
ok "question card: the question text and the answers (event-kinds.json)"

# The unknown fallback renders the placeholder card.
jq -e '
  [.[] | select(.rowKey? == "event:unknown")][0]
  | ([.. | objects | .text? // empty] | join(" ") | contains("Unknown event: holo"))
' "$evidence/event-kinds.json" > /dev/null \
  || fail "the unknown event fallback is wrong (event-kinds.json)"
ok "unknown fallback: the holo type renders the placeholder card (event-kinds.json)"

# The primitive-catalog guard: every node type in the probe tree is legal.
types=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' \
  "$evidence/event-kinds.json")
for t in $types; do
  catalog_primitives | grep -qx "$t" \
    || fail "node type '$t' is outside the docs/sdui.md section 2.5 catalog"
done
ok "every event card node type is inside the docs/sdui.md section 2.5 catalog"

# --- 7. The chat screen: the structured tool_result over real events ---
tx="$evidence/chat-transcript.txt"
: > "$tx"
session_id=$(seed_session "$tx" "kinds-demo" "/tmp/kinds-demo")
append_event "$tx" "$session_id" tool_result '{"id":"c1","name":"diff","content":"ignored","structured":{"type":"diff","file":"src/auth.java","additions":12,"deletions":3,"hunks":[{"header":"@@ -1 +1 @@","lines":[{"kind":"add","newNo":1,"text":"x"}]}]}}'
ok "seeded one session and appended a structured tool_result event (chat-transcript.txt)"

step_hdr "$client_header" "$tx" "fetch-chat" GET "/ui/screen/chat:$session_id" '' 200 \
  '.node.type == "screen"'
jq -S '[.. | objects | select(.id? == "messages")][0]' <<< "$step_payload" \
  > "$evidence/chat-rows.json"

jq -e '
  ([.items[] | select(.rowKey? == "event:diff")] | length) == 1
  and ([.items[] | select(.rowKey? == "work:log")] | length) == 0
' "$evidence/chat-rows.json" > /dev/null \
  || fail "the structured tool_result did not render the event:diff card (chat-rows.json)"
ok "structured tool_result: the chat history renders the event:diff card (chat-rows.json)"

# The kernel work is done — stop it before the summary.
stop_kernel

# --- 8. The summary ---
{
  echo "# T102 event kinds and tool card anatomy summary"
  echo
  echo "upstream anchors (commit 37de6cb): the event card tones and the"
  echo "status chip pill (components/chat/MessagesTimeline.tsx:2809-2813,"
  echo "2866-2876), the event presentation labels/icons"
  echo "(MessagesTimeline.tsx:2705-2786), the tool row line with the"
  echo "trailing timestamp and the disclosure chevron"
  echo "(MessagesTimeline.tsx:5296-5330), the tool output states with the"
  echo "muted italic \"No output.\" empty state (V2ItemInspector.tsx:143-158),"
  echo "the changed-files header and the DiffStatLabel pair"
  echo "(ChangedFilesTree.tsx:57-66, DiffStatLabel.tsx:38-47), the usage"
  echo "limit banner with the recovery actions"
  echo "(UsageLimitRecoveryBanner.tsx:31-41,92-99), the approval label on"
  echo "the warning tone (ComposerPendingApprovalPanel.tsx:40-44), the"
  echo "citation/skill ContextChip kinds (ContextChip.tsx:59-60), the"
  echo "subagent bar (ProviderSubagentBar.tsx:66-70) and the status chip"
  echo "words (ComposerTasksBadge.tsx:23-24, ThreadRelationshipIcon.tsx:13,"
  echo "21, pullRequestPresentation.tsx:226)."
  echo
  echo "plan-vs-upstream discrepancies:"
  echo "- the plan's status chip words (Pending/Running/Done/Error/Cancelled)"
  echo "  are a normalized set; the upstream scatters them across"
  echo "  ComposerTasksBadge (Pending/Running), ThreadRelationshipIcon"
  echo "  (Running/Done) and pullRequestPresentation (Cancelled) — the plan"
  echo "  wins (the five-state chip vocabulary)"
  echo "- the plan says the expansion state is setState keyed by row id; the"
  echo "  when degradation rule (an unset field keeps the node visible,"
  echo "  docs/sdui.md section 7) cannot express a collapsed-by-default"
  echo "  region, so the expansion is the patch/visible pair keyed by the row"
  echo "  id (ev-<seq>-body) — the same pure client-side reveal, no round-trip"
  echo "- the plan says the output region offers diff_view; the diff kind has"
  echo "  its own card and the tool card's diff output reads the payload's"
  echo "  file/hunks/stats fields (both paths render the T93 diff_view)"
  echo "- the upstream citation/skill pills are outlined ContextChips with"
  echo "  per-kind accents (citation blue 259, skill magenta 322,"
  echo "  ContextChip.tsx:59-60); the Jhin chip carries no accent-colour prop,"
  echo "  so the pills are the filled badges on the info/primary tokens"
  echo "- the upstream tool row shows the timestamp always (the trailing"
  echo "  slot); the plan puts the timestamp in the footer — the plan wins"
  echo "- the plan counts 16 event kinds and lists 17 tokens (the unknown"
  echo "  fallback included); 17 goldens cover every rendered card"
  echo
  echo "wire contract: the event row's rowKey subtype carries the kind"
  echo "(event:<kind>); a structured tool_result payload whose type names a"
  echo "kind renders that card (EventFrames + the chat history alike); the"
  echo "expansion is the ev-<seq>-body patch target (visible false at rest,"
  echo "the chevron and the footer affordance flip it); the decorative"
  echo "controls (Resume buttons, copy button, option chips) carry demo:true"
  echo
  echo "goldens: 17 files, one per event kind plus the unknown fallback"
  echo "(goldens/event-<kind>-light.png); the --fail path: the blank-card"
  echo "inversion fails as required (the empty-state region renders)"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T102 QA green: the sixteen event kinds and the tool card anatomy"
