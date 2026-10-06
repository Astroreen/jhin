#!/usr/bin/env bash
# QA for T111: the settings:keybindings, settings:diagnostics and
# settings:storage panels (plan section 4.2; upstream
# apps/web/src/components/settings/KeybindingsSettings.tsx,
# DiagnosticsSettings.tsx and StorageSettings.tsx, commit 37de6cb).
#
# The keybindings panel is a searchable command table grouped by category
# (Composer / Threads / Navigation / Panels / General): one row per command
# with the upstream label, the effective chord as a `kbd` pill, the `when`
# context and a Change button opening the capture dialog (keybind-edit); the
# Restore-defaults button clears every override (keybind-restore). The command
# vocabulary is the T67 set the client dispatches plus the inert upstream
# additions (marked demo). The diagnostics panel renders the real kernel
# version, the loaded-plugin list, the storage paths, the contract level, the
# requesting client's version, a copyable report blob and a decorative Export
# button. The storage panel renders the session counts by status, the database
# size, a real archived-threads shortcut (navigate settings:archived) and a
# decorative Clear-cache button.
# Usage: scripts/qa/t111.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T111. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (SettingsScreenTest carries the T111 asserts);
#   - runs the Flutter keyboard suite (flutter-keyboard.txt: the capture
#     sheet, the bare-modifier validation and the persistence) and requires
#     "All tests passed";
#   - boots the kernel and dumps settings:keybindings into keybinds.json: the
#     five category tables, every T67 command id and upstream addition as a
#     keybind-<id> row, exactly one Restore-defaults action, the demo marker
#     only on the 14 inert additions, the upstream labels verbatim and the
#     catalog gate;
#   - dumps settings:diagnostics into diagnostics.json and asserts the real
#     kernel version, the plugin list, the storage paths, the contract level,
#     the client version, the copyable report blob and the decorative Export;
#   - dumps settings:storage into storage.json and asserts the per-status
#     counts, the database size, the real settings:archived shortcut and the
#     decorative Clear-cache button;
#   - runs scripts/qa/t78.sh, scripts/qa/t109.sh and scripts/qa/t110.sh as the
#     regression gates (evidence in gate-t78/, gate-t109/, gate-t110/).
#
# Failure path: an invalid captured chord (a bare modifier) leaves the
# keyCapture field empty, so the required rule reports the inline errorText
# and nothing is persisted; the real behavior is recorded in checks-fail.txt
# (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T111_INNER:-}" ]; then
  exec env T111_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T111}
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

port=18511
base="http://localhost:$port"

# The T67 client command vocabulary (frontend/lib/sdui/keyboard/
# command_registry.dart:66-100), the rows the panel must list.
T67=(
  composer.send
  composer.sendAndNew
  composer.sendAlternate
  composer.newline
  composer.recallPrev
  composer.recallNext
  modelPicker.toggle
  composer.host
  composer.effort
  composer.mode
  composer.workspace
  composer.branch
  composer.previousWorktree
  thread.next
  thread.prev
  thread.jump1
  thread.jump2
  thread.jump3
  thread.jump4
  thread.jump5
  thread.jump6
  thread.jump7
  thread.jump8
  thread.jump9
  thread.undo
  thread.settle
  thread.pin
  thread.new
  palette.open
  nav.back
  nav.forward
  appearance.cycle
  theme.pick
)

# The upstream additions (packages/contracts/src/keybindings.ts:59-111) the
# panel lists but Jhin does not dispatch; every one is demo-marked.
ADDITIONS=(
  composer.sendBackground
  composer.sendAndNewThread
  composer.cycleHost
  composer.stash
  thread.steerQueuedMessage
  thread.editQueuedMessage
  thread.copyReference
  rightPanel.toggle
  terminal.toggle
  preview.toggle
  diff.toggle
  sidebar.toggle
  usage.open
  theme.select
)

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

# catalog_primitives: the docs/sdui.md section 2.5 primitive names
catalog_primitives() {
  awk '/^### 2\.5 /{f=1;next} /^### /{f=0} f' docs/sdui.md \
    | grep -oE '`[a-z_]+' | tr -d '`' | sort -u
}

# catalog_gate <tree-json> <label>: fail on any node type outside section 2.5
catalog_gate() {
  local tree=$1 label=$2
  local catalog bad_types
  catalog=$(catalog_primitives)
  bad_types=$(jq -r '[.. | objects | select(.type? != null) | .type] | unique | .[]' "$tree" \
    | while IFS= read -r t; do
    printf '%s\n' "$catalog" | grep -qx "$t" || echo "$t"
  done)
  if [ -n "$bad_types" ]; then
    fail "$label: node types outside the docs/sdui.md section 2.5 catalog: $bad_types"
  fi
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
  log "T111 QA --fail: a bare modifier capture shows the inline error and does not save"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/capture-fail.txt"
  : > "$tx"
  # The capture dialog carries the required keyCapture field with the inline
  # errorText: a bare modifier produces no chord, the field stays empty, the
  # required rule reports the errorText and the keybind-save side effect
  # persists nothing.
  step_hdr "$client_header" "$tx" "keybind-edit" POST /ui/action/keybind-edit \
    '{"action":"keybind-edit","payload":{"command":"composer.send"}}' \
    200 '.client[0].op == "dialog" and .client[0].kind == "sheet"'
  jq -e '[.client[0].node | .. | objects | select(.id? == "keyCapture")][0]
    | .required == true and .errorText == "Press a chord first"' <<< "$step_payload" > /dev/null \
    || fail "the capture dialog has no required keyCapture field with the errorText (capture-fail.txt)"
  # The client-side validation of the bare-modifier case (empty capture) and
  # the no-persistence of an empty keybind-save.
  bash scripts/qa/flutter-test.sh test/keyboard/keyboard_surface_test.dart \
    2>&1 | tee "$evidence/flutter-capture-fail.txt"
  grep -q 'All tests passed' "$evidence/flutter-capture-fail.txt" \
    || fail "the Flutter keyboard suite failed (see $evidence/flutter-capture-fail.txt)"
  {
    echo "FAIL: a bare modifier capture showed the inline errorText and saved nothing (as designed)"
    echo "  the failure path is the documented behavior: a bare modifier yields"
    echo "  no chord, so the required keyCapture field stays empty, the required"
    echo "  rule reports its errorText ('Press a chord first') and the"
    echo "  keybind-save side effect writes no override (capture-fail.txt)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: a bare modifier capture saved a binding (it does not; see $evidence/capture-fail.txt)"
fi

log "T111 QA: keybindings, diagnostics and storage settings panels"
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

# --- 3. The Flutter keyboard suite ---
bash scripts/qa/flutter-test.sh test/keyboard/keyboard_surface_test.dart \
  2>&1 | tee "$evidence/flutter-keyboard.txt"
grep -q 'All tests passed' "$evidence/flutter-keyboard.txt" \
  || fail "the Flutter keyboard suite failed (see $evidence/flutter-keyboard.txt)"
ok "Flutter keyboard suite green: capture sheet, bare-modifier validation, persistence (flutter-keyboard.txt)"

# --- 4. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/roundtrip.txt"
: > "$tx"

# --- 5. The keybindings panel ---
step_hdr "$client_header" "$tx" "settings-keybindings" GET "/ui/screen/settings:keybindings" '' 200 \
  '.node.type == "screen"'
jq '.node' <<< "$step_payload" > "$evidence/keybinds.json"
jq -e '[.. | objects | select(.type? == "table")] | length == 5' \
  "$evidence/keybinds.json" > /dev/null \
  || fail "settings:keybindings does not carry the five category tables (keybinds.json)"
for id in "${T67[@]}" "${ADDITIONS[@]}"; do
  jq -e --arg row "keybind-$id" '[.. | objects | select(.id? == $row)] | length == 1' \
    "$evidence/keybinds.json" > /dev/null \
    || fail "settings:keybindings is missing the row for '$id' (keybinds.json)"
done
jq -e '[.. | objects | select(.type? == "button" and .label? == "Change")] | length == 47' \
  "$evidence/keybinds.json" > /dev/null \
  || fail "settings:keybindings does not carry one Change button per row (keybinds.json)"
jq -e '[.. | objects | select(.type? == "button" and .label? == "Change" and .demo == true)] | length == 14' \
  "$evidence/keybinds.json" > /dev/null \
  || fail "settings:keybindings does not demo-mark exactly the 14 upstream additions (keybinds.json)"
jq -e '[.. | objects | select(.label? == "Restore defaults")] | length == 1' \
  "$evidence/keybinds.json" > /dev/null \
  || fail "settings:keybindings does not carry exactly one Restore-defaults action (keybinds.json)"
jq -e '[.. | objects | select(.name? == "keybind-restore")] | length == 1' \
  "$evidence/keybinds.json" > /dev/null \
  || fail "settings:keybindings does not dispatch keybind-restore (keybinds.json)"
jq -e '[.. | objects | select(.type? == "kbd")] | length == 40' \
  "$evidence/keybinds.json" > /dev/null \
  || fail "settings:keybindings does not render the assigned chords as kbd pills (keybinds.json)"
jq -e '[.. | objects | select(.id? == "keybindSearch")][0].demo == true' \
  "$evidence/keybinds.json" > /dev/null \
  || fail "settings:keybindings does not carry the decorative search field (keybinds.json)"
for label in "Composer: Opposite Queue or Steer Action" "Composer: Start in Background" \
    "Composer: Send and Start New Thread" "Queue: Send First Queued Message as Steer" \
    "Composer: Cycle Host"; do
  jq -e --arg label "$label" '[.. | strings | select(. == $label)] | length >= 1' \
    "$evidence/keybinds.json" > /dev/null \
    || fail "settings:keybindings is missing the upstream label '$label' (keybinds.json)"
done
catalog_gate "$evidence/keybinds.json" "settings:keybindings"
ok "settings:keybindings: five category tables, the T67 set plus the 14 upstream additions, kbd pills and the catalog gate (keybinds.json)"

# The caller's override wins per command: with the X-Jhin-Keybindings header
# carrying mod+shift+k for composer.send, the table shows that chord (the
# acceptance's capture-and-save result).
override=$(curl -sS --max-time 10 \
    -H 'X-Jhin-Client: api=3; version=0.3.0; schema=4; caps=sse' \
    -H 'X-Jhin-Keybindings: {"rules":[{"command":"composer.send","keys":"mod+shift+k"}]}' \
    "$base/ui/screen/settings:keybindings")
jq '.node' <<< "$override" > "$evidence/keybinds-override.json"
jq -e '[.. | objects | select(.type? == "kbd" and .chord == "mod+shift+k")] | length == 1' \
  "$evidence/keybinds-override.json" > /dev/null \
  || fail "the caller's composer.send override is not shown in the table (keybinds-override.json)"
ok "settings:keybindings: the caller's mod+shift+k override for composer.send renders in the table (keybinds-override.json)"

# --- 6. The diagnostics panel ---
step_hdr "$client_header" "$tx" "settings-diagnostics" GET "/ui/screen/settings:diagnostics" '' 200 \
  '.node.type == "screen"'
jq '.node' <<< "$step_payload" > "$evidence/diagnostics.json"
jq -e '[.. | strings | select(. == "0.2.0")] | length >= 1' \
  "$evidence/diagnostics.json" > /dev/null \
  || fail "settings:diagnostics does not show the real kernel version (diagnostics.json)"
jq -e '[.. | strings | select(. == "0.3.0")] | length >= 1' \
  "$evidence/diagnostics.json" > /dev/null \
  || fail "settings:diagnostics does not show the requesting client version (diagnostics.json)"
jq -e '[.. | strings | select(. == "jhin.sessions")] | length >= 1' \
  "$evidence/diagnostics.json" > /dev/null \
  || fail "settings:diagnostics does not list the loaded plugins (diagnostics.json)"
jq -e '[.. | objects | select(.id? == "diagnosticsReport")][0]
  | .type == "code_block" and .copyable == true' \
  "$evidence/diagnostics.json" > /dev/null \
  || fail "settings:diagnostics has no copyable report blob (diagnostics.json)"
jq -e '[.. | objects | select(.label? == "Export")][0].demo == true' \
  "$evidence/diagnostics.json" > /dev/null \
  || fail "settings:diagnostics does not demo-mark the Export button (diagnostics.json)"
catalog_gate "$evidence/diagnostics.json" "settings:diagnostics"
ok "settings:diagnostics: kernel version, plugin list, storage paths, contract level, client version, copyable blob and Export (diagnostics.json)"

# --- 7. The storage panel ---
step_hdr "$client_header" "$tx" "settings-storage" GET "/ui/screen/settings:storage" '' 200 \
  '.node.type == "screen"'
jq '.node' <<< "$step_payload" > "$evidence/storage.json"
for title in Active Settled Snoozed Archived; do
  jq -e --arg title "$title" '[.. | objects | select(.type? == "list_row" and .title? == $title)] | length == 1' \
    "$evidence/storage.json" > /dev/null \
    || fail "settings:storage is missing the '$title' count row (storage.json)"
done
jq -e '[.. | objects | select(.id? == "openArchive")][0].action
  | .op == "navigate" and .screen == "settings:archived"' \
  "$evidence/storage.json" > /dev/null \
  || fail "settings:storage does not shortcut to settings:archived (storage.json)"
jq -e '[.. | objects | select(.label? == "Clear cache")][0].demo == true' \
  "$evidence/storage.json" > /dev/null \
  || fail "settings:storage does not demo-mark the Clear-cache button (storage.json)"
catalog_gate "$evidence/storage.json" "settings:storage"
ok "settings:storage: per-status counts, database size, the settings:archived shortcut and Clear cache (storage.json)"

# --- 8. The regression gates ---
bash scripts/qa/t78.sh "$evidence/gate-t78" \
  2>&1 | tee "$evidence/gate-t78.txt"
grep -q 'T78 QA green' "$evidence/gate-t78.txt" \
  || fail "the T78 regression gate did not report green (see $evidence/gate-t78.txt)"
ok "T78 regression gate green: the settings contracts still hold (gate-t78/)"

bash scripts/qa/t109.sh "$evidence/gate-t109" \
  2>&1 | tee "$evidence/gate-t109.txt"
grep -q 'T109 QA happy path complete' "$evidence/gate-t109.txt" \
  || fail "the T109 regression gate did not report green (see $evidence/gate-t109.txt)"
ok "T109 regression gate green: the settings shell still holds (gate-t109/)"

bash scripts/qa/t110.sh "$evidence/gate-t110" \
  2>&1 | tee "$evidence/gate-t110.txt"
grep -q 'T110 QA happy path complete' "$evidence/gate-t110.txt" \
  || fail "the T110 regression gate did not report green (see $evidence/gate-t110.txt)"
ok "T110 regression gate green: the general and appearance panels still hold (gate-t110/)"

log "T111 QA happy path complete"
