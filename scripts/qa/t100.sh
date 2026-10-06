#!/usr/bin/env bash
# QA for T100: the chat frame — the content lane (the `laneWidth` default
# the client resolves through its chatWidth switch), the scroll-anchored
# timeline (jump-to-bottom on appended items, preserved position on patch,
# the 24 px CHAT_TIMELINE_ANCHOR_OFFSET end inset), the composer seam
# divider (the painted --background-image-composer-seam-above recipe), the
# docked composer and the chat header row (title, status badge, demo-marked
# panel toggles, thread action menu).
# Usage: scripts/qa/t100.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T100. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui (the chat screen IS the frame surface).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T100 tree asserts
#     (ChatScreenTest: the lane, the scroll fade, the seam, the composer
#     dock, the header row; UiConformanceTest: the documented props);
#   - runs the Flutter chat-frame suite (flutter-frame.txt: the lane width
#     at 46rem/72rem/full, the seam gradient, the composer prompt font
#     size, the demo toggles) and the stream-view anchoring suite
#     (flutter-anchor.txt: the end inset, patch preserves position,
#     following/free-scrolling) and requires "All tests passed";
#   - writes the pixel goldens into goldens/ (flutter test --update-goldens
#     with T100_GOLDEN_DIR: the frame at the 46rem lane and at the 72rem
#     wide lane, light) and proves the frames are byte-stable
#     (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel, seeds one session and writes the chat tree into
#     chat-frame.json;
#   - asserts the frame contract on the wire: the lane's laneWidth default,
#     the top scroll fade around the timeline, the seam gradient between
#     the timeline and the docked composer, the header row (title, status
#     badge, demo toggles with inline setState, the thread action menu),
#     the anchored live tail, and that every node type stays inside the
#     docs/sdui.md section 2.5 catalog.
#
# Failure path: the deliberately wrong expectation — that patching a row
# above the viewport scrolls the timeline to the bottom — is run through
# the Flutter anchoring suite with T100_FAIL_MODE=1 and must fail; the real
# behavior (a patch preserves the position) is recorded in checks-fail.txt
# (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T100_INNER:-}" ]; then
  exec env T100_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T100}
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

port=18500
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
  ( JHIN_HOME="$home" \
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
  log "T100 QA --fail: patching a row above the viewport must not scroll the timeline"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  ok "kernel booted for the failure path (fail-boot/kernel.log)"

  tx="$evidence/fail-transcript.txt"
  : > "$tx"
  id=$(seed_session "$tx" "fail-frame" "/tmp/fail-frame")

  # The real wire contract holds before the client-side inversion.
  step_hdr "$client_header" "$tx" "fetch-chat" GET "/ui/screen/chat:$id" '' 200 \
    '.node.type == "screen"'
  jq -S '.node.body' <<< "$step_payload" > "$evidence/fail-tree.json"
  jq -e '
    [.. | objects | select(.id? == "chat-lane")][0].laneWidth == "46rem"
  ' "$evidence/fail-tree.json" > /dev/null \
    || fail "the lane lost its laneWidth default (fail-tree.json)"
  ok "the lane keeps the 46rem default on the wire (fail-tree.json)"

  # The deliberately wrong expectation: a patch scrolls the timeline to the
  # bottom (it does not — the position is preserved; the happy run proves
  # it). The inverted suite must fail.
  if bash scripts/qa/flutter-test.sh test/stream_view_test.dart \
      --dart-define=T100_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the patch scrolled the timeline"
  fi
  {
    echo "FAIL: the patch scrolls the timeline to the bottom (as designed)"
    echo "  the real behavior is the opposite: a patch frame updates the"
    echo "  rendered item in place and the scroll position is preserved"
    echo "  (the upstream maintainVisibleContentPosition port); the happy"
    echo "  run proves it (flutter-anchor.txt, the patch test); the"
    echo "  inverted suite failed as required (flutter-fail.txt);"
    echo "  session id: $id (fail-tree.json)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the patch scrolled the timeline (it does not; see $evidence/flutter-fail.txt)"
fi

log "T100 QA: the chat frame — content lane, scroll anchor, composer dock"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T100 tree asserts live here) ---
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

# --- 3. The Flutter frame + anchoring suites ---
bash scripts/qa/flutter-test.sh test/sdui/chat_frame_test.dart \
  2>&1 | tee "$evidence/flutter-frame.txt"
grep -q 'All tests passed' "$evidence/flutter-frame.txt" \
  || fail "the Flutter chat-frame suite failed (see $evidence/flutter-frame.txt)"
ok "Flutter chat-frame suite green: the lane at 46/72/full, the seam gradient, the composer prompt size, the demo toggles (flutter-frame.txt)"

bash scripts/qa/flutter-test.sh test/stream_view_test.dart \
  2>&1 | tee "$evidence/flutter-anchor.txt"
grep -q 'All tests passed' "$evidence/flutter-anchor.txt" \
  || fail "the Flutter anchoring suite failed (see $evidence/flutter-anchor.txt)"
ok "Flutter anchoring suite green: the 24 px end inset, patch preserves position, following/free-scrolling (flutter-anchor.txt)"

# --- 4. The goldens: the frame at the 46rem and 72rem lanes ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/chat_frame_test.dart \
  --update-goldens \
  --dart-define="T100_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
for frame in chat-frame-46-light chat-frame-72-light; do
  [ -s "$goldens/$frame.png" ] \
    || fail "the golden $frame.png is missing or empty (goldens/)"
done
ok "goldens: 2 frames written (the frame at the 46rem lane and at the 72rem wide lane, light) (goldens/)"

# The verification pass: the same suite without --update-goldens must match
# the written frames byte-for-byte.
bash scripts/qa/flutter-test.sh test/sdui/chat_frame_test.dart \
  --dart-define="T100_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged from the written frames (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 5. The kernel with the chat screen ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/chat-transcript.txt"
: > "$tx"

session_id=$(seed_session "$tx" "frame-demo" "/tmp/frame-demo")
ok "seeded one session (chat-transcript.txt)"

# --- 6. The chat screen: the frame contract ---
step_hdr "$client_header" "$tx" "fetch-chat" GET "/ui/screen/chat:$session_id" '' 200 \
  '.node.type == "screen"'
jq -S '.node.body' <<< "$step_payload" > "$evidence/chat-frame.json"

# The lane: the centered content column with the server-side default width.
jq -e '
  [.children[] | select(.type? == "expanded")][0].child.id == "chat-lane"
  and [.. | objects | select(.id? == "chat-lane")][0].laneWidth == "46rem"
  and [.. | objects | select(.id? == "chat-lane")][0].direction == "column"
' "$evidence/chat-frame.json" > /dev/null \
  || fail "the content lane is wrong (chat-frame.json)"
ok "content lane: chat-lane centered at the 46rem default (chat-frame.json)"

# The timeline scrolls under a top scroll fade inside the lane.
jq -e '
  [.. | objects | select(.type? == "scroll_fade")][0]
  | .edge == "top" and .child.id == "chat-timeline"
' "$evidence/chat-frame.json" > /dev/null \
  || fail "the timeline scroll fade is wrong (chat-frame.json)"
ok "timeline: scroll_fade edge top wraps the chat-timeline (chat-frame.json)"

# The seam divider paints the composer-seam gradient between the timeline
# and the docked composer (typeless gradient: the client defaults to linear;
# a literal type key would read as a node discriminator to the catalog
# walkers).
jq -e '
  [.. | objects | select(.id? == "composer-seam")][0]
  | .height == 10
    and .gradient.type == null
    and .gradient.begin == "bottomCenter"
    and .gradient.end == "topCenter"
    and .gradient.colors == ["#2E000000", "#00000000"]
' "$evidence/chat-frame.json" > /dev/null \
  || fail "the composer seam is wrong (chat-frame.json)"
ok "composer seam: the 10px seam-above gradient band (chat-frame.json)"

# The composer docks below the seam, inside the lane, with the send action.
# T103 turned the composer into the full control surface: a column carrying
# the reserved surface id (the T100 seam/lane dock is unchanged).
jq -e '
  ([.. | objects | select(.id? == "chat-lane")][0].children
    | map(select(.id? != null).id))
    == ["composer-seam", "composer"]
  and [.. | objects | select(.id? == "composer")][0].type == "column"
  and [.. | objects | select(.id? == "messageInput")][0].minLines == 1
' "$evidence/chat-frame.json" > /dev/null \
  || fail "the composer dock is wrong (chat-frame.json)"
ok "composer dock: inside the lane, below the seam, the messageInput field (chat-frame.json)"

# The header row: title, status badge, demo toggles, thread menu.
jq -e '
  [.. | objects | select(.id? == "chat-header")][0]
  | . as $header
  | .children[0].text == "frame-demo"
    and .children[1].id == "runStatus"
    and ([$header.children[] | select(.type? == "icon_button" and .demo? == true)]
         | length) == 2
    and ([$header.children[] | select(.type? == "icon_button" and .demo? == true)
          | .action.op] | all(. == "setState"))
    and .children[-1].type == "menu"
' "$evidence/chat-frame.json" > /dev/null \
  || fail "the chat header row is wrong (chat-frame.json)"
ok "header row: title + runStatus badge + 2 demo setState toggles + thread menu (chat-frame.json)"

# The thread menu carries the real lifecycle actions of this session.
jq -e --arg sid "$session_id" '
  [.. | objects | select(.id? == "chat-header")][0].children[-1].items
  | map(.label)
    == ["Pin thread", "Settle thread", "Snooze", "Regenerate title",
        "Archive thread", "Delete"]
  and .[0].action.name == "pin" and .[0].action.payload.id == $sid
  and .[5].action.name == "delete-session" and .[5].danger == true
' "$evidence/chat-frame.json" > /dev/null \
  || fail "the thread action menu is wrong (chat-frame.json)"
ok "thread menu: the real lifecycle actions of the session (chat-frame.json)"

# The live tail stays anchored.
jq -e '
  [.. | objects | select(.type? == "stream_view")][0]
  | .id == "stream" and .autoScroll == true
    and (.topic | startswith("/ui/stream/session/"))
' "$evidence/chat-frame.json" > /dev/null \
  || fail "the live tail is wrong (chat-frame.json)"
ok "live tail: stream_view autoScroll on the session topic (chat-frame.json)"

# The primitive-catalog guard: every node type in the tree is legal.
types=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' \
  "$evidence/chat-frame.json")
for t in $types; do
  catalog_primitives | grep -qx "$t" \
    || fail "node type '$t' is outside the docs/sdui.md section 2.5 catalog"
done
ok "every node type is inside the docs/sdui.md section 2.5 catalog ($(echo "$types" | tr '\n' ' '))"

# The kernel work is done — stop it before the summary.
stop_kernel

# --- 7. The summary ---
{
  echo "# T100 chat frame summary"
  echo
  echo "upstream anchors (commit 37de6cb): the content lane"
  echo ".chat-content-lane (apps/web/src/index.css:901-907) at"
  echo "--chat-content-max-width 46rem (index.css:128), the wide/full"
  echo "overrides (index.css:2031-2038) set per data-chat-width on :root"
  echo "(routes/__root.tsx:277-280), the composer elevation --shadow-composer"
  echo "(index.css:193-194, ComposerSurface.tsx:51), the seam recipes"
  echo "--background-image-composer-seam-below/above (index.css:199-215),"
  echo "the prompt touch floor --font-size-prompt-touch (index.css:131),"
  echo "the anchor offset CHAT_TIMELINE_ANCHOR_OFFSET = 24"
  echo "(components/chat/timelineScrollAnchoring.ts:39) and the timeline"
  echo "fade (components/chat/MessagesTimeline.tsx:1377)"
  echo
  echo "plan-vs-upstream: the plan's prose said a 36 px anchor offset; the"
  echo "checkout says 24 (timelineScrollAnchoring.ts:39) — upstream wins"
  echo "(plan risk 5); the plan's 'layout.chatContentMaxWidth' server key"
  echo "became the lane container's laneWidth prop (46rem default) because"
  echo "the chatWidth switch is client-side (T86), exactly like upstream's"
  echo "data-chat-width attribute"
  echo
  echo "wire contract: container gains laneWidth (the chat content lane);"
  echo "stream_view autoScroll anchors (jump on append while following,"
  echo "preserve on patch, 24 px end inset); the chat frame = header row +"
  echo "lane(scroll_fade(timeline) + seam + composer dock)"
  echo
  echo "header row: thread title, runStatus badge, the right-panel and"
  echo "terminal toggles (inline setState shells, demo-marked — the"
  echo "E-phase panels do not exist yet) and the thread action menu with"
  echo "the real lifecycle actions"
  echo
  echo "goldens: chat-frame-46-light.png, chat-frame-72-light.png"
  echo "(goldens/); the --fail path: the patch-anchoring inversion fails"
  echo "as required (a patch never scrolls the timeline)"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T100 QA green: the chat frame — content lane, scroll anchor, composer dock"
