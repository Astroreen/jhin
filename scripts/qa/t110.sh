#!/usr/bin/env bash
# QA for T110: the settings:general and settings:appearance panels (plan
# section 4.2, upstream settings.general.tsx / settings.appearance.tsx).
#
# The General panel carries the upstream fields (Send shortcut, Follow-up
# behavior, Auto-resume limited threads, Snooze limited threads, Working
# section (beta), Auto-settle rules, Auto-settle inactive threads, Default
# settle days, Settle on PR merged, Quit shortcut) in FoldedSettingsSection
# collapsible cards; the Appearance panel carries the theme grid, the
# appearance mode, the canvas/accent seeds, the contrast boost, the chat
# width, the diff colour scheme, the density, the font sizes/families and the
# panel animations. The real fields persist through save-appearance /
# save-thread-behavior; every other control is decorative (demo: true).
# Usage: scripts/qa/t110.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T110. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (SettingsScreenTest carries the T110 asserts);
#   - runs the Flutter settings-appearance suite (flutter-appearance.txt: the
#     folded section, the font clamps, the chat-width segments, the demo
#     markers) and requires "All tests passed";
#   - writes the appearance-panel golden with --update-goldens and re-runs
#     without the flag to verify it byte-for-byte (goldens/);
#   - boots the kernel, round-trips the real fields via curl into
#     roundtrip.json: save-appearance (themeId ocean, dark, compact, 200 ms)
#     then the bootstrap (theme.id ocean, appearance dark, density compact,
#     tokens.motion.panel 200); save-thread-behavior (auto-settle off, 14
#     days) then the settings:general tree (autoSettleDefault false,
#     inactivityDays 14);
#   - asserts the General and Appearance panel fields, the demo markers on
#     the decorative controls, the fold toggles (setState + when) and that
#     every node type stays inside the docs/sdui.md section 2.5 catalog;
#   - runs scripts/qa/t78.sh and scripts/qa/t109.sh as the regression gates
#     (evidence in gate-t78/ and gate-t109/).
#
# Failure path: a panel-motion value out of the 0-400 range is rejected with
# the [patch, toast] validation path; the real behavior is recorded in
# checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T110_INNER:-}" ]; then
  exec env T110_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T110}
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

port=18510
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
  log "T110 QA --fail: an out-of-range panel motion is rejected"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/validation-fail.txt"
  : > "$tx"
  step_hdr "$client_header" "$tx" "save-out-of-range-panel-motion" \
    POST /ui/action/save-appearance \
    '{"action":"save-appearance","payload":{"appearance":"dark","canvas":"#101018","accent":"#ff0000","density":"compact","panelMotionMs":500}}' \
    200 '[.client[].op] == ["patch", "toast"]'
  jq -e '[.client[] | select(.op == "patch")][0].id == "panelMotionMs"' \
    <<< "$step_payload" > /dev/null \
    || fail "the out-of-range answer does not patch the panelMotionMs field (validation-fail.txt)"
  jq -e '[.client[] | select(.op == "toast")][0].style == "error"' \
    <<< "$step_payload" > /dev/null \
    || fail "the out-of-range answer does not toast an error (validation-fail.txt)"
  {
    echo "FAIL: an out-of-range panel motion was rejected with [patch, toast] (as designed)"
    echo "  the failure path is the documented behavior: panelMotionMs 500 is"
    echo "  outside the 0-400 range, so save-appearance patches the field's"
    echo "  errorText and toasts the message without persisting (validation-fail.txt)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: an out-of-range panel motion persisted (it does not; see $evidence/validation-fail.txt)"
fi

log "T110 QA: general and appearance settings panels"
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

# --- 3. The Flutter appearance suite ---
bash scripts/qa/flutter-test.sh test/sdui/settings_appearance_test.dart \
  2>&1 | tee "$evidence/flutter-appearance.txt"
grep -q 'All tests passed' "$evidence/flutter-appearance.txt" \
  || fail "the Flutter settings-appearance suite failed (see $evidence/flutter-appearance.txt)"
ok "Flutter settings-appearance suite green: folded section, font clamps, chat-width segments, demo markers (flutter-appearance.txt)"

# --- 4. The appearance-panel golden ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/settings_appearance_test.dart \
  --update-goldens \
  --dart-define="T110_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
[ -s "$goldens/settings-appearance-light.png" ] \
  || fail "the golden settings-appearance-light.png is missing or empty (goldens/)"
ok "golden written: the appearance panel with every section open, light (goldens/)"

# The verification pass: the same suite without --update-goldens must match
# the written frame byte-for-byte.
bash scripts/qa/flutter-test.sh test/sdui/settings_appearance_test.dart \
  --dart-define="T110_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged from the written frame (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 5. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/roundtrip.txt"
: > "$tx"

# --- 6. The appearance round-trip (the real fields) ---
step_hdr "$client_header" "$tx" "save-appearance" POST /ui/action/save-appearance \
  '{"action":"save-appearance","payload":{"appearance":"dark","themeId":"ocean","canvas":"#000000","accent":"#000000","density":"compact","panelMotionMs":200}}' \
  200 '[.client[].op] == ["toast", "reloadBootstrap"]'
step_hdr "$client_header" "$tx" "bootstrap-after-appearance" GET /_jhin/bootstrap '' 200 \
  '.api == 3'
jq -S . <<< "$step_payload" > "$evidence/bootstrap-after-appearance.json"
jq -e '.theme.id == "ocean" and .theme.appearance == "dark" and .theme.mode == "dark"' \
  "$evidence/bootstrap-after-appearance.json" > /dev/null \
  || fail "the saved themeId/appearance are not in the next bootstrap (bootstrap-after-appearance.json)"
jq -e '.density == "compact" and .tokens.motion.panel == 200' \
  "$evidence/bootstrap-after-appearance.json" > /dev/null \
  || fail "the saved density/panelMotionMs are not in the next bootstrap (bootstrap-after-appearance.json)"
ok "appearance round-trip: themeId ocean, dark, compact, 200 ms in the next bootstrap (bootstrap-after-appearance.json)"

# --- 7. The thread-behavior round-trip (the real fields) ---
step_hdr "$client_header" "$tx" "save-thread-behavior" POST /ui/action/save-thread-behavior \
  '{"action":"save-thread-behavior","payload":{"autoSettleDefault":false,"inactivityDays":14}}' \
  200 '[.client[].op] == ["toast", "refresh"]'
step_hdr "$client_header" "$tx" "settings-general-after" GET "/ui/screen/settings:general" '' 200 \
  '.node.type == "screen"'
jq '.node' <<< "$step_payload" > "$evidence/general-after.json"
jq -e '[.. | objects | select(.id? == "autoSettleDefault")][0].value == false' \
  "$evidence/general-after.json" > /dev/null \
  || fail "the saved auto-settle switch is not off on settings:general (general-after.json)"
jq -e '[.. | objects | select(.id? == "inactivityDays")][0].value == 14' \
  "$evidence/general-after.json" > /dev/null \
  || fail "the saved default settle days are not 14 on settings:general (general-after.json)"
ok "thread-behavior round-trip: auto-settle off and 14 days on settings:general (general-after.json)"

# The combined round-trip record.
jq -n \
  --slurpfile bootstrap "$evidence/bootstrap-after-appearance.json" \
  --slurpfile general "$evidence/general-after.json" \
  '{appearance: {themeId: $bootstrap[0].theme.id, appearance: $bootstrap[0].theme.appearance,
     density: $bootstrap[0].density, panelMotionMs: $bootstrap[0].tokens.motion.panel},
    threadBehavior: {
      autoSettleDefault: ([$general[0] | .. | objects | select(.id? == "autoSettleDefault")][0].value),
      inactivityDays: ([$general[0] | .. | objects | select(.id? == "inactivityDays")][0].value)}}' \
  > "$evidence/roundtrip.json"
ok "round-trip record written (roundtrip.json)"

# --- 8. The General panel fields ---
step_hdr "$client_header" "$tx" "settings-general" GET "/ui/screen/settings:general" '' 200 \
  '.node.type == "screen"'
jq '.node' <<< "$step_payload" > "$evidence/general.json"
for id in sendShortcut followUpBehavior autoResumeLimitedThreads snoozeLimitedThreads \
    workingSection autoSettleRules autoSettleDefault inactivityDays settleOnPrMerged confirmQuit; do
  jq -e --arg id "$id" '[.. | objects | select(.id? == $id)] | length == 1' \
    "$evidence/general.json" > /dev/null \
    || fail "settings:general is missing the '$id' field (general.json)"
done
for id in sendShortcut followUpBehavior autoResumeLimitedThreads snoozeLimitedThreads \
    workingSection autoSettleRules confirmQuit; do
  jq -e --arg id "$id" '[.. | objects | select(.id? == $id)][0].demo == true' \
    "$evidence/general.json" > /dev/null \
    || fail "settings:general does not mark '$id' demo (general.json)"
done
for id in autoSettleDefault inactivityDays settleOnPrMerged; do
  jq -e --arg id "$id" '[.. | objects | select(.id? == $id)][0] | has("demo") | not' \
    "$evidence/general.json" > /dev/null \
    || fail "settings:general wrongly marks the real field '$id' demo (general.json)"
done
jq -e '[.. | objects | select(.id? == "section-general-toggle")][0].when == "fold_general != true"' \
  "$evidence/general.json" > /dev/null \
  || fail "settings:general has no fold toggle (general.json)"
jq -e '[.. | objects | select(.id? == "section-general-toggle")][0].onTap.op == "setState"' \
  "$evidence/general.json" > /dev/null \
  || fail "the settings:general fold toggle does not dispatch setState (general.json)"
ok "settings:general: the upstream fields, the demo markers and the fold toggle (general.json)"

# --- 9. The Appearance panel fields ---
step_hdr "$client_header" "$tx" "settings-appearance" GET "/ui/screen/settings:appearance" '' 200 \
  '.node.type == "screen"'
jq '.node' <<< "$step_payload" > "$evidence/appearance.json"
for id in appearance canvas accent density panelMotionMs contrastBoost chatWidth diffColorScheme \
    fontSizeInterface fontSizePrompt fontSizeCode fontFamilySans fontFamilyCode fontFamilyComposer \
    reducedMotionNote; do
  jq -e --arg id "$id" '[.. | objects | select(.id? == $id)] | length == 1' \
    "$evidence/appearance.json" > /dev/null \
    || fail "settings:appearance is missing the '$id' field (appearance.json)"
done
for id in contrastBoost chatWidth diffColorScheme fontSizeInterface fontSizePrompt fontSizeCode \
    fontFamilySans fontFamilyCode fontFamilyComposer; do
  jq -e --arg id "$id" '[.. | objects | select(.id? == $id)][0].demo == true' \
    "$evidence/appearance.json" > /dev/null \
    || fail "settings:appearance does not mark '$id' demo (appearance.json)"
done
for id in appearance canvas accent density panelMotionMs; do
  jq -e --arg id "$id" '[.. | objects | select(.id? == $id)][0] | has("demo") | not' \
    "$evidence/appearance.json" > /dev/null \
    || fail "settings:appearance wrongly marks the real field '$id' demo (appearance.json)"
done
jq -e '[.. | objects | select(.id? == "contrastBoost")][0] | .min == 0 and .max == 100' \
  "$evidence/appearance.json" > /dev/null \
  || fail "the contrast boost slider is not 0-100 (appearance.json)"
jq -e '[.. | objects | select(.id? == "fontSizeInterface")][0] | .min == 12 and .max == 20' \
  "$evidence/appearance.json" > /dev/null \
  || fail "the interface font-size slider is not 12-20 (appearance.json)"
jq -e '[.. | objects | select(.id? == "fontSizeCode")][0] | .min == 10 and .max == 18' \
  "$evidence/appearance.json" > /dev/null \
  || fail "the code font-size slider is not 10-18 (appearance.json)"
jq -e '[.. | objects | select(.id? == "panelMotionMs")][0] | .min == 0 and .max == 400' \
  "$evidence/appearance.json" > /dev/null \
  || fail "the panel-animations slider is not 0-400 (appearance.json)"
ok "settings:appearance: the upstream fields, the clamps, the demo markers (appearance.json)"

# --- 10. The catalog gate ---
catalog=$(catalog_primitives)
for tree in "$evidence/general.json" "$evidence/appearance.json"; do
  bad_types=$(jq -r '[.. | objects | select(.type? != null) | .type] | unique | .[]' "$tree" \
    | while IFS= read -r t; do
    printf '%s\n' "$catalog" | grep -qx "$t" || echo "$t"
  done)
  if [ -n "$bad_types" ]; then
    fail "node types outside the docs/sdui.md section 2.5 catalog in $tree: $bad_types"
  fi
done
ok "every node type stays inside the docs/sdui.md section 2.5 catalog"

# --- 11. The regression gates ---
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

log "T110 QA happy path complete"
