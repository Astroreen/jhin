#!/usr/bin/env bash
# QA for T104: markdown parity in chat — the ChatMarkdown feature parity of
# the client markdown renderer (headings h1-h6, paragraphs with the
# remark-breaks semantics, ul/ol, tables, blockquotes, inline code, fenced
# code with the .chat-markdown-codeblock-header recipe (muted language
# label + copy action) and token-driven syntax colors, links with the
# external-link glyph, images inline and zoomable, task lists, strong/em/
# strikethrough, the five GitHub alert cards, the citation pill, the skill
# pills) and the non-features (math renders as a math code block, footnote
# refs render as plain refs, malformed markdown never throws).
# Usage: scripts/qa/t104.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T104. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui plus the QA switches (JHIN_SESSIONS_QA for the event-append
# helper).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL;
#   - runs the Flutter markdown parity suite (flutter-markdown.txt: the
#     mapping fixtures, the copy glyph flip, the zoom dialog, the malformed
#     inputs) and requires "All tests passed";
#   - writes the per-feature goldens into goldens/ (20 PNGs) and proves
#     them byte-stable (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel, seeds a session, appends a real assistant message
#     carrying the parity fixture and fetches the chat screen into
#     chat-screen.json, asserting the server-emitted markdown node over the
#     wire (the parity mapping itself is client-side — the Flutter suite
#     proves it) and that every node type stays inside the docs/sdui.md
#     section 2.5 catalog.
#
# Failure path: the real behavior holds first (malformed markdown renders
# partial content without throwing — proven in the Flutter suite), then the
# deliberately wrong expectation — that the parser throws on malformed
# input — is run through the Flutter suite with T104_FAIL_MODE=1 and must
# fail; the real behavior is recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T104_INNER:-}" ]; then
  exec env T104_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T104}
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

port=18504
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
  ( JHIN_HOME="$home" JHIN_SESSIONS_QA=true \
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
  log "T104 QA --fail: malformed markdown never throws (renders partial + placeholder)"
  log "evidence dir: $evidence"

  # The real behavior holds: the malformed inputs map and render without
  # throwing (the T104.2 robustness contract).
  if bash scripts/qa/flutter-test.sh test/design/markdown_parity_test.dart \
      2>&1 | tee "$evidence/flutter-real.txt" | grep -q 'All tests passed'; then
    ok "the real behavior holds: malformed markdown renders partial content, never throws (flutter-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/flutter-real.txt)"
  fi

  # The deliberately wrong expectation: the parser throws on malformed
  # input. The inverted suite must fail.
  if bash scripts/qa/flutter-test.sh test/design/markdown_parity_test.dart \
      --dart-define=T104_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the parser threw on malformed input"
  fi
  {
    echo "FAIL: malformed markdown throws (as designed)"
    echo "  the real behavior is the opposite: every malformed input —"
    echo "  unbalanced fences, broken links, control characters, unclosed"
    echo "  math markers — maps and renders partial content without"
    echo "  throwing (the §2.4 degrade list); the inverted suite failed"
    echo "  as required (flutter-fail.txt); the real behavior is recorded"
    echo "  in flutter-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: malformed markdown threw (it does not; see $evidence/flutter-fail.txt)"
fi

log "T104 QA: markdown parity — alerts, code headers, citations and media"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the cross-plugin gate) ---
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

# --- 3. The Flutter markdown parity suite ---
bash scripts/qa/flutter-test.sh test/design/markdown_parity_test.dart \
  2>&1 | tee "$evidence/flutter-markdown.txt"
grep -q 'All tests passed' "$evidence/flutter-markdown.txt" \
  || fail "the Flutter markdown parity suite failed (see $evidence/flutter-markdown.txt)"
ok "Flutter markdown parity suite green: headings h1-h6, paragraphs + breaks, lists, tables, quotes, inline code, fenced code + copy + syntax colors, links + glyph, images inline + zoomable, task lists, inline styles, five alert cards, citation and skill pills, math as code, plain footnote refs, malformed inputs (flutter-markdown.txt)"

# --- 4. The goldens: one per parity feature ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/design/markdown_parity_test.dart \
  --update-goldens \
  --dart-define="T104_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
golden_count=$(find "$goldens" -name 'markdown-*.png' | wc -l)
[ "$golden_count" -ge 20 ] \
  || fail "expected at least 20 parity goldens, found $golden_count (goldens/)"
ok "goldens written ($golden_count PNGs into goldens/)"

# The verification pass: the same suite without --update-goldens must match
# the written frames byte-for-byte.
bash scripts/qa/flutter-test.sh test/design/markdown_parity_test.dart \
  --dart-define="T104_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged from the written frames (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 5. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui plus the QA switches (kernel.log)"

tx="$evidence/chat-transcript.txt"
: > "$tx"

# --- 6. The chat screen: the markdown node over the wire ---
session_id=$(seed_session "$tx" "markdown-parity" "/tmp/markdown-demo")
ok "seeded one session ($session_id)"

append_event "$tx" "$session_id" user_message '{"text":"show the parity fixture"}'
append_event "$tx" "$session_id" message_start '{"role":"assistant"}'
append_event "$tx" "$session_id" message_end '{"text":"# Note\n\n> [!WARNING]\n> handle the `t3-citation://` body\n\n```java\ncode line\n```"}'

step_hdr "$client_header" "$tx" "fetch-chat" GET "/ui/screen/chat:$session_id" '' 200 \
  '.node.type == "screen"'
jq -S '[.. | objects | select(.type? == "markdown")][0]' <<< "$step_payload" \
  > "$evidence/markdown-node.json"
ok "fetched the chat screen and dumped the first markdown node (markdown-node.json)"

# The server emits the raw fixture into the markdown node (the parity
# mapping itself is client-side — the Flutter suite proves it).
jq -e '
  .text
  and (.text | contains("[!WARNING]"))
  and (.text | contains("```java"))
' "$evidence/markdown-node.json" > /dev/null \
  || fail "the assistant markdown node does not carry the parity fixture (markdown-node.json)"
ok "assistant markdown node carries the parity fixture (markdown-node.json)"

# --- 7. The catalog gate ---
catalog=$(catalog_primitives)
bad_types=$(jq -r '[.. | objects | select(.type? != null) | .type] | unique | .[]' \
    <<< "$step_payload" | while IFS= read -r t; do
  printf '%s\n' "$catalog" | grep -qx "$t" || echo "$t"
done)
if [ -n "$bad_types" ]; then
  fail "node types outside the docs/sdui.md section 2.5 catalog: $bad_types"
fi
ok "every node type stays inside the docs/sdui.md section 2.5 catalog"

log "T104 QA happy path complete"
