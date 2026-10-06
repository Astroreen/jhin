#!/usr/bin/env bash
# QA for T109: the settings shell and its sub-routes (plan section 4.2).
#
# The settings shell is a `shell` whose sidebar slot carries the settings
# `nav` (kind `sidebar`) with the fourteen `settings:*` sub-route entries,
# whose page header carries the `Settings / <name>` breadcrumb and whose body
# carries the panel. Every sub-route is its own screen id, reachable by
# `navigate` and listed in the bootstrap `screens[]`; the active route is
# highlighted through the nav `activeId`. The three pre-T109 sections live on
# their new homes (Appearance on settings:appearance, Thread behavior on
# settings:general, Keyboard on settings:keybindings) and the overview keeps
# them so the T78 contract assertions stay green.
# Usage: scripts/qa/t109.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T109. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (SettingsScreenTest carries the T109 asserts);
#   - runs the Flutter settings-shell suite (flutter-shell.txt: the nav
#     entries, the active highlight, the navigate dispatch and the
#     breadcrumb) and requires "All tests passed";
#   - boots the kernel, loops the fourteen settings:* routes with `step`,
#     dumps every tree into routes.json and asserts each is a `screen` root
#     with the shell, the nav (fourteen items, the route active) and the
#     breadcrumb label;
#   - asserts the three sections on their new homes and the overview's three
#     cards (the T78 contract), and that every node type stays inside the
#     docs/sdui.md section 2.5 catalog;
#   - runs scripts/qa/t78.sh as the regression gate (evidence in gate-t78/).
#
# Failure path: an unknown settings:* id is indistinguishable from an unknown
# screen and answers the standard 404 {"error":"unknown_screen"} payload; the
# real behavior is recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T109_INNER:-}" ]; then
  exec env T109_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T109}
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

port=18509
base="http://localhost:$port"

# The fourteen settings sub-routes of the plan section 4.2, in nav order.
ROUTES=(
  settings:general
  settings:appearance
  settings:keybindings
  settings:providers
  settings:connections
  settings:integrations
  settings:diagnostics
  settings:storage
  settings:archived
  settings:projects
  settings:scheduled-tasks
  settings:source-control
  settings:snap-shot
  settings:licenses
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
  log "T109 QA --fail: an unknown settings:* id answers 404"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/unknown-route.txt"
  : > "$tx"
  step_hdr "$client_header" "$tx" "unknown-settings-route" \
    GET "/ui/screen/settings:nope" '' 404 '.error == "unknown_screen"'
  ok "unknown settings:* id answers 404 unknown_screen (unknown-route.txt)"
  {
    echo "FAIL: an unknown settings:* id answered 404 unknown_screen (as designed)"
    echo "  the failure path is the documented behavior: the registry exposes"
    echo "  only the fourteen settings:* ids, so settings:nope is"
    echo "  indistinguishable from an unknown screen and answers the standard"
    echo "  {\"error\":\"unknown_screen\"} payload (unknown-route.txt)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: an unknown settings:* id resolved (it does not; see $evidence/unknown-route.txt)"
fi

log "T109 QA: settings shell with fourteen sub-routes"
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

# --- 3. The Flutter settings-shell suite ---
bash scripts/qa/flutter-test.sh test/sdui/settings_shell_test.dart \
  2>&1 | tee "$evidence/flutter-shell.txt"
grep -q 'All tests passed' "$evidence/flutter-shell.txt" \
  || fail "the Flutter settings-shell suite failed (see $evidence/flutter-shell.txt)"
ok "Flutter settings-shell suite green: nav entries, active highlight, navigate dispatch, breadcrumb (flutter-shell.txt)"

# --- 4. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/routes-transcript.txt"
: > "$tx"

# --- 5. The fourteen sub-routes ---
routes_dir="$evidence/routes"
rm -rf "$routes_dir"
mkdir -p "$routes_dir"
routes_json="$evidence/routes.json"
printf '[' > "$routes_json"
first=1
for id in "${ROUTES[@]}"; do
  safe=${id//:/_}
  step_hdr "$client_header" "$tx" "route-$id" GET "/ui/screen/$id" '' 200 \
    '.node.type == "screen"'
  jq '.node' <<< "$step_payload" > "$routes_dir/$safe.json"
  jq -e --arg id "$id" '
    .type == "screen"
    and ([.. | objects | select(.type? == "shell")] | length == 1)
    and ([.. | objects | select(.id? == "settings-nav")] | length == 1)
    and ([.. | objects | select(.id? == "settings-nav")][0].kind == "sidebar")
    and ([.. | objects | select(.id? == "settings-nav")][0].activeId == $id)
    and ([.. | objects | select(.id? == "settings-nav")][0].items | length == 14)
  ' "$routes_dir/$safe.json" > /dev/null \
    || fail "$id: the shell / nav / active route is wrong (routes/$safe.json)"
  if [ "$first" = "1" ]; then
    first=0
  else
    printf ',' >> "$routes_json"
  fi
  jq -c --arg id "$id" '{id: $id, node: .}' "$routes_dir/$safe.json" >> "$routes_json"
done
printf ']' >> "$routes_json"
ok "fourteen settings:* routes: screen root, shell, sidebar nav with fourteen items and the route active (routes.json)"

# --- 6. The breadcrumb labels ---
for id in "${ROUTES[@]}"; do
  safe=${id//:/_}
  case "$id" in
    settings:general) label="General" ;;
    settings:appearance) label="Appearance" ;;
    settings:keybindings) label="Keybindings" ;;
    settings:providers) label="Providers" ;;
    settings:connections) label="Connections" ;;
    settings:integrations) label="Integrations" ;;
    settings:diagnostics) label="Diagnostics" ;;
    settings:storage) label="Storage" ;;
    settings:archived) label="Archive" ;;
    settings:projects) label="Project" ;;
    settings:scheduled-tasks) label="Scheduled Tasks" ;;
    settings:source-control) label="Source Control" ;;
    settings:snap-shot) label="SnapShots" ;;
    settings:licenses) label="Open source licenses" ;;
  esac
  jq -e --arg label "$label" '
    [.. | objects | select(.id? == "settings-breadcrumb")][0]
    | ([.children[].text] | index("Settings") != null)
      and ([.children[].text] | index($label) != null)
  ' "$routes_dir/$safe.json" > /dev/null \
    || fail "$id: the Settings / $label breadcrumb is wrong (routes/$safe.json)"
done
ok "every sub-route carries the Settings / <name> breadcrumb (routes.json)"

# --- 7. The three sections on their new homes ---
jq -e '
  ([.. | objects | select(.type? == "card") | .title] | index("Appearance") != null)
  and ([.. | objects | select(.name? == "save-appearance")] | length == 1)
' "$routes_dir/settings_appearance.json" > /dev/null \
  || fail "settings:appearance does not carry the Appearance card (routes/settings_appearance.json)"
jq -e '
  ([.. | objects | select(.type? == "card") | .title] | index("Thread behavior") != null)
  and ([.. | objects | select(.name? == "save-thread-behavior")] | length == 1)
' "$routes_dir/settings_general.json" > /dev/null \
  || fail "settings:general does not carry the Thread behavior card (routes/settings_general.json)"
jq -e '
  ([.. | objects | select(.type? == "card") | .title] | index("Keyboard") != null)
  and ([.. | objects | select(.name? == "keybind-edit")] | length >= 1)
  and ([.. | objects | select(.label? == "Restore defaults")] | length == 1)
' "$routes_dir/settings_keybindings.json" > /dev/null \
  || fail "settings:keybindings does not carry the Keyboard section (routes/settings_keybindings.json)"
ok "the three sections live on their new homes: Appearance, Thread behavior, Keyboard"

# --- 8. The overview keeps the three cards (the T78 contract) ---
step_hdr "$client_header" "$tx" "settings-overview" GET "/ui/screen/settings" '' 200 \
  '.node.type == "screen"'
jq '.node' <<< "$step_payload" > "$evidence/settings-overview.json"
for title in "Appearance" "Thread behavior" "Keyboard"; do
  jq -e --arg title "$title" \
    '[.. | objects | select(.type? == "card") | .title] | index($title) != null' \
    "$evidence/settings-overview.json" > /dev/null \
    || fail "the settings overview has no '$title' card (settings-overview.json)"
done
jq -e '[.. | objects | select(.name? == "save-appearance")][0].include == ["appearance","themeId","canvas","accent","density","panelMotionMs"]' \
  "$evidence/settings-overview.json" > /dev/null \
  || fail "the overview save-appearance include list changed (settings-overview.json)"
ok "the settings overview keeps the three cards and the save-appearance include (settings-overview.json)"

# --- 9. The bootstrap lists every sub-route ---
step_hdr "$client_header" "$tx" "bootstrap" GET "/_jhin/bootstrap" '' 200 '.api == 3'
jq -S . <<< "$step_payload" > "$evidence/bootstrap.json"
for id in "${ROUTES[@]}"; do
  jq -e --arg id "$id" '[.screens[].id] | index($id) != null' \
    "$evidence/bootstrap.json" > /dev/null \
    || fail "the bootstrap screens[] is missing $id (bootstrap.json)"
done
ok "the bootstrap screens[] lists every settings:* sub-route (bootstrap.json)"

# --- 10. The catalog gate ---
catalog=$(catalog_primitives)
bad_types=$(jq -r '[.. | objects | select(.type? != null) | .type] | unique | .[]' \
    "$evidence/settings-overview.json" | while IFS= read -r t; do
  printf '%s\n' "$catalog" | grep -qx "$t" || echo "$t"
done)
if [ -n "$bad_types" ]; then
  fail "node types outside the docs/sdui.md section 2.5 catalog: $bad_types"
fi
ok "every node type stays inside the docs/sdui.md section 2.5 catalog"

# --- 11. The T78 regression gate ---
bash scripts/qa/t78.sh "$evidence/gate-t78" \
  2>&1 | tee "$evidence/gate-t78.txt"
grep -q 'T78 QA green' "$evidence/gate-t78.txt" \
  || fail "the T78 regression gate did not report green (see $evidence/gate-t78.txt)"
ok "T78 regression gate green: the settings contracts still hold (gate-t78/)"

log "T109 QA happy path complete"
