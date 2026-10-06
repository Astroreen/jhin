#!/usr/bin/env bash
# QA for T105: the right panel — the tab strip with per-tab close buttons
# and the sheet chrome. The panel is a positioned overlay of the chat frame,
# gated by the header's `chat_right_panel` setState toggle, painted on the
# sidebar surface with the left hairline at the `--thread-details-panel-width`
# 17.5rem default. The `tabs` node carries `hasClose` (the upstream
# PanelTabCloseButton, size-4 = 16 px hit target) and the six upstream tab
# kinds (Details, Diff, Files, Preview, Pull Requests, Usage); the Details tab
# mounts the ThreadDetailsPanel shell (title + status, model/effort/provider
# and created/updated/settled rows, the decorative relationships and
# pull-request rows with the Link to thread menu).
# Usage: scripts/qa/t105.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T105. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (RightPanelTest carries the T105 tree asserts);
#   - runs the Flutter right-panel suite (flutter-panel.txt: the six-tab
#     strip with close buttons, the client-side patch removal, the last-close
#     closeAction, the pinned no-op and the 17.5rem panelWidth parse) and
#     requires "All tests passed";
#   - writes the tab-bar pixel golden into goldens/ (flutter test
#     --update-goldens with T105_GOLDEN_DIR) and proves it byte-stable
#     (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel, seeds one session, fetches the chat screen and dumps
#     the tabs node into tabs.json;
#   - asserts the panel chrome (the when-gated positioned slot, the sidebar
#     fill + left hairline + 17.5rem width), the six-tab strip (hasClose,
#     labels, icons, the panel-close closeAction) and the Details shell, and
#     that every node type stays inside the docs/sdui.md section 2.5 catalog.
#
# Failure path: the real behavior holds first (a pinned `closable: false` tab
# close is a no-op — proven in the Flutter suite), then the deliberately
# wrong expectation — that the pinned close removes the tab — is run with
# T105_FAIL_MODE=true and must fail; the real behavior is recorded in
# checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T105_INNER:-}" ]; then
  exec env T105_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T105}
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

port=18505
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
  log "T105 QA --fail: a pinned (closable: false) tab close is a no-op"
  log "evidence dir: $evidence"

  # The real behavior holds: the pinned close never removes the tab.
  if bash scripts/qa/flutter-test.sh test/sdui/right_panel_test.dart \
      2>&1 | tee "$evidence/flutter-real.txt" | grep -q 'All tests passed'; then
    ok "the real behavior holds: a pinned tab close is a no-op (flutter-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/flutter-real.txt)"
  fi

  # The deliberately wrong expectation: the pinned close removes the tab.
  # The inverted suite must fail.
  if bash scripts/qa/flutter-test.sh test/sdui/right_panel_test.dart \
      --dart-define=T105_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the pinned tab close removed the tab"
  fi
  {
    echo "FAIL: a pinned (closable: false) tab close removed the tab (as designed)"
    echo "  the real behavior is the opposite: the close is a no-op — the"
    echo "  item stays and no items patch is recorded (the T105.1 pinned"
    echo "  contract); the inverted suite failed as required"
    echo "  (flutter-fail.txt); the real behavior is recorded in"
    echo "  flutter-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the pinned tab close removed the tab (it does not; see $evidence/flutter-fail.txt)"
fi

log "T105 QA: right panel tab bar and sheet chrome"
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

# --- 3. The Flutter right-panel suite ---
bash scripts/qa/flutter-test.sh test/sdui/right_panel_test.dart \
  2>&1 | tee "$evidence/flutter-panel.txt"
grep -q 'All tests passed' "$evidence/flutter-panel.txt" \
  || fail "the Flutter right-panel suite failed (see $evidence/flutter-panel.txt)"
ok "Flutter right-panel suite green: six tabs with close X, patch removal, last-close closeAction, pinned no-op, 17.5rem panelWidth (flutter-panel.txt)"

# --- 4. The golden: the panel tab bar ---
goldens="$evidence/goldens"
rm -rf "$goldens"
bash scripts/qa/flutter-test.sh test/sdui/right_panel_test.dart \
  --update-goldens \
  --dart-define="T105_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
golden_count=$(find "$goldens" -name 'right-panel-*.png' | wc -l)
[ "$golden_count" -ge 1 ] \
  || fail "expected at least 1 panel golden, found $golden_count (goldens/)"
ok "golden written ($golden_count PNG into goldens/)"

bash scripts/qa/flutter-test.sh test/sdui/right_panel_test.dart \
  --dart-define="T105_GOLDEN_DIR=$(readlink -f "$goldens")" \
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

session_id=$(seed_session "$tx" "panel-demo" "/tmp/panel-demo")
ok "seeded one session ($session_id)"

step_hdr "$client_header" "$tx" "fetch-chat" GET "/ui/screen/chat:$session_id" '' 200 \
  '.node.type == "screen"'

# The tabs node over the wire.
jq -S '[.. | objects | select(.id? == "right-panel-tabs")][0]' <<< "$step_payload" \
  > "$evidence/tabs.json"
[ "$(jq -r '.type' "$evidence/tabs.json")" = "tabs" ] \
  || fail "the right-panel tabs node is missing (tabs.json)"

# --- 6. The panel chrome ---
jq -e '
  [.. | objects | select(.id? == "right-panel-slot")][0]
  | .type == "positioned" and .when == "chat_right_panel == true"
    and .top == 0 and .right == 0 and .bottom == 0
' <<< "$step_payload" > /dev/null \
  || fail "the panel overlay slot is wrong (when-gated positioned)"
ok "panel slot: the when-gated positioned overlay (tabs.json)"

jq -e '
  [.. | objects | select(.id? == "right-panel")][0]
  | .type == "container" and .panelWidth == "17.5rem"
    and .color == "$color.sidebar"
    and .border == "$color.sidebar-border" and .borderWidth == 1
' <<< "$step_payload" > /dev/null \
  || fail "the panel sheet chrome is wrong (width/sidebar/border)"
ok "panel chrome: sidebar fill + left hairline + 17.5rem width (tabs.json)"

# The header toggle that opens the panel.
jq -e '
  [.. | objects | select(.id? == "chat_right_panel-toggle")][0]
  | .type == "icon_button" and .demo == true and .action.op == "setState"
' <<< "$step_payload" > /dev/null \
  || fail "the chat header right-panel toggle is wrong"
ok "header toggle: the demo setState shell that opens the panel (tabs.json)"

# --- 7. The six-tab strip ---
jq -e '
  .hasClose == true
  and .demo == true
  and (.items | length) == 6
  and ([.items[].label] == ["Details","Diff","Files","Preview","Pull Requests","Usage"])
  and ([.items[].icon] == ["info","difference","folder","public","call_merge","bar_chart"])
  and (.closeAction.op == "setState" and .closeAction.id == "chat_right_panel"
       and .closeAction.value == false)
' "$evidence/tabs.json" > /dev/null \
  || fail "the six-tab strip is wrong (hasClose/labels/icons/closeAction; tabs.json)"
ok "tab strip: 6 tabs (Details, Diff, Files, Preview, Pull Requests, Usage), hasClose + panel close (tabs.json)"

# --- 8. The Details tab shell ---
jq -e '
  [.. | objects | select(.id? == "right-panel-details")][0] != null
  and [.. | objects | select(.id? == "right-panel-status")][0] != null
  and ([.. | objects | select(.id? == "right-panel-model")][0].children[0].text == "Model")
  and ([.. | objects | select(.id? == "right-panel-effort")][0].children[0].text == "Effort")
  and ([.. | objects | select(.id? == "right-panel-provider")][0].children[0].text == "Provider")
  and ([.. | objects | select(.id? == "right-panel-created")][0].children[0].text == "Created")
  and ([.. | objects | select(.id? == "right-panel-updated")][0].children[0].text == "Updated")
  and ([.. | objects | select(.id? == "right-panel-settled")][0].children[0].text == "Settled")
  and [.. | objects | select(.id? == "right-panel-relationships")][0] != null
  and [.. | objects | select(.id? == "right-panel-rel-corner_left_up")][0].demo == true
  and [.. | objects | select(.id? == "right-panel-prs")][0] != null
  and ([.. | objects | select(.type? == "menu") | .items[]?
         | select(.label? == "Link to thread")] | length) == 2
' <<< "$step_payload" > /dev/null \
  || fail "the Details tab shell is wrong (tabs.json)"
ok "Details shell: status + model/effort/provider + created/updated/settled + relationships + PR rows (tabs.json)"

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

log "T105 QA happy path complete"
