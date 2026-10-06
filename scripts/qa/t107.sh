#!/usr/bin/env bash
# QA for T107: the Diff / Files / Preview panel tabs — the decorative
# surfaces seeded from the fixture pack (plan section 4.8).
#
# The Diff tab is the file-list header (the changed count, the total stat,
# the copy-path button and the unified/split toggle) over the first fixture
# file's `diff_view`; the Files tab is a `tree` whose file rows carry the
# A/M/D status badge and the `+n −m` line stats and whose tap is an inline
# `setState` selector that `patch`es the Diff tab's `diff_view`; the Preview
# tab is a syntax-highlighted `code_block` with the decorative `Open in…`
# button. There is no diff engine, no git operation and no file read (plan
# section 14.1): the fixtures are loaded at build time and never fetched.
# An empty fixture renders the empty-state card, never a blank tab.
# Usage: scripts/qa/t107.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T107. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (DiffPanelTest carries the T107 tree asserts);
#   - runs the Flutter diff-panel suite (flutter-panel.txt: the file-list
#     header, the view-toggle composite, the changed-files tree with badges
#     and stats, the file-row selector, the preview code block and the
#     empty-state card) and requires "All tests passed";
#   - writes the three tab pixel goldens into goldens/ (flutter test
#     --update-goldens with T107_GOLDEN_DIR) and proves them byte-stable
#     (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel, seeds one session, fetches the chat screen and dumps
#     the Diff / Files / Preview tab nodes into diff.json / files.json /
#     preview.json;
#   - asserts the Diff tab (the header count + total stat, the copy-path
#     button, the two view toggles, the demo diff_view with three hunks and
#     no hardcoded colorScheme), the Files tab (the tree, the A/M/D badges,
#     the `+n −m` stats, the setState + patch file-row actions) and the
#     Preview tab (the syntax code_block and the Open in… button), and that
#     every node type stays inside the docs/sdui.md section 2.5 catalog.
#
# Failure path: the real behavior holds first (an empty fixture renders the
# empty-state card — proven in the Flutter suite), then the deliberately
# wrong expectation — that the empty fixture renders a blank tab — is run
# with T107_FAIL_MODE=true and must fail; the real behavior is recorded in
# checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T107_INNER:-}" ]; then
  exec env T107_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T107}
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

port=18507
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
  log "T107 QA --fail: an empty fixture renders the empty-state card"
  log "evidence dir: $evidence"

  # The real behavior holds: the empty fixture renders the empty-state card.
  if bash scripts/qa/flutter-test.sh test/sdui/diff_panel_test.dart \
      2>&1 | tee "$evidence/flutter-real.txt" | grep -q 'All tests passed'; then
    ok "the real behavior holds: an empty fixture renders the empty-state card (flutter-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/flutter-real.txt)"
  fi

  # The deliberately wrong expectation: the empty fixture renders a blank
  # tab. The inverted suite must fail.
  if bash scripts/qa/flutter-test.sh test/sdui/diff_panel_test.dart \
      --dart-define=T107_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the empty fixture rendered a blank tab"
  fi
  {
    echo "FAIL: an empty fixture rendered a blank tab (as designed)"
    echo "  the real behavior is the opposite: the empty fixture renders the"
    echo "  empty-state card — the T107 empty-state contract; the inverted"
    echo "  suite failed as required (flutter-fail.txt); the real behavior is"
    echo "  recorded in flutter-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the empty fixture rendered a blank tab (it does not; see $evidence/flutter-fail.txt)"
fi

log "T107 QA: decorative diff panel, changed-files tree and file preview"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the cross-plugin gate) ---
# --rerun is a per-task flag: each suite carries its own.
./gradlew :jhin-plugin-ui-default:test --rerun :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; transcript in test.txt)"

# --- 3. The Flutter diff-panel suite ---
bash scripts/qa/flutter-test.sh test/sdui/diff_panel_test.dart \
  2>&1 | tee "$evidence/flutter-panel.txt"
grep -q 'All tests passed' "$evidence/flutter-panel.txt" \
  || fail "the Flutter diff-panel suite failed (see $evidence/flutter-panel.txt)"
ok "Flutter diff-panel suite green: file-list header, view-toggle composite, changed-files tree with badges/stats, file-row selector, preview code block, empty-state card (flutter-panel.txt)"

# --- 4. The goldens: the three tabs ---
goldens="$evidence/goldens"
rm -rf "$goldens"
bash scripts/qa/flutter-test.sh test/sdui/diff_panel_test.dart \
  --update-goldens \
  --dart-define="T107_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
golden_count=$(find "$goldens" -name 'diff-panel-*.png' | wc -l)
[ "$golden_count" -ge 3 ] \
  || fail "expected at least 3 tab goldens, found $golden_count (goldens/)"
ok "goldens written ($golden_count PNG into goldens/)"

bash scripts/qa/flutter-test.sh test/sdui/diff_panel_test.dart \
  --dart-define="T107_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 5. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/panel-transcript.txt"
: > "$tx"

session_id=$(seed_session "$tx" "diff-demo" "/tmp/diff-demo")
ok "seeded one session ($session_id)"

step_hdr "$client_header" "$tx" "fetch-chat" GET "/ui/screen/chat:$session_id" '' 200 \
  '.node.type == "screen"'

# The three tab nodes over the wire.
jq -S '[.. | objects | select(.id? == "right-panel-diff")][0]' <<< "$step_payload" \
  > "$evidence/diff.json"
jq -S '[.. | objects | select(.id? == "right-panel-files")][0]' <<< "$step_payload" \
  > "$evidence/files.json"
jq -S '[.. | objects | select(.id? == "right-panel-preview")][0]' <<< "$step_payload" \
  > "$evidence/preview.json"
[ "$(jq -r '.type' "$evidence/diff.json")" = "column" ] \
  || fail "the Diff tab node is missing (diff.json)"
[ "$(jq -r '.type' "$evidence/files.json")" = "column" ] \
  || fail "the Files tab node is missing (files.json)"
[ "$(jq -r '.type' "$evidence/preview.json")" = "column" ] \
  || fail "the Preview tab node is missing (preview.json)"

# --- 6. The Diff tab: the file-list header ---
jq -e '
  [.. | objects | select(.id? == "right-panel-diff-header")][0]
  | .type == "row"
    and ([.children[] | select(.type == "text") | .text] | index("3 changed files") != null)
    and ([.children[] | select(.type == "text") | .text] | index("+17") != null)
    and ([.children[] | select(.type == "text") | .text] | index("-10") != null)
' "$evidence/diff.json" > /dev/null \
  || fail "the Diff tab file-list header is wrong (count / total stat; diff.json)"
ok "Diff header: 3 changed files, +17 / -10 total stat (diff.json)"

jq -e '
  [.. | objects | select(.id? == "right-panel-diff-copy")][0]
  | .type == "icon_button" and .demo == true and .action.client != null
' "$evidence/diff.json" > /dev/null \
  || fail "the Diff tab copy-path button is wrong (diff.json)"
ok "Diff header: the demo copy-path button (diff.json)"

jq -e '
  [.. | objects | select(.id? == "right-panel-diff-view-toggle-unified")][0].demo == true
  and [.. | objects | select(.id? == "right-panel-diff-view-toggle-split")][0].demo == true
  and ([.. | objects | select(.id? == "right-panel-diff-view-toggle-split")][0]
       | .action.client[0].op == "setState"
         and .action.client[0].id == "chat_diff_view"
         and .action.client[0].value == "split"
         and .action.client[1].op == "patch"
         and .action.client[1].id == "right-panel-diff-view"
         and .action.client[1].props.view == "split")
' "$evidence/diff.json" > /dev/null \
  || fail "the Diff tab view toggle is wrong (setState + patch; diff.json)"
ok "Diff header: the unified/split toggle (setState + patch on the diff_view) (diff.json)"

# --- 7. The Diff tab: the diff_view ---
jq -e '
  [.. | objects | select(.id? == "right-panel-diff-view" and .type? == "diff_view")][0]
  | .type == "diff_view"
    and .file == "lib/agent/run.ts"
    and .language == "typescript"
    and .demo == true
    and (has("colorScheme") | not)
    and .stats.additions == 5 and .stats.deletions == 2
    and (.hunks | length) == 3
' "$evidence/diff.json" > /dev/null \
  || fail "the Diff tab diff_view is wrong (file / hunks / demo / ambient scheme; diff.json)"
ok "Diff body: the demo diff_view (lib/agent/run.ts, 3 hunks, no hardcoded colorScheme) (diff.json)"

# --- 8. The Files tab: the changed-files tree ---
jq -e '
  [.. | objects | select(.id? == "right-panel-files-tree")][0]
  | .type == "tree"
    and ([.. | objects | select(.path? != null)] | length) == 3
    and ([.. | objects | select(.path? == "lib/agent/run.ts")][0].stat == "+5 \u22122")
    and ([.. | objects | select(.path? == "lib/agent/prompt.ts")][0].stat == "+12 \u22120")
    and ([.. | objects | select(.path? == "lib/agent/legacy.ts")][0].stat == "+0 \u22128")
    and ([.. | objects | select(.badge?.type == "badge")] | length) == 3
    and ([.. | objects | select(.badge?.label == "M")] | length) == 1
    and ([.. | objects | select(.badge?.label == "A")] | length) == 1
    and ([.. | objects | select(.badge?.label == "D")] | length) == 1
' "$evidence/files.json" > /dev/null \
  || fail "the Files tab changed-files tree is wrong (paths / stats / A-M-D badges; files.json)"
ok "Files tree: 3 files with +n −m stats and A/M/D badges (files.json)"

jq -e '
  [.. | objects | select(.path? == "lib/agent/prompt.ts")][0]
  | .action.client[0].op == "setState"
    and .action.client[0].id == "chat_diff_file"
    and .action.client[0].value == "lib/agent/prompt.ts"
    and .action.client[1].op == "patch"
    and .action.client[1].id == "right-panel-diff-view"
    and .action.client[1].props.file == "lib/agent/prompt.ts"
    and (.action.client[1].props.hunks | length) == 3
' "$evidence/files.json" > /dev/null \
  || fail "the Files tab file-row selector is wrong (setState + patch; files.json)"
ok "Files tree: the file-row selector (setState chat_diff_file + patch the diff_view) (files.json)"

# --- 9. The Preview tab ---
jq -e '
  [.. | objects | select(.id? == "right-panel-preview-code")][0]
  | .type == "code_block"
    and .language == "typescript"
    and .syntax == true
    and .copyable == true
    and .lineNumbers == true
    and (.code | contains("export async function run"))
' "$evidence/preview.json" > /dev/null \
  || fail "the Preview tab code_block is wrong (syntax / language / content; preview.json)"
ok "Preview body: the syntax-highlighted code_block (preview.json)"

jq -e '
  [.. | objects | select(.id? == "right-panel-preview-open")][0]
  | .type == "button" and .label == "Open in\u2026"
    and .demo == true and .action.client != null
' "$evidence/preview.json" > /dev/null \
  || fail "the Preview tab Open in… button is wrong (preview.json)"
ok "Preview header: the demo Open in… button (preview.json)"

# --- 10. The catalog gate ---
catalog=$(catalog_primitives)
bad_types=$(jq -r '[.. | objects | select(.type? != null) | .type] | unique | .[]' \
    <<< "$step_payload" | while IFS= read -r t; do
  printf '%s\n' "$catalog" | grep -qx "$t" || echo "$t"
done)
if [ -n "$bad_types" ]; then
  fail "node types outside the docs/sdui.md section 2.5 catalog: $bad_types"
fi
ok "every node type stays inside the docs/sdui.md section 2.5 catalog"

log "T107 QA happy path complete"
