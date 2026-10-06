#!/usr/bin/env bash
# QA for T116: the keybinding surface parity — the twelve upstream `when`
# contexts (plus the three Jhin palette/sidebar keys), the `!` / `&&` / `||` /
# paren grammar, last-match-wins precedence, the upstream default chords in
# the server keymap and the `X-Jhin-Keybindings` header size decision
# (plan section T116; upstream packages/shared/src/keybindings.ts and
# apps/web/src/keybindings.ts, commit 37de6cb).
#
# The client side is Flutter (frontend/lib/sdui/keyboard/when_context.dart,
# keymap.dart, command_shortcuts.dart); the server side is the bootstrap
# `keymap` block (plugins/ui-default/.../DefaultKeymap.java). The happy path
# runs the keyboard suites (when.txt), fetches the live bootstrap keymap
# (keymap.json) and asserts the upstream chords, the docs when-keys table and
# the header-size decision; the failure path proves an unknown `when` key
# evaluates false and never throws.
# Usage: scripts/qa/t116.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T116. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.security,
# jhin.ui-kit and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (test.txt) and requires
#     BUILD SUCCESSFUL;
#   - runs the Flutter keyboard suites (when.txt) and requires "All tests
#     passed" (when_context_test.dart, keymap_test.dart,
#     keybinding_parity_test.dart carry the T116 asserts);
#   - boots the kernel, enrolls a device and fetches /_jhin/bootstrap;
#   - writes the bootstrap `keymap` to keymap.json and asserts every T116
#     upstream chord resolves to its command id;
#   - asserts the docs/sdui.md section 4.1 when-keys table lists all fifteen
#     contexts;
#   - measures the X-Jhin-Keybindings header worst case and records the
#     section 15.7 decision in checks.txt;
#   - runs scripts/qa/t78.sh and scripts/qa/t115.sh as the regression gates
#     (evidence in gate-t78/, gate-t115/).
#
# Failure path: an unknown `when` key evaluates false (documented) and never
# throws. The real behavior is proven by the Flutter suite, then the
# deliberately wrong expectation — that the unknown key evaluates true — is
# run with T116_FAIL_MODE=true and must fail; the real behavior is recorded
# in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T116_INNER:-}" ]; then
  exec env T116_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T116}
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

port=18516
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
  log "T116 QA --fail: an unknown when key evaluates false (documented) and never throws"
  log "evidence dir: $evidence"

  # The real behavior holds: an unknown when key evaluates false and never
  # throws. The real test must pass.
  if bash scripts/qa/flutter-test.sh \
      test/keyboard/keybinding_parity_test.dart \
      --plain-name 'unknown when keys evaluate false and never throw' \
      2>&1 | tee "$evidence/test-real.txt" | grep -q 'All tests passed'; then
    ok "the real behavior holds: an unknown when key evaluates false and never throws (test-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/test-real.txt)"
  fi

  # The deliberately wrong expectation: the unknown when key evaluates true.
  # The inverted suite must fail.
  if T116_FAIL_MODE=true bash scripts/qa/flutter-test.sh \
      test/keyboard/keybinding_parity_test.dart --plain-name 'fail-mode' \
      2>&1 | tee "$evidence/test-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the unknown when key evaluated true"
  fi
  {
    echo "FAIL: the unknown when key was expected to evaluate true (as designed)"
    echo "  the real behavior is the opposite: an unknown context name evaluates"
    echo "  false and the evaluator never throws; the inverted suite failed as"
    echo "  required (test-fail.txt); the real behavior is recorded in"
    echo "  test-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the unknown when key evaluated true (it evaluates false; see $evidence/test-fail.txt)"
fi

log "T116 QA: when-contexts, chords and last-match-wins precedence"
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

# --- 3. The Flutter keyboard suites (when.txt) ---
bash scripts/qa/flutter-test.sh test/keyboard \
  2>&1 | tee "$evidence/when.txt"
grep -q 'All tests passed' "$evidence/when.txt" \
  || fail "the Flutter keyboard suites failed (see $evidence/when.txt)"
ok "Flutter keyboard suites green: when-contexts, chords and precedence (when.txt)"

# --- 4. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, security, ui-kit and ui (kernel.log)"

# --- 5. Enroll a device and fetch the bootstrap keymap ---
run_cli create-account create-account qa
run_cli create-enrollment create-enrollment qa
enroll_code=$(sed -n 's/^code: //p' "$evidence/cli-create-enrollment.txt")
[ -n "$enroll_code" ] \
  || fail "create-enrollment printed no code (see $evidence/cli-create-enrollment.txt)"
tx="$evidence/keymap-transcript.txt"
: > "$tx"
step_hdr "$client_header" "$tx" "enroll" POST /enroll \
  "{\"code\":\"$enroll_code\",\"deviceName\":\"t116-qa\"}" 200 \
  '.token != null and .accountName == "qa"'
token=$(jq -r '.token' <<< "$step_payload")
[ -n "$token" ] && [ "$token" != "null" ] \
  || fail "POST /enroll returned no token (keymap-transcript.txt)"
auth_header="Authorization: Bearer $token"
step_hdr "$client_header" "$tx" "bootstrap-keymap" GET /_jhin/bootstrap '' 200 \
  '.keymap | length >= 20'
jq '.keymap' <<< "$step_payload" > "$evidence/keymap.json"
ok "bootstrap keymap captured (keymap.json)"

# --- 6. The T116 upstream chords resolve to their command ids ---
assert_chord() {
  local key=$1 command=$2 when=$3
  if [ -n "$when" ]; then
    jq -e --arg k "$key" --arg c "$command" --arg w "$when" \
      '[.[] | select(.key == $k and .command == $c and .when == $w)] | length == 1' \
      "$evidence/keymap.json" > /dev/null \
      || fail "the keymap lacks $key -> $command when $when (keymap.json)"
  else
    jq -e --arg k "$key" --arg c "$command" \
      '[.[] | select(.key == $k and .command == $c)] | length >= 1' \
      "$evidence/keymap.json" > /dev/null \
      || fail "the keymap lacks $key -> $command (keymap.json)"
  fi
}
assert_chord 'mod+[' 'navigation.back' '!terminalFocus'
assert_chord 'mod+]' 'navigation.forward' '!terminalFocus'
assert_chord 'mod+j' 'terminal.toggle' ''
assert_chord 'mod+w' 'terminal.close' 'terminalFocus'
assert_chord 'mod+w' 'rightPanel.close' '!terminalFocus'
assert_chord 'mod+alt+n' 'chat.newWithoutProject' '!terminalFocus'
assert_chord 'mod+shift+enter' 'thread.steerQueuedMessage' '!terminalFocus'
assert_chord 'mod+1' 'thread.jump1' 'isDesktop'
assert_chord 'mod+9' 'thread.jump9' 'isDesktop'
ok "every T116 upstream chord resolves to its command id (keymap.json)"

# --- 7. The docs when-keys table (section 4.1) ---
when_table=$(awk '/^### 4\.1 /{f=1;next} /^## /{f=0} f' docs/sdui.md)
[ -n "$when_table" ] || fail "docs/sdui.md has no section 4.1 when-keys table"
for context in terminalFocus terminalOpen previewFocus previewOpen \
    modelPickerOpen usagePageOpen composerFocus composerDraft turnRunning \
    editableFocus isWeb isDesktop sidebarFocus paletteOpen modalOpen; do
  grep -q "\`$context\`" <<< "$when_table" \
    || fail "the section 4.1 when-keys table lacks $context"
done
grep -q 'matching rule wins' <<< "$when_table" \
  || fail "the section 4.1 table does not document last-match-wins"
ok "docs/sdui.md section 4.1 lists all fifteen when contexts and last-match-wins"

# --- 8. The X-Jhin-Keybindings header size decision (section 15.7) ---
# The header carries only the user overrides (store shape), never the default
# keymap — the defaults already travel in the bootstrap payload. Measure the
# worst case (every catalogue command overridden) and record the decision.
header_bytes=$(jq -c '{rules: [.[] | {command: .command, keys: .key}]}' \
    "$evidence/keymap.json" | wc -c | tr -d ' ')
if [ "$header_bytes" -le 4096 ]; then
  {
    echo "ok: X-Jhin-Keybindings header worst case is ${header_bytes} bytes (<= 4096)"
    echo "  decision: keep the keymap in the bootstrap payload and the user"
    echo "  overrides in the header. The header carries only the override rules"
    echo "  (store shape {\"rules\":[{command,keys}]}), never the default set, so"
    echo "  the enlarged command set does not grow the per-request header."
  } | tee -a "$checks"
else
  fail "the X-Jhin-Keybindings header worst case is ${header_bytes} bytes (> 4096); move the keymap to the bootstrap payload"
fi

# --- 9. The regression gates ---
bash scripts/qa/t78.sh "$evidence/gate-t78" \
  2>&1 | tee "$evidence/gate-t78.txt"
grep -q 'T78 QA green' "$evidence/gate-t78.txt" \
  || fail "the T78 regression gate did not report green (see $evidence/gate-t78.txt)"
ok "T78 regression gate green: the settings contracts still hold (gate-t78/)"

bash scripts/qa/t115.sh "$evidence/gate-t115" \
  2>&1 | tee "$evidence/gate-t115.txt"
grep -q 'T115 QA happy path complete' "$evidence/gate-t115.txt" \
  || fail "the T115 regression gate did not report green (see $evidence/gate-t115.txt)"
ok "T115 regression gate green: the palette groups still hold (gate-t115/)"

log "T116 QA happy path complete"
