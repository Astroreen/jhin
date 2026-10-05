#!/usr/bin/env bash
# QA for T85: the six-theme catalogue, bootstrap theme.id and selection
# persistence. Usage: scripts/qa/t85.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T85. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM
# and reaped with `wait`; JSON assertions run with jq (present on the QA
# machine). The kernel boots with jhin.sessions, jhin.ui-kit and jhin.ui.
#
# Happy path:
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL;
#   - runs the Flutter store suites (the 3→4 schema migration, transcript in
#     flutter-store.txt) and the design suites (flutter-design.txt);
#   - fetches GET /_jhin/bootstrap and asserts the default theme block
#     (theme.id t3-chat, appearance system);
#   - fetches GET /ui/screen/settings, records the six theme cards in
#     theme-cards.json and asserts the grid (one card per catalogue theme,
#     the active card outlined, light/dark chips on every card);
#   - posts save-appearance with themeId=ocean (no seeds — the server must
#     re-derive them from the catalogue) and asserts the
#     [toast, reloadBootstrap] answer, then re-fetches the bootstrap and
#     asserts theme.id ocean and theme.accent equal to the ocean card's own
#     light-chip seed — both payloads recorded side by side in
#     theme-roundtrip.json;
#   - posts save-appearance with appearance=dark and themeId=ocean and
#     asserts the dark pair in the next bootstrap;
#   - posts save-appearance with themeId=jhin and asserts the exact pre-plan
#     palette (#16161e / #7E57C2) in the next bootstrap;
#   - asserts every primitive type of the settings tree is in the
#     docs/sdui.md section 2.5 catalog.
#
# Failure path: the same kernel, then save-appearance with themeId=nope —
# the answer must be the validation [patch, toast] path with style:error,
# nothing persisted (the next bootstrap keeps the previous theme), recorded
# in checks-fail.txt.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T85_INNER:-}" ]; then
  exec env T85_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T85}
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

port=18485
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

# step <transcript> <name> <method> <path> <body> <status> <jq>
# Appends the request, status and response to the transcript and asserts both
# the status and the jq expression over the response body. The last response
# body is left in $step_payload for the caller.
step() {
  local tx=$1 name=$2 method=$3 path=$4 body=$5 expected=$6 expr=$7
  local response status payload
  response=$(curl -sS --max-time 10 -X "$method" \
      -H 'Content-Type: application/json' \
      -H 'X-Jhin-Client: api=2; version=0.3.0; schema=4; caps=sse' \
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
  log "T85 QA --fail: an unknown themeId must be rejected without persisting"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/validation-fail.txt"
  : > "$tx"
  step "$tx" "save-unknown-theme" POST /ui/action/save-appearance \
    '{"action":"save-appearance","payload":{"appearance":"light","themeId":"nope","density":"comfortable","panelMotionMs":0}}' \
    200 '[.client[].op] == ["patch", "toast"]'
  jq -e '[.client[] | select(.op == "patch")][0].id == "themeId"' <<< "$step_payload" > /dev/null \
    || fail "the unknown themeId answer does not patch the themeId field (validation-fail.txt)"
  jq -e '[.client[] | select(.op == "toast")][0].style == "error"' <<< "$step_payload" > /dev/null \
    || fail "the unknown themeId answer does not toast an error (validation-fail.txt)"
  fetch_bootstrap "$tx" "$evidence/bootstrap-fail.json"
  jq -e '.theme.id == "t3-chat"' "$evidence/bootstrap-fail.json" > /dev/null \
    || fail "the unknown themeId save changed the theme (bootstrap-fail.json)"
  {
    echo "FAIL: themeId \"nope\" was answered with the documented error (rejected as designed)"
    echo "  server: errorText patch on the themeId field, error toast, nothing persisted (validation-fail.txt)"
    echo "  next bootstrap keeps the default theme t3-chat (bootstrap-fail.json)"
  } | tee -a "$checks"
  ok "--fail probe: unknown themeId rejected with [patch, toast] style:error, nothing persisted"
  fail "deliberately wrong expectation: the unknown themeId \"nope\" was persisted (it is blocked; see $evidence/bootstrap-fail.json)"
fi

log "T85 QA: six-theme catalogue, bootstrap theme.id and selection persistence"
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

# --- 2. The Flutter store and design suites (3→4 migration lives in store/) ---
bash scripts/qa/flutter-test.sh test/store 2>&1 | tee "$evidence/flutter-store.txt"
grep -q 'All tests passed' "$evidence/flutter-store.txt" \
  || fail "the Flutter store suites failed (see $evidence/flutter-store.txt)"
ok "Flutter store suites green: schema 3→4 migration seeds t3-chat, no data loss (flutter-store.txt)"
bash scripts/qa/flutter-test.sh test/design 2>&1 | tee "$evidence/flutter-design.txt"
grep -q 'All tests passed' "$evidence/flutter-design.txt" \
  || fail "the Flutter design suites failed (see $evidence/flutter-design.txt)"
ok "Flutter design suites green (flutter-design.txt)"

# --- 3. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/roundtrip.txt"
: > "$tx"

# --- 4. Bootstrap before: the default theme ---
fetch_bootstrap "$tx" "$evidence/bootstrap-before.json"
jq -e '.theme.id == "t3-chat" and .theme.appearance == "system" and .theme.mode == "system"' \
  "$evidence/bootstrap-before.json" > /dev/null \
  || fail "the default theme is not t3-chat/system (bootstrap-before.json)"
ok "bootstrap defaults: theme.id t3-chat, appearance system (bootstrap-before.json)"

# --- 5. The settings screen: the six theme cards ---
fetch_settings "$tx" "$evidence/settings-tree.json"
for id in t3-chat grove ocean ember iris jhin; do
  jq -e --arg id "theme-$id" '[.. | objects | select(.id? == $id)] | length == 1' \
    "$evidence/settings-tree.json" > /dev/null \
    || fail "the settings tree has no theme card for $id (settings-tree.json)"
done
jq -e '[.. | objects | select(.id? == "theme-t3-chat")][0].border == "$color.primary"' \
  "$evidence/settings-tree.json" > /dev/null \
  || fail "the active theme card is not outlined as active (settings-tree.json)"
for id in t3-chat grove ocean ember iris jhin; do
  jq -e --arg id "chip-$id-light" --arg idd "chip-$id-dark" \
    '([.. | objects | select(.id? == $id)] | length == 1)
     and ([.. | objects | select(.id? == $idd)] | length == 1)' \
    "$evidence/settings-tree.json" > /dev/null \
    || fail "the $id card misses its light/dark preview chips (settings-tree.json)"
done
# The theme cards tree, side by side with the catalogue ids.
jq '{cards: [.. | objects | select((.id? // "") | startswith("theme-"))][0:6]}' \
  "$evidence/settings-tree.json" > "$evidence/theme-cards.json"
ok "theme grid: six cards, active outlined, light+dark chips (theme-cards.json)"

# --- 6. Selecting ocean: the server re-derives the seeds ---
ocean_light=$(jq -r '[.. | objects | select(.id? == "chip-ocean-light")][0].color' \
  "$evidence/settings-tree.json")
ocean_dark=$(jq -r '[.. | objects | select(.id? == "chip-ocean-dark")][0].color' \
  "$evidence/settings-tree.json")
[ -n "$ocean_light" ] && [ "$ocean_light" != "null" ] \
  || fail "the ocean light chip carries no seed color (settings-tree.json)"
step "$tx" "save-theme-ocean" POST /ui/action/save-appearance \
  '{"action":"save-appearance","payload":{"appearance":"light","themeId":"ocean","density":"comfortable","panelMotionMs":0}}' \
  200 '[.client[].op] == ["toast", "reloadBootstrap"]'
fetch_bootstrap "$tx" "$evidence/bootstrap-ocean.json"
jq -e '.theme.id == "ocean" and .theme.appearance == "light"' \
  "$evidence/bootstrap-ocean.json" > /dev/null \
  || fail "the saved theme is not ocean in the next bootstrap (bootstrap-ocean.json)"
jq -e --arg accent "$ocean_light" '.theme.accent == $accent' \
  "$evidence/bootstrap-ocean.json" > /dev/null \
  || fail "the bootstrap accent is not the ocean catalogue seed (bootstrap-ocean.json)"
jq -n --slurpfile before "$evidence/bootstrap-before.json" \
      --slurpfile after "$evidence/bootstrap-ocean.json" \
  '{before: $before[0], after: $after[0]}' > "$evidence/theme-roundtrip.json"
ok "theme round-trip: ocean selected, accent re-derived from the catalogue (theme-roundtrip.json)"

# --- 7. The dark pair follows the saved appearance ---
step "$tx" "save-theme-ocean-dark" POST /ui/action/save-appearance \
  '{"action":"save-appearance","payload":{"appearance":"dark","themeId":"ocean","density":"comfortable","panelMotionMs":0}}' \
  200 '[.client[].op] == ["toast", "reloadBootstrap"]'
fetch_bootstrap "$tx" "$evidence/bootstrap-ocean-dark.json"
jq -e --arg accent "$ocean_dark" '.theme.id == "ocean" and .theme.accent == $accent' \
  "$evidence/bootstrap-ocean-dark.json" > /dev/null \
  || fail "the dark appearance does not carry the ocean dark seed (bootstrap-ocean-dark.json)"
ok "dark pair: ocean under appearance dark answers the dark seed (bootstrap-ocean-dark.json)"

# --- 8. The jhin theme reproduces the exact pre-plan palette ---
step "$tx" "save-theme-jhin" POST /ui/action/save-appearance \
  '{"action":"save-appearance","payload":{"appearance":"dark","themeId":"jhin","density":"comfortable","panelMotionMs":0}}' \
  200 '[.client[].op] == ["toast", "reloadBootstrap"]'
fetch_bootstrap "$tx" "$evidence/bootstrap-jhin.json"
jq -e '.theme.id == "jhin" and .theme.canvas == "#16161e" and .theme.accent == "#7E57C2"' \
  "$evidence/bootstrap-jhin.json" > /dev/null \
  || fail "the jhin theme does not reproduce the pre-plan palette (bootstrap-jhin.json)"
ok "jhin identity: canvas #16161e, accent #7E57C2 (bootstrap-jhin.json)"

# --- 9. Only documented primitives in the settings tree ---
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
ok "settings tree uses only documented primitives"

log "T85 QA green: six-theme catalogue, bootstrap theme.id and persistence verified"
