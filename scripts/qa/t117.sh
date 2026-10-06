#!/usr/bin/env bash
# QA for T117: the demo-marker and disabled-affordance sweep (plan section
# T117; docs/sdui.md section 2.1 level 3 `demo`; plan section 14.10 no silent
# decoration).
#
# The decorative-surface contract is mechanically enforced: every interactive
# node on a decorative screen carries the universal `demo` marker, and no real
# action on a real screen carries it. The server side is the ui-default screen
# registry (plugins/ui-default/.../Screens.java); the client side is the shared
# marker (frontend/lib/sdui/demo_marker.dart) applied by
# frontend/lib/sdui/ui_registry.dart step 13c.
#
# The happy path boots the kernel, fetches every decorative route, runs the
# sweep (the same classification as DemoMarkerSweepTest) and reports the
# per-route interactive-node count; it also asserts the real screens' real
# actions carry no demo mark. The failure path injects an unmarked decorative
# button into a live decorative route and asserts the sweep catches it.
# Usage: scripts/qa/t117.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T117. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.security,
# jhin.ui-kit and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (test.txt) and requires
#     BUILD SUCCESSFUL (DemoMarkerSweepTest carries the T117 asserts);
#   - runs the Flutter demo-marker suite (flutter.txt) and requires "All tests
#     passed" (right_panel_test.dart carries the badge/close-X assert);
#   - boots the kernel, enrolls a device and fetches every decorative route;
#   - runs the sweep per route into sweep.txt and checks.txt, reporting the
#     per-route interactive-node count;
#   - asserts the real screens' real actions carry no demo mark;
#   - runs scripts/qa/t78.sh and scripts/qa/t116.sh as the regression gates
#     (evidence in gate-t78/, gate-t116/).
#
# Failure path: an injected unmarked decorative button is caught by the sweep.
# The real behavior is proven first, then the deliberately wrong expectation —
# that the sweep passes with the injected node — is run and must fail; the
# real behavior is recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T117_INNER:-}" ]; then
  exec env T117_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T117}
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

port=18517
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

client_header='api=3; version=0.3.0; schema=4; caps=sse,open_url'

# The interactive primitive types the sweep inspects (plan section T117).
INTERACTIVE='["button","icon_button","switch","dropdown","input","textarea","tabs"]'
# The server action names that are unambiguously real (they write or drive the
# run lifecycle). The decorative server actions (preview-reload, demo-snooze)
# and the per-command keybind-edit are deliberately absent.
REAL_NAMES='["enroll","create-session","send","cancel","create-provider","delete-provider","reload","undo","keybind-save","keybind-reset","keybind-restore","save-appearance","save-thread-behavior","pin","unpin","settle","unsettle","snooze","wake","archive","restore","regenerate-title","reorder","auto-settle","delete-session","arrange-toggle"]'
# The real client navigation ops.
REAL_OPS='["navigate","replace","refresh","reloadBootstrap","back","openProfiles","openUrl","setToken","clearToken","setServerUrl"]'
# The decorative inline directive ops (plan section 4.4).
DECORATIVE_OPS='["dialog","dismissDialog","setState","patch","setScreen","toast"]'

# sweep <tree-file> <kind> <label>: print the violations of the demo-marker
# sweep for one screen tree. kind is decorative | partly | real. Returns the
# violation lines on stdout (empty when clean).
sweep() {
  local tree=$1 kind=$2
  jq -r --arg kind "$kind" \
    --argjson interactive "$INTERACTIVE" \
    --argjson real_names "$REAL_NAMES" \
    --argjson real_ops "$REAL_OPS" \
    --argjson decorative_ops "$DECORATIVE_OPS" '
    def is_interactive: (.type? as $t | $interactive | index($t)) != null;
    def is_real_action:
      (.action? // {}) as $a
      | (($a.name? // "") as $n | $real_names | index($n)) != null
        or (($a.op? // "") as $o | $real_ops | index($o)) != null;
    def is_decorative_action:
      (.action? // {}) as $a
      | ($a.client? != null)
        or (($a.op? // "") as $o | $decorative_ops | index($o)) != null;
    [ .. | objects
      | select(is_interactive)
      | select(is_real_action | not)
      | select(
          if $kind == "decorative" then true
          elif $kind == "partly" then (.visible? == false or is_decorative_action)
          else false end)
      | select(.demo? != true)
      | "\(.type) id=\(.id) label=\(.label)" ]
    | .[]' "$tree"
}

# sweep_real <tree-file>: print the real actions that wrongly carry demo.
sweep_real() {
  local tree=$1
  jq -r \
    --argjson interactive "$INTERACTIVE" \
    --argjson real_names "$REAL_NAMES" \
    --argjson real_ops "$REAL_OPS" '
    def is_interactive: (.type? as $t | $interactive | index($t)) != null;
    def is_real_action:
      (.action? // {}) as $a
      | (($a.name? // "") as $n | $real_names | index($n)) != null
        or (($a.op? // "") as $o | $real_ops | index($o)) != null;
    [ .. | objects
      | select(is_interactive)
      | select(is_real_action)
      | select(.demo? == true)
      | "\(.type) id=\(.id) label=\(.label)" ]
    | .[]' "$tree"
}

# interactive_count <tree-file>: the number of interactive nodes in the tree.
interactive_count() {
  jq -r --argjson interactive "$INTERACTIVE" \
    '[ .. | objects | select((.type? as $t | $interactive | index($t)) != null) ] | length' "$1"
}

# fetch_screen <id> <out-file>: fetch one screen tree into a file.
fetch_screen() {
  local id=$1 out=$2
  curl -sSk --max-time 10 \
    -H "X-Jhin-Client: $client_header" \
    -H "$auth_header" \
    "$base/ui/screen/$id" > "$out"
  jq -e '.node.type == "screen"' "$out" > /dev/null \
    || fail "GET /ui/screen/$id did not return a screen root (see $out)"
}

if [ "$fail_mode" = "1" ]; then
  log "T117 QA --fail: an injected unmarked decorative button is caught by the sweep"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  run_cli create-account create-account qa
  run_cli create-enrollment create-enrollment qa
  enroll_code=$(sed -n 's/^code: //p' "$evidence/cli-create-enrollment.txt")
  [ -n "$enroll_code" ] \
    || fail "create-enrollment printed no code (see $evidence/cli-create-enrollment.txt)"
  tx="$evidence/fail-transcript.txt"
  : > "$tx"
  step_hdr "$client_header" "$tx" "enroll" POST /enroll \
    "{\"code\":\"$enroll_code\",\"deviceName\":\"t117-qa\"}" 200 \
    '.token != null'
  token=$(jq -r '.token' <<< "$step_payload")
  auth_header="Authorization: Bearer $token"

  # The real behavior holds: the clean usage tree has no violation.
  fetch_screen "usage" "$evidence/fail-usage.json"
  clean=$(sweep "$evidence/fail-usage.json" decorative)
  [ -z "$clean" ] \
    || fail "the clean usage tree already violates the sweep: $clean"
  ok "the clean usage tree passes the sweep (fail-usage.json)"

  # Inject an unmarked decorative button and prove the sweep catches it.
  jq '.node.children += [{"type":"button","label":"Injected","action":{"client":[]}}]' \
    "$evidence/fail-usage.json" > "$evidence/fail-injected.json"
  injected=$(sweep "$evidence/fail-injected.json" decorative)
  if [ -z "$injected" ]; then
    fail "the sweep did not catch the injected unmarked button (fail-injected.json)"
  fi
  {
    echo "FAIL: the injected unmarked decorative button was expected to pass the sweep (as designed)"
    echo "  the real behavior is the opposite: the sweep caught it —"
    printf '  %s\n' "$injected"
    echo "  the clean tree passes (fail-usage.json); the injected tree fails"
    echo "  (fail-injected.json)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the injected unmarked button passed the sweep (it is caught; see $evidence/fail-injected.json)"
fi

log "T117 QA: the demo-marker and disabled-affordance sweep"
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
ok "ui-default and ui-kit suites green ($test_count tests; DemoMarkerSweepTest in test.txt)"

# --- 3. The Flutter demo-marker suite ---
bash scripts/qa/flutter-test.sh test/sdui/right_panel_test.dart \
  2>&1 | tee "$evidence/flutter.txt"
grep -q 'All tests passed' "$evidence/flutter.txt" \
  || fail "the Flutter demo-marker suite failed (see $evidence/flutter.txt)"
ok "Flutter demo-marker suite green: the badge never covers the tab close X (flutter.txt)"

# --- 4. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, security, ui-kit and ui (kernel.log)"

# --- 5. Enroll a device ---
run_cli create-account create-account qa
run_cli create-enrollment create-enrollment qa
enroll_code=$(sed -n 's/^code: //p' "$evidence/cli-create-enrollment.txt")
[ -n "$enroll_code" ] \
  || fail "create-enrollment printed no code (see $evidence/cli-create-enrollment.txt)"
tx="$evidence/sweep-transcript.txt"
: > "$tx"
step_hdr "$client_header" "$tx" "enroll" POST /enroll \
  "{\"code\":\"$enroll_code\",\"deviceName\":\"t117-qa\"}" 200 \
  '.token != null and .accountName == "qa"'
token=$(jq -r '.token' <<< "$step_payload")
[ -n "$token" ] && [ "$token" != "null" ] \
  || fail "POST /enroll returned no token (sweep-transcript.txt)"
auth_header="Authorization: Bearer $token"

# --- 6. The decorative routes: the sweep and the per-route counts ---
DECORATIVE_ROUTES=(
  pull-requests connect usage welcome
  settings:connections settings:integrations settings:projects
  settings:scheduled-tasks settings:source-control settings:snap-shot
)
PARTLY_ROUTES=(settings:general settings:diagnostics settings:storage)
REAL_ROUTES=(
  sessions settings settings:appearance settings:keybindings
  settings:providers settings:archived settings:licenses pair
)

sweep_out="$evidence/sweep.txt"
: > "$sweep_out"
total_interactive=0
for route in "${DECORATIVE_ROUTES[@]}"; do
  file="$evidence/screen-$(echo "$route" | tr ':' '_').json"
  fetch_screen "$route" "$file"
  catalog_gate "$file" "$route"
  count=$(interactive_count "$file")
  total_interactive=$((total_interactive + count))
  violations=$(sweep "$file" decorative)
  if [ -n "$violations" ]; then
    printf 'FAIL %s (%s interactive)\n%s\n' "$route" "$count" "$violations" >> "$sweep_out"
    fail "$route: unmarked decorative interactive nodes: $violations"
  fi
  printf 'ok %s: %s interactive nodes, all decorative nodes demo-marked\n' \
    "$route" "$count" >> "$sweep_out"
done
ok "the fully decorative routes pass the sweep ($total_interactive interactive nodes; sweep.txt)"

for route in "${PARTLY_ROUTES[@]}"; do
  file="$evidence/screen-$(echo "$route" | tr ':' '_').json"
  fetch_screen "$route" "$file"
  catalog_gate "$file" "$route"
  count=$(interactive_count "$file")
  violations=$(sweep "$file" partly)
  if [ -n "$violations" ]; then
    printf 'FAIL %s (%s interactive)\n%s\n' "$route" "$count" "$violations" >> "$sweep_out"
    fail "$route: unmarked decorative parts: $violations"
  fi
  printf 'ok %s: %s interactive nodes, decorative parts demo-marked\n' \
    "$route" "$count" >> "$sweep_out"
done
ok "the partly-real routes pass the sweep on their decorative parts (sweep.txt)"

# --- 7. The inverted check: real screens never demo-mark a real action ---
real_out="$evidence/real-actions.txt"
: > "$real_out"
for route in "${REAL_ROUTES[@]}"; do
  file="$evidence/screen-$(echo "$route" | tr ':' '_').json"
  fetch_screen "$route" "$file"
  catalog_gate "$file" "$route"
  violations=$(sweep_real "$file")
  if [ -n "$violations" ]; then
    printf 'FAIL %s\n%s\n' "$route" "$violations" >> "$real_out"
    fail "$route: a real action carries the demo marker: $violations"
  fi
  printf 'ok %s: no real action carries demo\n' "$route" >> "$real_out"
done
ok "the real screens never demo-mark a real action (real-actions.txt)"

# --- 8. The regression gates ---
bash scripts/qa/t78.sh "$evidence/gate-t78" \
  2>&1 | tee "$evidence/gate-t78.txt"
grep -q 'T78 QA green' "$evidence/gate-t78.txt" \
  || fail "the T78 regression gate did not report green (see $evidence/gate-t78.txt)"
ok "T78 regression gate green: the settings contracts still hold (gate-t78/)"

bash scripts/qa/t116.sh "$evidence/gate-t116" \
  2>&1 | tee "$evidence/gate-t116.txt"
grep -q 'T116 QA happy path complete' "$evidence/gate-t116.txt" \
  || fail "the T116 regression gate did not report green (see $evidence/gate-t116.txt)"
ok "T116 regression gate green: the keybinding surface still holds (gate-t116/)"

log "T117 QA happy path complete"