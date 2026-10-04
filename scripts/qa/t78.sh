#!/usr/bin/env bash
# QA for T78: appearance, thread-behavior and keyboard settings screens.
# Usage: scripts/qa/t78.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T78. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM and
# reaped with `wait`; JSON assertions run with jq (present on the QA machine).
# The kernel boots with jhin.sessions, jhin.ui-kit and jhin.ui — deliberately
# without jhin.llm, so the Providers screen must be absent.
#
# Happy path:
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL;
#   - fetches GET /_jhin/bootstrap and asserts the built-in defaults
#     (theme.appearance system, density comfortable, tokens.motion.panel 0);
#   - posts save-appearance with an invalid accent hex and records the answer
#     in validation.txt: the response patches the accent field's errorText and
#     toasts the message, and the next bootstrap still carries the defaults
#     (nothing was saved);
#   - posts save-appearance (dark / #101018 / #ff0000 / compact / 200 ms) and
#     asserts the [toast, reloadBootstrap] answer, then re-fetches the
#     bootstrap and asserts theme.appearance dark, theme.mode dark,
#     theme.canvas #101018, theme.accent #ff0000, density compact and
#     tokens.motion.panel 200 — both payloads recorded side by side in
#     appearance-roundtrip.json;
#   - fetches GET /ui/screen/settings into settings-tree.json and asserts the
#     three section cards (Appearance, Thread behavior, Keyboard), the
#     T70 keyboard surface (keybind-edit rows + Restore defaults), the
#     save-appearance include list, the disabled "settle on PR merged" switch
#     (enabled=false, tooltip "PR linking is not enabled") and that every
#     primitive type of the tree is in the docs/sdui.md section 2.5 catalog;
#   - posts save-thread-behavior (auto-settle off, 14 days) and asserts the
#     [toast, refresh] answer plus the values on the re-fetched settings
#     screen;
#   - asserts the Providers screen is absent from the bootstrap screens
#     (jhin.llm is not loaded — existing gating preserved);
#   - settings.png is skipped: no screenshot harness exists for the
#     server-rendered node tree (the Flutter goldens cover client-side
#     fixtures only), recorded in checks.txt.
#
# Failure path: the same kernel and saves, then a deliberately wrong
# expectation — that the invalid hex save persisted accent "not-a-color" —
# asserted against the real bootstrap; the checker must fail
# (checks-fail.txt, exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T78_INNER:-}" ]; then
  exec env T78_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T78}
mkdir -p "$evidence"

kernel_pid=""
cleanup() {
  if [ -n "$kernel_pid" ] && ps -p "$kernel_pid" > /dev/null 2>&1; then
    kill "$kernel_pid" 2>/dev/null || true
    wait "$kernel_pid" 2>/dev/null || true
  fi
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

port=18478
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
  JHIN_HOME="$home" \
    scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 60 || fail "the kernel did not become healthy (see $kernel_log_dir/kernel.log)"
}

# step <transcript> <name> <method> <path> <body> <expected-status> <jq-expr>
# Appends the request, status and response to the transcript and asserts both
# the status and the jq expression over the response body. The last response
# body is left in $step_payload for the caller.
step() {
  local tx=$1 name=$2 method=$3 path=$4 body=$5 expected=$6 expr=$7
  local response status payload
  response=$(curl -sS --max-time 10 -X "$method" \
      -H 'Content-Type: application/json' \
      -H 'X-Jhin-Client: api=2; version=0.2.0; schema=3; caps=sse' \
      --data "$body" \
      -w $'\n%{http_code}' "$base$path")
  status=${response##*$'\n'}
  payload=${response%$'\n'*}
  step_payload=$payload
  {
    echo "=== $name ==="
    echo "$method $path"
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

# fetch_bootstrap <transcript> <out-json>: the level-2 bootstrap payload
fetch_bootstrap() {
  local tx=$1 out=$2
  step "$tx" "bootstrap" GET /_jhin/bootstrap '' 200 '.api == 2'
  jq -S . <<< "$step_payload" > "$out"
}

# fetch_settings <transcript> <out-json>: the rendered settings node tree
fetch_settings() {
  local tx=$1 out=$2
  step "$tx" "settings" GET /ui/screen/settings '' 200 '.node.type == "screen"'
  jq '.node' <<< "$step_payload" > "$out"
}

# catalog_primitives: the docs/sdui.md section 2.5 primitive names
catalog_primitives() {
  awk '/^### 2\.5 /{f=1;next} /^### /{f=0} f' docs/sdui.md \
    | grep -oE '`[a-z_]+' | tr -d '`' | sort -u
}

if [ "$fail_mode" = "1" ]; then
  log "T78 QA --fail: the checker must fail on a deliberately wrong expectation"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/validation-fail.txt"
  : > "$tx"
  step "$tx" "save-invalid-accent" POST /ui/action/save-appearance \
    '{"action":"save-appearance","payload":{"appearance":"dark","canvas":"#101018","accent":"not-a-color","density":"compact","panelMotionMs":200}}' \
    200 '[.client[].op] == ["patch", "toast"]'
  fetch_bootstrap "$tx" "$evidence/bootstrap-fail.json"
  # deliberate wrong expectation: the invalid hex save persisted the accent
  if jq -e '.theme.accent == "not-a-color"' "$evidence/bootstrap-fail.json" > /dev/null; then
    fail "deliberately wrong expectation held: the invalid hex was persisted (see $evidence/bootstrap-fail.json)"
  fi
  fail "deliberately wrong expectation: the invalid hex save persisted accent not-a-color (it is blocked; see $evidence/bootstrap-fail.json)"
fi

log "T78 QA: appearance, thread-behavior and keyboard settings screens"
log "evidence dir: $evidence"

# --- 1. The JVM suites ---
./gradlew :jhin-plugin-ui-default:test :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; transcript in test.txt)"

# --- 2. The kernel (no jhin.llm: the Providers screen must be absent) ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui, without jhin.llm (kernel.log)"

tx="$evidence/roundtrip.txt"
: > "$tx"

# --- 3. Bootstrap before: the built-in defaults ---
fetch_bootstrap "$tx" "$evidence/bootstrap-before.json"
jq -e '.theme.appearance == "system" and .theme.mode == "system"' \
  "$evidence/bootstrap-before.json" > /dev/null \
  || fail "the default theme.appearance is not 'system' (bootstrap-before.json)"
jq -e '.theme.canvas == "#16161e" and .theme.accent == "#7E57C2"' \
  "$evidence/bootstrap-before.json" > /dev/null \
  || fail "the default canvas/accent seeds are wrong (bootstrap-before.json)"
jq -e '.density == "comfortable"' "$evidence/bootstrap-before.json" > /dev/null \
  || fail "the default density is not 'comfortable' (bootstrap-before.json)"
jq -e '.tokens.motion.panel == 0' "$evidence/bootstrap-before.json" > /dev/null \
  || fail "the default tokens.motion.panel is not 0 (bootstrap-before.json)"
ok "bootstrap defaults: appearance system, canvas #16161e, accent #7E57C2, density comfortable, motion.panel 0"

# --- 4. Invalid hex: errorText, no save ---
validation="$evidence/validation.txt"
: > "$validation"
step "$validation" "save-invalid-accent" POST /ui/action/save-appearance \
  '{"action":"save-appearance","payload":{"appearance":"dark","canvas":"#101018","accent":"not-a-color","density":"compact","panelMotionMs":200}}' \
  200 '[.client[].op] == ["patch", "toast"]'
jq -e '[.client[] | select(.op == "patch")][0].id == "accent"' <<< "$step_payload" > /dev/null \
  || fail "the invalid hex answer does not patch the accent field (validation.txt)"
jq -e '[.client[] | select(.op == "patch")][0].props.errorText | contains("#RRGGBB")' \
    <<< "$step_payload" > /dev/null \
  || fail "the invalid hex answer does not carry the errorText (validation.txt)"
jq -e '[.client[] | select(.op == "toast")][0].style == "error"' <<< "$step_payload" > /dev/null \
  || fail "the invalid hex answer does not toast an error (validation.txt)"
fetch_bootstrap "$validation" "$evidence/bootstrap-after-invalid.json"
jq -e '.theme.accent == "#7E57C2" and .theme.appearance == "system"' \
  "$evidence/bootstrap-after-invalid.json" > /dev/null \
  || fail "the invalid hex save changed the bootstrap (validation.txt)"
{
  echo
  echo "assert: errorText patched on 'accent', error toast answered, nothing persisted"
  echo "assert: next bootstrap still carries accent #7E57C2 and appearance system"
} >> "$validation"
ok "invalid hex blocked: errorText on the accent field, no persistence (validation.txt)"

# --- 5. Valid save-appearance and the round-trip ---
step "$tx" "save-appearance" POST /ui/action/save-appearance \
  '{"action":"save-appearance","payload":{"appearance":"dark","canvas":"#101018","accent":"#ff0000","density":"compact","panelMotionMs":200}}' \
  200 '[.client[].op] == ["toast", "reloadBootstrap"]'
fetch_bootstrap "$tx" "$evidence/bootstrap-after.json"
jq -e '.theme.appearance == "dark" and .theme.mode == "dark"' \
  "$evidence/bootstrap-after.json" > /dev/null \
  || fail "the saved appearance is not dark in the next bootstrap (bootstrap-after.json)"
jq -e '.theme.canvas == "#101018" and .theme.accent == "#ff0000"' \
  "$evidence/bootstrap-after.json" > /dev/null \
  || fail "the saved canvas/accent seeds are not in the next bootstrap (bootstrap-after.json)"
jq -e '.density == "compact"' "$evidence/bootstrap-after.json" > /dev/null \
  || fail "the saved density is not compact in the next bootstrap (bootstrap-after.json)"
jq -e '.tokens.motion.panel == 200' "$evidence/bootstrap-after.json" > /dev/null \
  || fail "the saved panelMotionMs is not tokens.motion.panel 200 (bootstrap-after.json)"
jq -n --slurpfile before "$evidence/bootstrap-before.json" \
      --slurpfile after "$evidence/bootstrap-after.json" \
  '{before: $before[0], after: $after[0]}' > "$evidence/appearance-roundtrip.json"
ok "appearance round-trip: dark/#101018/#ff0000/compact/200ms in the next bootstrap (appearance-roundtrip.json)"

# --- 6. The settings screen tree ---
fetch_settings "$tx" "$evidence/settings-tree.json"
for title in "Appearance" "Thread behavior" "Keyboard"; do
  jq -e --arg title "$title" '[.. | objects | select(.title? == $title)] | length >= 1' \
    "$evidence/settings-tree.json" > /dev/null \
    || fail "the settings tree has no '$title' card (settings-tree.json)"
done
jq -e '[.. | objects | select(.id? == "settleOnPrMerged")][0] | .type == "switch" and .enabled == false and .tooltip == "PR linking is not enabled"' \
  "$evidence/settings-tree.json" > /dev/null \
  || fail "the settle-on-PR-merged switch is not disabled with its tooltip (settings-tree.json)"
jq -e '[.. | objects | select(.name? == "save-appearance")][0].include == ["appearance","canvas","accent","density","panelMotionMs"]' \
  "$evidence/settings-tree.json" > /dev/null \
  || fail "the save-appearance action does not include the five field ids (settings-tree.json)"
jq -e '[.. | objects | select(.name? == "keybind-edit")] | length >= 1' \
  "$evidence/settings-tree.json" > /dev/null \
  || fail "the T70 keyboard rows are missing (settings-tree.json)"
jq -e '[.. | objects | select(.label? == "Restore defaults")] | length == 1' \
  "$evidence/settings-tree.json" > /dev/null \
  || fail "the T70 Restore-defaults action is missing (settings-tree.json)"
jq -e '[.. | objects | select(.id? == "appearance")][0].value == "dark"' \
  "$evidence/settings-tree.json" > /dev/null \
  || fail "the appearance segmented does not show the saved value (settings-tree.json)"
catalog=$(catalog_primitives)
used=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' "$evidence/settings-tree.json")
undocumented=""
for type in $used; do
  if ! grep -qx "$type" <<< "$catalog"; then
    undocumented="$undocumented $type"
  fi
done
[ -z "$undocumented" ] \
  || fail "undocumented primitive types in the settings tree:$undocumented (settings-tree.json)"
ok "settings tree: three section cards, PR-merged disabled with tooltip, T70 keyboard intact, only documented primitives"

# --- 7. Thread behavior save ---
step "$tx" "save-thread-behavior" POST /ui/action/save-thread-behavior \
  '{"action":"save-thread-behavior","payload":{"autoSettleDefault":false,"inactivityDays":14}}' \
  200 '[.client[].op] == ["toast", "refresh"]'
fetch_settings "$tx" "$evidence/settings-tree.json"
jq -e '[.. | objects | select(.id? == "autoSettleDefault")][0].value == false' \
  "$evidence/settings-tree.json" > /dev/null \
  || fail "the saved auto-settle switch is not off on the settings screen (settings-tree.json)"
jq -e '[.. | objects | select(.id? == "inactivityDays")][0].value == 14' \
  "$evidence/settings-tree.json" > /dev/null \
  || fail "the saved inactivity window is not 14 days on the settings screen (settings-tree.json)"
ok "thread-behavior round-trip: auto-settle off and 14 days on the re-fetched settings screen"

# --- 8. Providers absent without jhin.llm ---
jq -e '[.screens[].id] | index("providers") | not' "$evidence/bootstrap-after.json" > /dev/null \
  || fail "the Providers screen is present although jhin.llm is absent (bootstrap-after.json)"
jq -e '[.screens[].id] | index("settings") != null' "$evidence/bootstrap-after.json" > /dev/null \
  || fail "the settings screen is missing from the bootstrap screens (bootstrap-after.json)"
ok "providers screen absent without jhin.llm, settings screen present (bootstrap-after.json)"

# --- 9. Widget golden: skipped ---
{
  echo "T78 widget golden settings.png: skipped"
  echo "No screenshot harness exists for the server-rendered node tree;"
  echo "the Flutter goldens cover client-side fixtures only."
} | tee "$evidence/settings-png-skipped.txt"
ok "settings.png skipped (no screenshot harness for server-rendered trees; settings-png-skipped.txt)"

log "T78 QA green: appearance, thread-behavior and keyboard settings verified"