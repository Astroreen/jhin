#!/usr/bin/env bash
# QA for T115: the command-palette parity — the four result groups
# (Actions / Threads / Projects / Models) with upper-case headers and counts,
# the `ThreadCommandSubtitle`-style muted subtitles, the right-aligned `kbd`
# hints, the `>`-prefix action filter and the disabled row for an unregistered
# keymap command (plan section T115; upstream apps/web/src/components/
# CommandPalette.tsx, CommandPalette.logic.ts, CommandPaletteResults.tsx and
# ThreadCommandSubtitle.tsx, commit 37de6cb).
#
# The palette itself is client-owned Flutter chrome (frontend/lib/sdui/
# keyboard/palette.dart); its two server sources are the search route
# (`POST /ui/action/search`, the Threads group) and the bootstrap `palette`
# block (`GET /_jhin/bootstrap`, the Actions/Models groups built from
# KeybindCatalog via ClientKeybindings). The happy path probes both over HTTP
# and groups them into palette.json; the Flutter suite asserts the rendered
# grouping, the `>` filter, the subtitles and the disabled affordance.
# Usage: scripts/qa/t115.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T115. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.security,
# jhin.ui-kit and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (KeybindActionsTest carries the T115 palette
#     metadata asserts);
#   - runs the full Flutter suite (flutter.txt) and requires "All tests
#     passed" (palette_groups_test.dart carries the T115 client asserts);
#   - boots the kernel, enrolls a device and creates a searchable session;
#   - POSTs /ui/action/search for the session title and asserts the thread
#     hits (palette-transcript.txt);
#   - fetches /_jhin/bootstrap and asserts the four `palette` groups with
#     their counts and the caller's effective chords;
#   - combines both sources into evidence/T115/palette.json and asserts the
#     grouped results;
#   - runs scripts/qa/t78.sh and scripts/qa/t114.sh as the regression gates
#     (evidence in gate-t78/, gate-t114/).
#
# Failure path: an unregistered command id in the keymap renders a disabled
# row and logs. The real behavior is proven by the Flutter suite, then the
# deliberately wrong expectation — that the unregistered command is
# dispatchable — is run with T115_FAIL_MODE=true and must fail; the real
# behavior is recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T115_INNER:-}" ]; then
  exec env T115_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T115}
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

port=18515
# The security plugin installs the TLS keystore, so the kernel serves HTTPS.
base="https://localhost:$port"

# wait_health <url> <timeout-seconds>: poll until the health endpoint answers
wait_health() {
  local url=$1 deadline=$(( $(date +%s) + $2 ))
  until curl -sfk --max-time 3 "$url" > /dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

# kernel_jar: the executable kernel boot jar (the CLI entry point).
kernel_jar() {
  ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$' | head -n 1
}

boot_kernel() {
  ./gradlew :jhin-plugin-sessions:jar :jhin-plugin-security:jar \
    :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar
  local home
  home=$(mktemp -d)
  mkdir -p "$home/plugins"
  cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$home/plugins/"
  cp plugins/security/build/libs/jhin-plugin-security-*.jar "$home/plugins/"
  cp plugins/ui-kit/build/libs/jhin-plugin-ui-kit-*.jar "$home/plugins/"
  cp plugins/ui-default/build/libs/jhin-plugin-ui-default-*.jar "$home/plugins/"
  # The subshell execs into run-kernel.sh (and that into the JVM), so
  # $kernel_pid is the JVM process itself and the cleanup TERM reaches it.
  ( JHIN_HOME="$home" \
      exec scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" ) &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 60 || fail "the kernel did not become healthy (see $kernel_log_dir/kernel.log)"
  jhin_home="$home"
}

# run_cli <label> <command> [args...]: run one admin CLI command against the
# running kernel's JHIN_HOME.
run_cli() {
  local label=$1
  shift
  JHIN_HOME="$jhin_home" timeout 120 java -jar "$(kernel_jar)" cli "$@" \
    > "$evidence/cli-$label.txt" 2> "$evidence/cli-$label.err" \
    || fail "cli $* failed (see $evidence/cli-$label.err)"
}

# step_hdr <client-header> <transcript> <name> <method> <path> <body>
# <expected-status> <jq-expr> — the t78 step helper with the X-Jhin-Client
# value as the first argument.
step_hdr() {
  local hdr=$1 tx=$2 name=$3 method=$4 path=$5 body=$6 expected=$7 expr=$8
  local response status payload
  local auth=()
  if [ -n "${auth_header:-}" ]; then
    auth=(-H "$auth_header")
  fi
  response=$(curl -sSk --max-time 10 -X "$method" \
      -H 'Content-Type: application/json' \
      -H "X-Jhin-Client: $hdr" \
      "${auth[@]}" \
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

client_header='api=3; version=0.3.0; schema=4; caps=sse,open_url'

if [ "$fail_mode" = "1" ]; then
  log "T115 QA --fail: an unregistered command id in the keymap renders a disabled row and logs"
  log "evidence dir: $evidence"

  # The real behavior holds: the unregistered command renders disabled and is
  # logged. The real test must pass.
  if bash scripts/qa/flutter-test.sh test/keyboard/palette_groups_test.dart \
      --plain-name 'unregistered keymap command renders' \
      2>&1 | tee "$evidence/test-real.txt" | grep -q 'All tests passed'; then
    ok "the real behavior holds: the unregistered keymap command renders a disabled row and logs (test-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/test-real.txt)"
  fi

  # The deliberately wrong expectation: the unregistered command is
  # dispatchable. The inverted suite must fail.
  if T115_FAIL_MODE=true bash scripts/qa/flutter-test.sh \
      test/keyboard/palette_groups_test.dart --plain-name 'fail-mode' \
      2>&1 | tee "$evidence/test-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the unregistered command was dispatchable"
  fi
  {
    echo "FAIL: the unregistered keymap command was dispatchable (as designed)"
    echo "  the real behavior is the opposite: an id the registry does not know"
    echo "  renders a disabled palette row and is logged once; the inverted"
    echo "  suite failed as required (test-fail.txt); the real behavior is"
    echo "  recorded in test-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the unregistered command was dispatchable (it is disabled; see $evidence/test-fail.txt)"
fi

log "T115 QA: the command-palette groups, subtitles, action prefix and disabled affordance"
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

# --- 3. The full Flutter suite ---
bash scripts/qa/flutter-test.sh test \
  2>&1 | tee "$evidence/flutter.txt"
grep -q 'All tests passed' "$evidence/flutter.txt" \
  || fail "the Flutter suite failed (see $evidence/flutter.txt)"
ok "Flutter suite green (flutter.txt)"

# --- 4. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, security, ui-kit and ui (kernel.log)"

# --- 5. Enroll a device and create a searchable session ---
run_cli create-account create-account qa
run_cli create-enrollment create-enrollment qa
enroll_code=$(sed -n 's/^code: //p' "$evidence/cli-create-enrollment.txt")
[ -n "$enroll_code" ] \
  || fail "create-enrollment printed no code (see $evidence/cli-create-enrollment.txt)"
tx="$evidence/palette-transcript.txt"
: > "$tx"
step_hdr "$client_header" "$tx" "enroll" POST /enroll \
  "{\"code\":\"$enroll_code\",\"deviceName\":\"t115-qa\"}" 200 \
  '.token != null and .accountName == "qa"'
token=$(jq -r '.token' <<< "$step_payload")
[ -n "$token" ] && [ "$token" != "null" ] \
  || fail "POST /enroll returned no token (palette-transcript.txt)"
auth_header="Authorization: Bearer $token"
step_hdr "$client_header" "$tx" "create-session" POST /ui/action/create-session \
  '{"action":"create-session","payload":{"title":"Palette probe thread","workdir":"/home/astroreen/Documents/jhin"}}' \
  200 '[.client[].op] == ["navigate"]'
ok "enrolled and created a searchable session (palette-transcript.txt)"

# --- 6. The search route: the Threads group source ---
step_hdr "$client_header" "$tx" "palette-search" POST /ui/action/search \
  '{"query":"palette"}' 200 '.results | length >= 1'
jq '.results' <<< "$step_payload" > "$evidence/search-results.json"
jq -e '[.[] | select(.kind == "session")] | length >= 1' \
  "$evidence/search-results.json" > /dev/null \
  || fail "the search route returned no session hit (search-results.json)"
ok "search route: the session title is a Threads-group hit (search-results.json)"

# --- 7. The bootstrap palette block: the Actions/Models group source ---
step_hdr "$client_header" "$tx" "palette-metadata" GET /_jhin/bootstrap '' 200 \
  '.palette | length == 4'
jq '.palette' <<< "$step_payload" > "$evidence/bootstrap-palette.json"
jq -e '[.[] | select(.value == "actions")][0].count >= 33' \
  "$evidence/bootstrap-palette.json" > /dev/null \
  || fail "the palette actions group carries fewer than 33 commands (bootstrap-palette.json)"
jq -e '[.[] | select(.value == "models")][0].count == 3' \
  "$evidence/bootstrap-palette.json" > /dev/null \
  || fail "the palette models group is not the three decorative rows (bootstrap-palette.json)"
jq -e '[.[] | select(.value == "models")][0].items | all(.demo == true)' \
  "$evidence/bootstrap-palette.json" > /dev/null \
  || fail "a decorative model row is not demo-marked (bootstrap-palette.json)"
jq -e '[.[] | select(.value == "actions")][0].items[] | select(.id == "composer.send") | .chord == "mod+enter"' \
  "$evidence/bootstrap-palette.json" > /dev/null \
  || fail "the actions group does not carry the effective composer.send chord (bootstrap-palette.json)"
jq -e '[.[] | select(.value == "actions")][0].items[] | select(.id == "composer.send") | .subtitle == "composer.send"' \
  "$evidence/bootstrap-palette.json" > /dev/null \
  || fail "the actions group does not carry the muted command-id subtitle (bootstrap-palette.json)"
ok "bootstrap palette: four groups, 33+ actions, three demo models, effective chords (bootstrap-palette.json)"

# --- 8. The combined grouped results ---
jq -n \
  --slurpfile meta "$evidence/bootstrap-palette.json" \
  --slurpfile hits "$evidence/search-results.json" '
  {
    groups: ($meta[0] | map(
      if .value == "threads"
      then . + {count: ($hits[0] | length), items: $hits[0]}
      else . end))
  }' > "$evidence/palette.json"
jq -e '.groups | length == 4' "$evidence/palette.json" > /dev/null \
  || fail "palette.json does not carry the four groups"
jq -e '[.groups[] | select(.value == "actions")][0].count >= 33' \
  "$evidence/palette.json" > /dev/null \
  || fail "palette.json actions count is wrong"
jq -e '[.groups[] | select(.value == "threads")][0].count >= 1' \
  "$evidence/palette.json" > /dev/null \
  || fail "palette.json threads count is wrong"
jq -e '[.groups[] | select(.value == "models")][0].count == 3' \
  "$evidence/palette.json" > /dev/null \
  || fail "palette.json models count is wrong"
ok "palette.json: the four grouped result sets with counts (palette.json)"

# --- 9. The regression gates ---
bash scripts/qa/t78.sh "$evidence/gate-t78" \
  2>&1 | tee "$evidence/gate-t78.txt"
grep -q 'T78 QA green' "$evidence/gate-t78.txt" \
  || fail "the T78 regression gate did not report green (see $evidence/gate-t78.txt)"
ok "T78 regression gate green: the settings contracts still hold (gate-t78/)"

bash scripts/qa/t114.sh "$evidence/gate-t114" \
  2>&1 | tee "$evidence/gate-t114.txt"
grep -q 'T114 QA happy path complete' "$evidence/gate-t114.txt" \
  || fail "the T114 regression gate did not report green (see $evidence/gate-t114.txt)"
ok "T114 regression gate green: the welcome/connect/pair/project screens still hold (gate-t114/)"

log "T115 QA happy path complete"
