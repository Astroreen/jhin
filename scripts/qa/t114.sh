#!/usr/bin/env bash
# QA for T114: the welcome wizard, the connect explainer, the pair enrollment
# and the project screen (plan section 4.2; upstream apps/web/src/routes/
# welcome.tsx, connect.tsx, pair.tsx, projects.$projectKey.tsx and the
# components/onboarding/WelcomeWizard.tsx, components/cloud/
# ConnectCliAuthSurface.tsx, components/auth/PairingRouteSurface.tsx,
# components/NoActiveThreadState.tsx, components/NoProjectsHero.tsx, commit
# 37de6cb).
#
# The welcome wizard is a decorative stepped card (three steps, inline
# setState, Finish -> chat:new); the connect screen is the decorative
# device-connection explainer; the pair route is the real jhin.security
# enrollment form (the bootstrap entry for an unauthenticated caller); the
# project:<key> screen renders the fixture project header, the decorative
# branch toolbar, the real threads-in-project subset and the decorative
# scripts card. Every decorative interactive node is demo: true (plan section
# 14.10); the fixtures are read at build time and never fetched (plan section
# 14.1).
# Usage: scripts/qa/t114.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T114. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.security,
# jhin.ui-kit and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (WelcomeScreenTest / ConnectScreenTest /
#     ProjectScreenTest / PairScreenTest carry the T114 asserts);
#   - runs the full Flutter suite (flutter.txt) and requires "All tests
#     passed";
#   - boots the kernel, seeds an account and an enrollment code through the
#     admin CLI, then POSTs /enroll and asserts the token payload
#     (pair-transcript.txt);
#   - steps pair / welcome / connect / project:jhin with `step`, dumps every
#     tree into evidence/T114/{pair,welcome,connect,project}.json and asserts
#     each is a `screen` root with the shell;
#   - creates a session whose workdir is the project path and asserts the
#     project screen lists it (the real threads-in-project subset);
#   - asserts every interactive node on the decorative screens carries
#     demo: true and that every node type stays inside the docs/sdui.md
#     section 2.5 catalog;
#   - runs scripts/qa/t78.sh and scripts/qa/t113.sh as the regression gates
#     (evidence in gate-t78/, gate-t113/).
#
# Failure path: the expired enrollment code answers the documented error and
# the pair screen shows the error card. The real behavior is proven by the
# PairScreenTest suite, then the deliberately wrong expectation — that the
# expired code succeeds — is run with T114_FAIL_MODE=true and must fail; the
# real behavior is recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T114_INNER:-}" ]; then
  exec env T114_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T114}
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

port=18514
# The security plugin installs the TLS keystore, so the kernel serves HTTPS.
base="https://localhost:$port"

# The four T114 screens (plan section 4.2).
ROUTES=(
  pair
  welcome
  connect
  project:jhin
)

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

if [ "$fail_mode" = "1" ]; then
  log "T114 QA --fail: the expired enrollment code answers the documented error and the pair screen shows the error card"
  log "evidence dir: $evidence"

  # The real behavior holds: the expired code is refused with the documented
  # security error and the pair screen's error banner is patched visible.
  if ./gradlew :jhin-plugin-ui-default:test --tests '*PairScreenTest' --rerun \
      2>&1 | tee "$evidence/test-real.txt" | grep -q 'BUILD SUCCESSFUL'; then
    ok "the real behavior holds: the expired code answers the documented error and the pair screen shows the error card (test-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/test-real.txt)"
  fi

  # The deliberately wrong expectation: the expired code succeeds. The
  # inverted suite must fail.
  if T114_FAIL_MODE=true ./gradlew :jhin-plugin-ui-default:test \
      --tests '*PairScreenTest' --rerun \
      2>&1 | tee "$evidence/test-fail.txt" | grep -q 'BUILD SUCCESSFUL'; then
    fail "deliberately wrong expectation held: the expired code succeeded"
  fi
  {
    echo "FAIL: the expired enrollment code succeeded (as designed)"
    echo "  the real behavior is the opposite: the expired code is refused with"
    echo "  the documented 410 code_expired error and the pair screen's"
    echo "  enroll-error banner is patched visible with the security message;"
    echo "  the inverted suite failed as required (test-fail.txt); the real"
    echo "  behavior is recorded in test-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the expired code succeeded (it is refused; see $evidence/test-fail.txt)"
fi

log "T114 QA: the welcome wizard, connect, pair and project screens"
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

# --- 5. The pair/enroll round-trip through the admin CLI ---
run_cli create-account create-account qa
run_cli create-enrollment create-enrollment qa
enroll_code=$(sed -n 's/^code: //p' "$evidence/cli-create-enrollment.txt")
[ -n "$enroll_code" ] \
  || fail "create-enrollment printed no code (see $evidence/cli-create-enrollment.txt)"
tx="$evidence/pair-transcript.txt"
: > "$tx"
step_hdr "$client_header" "$tx" "enroll" POST /enroll \
  "{\"code\":\"$enroll_code\",\"deviceName\":\"t114-qa\"}" 200 \
  '.token != null and .accountName == "qa"'
token=$(jq -r '.token' <<< "$step_payload")
[ -n "$token" ] && [ "$token" != "null" ] \
  || fail "POST /enroll returned no token (pair-transcript.txt)"
auth_header="Authorization: Bearer $token"
ok "pair/enroll round-trip: code redeemed, device token captured (pair-transcript.txt)"

# --- 6. The four T114 screens ---
routes_dir="$evidence/routes"
rm -rf "$routes_dir"
mkdir -p "$routes_dir"
for id in "${ROUTES[@]}"; do
  safe=${id//:/_}
  step_hdr "$client_header" "$tx" "route-$id" GET "/ui/screen/$id" '' 200 \
    '.node.type == "screen"'
  jq '.node' <<< "$step_payload" > "$evidence/$safe.json"
  if [ "$id" = "pair" ]; then
    # The pair route is the enrollment form, not a shell surface.
    jq -e '[.. | objects | select(.type? == "form")] | length == 1' \
      "$evidence/$safe.json" > /dev/null \
      || fail "$id: the enrollment form is missing ($safe.json)"
  else
    jq -e '
      .type == "screen"
      and ([.. | objects | select(.type? == "shell")] | length == 1)
    ' "$evidence/$safe.json" > /dev/null \
      || fail "$id: the screen root / shell is wrong ($safe.json)"
  fi
done
ok "all four T114 screens: screen root, shell (welcome/connect/project) and form (pair)"

# The combined route tree dump (plan section 4.6): one file with every tree.
jq -n \
  --slurpfile pair "$evidence/pair.json" \
  --slurpfile welcome "$evidence/welcome.json" \
  --slurpfile connect "$evidence/connect.json" \
  --slurpfile project "$evidence/project_jhin.json" \
  '{pair: $pair[0], welcome: $welcome[0], connect: $connect[0], project: $project[0]}' \
  > "$evidence/routes.json"

# --- 7. The welcome wizard content ---
jq -e '[.. | objects | select(.id? == "welcomeStep")][0] | .type == "segmented" and .value == 0' \
  "$evidence/welcome.json" > /dev/null \
  || fail "welcome: the step strip is missing (welcome.json)"
for step in 0 1 2; do
  jq -e --arg when "welcomeStep == $step" \
    '[.. | objects | select(.when? == $when)] | length == 1' \
    "$evidence/welcome.json" > /dev/null \
    || fail "welcome: the step $step panel is missing (welcome.json)"
done
jq -e '[.. | objects | select(.id? == "welcome-finish")][0].action.client[0] | .op == "navigate" and .screen == "chat:new"' \
  "$evidence/welcome.json" > /dev/null \
  || fail "welcome: Finish does not navigate to chat:new (welcome.json)"
ok "welcome: the three gated steps and the Finish navigation (welcome.json)"

# --- 8. The connect explainer content ---
jq -e '[.. | strings | select(. == "npx jhin connect")] | length >= 1' \
  "$evidence/connect.json" > /dev/null \
  || fail "connect: the connect command is missing (connect.json)"
jq -e '[.. | objects | select(.id? == "connectionCode")][0].demo == true' \
  "$evidence/connect.json" > /dev/null \
  || fail "connect: the connection-code input is not demo-marked (connect.json)"
jq -e '[.. | objects | select(.id? == "connect-docs")][0].action.op == "openUrl"' \
  "$evidence/connect.json" > /dev/null \
  || fail "connect: the docs link is missing (connect.json)"
ok "connect: the command, the code input and the docs link (connect.json)"

# --- 9. The pair enrollment form ---
jq -e '[.. | objects | select(.id? == "enroll-error")][0] | .type == "banner" and .visible == false' \
  "$evidence/pair.json" > /dev/null \
  || fail "pair: the hidden error banner is missing (pair.json)"
jq -e '[.. | objects | select(.name? == "enroll")][0].include == ["code", "deviceName"]' \
  "$evidence/pair.json" > /dev/null \
  || fail "pair: the enroll action does not include the two fields (pair.json)"
ok "pair: the enrollment form and the hidden error banner (pair.json)"

# --- 10. The project screen content ---
jq -e '[.. | objects | select(.id? == "project-header")] | length == 1' \
  "$evidence/project_jhin.json" > /dev/null \
  || fail "project: the header card is missing (project_jhin.json)"
jq -e '[.. | objects | select(.id? == "project-branch-toolbar")] | length == 1' \
  "$evidence/project_jhin.json" > /dev/null \
  || fail "project: the branch toolbar is missing (project_jhin.json)"
jq -e '[.. | objects | select(.id? == "project-scripts")] | length == 1' \
  "$evidence/project_jhin.json" > /dev/null \
  || fail "project: the scripts card is missing (project_jhin.json)"
jq -e '[.. | strings | select(. == "Jhin")] | length >= 1' \
  "$evidence/project_jhin.json" > /dev/null \
  || fail "project: the project name is missing (project_jhin.json)"
ok "project: the header, the branch toolbar and the scripts card (project_jhin.json)"

# --- 11. The real threads-in-project subset ---
step_hdr "$client_header" "$tx" "create-session" POST /ui/action/create-session \
  '{"action":"create-session","payload":{"title":"T114 project thread","workdir":"/home/astroreen/Documents/jhin"}}' \
  200 '[.client[].op] == ["navigate"]'
session_screen=$(jq -r '[.client[] | select(.op == "navigate")][0].screen' <<< "$step_payload")
session_id=${session_screen#chat:}
step_hdr "$client_header" "$tx" "project-with-thread" GET "/ui/screen/project:jhin" '' 200 \
  '.node.type == "screen"'
jq '.node' <<< "$step_payload" > "$evidence/project_jhin.json"
jq -e --arg row "project-thread-$session_id" \
  '[.. | objects | select(.id? == $row)] | length == 1' \
  "$evidence/project_jhin.json" > /dev/null \
  || fail "project: the created session is not listed (project_jhin.json)"
jq -e '[.. | strings | select(. == "T114 project thread")] | length >= 1' \
  "$evidence/project_jhin.json" > /dev/null \
  || fail "project: the created session title is missing (project_jhin.json)"
ok "project: the real threads-in-project subset lists the created session (project_jhin.json)"

# --- 12. Every interactive node on the decorative screens is demo-marked ---
for safe in welcome connect; do
  bad=$(jq -r '[.. | objects | select((.type? == "button" or .type? == "icon_button" or .type? == "switch" or .type? == "segmented" or .type? == "list_row" or .type? == "tabs" or .type? == "menu" or .type? == "dropdown" or .type? == "input") and (.demo? != true))] | length' "$evidence/$safe.json")
  [ "$bad" = "0" ] \
    || fail "$safe: $bad interactive node(s) without the demo marker ($safe.json)"
done
ok "every interactive node on the welcome and connect screens carries demo: true"

# --- 13. The catalog gate ---
for id in "${ROUTES[@]}"; do
  safe=${id//:/_}
  catalog_gate "$evidence/$safe.json" "$id"
done
ok "every node type stays inside the docs/sdui.md section 2.5 catalog"

# --- 14. The regression gates ---
bash scripts/qa/t78.sh "$evidence/gate-t78" \
  2>&1 | tee "$evidence/gate-t78.txt"
grep -q 'T78 QA green' "$evidence/gate-t78.txt" \
  || fail "the T78 regression gate did not report green (see $evidence/gate-t78.txt)"
ok "T78 regression gate green: the settings contracts still hold (gate-t78/)"

bash scripts/qa/t113.sh "$evidence/gate-t113" \
  2>&1 | tee "$evidence/gate-t113.txt"
grep -q 'T113 QA happy path complete' "$evidence/gate-t113.txt" \
  || fail "the T113 regression gate did not report green (see $evidence/gate-t113.txt)"
ok "T113 regression gate green: the usage and pull-requests screens still hold (gate-t113/)"

log "T114 QA happy path complete"