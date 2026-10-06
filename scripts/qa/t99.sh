#!/usr/bin/env bash
# QA for T99: the sidebar drag choreography — the reveal-label chip (the
# upstream dropVerbBadge port), the accent-coloured drop targets, the
# pinned/active boundary labels, the Escape cancel and the exactly-once
# drop dispatch of the mapped lifecycle action, plus the decorative
# Arrange threads sheet.
# Usage: scripts/qa/t99.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T99. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui (the sessions screen IS the sidebar surface).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T99 tree asserts
#     (SidebarBuilderTest: the draggable rows, the dropTargets verb words
#     and actions, the dragLabel chip, the boundary labels, the arrange
#     sheet; UiConformanceTest: the documented props);
#   - runs the Flutter drag suite (flutter-drag.txt: the boundary labels,
#     the accent tint, the badge word per target, the Escape cancel, the
#     exactly-once dispatch, the non-target cancel) and requires
#     "All tests passed";
#   - writes the pixel goldens into goldens/ (flutter test --update-goldens
#     with T99_GOLDEN_DIR: the revealed drag over the pinned boundary and
#     over the settled header, light) and proves the frames are byte-stable
#     (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel, seeds three sessions (active, pinned, settled) and
#     writes the sidebar tree into drag.json;
#   - asserts the drag contract on the wire: the draggable rows outside the
#     Working shelf, the dropTargets verb words with the real lifecycle
#     actions (Pin/Unpin/Settle/Un-settle/Wake), the dragLabel chip
#     template, the Pinned/Active boundary labels, the Working row left
#     undraggable, the Arrange threads menu entry opening the demo-marked
#     sheet, and that every node type stays inside the docs/sdui.md
#     section 2.5 catalog;
#   - posts the pin action a drop target carries and asserts the refresh
#     answer, then settles and un-settles through the same actions (the
#     drop dispatch path works end-to-end).
#
# Failure path: the deliberately wrong expectation — that a row's
# dropTargets include its own section and the Working/Snoozed shelves (the
# non-target areas) — is asserted against the real tree and must fail; the
# real behavior (no self-section, no shelf targets: a drop there cancels
# and dispatches nothing) is recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T99_INNER:-}" ]; then
  exec env T99_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T99}
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

port=18499
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

# get_json <transcript> <name> <path> <jq-expr>: one GET with the client
# header, recorded and asserted.
get_json() {
  step_hdr "$client_header" "$1" "$2" GET "$3" '' 200 "$4"
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

# action <transcript> <name> <payload>: posts one ui action, records the
# response, echoes it.
action() {
  local tx=$1 name=$2 payload=$3 response
  response=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -H "$client_header" \
      --data "{\"action\":\"$name\",\"payload\":$payload}" \
      "$base/ui/action/$name")
  {
    echo "=== action $name ==="
    echo "POST /ui/action/$name"
    echo "req:  {\"action\":\"$name\",\"payload\":$payload}"
    echo "resp: $response"
  } >> "$tx"
  printf '%s' "$response"
}

# row_of <file> <session-id>: the row node of one session, over the split
# tree (the split's first pane carries the section list).
row_of() {
  local file=$1 id=$2
  jq -r --arg rid "session-row:$id" \
    '[.. | objects | select(.id? == $rid)][0]' "$file"
}

# section_of <file> <label>: one section spec of the sidebar list.
section_of() {
  local file=$1 label=$2
  jq -r --arg label "$label" \
    '[.first.sections[] | select(.label == $label)][0]' "$file"
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
  log "T99 QA --fail: a drop on a non-target area cancels and dispatches nothing"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  ok "kernel booted for the failure path (fail-boot/kernel.log)"

  tx="$evidence/fail-transcript.txt"
  : > "$tx"
  id=$(seed_session "$tx" "fail-drag" "/tmp/fail-drag")

  step_hdr "$client_header" "$tx" "fetch-sidebar" GET /ui/screen/sessions '' 200 \
    '.node.type == "screen"'
  jq -S '.node.body.body' <<< "$step_payload" > "$evidence/fail-tree.json"
  row=$(row_of "$evidence/fail-tree.json" "$id")

  # The real behavior: the active row's dropTargets name only the pinned
  # and settled sections — its own section and the Working/Snoozed shelves
  # are non-target areas (a drop there cancels and dispatches nothing).
  jq -e '
    [.dropTargets[].id] == ["section-pinned", "section-settled"]
  ' <<< "$row" > /dev/null \
    || fail "the active row's dropTargets are wrong (fail-tree.json)"
  ok "the active row targets only section-pinned and section-settled (fail-tree.json)"

  # The deliberately wrong expectation: the dropTargets include the row's
  # own section and the shelves (they do not — a drop there is a cancel).
  if jq -e '[.dropTargets[].id] | index("section-active")' <<< "$row" > /dev/null 2>&1; then
    fail "deliberately wrong expectation held: the dropTargets include the own section"
  fi
  {
    echo "FAIL: the dropTargets include the row's own section (as designed)"
    echo "  the own section and the Working/Snoozed shelves are non-target"
    echo "  areas: a drop there cancels and dispatches nothing; the client"
    echo "  suite proves it (drag_label_test.dart, the non-target case);"
    echo "  session id: $id (fail-tree.json)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the dropTargets include the own section (they do not; see $evidence/fail-tree.json)"
fi

log "T99 QA: the sidebar drag choreography and the arrange sheet"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T99 tree asserts live here) ---
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

# --- 3. The Flutter drag suite ---
bash scripts/qa/flutter-test.sh test/sdui/drag_label_test.dart \
  2>&1 | tee "$evidence/flutter-drag.txt"
grep -q 'All tests passed' "$evidence/flutter-drag.txt" \
  || fail "the Flutter drag suite failed (see $evidence/flutter-drag.txt)"
ok "Flutter drag suite green: the boundary labels, the accent tint, the badge word per target, the Escape cancel, the exactly-once dispatch, the non-target cancel (flutter-drag.txt)"

# --- 4. The goldens: the revealed drag over both target kinds ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/drag_label_test.dart \
  --update-goldens \
  --dart-define="T99_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
for frame in drag-label-pin-light drag-label-settle-light; do
  [ -s "$goldens/$frame.png" ] \
    || fail "the golden $frame.png is missing or empty (goldens/)"
done
ok "goldens: 2 frames written (the revealed drag over the pinned boundary and over the settled header, light) (goldens/)"

# The verification pass: the same suite without --update-goldens must match
# the written frames byte-for-byte.
bash scripts/qa/flutter-test.sh test/sdui/drag_label_test.dart \
  --dart-define="T99_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged from the written frames (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 5. The kernel with the sidebar ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/drag-transcript.txt"
: > "$tx"

active_id=$(seed_session "$tx" "drag-active" "/tmp/drag-active")
pinned_id=$(seed_session "$tx" "drag-pinned" "/tmp/drag-pinned")
settled_id=$(seed_session "$tx" "drag-settled" "/tmp/drag-settled")
action "$tx" "pin" "{\"id\":\"$pinned_id\"}" > /dev/null
action "$tx" "settle" "{\"id\":\"$settled_id\"}" > /dev/null
ok "seeded one active, one pinned and one settled session (drag-transcript.txt)"

# --- 6. The sessions screen: the drag contract ---
step_hdr "$client_header" "$tx" "fetch-sidebar" GET /ui/screen/sessions '' 200 \
  '.node.type == "screen"'
jq -S '.node.body.body' <<< "$step_payload" > "$evidence/drag.json"

active=$(row_of "$evidence/drag.json" "$active_id")
pinned=$(row_of "$evidence/drag.json" "$pinned_id")
settled=$(row_of "$evidence/drag.json" "$settled_id")

# The active row: draggable, the dropTargets verb words with the real
# lifecycle actions, the dragLabel chip template.
jq -e '
  .draggable == true
  and ([.dropTargets[].id]) == ["section-pinned", "section-settled"]
  and [.dropTargets[].label] == ["Pin", "Settle"]
  and ([.dropTargets[].accentWhenHovered] | all)
  and .dropTargets[0].action.name == "pin"
  and .dropTargets[0].action.payload.id == "'"$active_id"'"
  and .dropTargets[1].action.name == "settle"
  and .dragLabel.id == "drag-label"
  and .dragLabel.children[0].icon == "push_pin"
  and .dragLabel.children[1].text == "Pin"
' <<< "$active" > /dev/null \
  || fail "the active row's drag contract is wrong (drag.json)"
ok "active row: draggable, dropTargets Pin->pin + Settle->settle with the real actions, the dragLabel chip template (drag.json)"

# The pinned row: Unpin onto Active, Settle onto Settled.
jq -e '
  .draggable == true
  and ([.dropTargets[].id]) == ["section-active", "section-settled"]
  and [.dropTargets[].label] == ["Unpin", "Settle"]
  and .dropTargets[0].action.name == "unpin"
  and .dropTargets[0].action.payload.id == "'"$pinned_id"'"
' <<< "$pinned" > /dev/null \
  || fail "the pinned row's dropTargets are wrong (drag.json)"
ok "pinned row: dropTargets Unpin->unpin + Settle->settle (drag.json)"

# The settled row: Pin onto Pinned, Un-settle onto Active.
jq -e '
  .draggable == true
  and ([.dropTargets[].id]) == ["section-pinned", "section-active"]
  and [.dropTargets[].label] == ["Pin", "Un-settle"]
  and .dropTargets[1].action.name == "unsettle"
' <<< "$settled" > /dev/null \
  || fail "the settled row's dropTargets are wrong (drag.json)"
ok "settled row: dropTargets Pin->pin + Un-settle->unsettle (drag.json)"

# The boundary labels on the Pinned and Active sections only.
[ "$(jq -r '.boundaryLabel' < <(section_of "$evidence/drag.json" Pinned))" = "Pinned" ] \
  || fail "the Pinned section lost its boundary label (drag.json)"
[ "$(jq -r '.boundaryLabel' < <(section_of "$evidence/drag.json" Active))" = "Active" ] \
  || fail "the Active section lost its boundary label (drag.json)"
[ "$(jq -r '.boundaryLabel // "none"' < <(section_of "$evidence/drag.json" Settled))" = "none" ] \
  || fail "the Settled section must not carry a boundary label (drag.json)"
ok "boundary labels: Pinned and Active carry them, Settled does not (drag.json)"

# The Working shelf stays empty in this fixture (the undraggable Working
# row is covered by the JVM suite).
jq -e '
  [.first.sections[] | select(.label == "Working") | .items[]?] == []
' <<< "$(jq -S '.node.body.body' <<< "$step_payload")" > /dev/null \
  || fail "the Working shelf must be empty in this fixture (drag.json)"
ok "Working shelf empty in the fixture (the undraggable Working row is covered by the JVM suite) (drag.json)"

# The Arrange threads menu entry opens the demo-marked sheet.
jq -e '
  [.trailing.items[].label] ==
    ["Pin thread", "Settle thread", "Snooze", "Regenerate title",
     "Auto-settle behavior", "Arrange threads", "Archive thread", "Delete"]
  and .trailing.items[5].label == "Arrange threads"
  and .trailing.items[5].icon == "drag_handle"
  and .trailing.items[5].action.op == "dialog"
  and .trailing.items[5].action.kind == "sheet"
  and .trailing.items[5].action.node.demo == true
  and .trailing.items[5].action.node.title == "Arrange threads"
' <<< "$active" > /dev/null \
  || fail "the Arrange threads entry is wrong (drag.json)"
arrange_sheet=$(jq -r '.trailing.items[5].action.node' <<< "$active")
jq -e '
  .type == "sheet"
  and .demo == true
  and (.body.children | length >= 1)
  and ([.body.children[].dragHandle] | all)
  and (.footer | tostring | contains("Done"))
' <<< "$arrange_sheet" > /dev/null \
  || fail "the arrange sheet is wrong (drag.json)"
ok "Arrange threads: the demo-marked sheet with drag-handle rows and the Done button (drag.json)"

# The primitive-catalog guard: every node type in the tree is legal.
types=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' \
  "$evidence/drag.json")
for t in $types; do
  catalog_primitives | grep -qx "$t" \
    || fail "node type '$t' is outside the docs/sdui.md section 2.5 catalog"
done
ok "every node type is inside the docs/sdui.md section 2.5 catalog ($(echo "$types" | tr '\n' ' '))"

# --- 7. The drop dispatch path: the mapped actions work end-to-end ---
response=$(action "$tx" "pin" "{\"id\":\"$active_id\"}")
jq -e '.client[0].op == "refresh"' <<< "$response" > /dev/null \
  || fail "the pin action (the dropTarget's action) did not answer refresh (resp: $response)"
ok "the dropTarget's pin action answered refresh (drag-transcript.txt)"
get_json "$tx" "fetch-pinned" "/sessions/$active_id" '.pinned == true'
ok "the drop-equivalent pin persisted: the session is pinned (drag-transcript.txt)"

response=$(action "$tx" "unpin" "{\"id\":\"$active_id\"}")
jq -e '.client[0].text == "Unpinned 1 thread,"
    and .client[0].action.name == "undo"' <<< "$response" > /dev/null \
  || fail "the unpin action did not answer the Unpinned notice (resp: $response)"
ok "the dropTarget's unpin action answered the upstream undo notice (drag-transcript.txt)"

response=$(action "$tx" "unsettle" "{\"id\":\"$settled_id\"}")
jq -e '[.client[].op] == ["refresh"]' <<< "$response" > /dev/null \
  || fail "the unsettle action answered a notice (upstream shows none) (resp: $response)"
ok "the dropTarget's unsettle action answered refresh only (drag-transcript.txt)"

# The kernel work is done — stop it before the summary.
stop_kernel

# --- 8. The summary ---
{
  echo "# T99 drag choreography + arrange sheet summary"
  echo
  echo "upstream anchors (commit 37de6cb): the drop verbs resolveSidebarDropVerb"
  echo "(components/Sidebar.logic.ts:346-357), the badge words and icons"
  echo "dropVerbBadge (components/Sidebar.tsx:1041-1070), the badge chip"
  echo "surface (Sidebar.tsx:1586-1592), the boundary labels Pinned/Active"
  echo "(Sidebar.tsx:5261-5280) with the sidebar-drag-boundary-label reveal"
  echo "keyframe (index.css:2154-2165, 200ms step-end), the Escape cancel"
  echo "(Sidebar.pointer.ts:115), the mobile Arrange threads sheet"
  echo "(docs/user/thread-sidebar.md:85-88)"
  echo
  echo "wire contract: list_row gains draggable / dragLabel / dropTargets"
  echo "[{id, label, accentWhenHovered, action}]; the list section gains"
  echo "boundaryLabel; the Working shelf rows stay undraggable and the"
  echo "Working/Snoozed shelves are never destinations"
  echo
  echo "drop dispatch: the hovered target's action dispatches exactly once"
  echo "(client guard); a drop on a non-target area cancels and dispatches"
  echo "nothing; Escape cancels and restores the resting tree; the"
  echo "decorative drag itself never mutates state"
  echo
  echo "arrange sheet: the demo-marked decorative shell (drag handles +"
  echo "Done) opened by the Arrange threads menu entry"
  echo
  echo "goldens: drag-label-pin-light.png, drag-label-settle-light.png"
  echo "(goldens/); the --fail path: the dropTargets never include the own"
  echo "section or the shelves (the non-target areas)"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T99 QA green: the sidebar drag choreography and the arrange sheet"
