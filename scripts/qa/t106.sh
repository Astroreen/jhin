#!/usr/bin/env bash
# QA for T106: the decorative terminal drawer — the grip handle, the
# `Terminal` title, the close X and the fixture transcript, with the grip
# resize (min 100 px, max 50% of the viewport) persisted under
# `terminal_height`, the Escape close and the mod+w close precedence.
#
# The drawer is a `container` in the shell's `terminal` slot, gated by the
# chat header's `chat_terminal` setState toggle; the body is the
# `fixtures/terminal-fixtures.json` transcript rendered as a `code_block`.
# There is no PTY (plan section 14.1): the transcript is a build-time
# fixture.
# Usage: scripts/qa/t106.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T106. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (TerminalDrawerTest carries the T106 tree
#     asserts);
#   - runs the Flutter terminal-drawer suite (flutter-drawer.txt: the open /
#     hidden states, the 100 px clamp, the 50% cap, the `terminal_height`
#     persistence, the Escape close and the mod+w precedence) and requires
#     "All tests passed";
#   - writes the open-drawer pixel golden into goldens/ (flutter test
#     --update-goldens with T106_GOLDEN_DIR) and proves it byte-stable
#     (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel, fetches the sessions shell and dumps the terminal
#     drawer node into drawer.json;
#   - asserts the drawer chrome (the when-gated container, the code token
#     pair, the border, the resize / persistence props), the header (the
#     grip, the title, the close X) and the fixture transcript, and that
#     every node type stays inside the docs/sdui.md section 2.5 catalog.
#
# Failure path: the real behavior holds first (a drag below 100 px clamps at
# 100 — proven in the Flutter suite), then the deliberately wrong
# expectation — that the drag drops below the floor — is run with
# T106_FAIL_MODE=true and must fail; the real behavior is recorded in
# checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T106_INNER:-}" ]; then
  exec env T106_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T106}
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

port=18506
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
  log "T106 QA --fail: a drag below 100 px clamps at 100"
  log "evidence dir: $evidence"

  # The real behavior holds: the drag clamps at the 100 px floor.
  if bash scripts/qa/flutter-test.sh test/sdui/terminal_drawer_test.dart \
      2>&1 | tee "$evidence/flutter-real.txt" | grep -q 'All tests passed'; then
    ok "the real behavior holds: a drag below 100 px clamps at 100 (flutter-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/flutter-real.txt)"
  fi

  # The deliberately wrong expectation: the drag drops below the floor.
  # The inverted suite must fail.
  if bash scripts/qa/flutter-test.sh test/sdui/terminal_drawer_test.dart \
      --dart-define=T106_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the drag dropped below the 100 px floor"
  fi
  {
    echo "FAIL: a drag below 100 px dropped the drawer height below the floor (as designed)"
    echo "  the real behavior is the opposite: the drag clamps at 100 px —"
    echo "  the T106.2 floor contract; the inverted suite failed as required"
    echo "  (flutter-fail.txt); the real behavior is recorded in"
    echo "  flutter-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the drag dropped below the 100 px floor (it does not; see $evidence/flutter-fail.txt)"
fi

log "T106 QA: decorative terminal drawer with grip resize"
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

# --- 3. The Flutter terminal-drawer suite ---
bash scripts/qa/flutter-test.sh test/sdui/terminal_drawer_test.dart \
  2>&1 | tee "$evidence/flutter-drawer.txt"
grep -q 'All tests passed' "$evidence/flutter-drawer.txt" \
  || fail "the Flutter terminal-drawer suite failed (see $evidence/flutter-drawer.txt)"
ok "Flutter terminal-drawer suite green: open/hidden, 100 px clamp, 50% cap, terminal_height persistence, Escape close, mod+w precedence (flutter-drawer.txt)"

# --- 4. The golden: the open drawer ---
goldens="$evidence/goldens"
rm -rf "$goldens"
bash scripts/qa/flutter-test.sh test/sdui/terminal_drawer_test.dart \
  --update-goldens \
  --dart-define="T106_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
golden_count=$(find "$goldens" -name 'terminal-drawer-*.png' | wc -l)
[ "$golden_count" -ge 1 ] \
  || fail "expected at least 1 drawer golden, found $golden_count (goldens/)"
ok "golden written ($golden_count PNG into goldens/)"

bash scripts/qa/flutter-test.sh test/sdui/terminal_drawer_test.dart \
  --dart-define="T106_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 5. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/drawer-transcript.txt"
: > "$tx"

step_hdr "$client_header" "$tx" "fetch-shell" GET "/ui/screen/sessions" '' 200 \
  '.node.type == "screen"'

# The terminal drawer node over the wire.
jq -S '[.. | objects | select(.id? == "terminal-drawer")][0]' <<< "$step_payload" \
  > "$evidence/drawer.json"
[ "$(jq -r '.type' "$evidence/drawer.json")" = "container" ] \
  || fail "the terminal drawer node is missing (drawer.json)"

# --- 6. The drawer chrome ---
jq -e '
  .type == "container"
  and .direction == "column"
  and .when == "chat_terminal == true"
  and .color == "$color.code"
  and .border == "$color.border" and .borderWidth == 1
  and .initialHeight == 240
  and .minDrawerHeight == 100
  and .maxDrawerRatio == 0.5
  and .persistKey == "terminal_height"
  and .closeState == "chat_terminal"
  and .cursorColor == "$color.foreground"
  and .selectionColor == "$color.accent"
' "$evidence/drawer.json" > /dev/null \
  || fail "the drawer chrome is wrong (token pair / border / resize props; drawer.json)"
ok "drawer chrome: code token pair + border + 100/50% resize + terminal_height persistence (drawer.json)"

# --- 7. The header: grip, title, close X ---
jq -e '
  [.. | objects | select(.id? == "terminal-drawer-grip")][0].icon == "drag_indicator"
  and ([.. | objects | select(.text? == "Terminal")] | length) >= 1
  and ([.. | objects | select(.id? == "terminal-drawer-close")][0]
       | .icon == "close"
         and .action.op == "setState"
         and .action.id == "chat_terminal"
         and .action.value == false)
' "$evidence/drawer.json" > /dev/null \
  || fail "the drawer header is wrong (grip / title / close X; drawer.json)"
ok "header: drag_indicator grip + Terminal title + close X (setState chat_terminal=false) (drawer.json)"

# --- 8. The fixture transcript ---
jq -e '
  [.. | objects | select(.id? == "terminal-drawer-transcript")][0]
  | .type == "code_block"
    and .language == "shell"
    and .syntax == true
    and (.code | contains("$ jhin health"))
    and (.code | contains("ok"))
    and (.code | split("\n") | length) == 20
' "$evidence/drawer.json" > /dev/null \
  || fail "the fixture transcript is wrong (code_block / 20 lines; drawer.json)"
ok "body: the 20-line terminal-fixtures.json transcript as a syntax code_block (drawer.json)"

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

log "T106 QA happy path complete"
