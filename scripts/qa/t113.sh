#!/usr/bin/env bash
# QA for T113: the usage and pull-requests screens (plan section 4.2;
# upstream apps/web/src/routes/usage.tsx, _chat.pull-requests.tsx and
# components/usage/*, components/pullRequest/*, commit 37de6cb).
#
# Both screens are decorative full-page surfaces: the usage page renders the
# token summary, one meter card per provider (a chart_line over the fixture's
# 30-day series), the limit-source meters and the per-provider rows; the
# pull-requests page renders the list (number, title, branch chip, status
# badge) and the detail card (summary, Summary/Timeline/Code tabs over a
# decorative diff_view, the Link-to-thread menu and the Unlink action). Every
# interactive node is demo: true (plan section 14.10); the fixtures are read
# at build time and never fetched (plan section 14.1).
# Usage: scripts/qa/t113.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T113. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.llm,
# jhin.qa-mock-llm, jhin.ui-kit and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (UsageScreenTest / PullRequestsScreenTest
#     carry the T113 asserts);
#   - runs the full Flutter suite (flutter.txt) and requires "All tests passed";
#   - boots the kernel, steps both screens with `step`, dumps every tree into
#     evidence/T113/{usage,pull-requests}.json and asserts each is a `screen`
#     root with the shell and the body;
#   - asserts the usage fixture rows, the 30-point chart series, the three
#     limit sources and the demo-marked Add-usage-limit-source dialog;
#   - asserts the pull-request rows, the four states, the detail tabs, the
#     demo-marked diff_view and the Link-to-thread menu;
#   - asserts every interactive node carries demo: true and that every node
#     type stays inside the docs/sdui.md section 2.5 catalog;
#   - runs scripts/qa/t78.sh and scripts/qa/t112.sh as the regression gates
#     (evidence in gate-t78/, gate-t112/).
#
# Failure path: an empty fixture renders the NoProjectsHero-style empty state
# (not a blank screen). The real behavior is proven by the Flutter suite, then
# the deliberately wrong expectation — that the empty fixture renders a blank
# screen — is run with T113_FAIL_MODE=true and must fail; the real behavior is
# recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T113_INNER:-}" ]; then
  exec env T113_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T113}
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

port=18513
base="http://localhost:$port"

# The two T113 screens (plan section 4.2).
ROUTES=(
  usage
  pull-requests
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
  ./gradlew :jhin-plugin-sessions:jar :jhin-plugin-llm:jar :jhin-plugin-qa-mock-llm:jar \
    :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar
  local home
  home=$(mktemp -d)
  mkdir -p "$home/plugins"
  cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$home/plugins/"
  cp plugins/llm/build/libs/jhin-plugin-llm-*.jar "$home/plugins/"
  cp plugins/qa-mock-llm/build/libs/jhin-plugin-qa-mock-llm-*.jar "$home/plugins/"
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
  log "T113 QA --fail: an empty fixture renders the empty state, not a blank screen"
  log "evidence dir: $evidence"

  # The real behavior holds: the empty fixture renders the empty-state hero.
  if bash scripts/qa/flutter-test.sh test/sdui/usage_pull_requests_test.dart \
      2>&1 | tee "$evidence/flutter-real.txt" | grep -q 'All tests passed'; then
    ok "the real behavior holds: an empty fixture renders the empty state (flutter-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/flutter-real.txt)"
  fi

  # The deliberately wrong expectation: the empty fixture renders a blank
  # screen. The inverted suite must fail.
  if bash scripts/qa/flutter-test.sh test/sdui/usage_pull_requests_test.dart \
      --dart-define=T113_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the empty fixture rendered a blank screen"
  fi
  {
    echo "FAIL: an empty fixture rendered a blank screen (as designed)"
    echo "  the real behavior is the opposite: the empty fixture renders the"
    echo "  NoProjectsHero-style empty state — the T113 empty-state contract;"
    echo "  the inverted suite failed as required (flutter-fail.txt); the real"
    echo "  behavior is recorded in flutter-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the empty fixture rendered a blank screen (it does not; see $evidence/flutter-fail.txt)"
fi

log "T113 QA: the usage and pull-requests screens"
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
ok "kernel booted with sessions, llm, qa-mock-llm, ui-kit and ui (kernel.log)"

tx="$evidence/routes-transcript.txt"
: > "$tx"

# --- 5. The two T113 screens ---
routes_dir="$evidence/routes"
rm -rf "$routes_dir"
mkdir -p "$routes_dir"
for id in "${ROUTES[@]}"; do
  safe=${id//:/_}
  step_hdr "$client_header" "$tx" "route-$id" GET "/ui/screen/$id" '' 200 \
    '.node.type == "screen"'
  jq '.node' <<< "$step_payload" > "$evidence/$safe.json"
  jq -e '
    .type == "screen"
    and ([.. | objects | select(.type? == "shell")] | length == 1)
  ' "$evidence/$safe.json" > /dev/null \
    || fail "$id: the screen root / shell is wrong ($safe.json)"
done
ok "both T113 screens: screen root and shell (usage.json, pull-requests.json)"

# --- 6. The usage fixture content ---
jq -e '[.. | objects | select(.id? == "usage-chart-codex")][0].type == "chart_line"' \
  "$evidence/usage.json" > /dev/null \
  || fail "usage: the codex meter card is missing (usage.json)"
jq -e '[.. | objects | select(.id? == "usage-chart-claude")][0].type == "chart_line"' \
  "$evidence/usage.json" > /dev/null \
  || fail "usage: the claude meter card is missing (usage.json)"
jq -e '[.. | objects | select(.type? == "chart_line")] | length == 2' \
  "$evidence/usage.json" > /dev/null \
  || fail "usage: expected two chart_line meter cards (usage.json)"
jq -e '[.. | objects | select(.type? == "chart_line")][0].series[0].values | length == 30' \
  "$evidence/usage.json" > /dev/null \
  || fail "usage: the chart series is not 30 points (usage.json)"
for id in codex-weekly claude-5h claude-weekly; do
  jq -e --arg row "limit-$id" '[.. | objects | select(.id? == $row)] | length == 1' \
    "$evidence/usage.json" > /dev/null \
    || fail "usage: the limit source '$id' is missing (usage.json)"
done
jq -e '[.. | objects | select(.id? == "usage-provider-codex")] | length == 1' \
  "$evidence/usage.json" > /dev/null \
  || fail "usage: the codex provider row is missing (usage.json)"
jq -e '[.. | objects | select(.id? == "addUsageLimitSource")][0].demo == true' \
  "$evidence/usage.json" > /dev/null \
  || fail "usage: Add usage limit source is not demo-marked (usage.json)"
jq -e '[.. | objects | select(.id? == "addUsageLimitSource")][0].action.op == "dialog"' \
  "$evidence/usage.json" > /dev/null \
  || fail "usage: Add usage limit source does not open a dialog (usage.json)"
ok "usage: the meter cards, the 30-point series, the limits and the dialog (usage.json)"

# --- 7. The pull-requests fixture content ---
for number in 482 479 471 468; do
  jq -e --arg row "pull-request-$number" '[.. | objects | select(.id? == $row)] | length == 1' \
    "$evidence/pull-requests.json" > /dev/null \
    || fail "pull-requests: the row #$number is missing (pull-requests.json)"
done
jq -e '[.. | strings | select(. == "Open")] | length >= 1' \
  "$evidence/pull-requests.json" > /dev/null \
  || fail "pull-requests: the Open badge is missing (pull-requests.json)"
for label in Draft Merged Closed; do
  jq -e --arg label "$label" '[.. | strings | select(. == $label)] | length >= 1' \
    "$evidence/pull-requests.json" > /dev/null \
    || fail "pull-requests: the $label badge is missing (pull-requests.json)"
done
jq -e '[.. | objects | select(.id? == "pull-request-detail-tabs")] | length == 1' \
  "$evidence/pull-requests.json" > /dev/null \
  || fail "pull-requests: the detail tab strip is missing (pull-requests.json)"
jq -e '[.. | objects | select(.id? == "pull-request-diff")][0].demo == true' \
  "$evidence/pull-requests.json" > /dev/null \
  || fail "pull-requests: the detail diff_view is not demo-marked (pull-requests.json)"
jq -e '[.. | objects | select(.id? == "pull-request-link-menu")] | length == 1' \
  "$evidence/pull-requests.json" > /dev/null \
  || fail "pull-requests: the Link-to-thread menu is missing (pull-requests.json)"
jq -e '[.. | strings | select(. == "Unlink")] | length >= 1' \
  "$evidence/pull-requests.json" > /dev/null \
  || fail "pull-requests: the Unlink action is missing (pull-requests.json)"
ok "pull-requests: the rows, the four states, the detail tabs, the diff and the link menu (pull-requests.json)"

# --- 8. Every interactive node is demo-marked ---
for safe in usage pull-requests; do
  bad=$(jq -r '[.. | objects | select((.type? == "button" or .type? == "icon_button" or .type? == "switch" or .type? == "segmented" or .type? == "list_row" or .type? == "tabs" or .type? == "menu" or .type? == "dropdown" or .type? == "input") and (.demo? != true) and (.label? != "Cancel"))] | length' "$evidence/$safe.json")
  [ "$bad" = "0" ] \
    || fail "$safe: $bad interactive node(s) without the demo marker ($safe.json)"
done
ok "every interactive node on both screens carries demo: true"

# --- 9. The catalog gate ---
for id in "${ROUTES[@]}"; do
  safe=${id//:/_}
  catalog_gate "$evidence/$safe.json" "$id"
done
ok "every node type stays inside the docs/sdui.md section 2.5 catalog"

# --- 10. The regression gates ---
bash scripts/qa/t78.sh "$evidence/gate-t78" \
  2>&1 | tee "$evidence/gate-t78.txt"
grep -q 'T78 QA green' "$evidence/gate-t78.txt" \
  || fail "the T78 regression gate did not report green (see $evidence/gate-t78.txt)"
ok "T78 regression gate green: the settings contracts still hold (gate-t78/)"

bash scripts/qa/t112.sh "$evidence/gate-t112" \
  2>&1 | tee "$evidence/gate-t112.txt"
grep -q 'T112 QA happy path complete' "$evidence/gate-t112.txt" \
  || fail "the T112 regression gate did not report green (see $evidence/gate-t112.txt)"
ok "T112 regression gate green: the remaining settings panels still hold (gate-t112/)"

log "T113 QA happy path complete"
