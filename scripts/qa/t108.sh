#!/usr/bin/env bash
# QA for T108: the browser-preview panel chrome and the permissions dialog
# shell (plan section 4.6).
#
# The Preview tab carries the browser-preview section — the read-only URL bar
# with the decorative Reload button, the `preview-loading` progress bar and
# the illustrated viewport placeholder — over the retained T107 file preview.
# The permissions dialog is the access-mode picker shell: the three upstream
# permission modes (Read only / Ask / Full access) as a radio group, a demo
# note and the Save button. There is no browser automation (plan section
# 14.1): the URL is a read-only fixture value, the Reload button is a demo
# server action whose empty-URL validation is the client's own, and the
# viewport is an illustrated placeholder.
# Usage: scripts/qa/t108.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T108. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (PreviewPanelTest carries the T108 asserts);
#   - runs the Flutter preview-panel suite (flutter-panel.txt: the URL bar,
#     the preview-loading animation, the reload dispatch, the empty-URL
#     validation, the viewport placeholder, the permissions dialog and Save)
#     and requires "All tests passed";
#   - writes the preview-tab and permissions-dialog pixel goldens into
#     goldens/ (flutter test --update-goldens with T108_GOLDEN_DIR) and
#     proves them byte-stable (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel, seeds one session, fetches the chat screen and dumps
#     the Preview tab node into preview.json and the permissions dialog into
#     permissions.json;
#   - asserts the browser chrome (the URL bar input + reload action, the
#     preview-loading progress, the viewport figure + copy), the retained
#     file preview and the permissions dialog (three modes, note, Save), and
#     that every node type stays inside the docs/sdui.md section 2.5 catalog.
#
# Failure path: the real behavior holds first (an empty URL shows the
# validation error and posts nothing — proven in the Flutter suite), then the
# deliberately wrong expectation — that the empty URL animates — is run with
# T108_FAIL_MODE=true and must fail; the real behavior is recorded in
# checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T108_INNER:-}" ]; then
  exec env T108_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T108}
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

port=18508
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
  log "T108 QA --fail: an empty URL shows the validation error, not an animation"
  log "evidence dir: $evidence"

  # The real behavior holds: the empty URL shows the validation error and
  # posts nothing.
  if bash scripts/qa/flutter-test.sh test/sdui/preview_panel_test.dart \
      2>&1 | tee "$evidence/flutter-real.txt" | grep -q 'All tests passed'; then
    ok "the real behavior holds: an empty URL shows the validation error and posts nothing (flutter-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/flutter-real.txt)"
  fi

  # The deliberately wrong expectation: the empty URL animates. The inverted
  # suite must fail.
  if bash scripts/qa/flutter-test.sh test/sdui/preview_panel_test.dart \
      --dart-define=T108_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the empty URL animated"
  fi
  {
    echo "FAIL: the empty URL animated (as designed)"
    echo "  the real behavior is the opposite: the empty URL shows the"
    echo "  validation error and posts nothing — the T108 empty-URL contract;"
    echo "  the inverted suite failed as required (flutter-fail.txt); the real"
    echo "  behavior is recorded in flutter-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the empty URL animated (it does not; see $evidence/flutter-fail.txt)"
fi

log "T108 QA: browser preview panel, loading progress and permissions shell"
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

# --- 3. The Flutter preview-panel suite ---
bash scripts/qa/flutter-test.sh test/sdui/preview_panel_test.dart \
  2>&1 | tee "$evidence/flutter-panel.txt"
grep -q 'All tests passed' "$evidence/flutter-panel.txt" \
  || fail "the Flutter preview-panel suite failed (see $evidence/flutter-panel.txt)"
ok "Flutter preview-panel suite green: URL bar, preview-loading animation, reload dispatch, empty-URL validation, viewport placeholder, permissions dialog, Save (flutter-panel.txt)"

# --- 4. The goldens: the preview tab and the permissions dialog ---
goldens="$evidence/goldens"
rm -rf "$goldens"
bash scripts/qa/flutter-test.sh test/sdui/preview_panel_test.dart \
  --update-goldens \
  --dart-define="T108_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
golden_count=$(find "$goldens" -name 'preview-panel-*.png' -o -name 'permissions-*.png' | wc -l)
[ "$golden_count" -ge 3 ] \
  || fail "expected at least 3 goldens, found $golden_count (goldens/)"
ok "goldens written ($golden_count PNG into goldens/)"

bash scripts/qa/flutter-test.sh test/sdui/preview_panel_test.dart \
  --dart-define="T108_GOLDEN_DIR=$(readlink -f "$goldens")" \
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

session_id=$(seed_session "$tx" "preview-demo" "/tmp/preview-demo")
ok "seeded one session ($session_id)"

step_hdr "$client_header" "$tx" "fetch-chat" GET "/ui/screen/chat:$session_id" '' 200 \
  '.node.type == "screen"'

# The Preview tab node and the permissions dialog over the wire.
jq -S '[.. | objects | select(.id? == "right-panel-preview")][0]' <<< "$step_payload" \
  > "$evidence/preview.json"
jq -S '[.. | objects | select(.id? == "composer-mode-dialog")][0]' <<< "$step_payload" \
  > "$evidence/permissions.json"
[ "$(jq -r '.type' "$evidence/preview.json")" = "column" ] \
  || fail "the Preview tab node is missing (preview.json)"
[ "$(jq -r '.type' "$evidence/permissions.json")" = "column" ] \
  || fail "the permissions dialog node is missing (permissions.json)"

# --- 6. The browser-preview chrome ---
jq -e '
  [.. | objects | select(.id? == "right-panel-preview-browser")][0].type == "column"
  and [.. | objects | select(.id? == "right-panel-preview-url-bar")][0].type == "row"
  and [.. | objects | select(.id? == "right-panel-preview-viewport")][0].type == "column"
' "$evidence/preview.json" > /dev/null \
  || fail "the browser-preview section is wrong (browser / url-bar / viewport; preview.json)"
ok "browser preview: the section, the URL bar and the viewport (preview.json)"

jq -e '
  [.. | objects | select(.id? == "preview_url")][0]
  | .type == "input"
    and .value == "http://localhost:5173"
    and .readOnly == true
    and .required == true
    and .errorText == "Enter a URL to preview"
' "$evidence/preview.json" > /dev/null \
  || fail "the URL bar input is wrong (readOnly / required / errorText; preview.json)"
ok "URL bar: the read-only required input with the T108 error text (preview.json)"

jq -e '
  [.. | objects | select(.id? == "right-panel-preview-reload")][0]
  | .type == "icon_button" and .icon == "refresh" and .demo == true
    and .action.path == "/ui/action/preview-reload"
    and .action.name == "preview-reload"
    and .action.include == ["preview_url"]
' "$evidence/preview.json" > /dev/null \
  || fail "the Reload button is wrong (demo / preview-reload / include; preview.json)"
ok "URL bar: the demo Reload button (preview-reload with the URL included) (preview.json)"

jq -e '
  [.. | objects | select(.id? == "right-panel-preview-progress")][0]
  | .type == "progress"
    and .statusPulse == "preview-loading"
    and .loading == false
' "$evidence/preview.json" > /dev/null \
  || fail "the preview-loading progress bar is wrong (mode / loading; preview.json)"
ok "progress: the preview-loading bar, hidden until reload (preview.json)"

jq -e '
  [.. | objects | select(.id? == "right-panel-preview-figure")][0]
  | .type == "figure" and .shape == "rectangle" and .width == 160 and .height == 96
' "$evidence/preview.json" > /dev/null \
  || fail "the viewport figure is wrong (shape / size; preview.json)"
ok "viewport: the illustrated figure placeholder (preview.json)"

jq -e '
  [.. | objects | select(.type? == "text") | .text]
  | index("Preview is not available in this build") != null
' "$evidence/preview.json" > /dev/null \
  || fail "the viewport copy is missing (preview.json)"
ok "viewport: the unavailable-preview copy (preview.json)"

# --- 7. The retained T107 file preview ---
jq -e '
  [.. | objects | select(.id? == "right-panel-preview-code")][0]
  | .type == "code_block" and .language == "typescript" and .syntax == true
' "$evidence/preview.json" > /dev/null \
  || fail "the retained file preview code_block is wrong (preview.json)"
jq -e '
  [.. | objects | select(.id? == "right-panel-preview-open")][0]
  | .type == "button" and .demo == true
' "$evidence/preview.json" > /dev/null \
  || fail "the retained file preview Open in… button is wrong (preview.json)"
ok "file preview: the retained T107 code_block and Open in… button (preview.json)"

# --- 8. The permissions dialog ---
jq -e '
  [.. | objects | select(.id? == "permissions-modes")][0]
  | .type == "list"
    and ([.items[].title] == ["Read only", "Ask", "Full access"])
    and ([.items[].demo] | all(. == true))
    and ([.items[].leading.type] | all(. == "icon"))
    and ([.items[].leading.icon] | all(startswith("radio_button_")))
' "$evidence/permissions.json" > /dev/null \
  || fail "the permissions radio group is wrong (three modes / demo / radio glyphs; permissions.json)"
ok "permissions: the three-mode radio group (Read only / Ask / Full access) (permissions.json)"

jq -e '
  [.. | objects | select(.id? == "permissions-note")][0]
  | .type == "text" and (.text | contains("Preview only"))
' "$evidence/permissions.json" > /dev/null \
  || fail "the permissions demo note is wrong (permissions.json)"
ok "permissions: the demo note (permissions.json)"

jq -e '
  [.. | objects | select(.id? == "permissions-save")][0]
  | .type == "button" and .label == "Save" and .demo == true
    and .action.client[0].op == "toast"
    and .action.client[1].op == "dismissDialog"
' "$evidence/permissions.json" > /dev/null \
  || fail "the permissions Save button is wrong (toast + dismissDialog; permissions.json)"
ok "permissions: Save toasts and closes (permissions.json)"

# --- 9. The catalog gate ---
catalog=$(catalog_primitives)
bad_types=$(jq -r '[.. | objects | select(.type? != null) | .type] | unique | .[]' \
    <<< "$step_payload" | while IFS= read -r t; do
  printf '%s\n' "$catalog" | grep -qx "$t" || echo "$t"
done)
if [ -n "$bad_types" ]; then
  fail "node types outside the docs/sdui.md section 2.5 catalog: $bad_types"
fi
ok "every node type stays inside the docs/sdui.md section 2.5 catalog"

log "T108 QA happy path complete"
