#!/usr/bin/env bash
# QA for T112: the remaining settings panels (plan section 4.2; upstream
# apps/web/src/routes/settings.*.tsx and components/settings/*, commit
# 37de6cb).
#
# The nine remaining settings sub-routes: settings:providers embeds the real
# providers CRUD under the settings shell (CreateProviderAction unchanged),
# settings:archived lists the caller's archived sessions with the real
# Restore lifecycle action, settings:licenses renders the static open-source
# notice text, and the six decorative panels (connections, integrations,
# projects, scheduled-tasks, source-control, snap-shot) render from
# fixtures/settings-fixtures.json with every interactive node marked
# demo: true. The decorative switches flip through the client setState
# without persistence.
# Usage: scripts/qa/t112.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T112. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.llm,
# jhin.qa-mock-llm, jhin.ui-kit and jhin.ui.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL (SettingsScreenTest carries the T112 asserts);
#   - runs the full Flutter suite (flutter.txt) and requires "All tests passed";
#   - boots the kernel, loops the nine T112 routes with `step`, dumps every
#     tree into routes.json and asserts each is a `screen` root with the shell
#     and the active nav;
#   - runs a providers CRUD curl sequence (create -> appears in list -> delete)
#     into providers-transcript.txt;
#   - archives a session and asserts settings:archived lists it with the real
#     Restore action (archive-transcript.txt);
#   - asserts the decorative panels' fixture rows, the demo markers on every
#     interactive node and that every node type stays inside the docs/sdui.md
#     section 2.5 catalog;
#   - runs scripts/qa/t78.sh, scripts/qa/t109.sh and scripts/qa/t111.sh as the
#     regression gates (evidence in gate-t78/, gate-t109/, gate-t111/).
#
# Failure path: deleting a non-existent provider id answers the standard 404
# {"error":"not_found"} payload; the real behavior is recorded in
# checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T112_INNER:-}" ]; then
  exec env T112_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T112}
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

port=18512
base="http://localhost:$port"

# The nine T112 settings sub-routes: the three real panels plus the six
# decorative ones (plan section 4.2).
ROUTES=(
  settings:providers
  settings:archived
  settings:licenses
  settings:connections
  settings:integrations
  settings:projects
  settings:scheduled-tasks
  settings:source-control
  settings:snap-shot
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
  log "T112 QA --fail: deleting a non-existent provider answers 404 not_found"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/providers-fail.txt"
  : > "$tx"
  step_hdr "$client_header" "$tx" "delete-missing-provider" \
    DELETE /providers/does-not-exist '' 404 '.error == "not_found"'
  ok "deleting a non-existent provider answers 404 not_found (providers-fail.txt)"
  {
    echo "FAIL: deleting a non-existent provider answered 404 not_found (as designed)"
    echo "  the failure path is the documented behavior: DELETE /providers/{id}"
    echo "  for an unknown id answers the standard 404"
    echo "  {\"error\":\"not_found\",\"message\":\"provider ... not found\"} payload"
    echo "  (providers-fail.txt)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: deleting a non-existent provider succeeded (it does not; see $evidence/providers-fail.txt)"
fi

log "T112 QA: the remaining settings panels"
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

# --- 5. The nine T112 routes ---
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
    and ([.. | objects | select(.id? == "settings-nav")][0].activeId == $id)
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
ok "nine T112 routes: screen root, shell and the active nav (routes.json)"

# --- 6. The providers CRUD sequence (real) ---
tx="$evidence/providers-transcript.txt"
: > "$tx"
step_hdr "$client_header" "$tx" "create-provider" POST /providers \
  '{"format":"mock","model":"t112","apiKey":"qa"}' 201 '.id | length > 0'
provider_id=$(jq -r '.id' <<< "$step_payload")
[ -n "$provider_id" ] && [ "$provider_id" != "null" ] || fail "could not read the created provider id"
step_hdr "$client_header" "$tx" "list-providers" GET /providers '' 200 'type == "array"'
jq -e --arg id "$provider_id" 'any(.[]; .id == $id)' <<< "$step_payload" > /dev/null \
  || fail "the created provider is not in the list (providers-transcript.txt)"
# The delete answers 204 with an empty body, so it is asserted on the status
# alone (jq has no input to read).
delete_response=$(curl -sS --max-time 10 -X DELETE \
    -H "X-Jhin-Client: $client_header" \
    -w $'\n%{http_code}' "$base/providers/$provider_id")
delete_status=${delete_response##*$'\n'}
{
  echo "=== delete-provider ==="
  echo "DELETE /providers/$provider_id"
  echo "status: $delete_status"
  echo "assert: status=204"
} >> "$tx"
[ "$delete_status" = "204" ] \
  || fail "delete-provider: expected status 204, got $delete_status"
echo "assert: ok" >> "$tx"
step_hdr "$client_header" "$tx" "list-providers-after-delete" GET /providers '' 200 'type == "array"'
jq -e --arg id "$provider_id" 'all(.[]; .id != $id)' <<< "$step_payload" > /dev/null \
  || fail "the deleted provider is still in the list (providers-transcript.txt)"
ok "providers CRUD: create -> appears in list -> delete (providers-transcript.txt)"

# --- 7. The archived panel round-trip (real) ---
tx="$evidence/archive-transcript.txt"
: > "$tx"
step_hdr "$client_header" "$tx" "create-session" POST /sessions \
  '{"title":"t112-archive","workdir":"/tmp/t112"}' 201 '.id | length > 0'
archive_id=$(jq -r '.id' <<< "$step_payload")
[ -n "$archive_id" ] && [ "$archive_id" != "null" ] || fail "could not read the created session id"
step_hdr "$client_header" "$tx" "archive-session" POST /ui/action/archive \
  "{\"action\":\"archive\",\"payload\":{\"id\":\"$archive_id\"}}" 200 '.client | length >= 1'
step_hdr "$client_header" "$tx" "settings-archived" GET "/ui/screen/settings:archived" '' 200 \
  '.node.type == "screen"'
jq '.node' <<< "$step_payload" > "$evidence/archived.json"
jq -e --arg row "archived-$archive_id" '[.. | objects | select(.id? == $row)] | length == 1' \
  "$evidence/archived.json" > /dev/null \
  || fail "settings:archived does not list the archived session (archived.json)"
jq -e --arg id "$archive_id" \
  '[.. | objects | select(.name? == "restore")][0].payload.id == $id' \
  "$evidence/archived.json" > /dev/null \
  || fail "settings:archived does not carry the real Restore action (archived.json)"
ok "settings:archived: the archived session with the real Restore action (archived.json)"

# --- 8. The real panels' content ---
jq -e '[.. | objects | select(.type? == "form")][0].submit.label == "Add provider"' \
  "$routes_dir/settings_providers.json" > /dev/null \
  || fail "settings:providers does not embed the providers CRUD form (routes/settings_providers.json)"
jq -e '[.. | objects | select(.name? == "create-provider")] | length == 1' \
  "$routes_dir/settings_providers.json" > /dev/null \
  || fail "settings:providers does not dispatch create-provider (routes/settings_providers.json)"
jq -e '[.. | objects | select(.type? == "card") | .title] | index("Third-party notices") != null' \
  "$routes_dir/settings_licenses.json" > /dev/null \
  || fail "settings:licenses has no Third-party notices card (routes/settings_licenses.json)"
jq -e '[.. | strings | select(. == "LangChain4j")] | length >= 1' \
  "$routes_dir/settings_licenses.json" > /dev/null \
  || fail "settings:licenses does not list the bundled dependencies (routes/settings_licenses.json)"
ok "settings:providers embeds the CRUD and settings:licenses renders the static notices"

# --- 9. The six decorative panels' fixture rows and demo markers ---
jq -e '[.. | objects | select(.id? == "device-host-host-build-mac")] | length == 1' \
  "$routes_dir/settings_connections.json" > /dev/null \
  || fail "settings:connections is missing the fixture device host (routes/settings_connections.json)"
jq -e '[.. | objects | select(.id? == "pairQr")] | length == 1' \
  "$routes_dir/settings_connections.json" > /dev/null \
  || fail "settings:connections is missing the QR placeholder (routes/settings_connections.json)"
for id in github bitbucket chatgpt codex; do
  jq -e --arg row "integration-$id" '[.. | objects | select(.id? == $row)] | length == 1' \
    "$routes_dir/settings_integrations.json" > /dev/null \
    || fail "settings:integrations is missing the '$id' row (routes/settings_integrations.json)"
done
for key in pinball-stats jhin docs-site; do
  jq -e --arg row "project-$key" --arg screen "project:$key" \
    '[.. | objects | select(.id? == $row)][0].action.screen == $screen' \
    "$routes_dir/settings_projects.json" > /dev/null \
    || fail "settings:projects row '$key' does not navigate to project:$key (routes/settings_projects.json)"
done
for id in task-sentry task-deps task-digest; do
  jq -e --arg row "taskEnabled-$id" '[.. | objects | select(.id? == $row)][0].demo == true' \
    "$routes_dir/settings_scheduled-tasks.json" > /dev/null \
    || fail "settings:scheduled-tasks switch '$id' is not demo-marked (routes/settings_scheduled-tasks.json)"
done
jq -e '[.. | strings | select(. == "Every 15 min · in 12m")] | length >= 1' \
  "$routes_dir/settings_scheduled-tasks.json" > /dev/null \
  || fail "settings:scheduled-tasks is missing the cron label (routes/settings_scheduled-tasks.json)"
for id in branchNamingMode branchPrefix prTemplate followChangeRequestTemplates sc-provider-git; do
  jq -e --arg row "$id" '[.. | objects | select(.id? == $row)] | length == 1' \
    "$routes_dir/settings_source-control.json" > /dev/null \
    || fail "settings:source-control is missing the '$id' field (routes/settings_source-control.json)"
done
jq -e '[.. | objects | select(.id? == "snapshot-snap-editor")] | length == 1' \
  "$routes_dir/settings_snap-shot.json" > /dev/null \
  || fail "settings:snap-shot is missing the fixture snapshot (routes/settings_snap-shot.json)"
jq -e '[.. | objects | select(.id? == "createSnapshot")][0].demo == true' \
  "$routes_dir/settings_snap-shot.json" > /dev/null \
  || fail "settings:snap-shot does not demo-mark Create snapshot (routes/settings_snap-shot.json)"
ok "the six decorative panels render their fixture rows"

# Every interactive node in the six decorative panels is demo-marked. The
# walk starts at the shell body so the shell chrome (the Back-to-threads
# button) is not counted.
for safe in settings_connections settings_integrations settings_projects \
    settings_scheduled-tasks settings_source-control settings_snap-shot; do
  bad=$(jq -r '
    ([.. | objects | select(.type? == "shell")][0].body
      | [.. | objects | select((.type? == "list_row" or .type? == "switch" or .type? == "button")
        and (.demo? != true))] | length)' "$routes_dir/$safe.json")
  [ "$bad" = "0" ] \
    || fail "$safe: $bad interactive node(s) without the demo marker (routes/$safe.json)"
done
ok "every interactive node in the six decorative panels carries demo: true"

# --- 10. The catalog gate ---
for id in "${ROUTES[@]}"; do
  safe=${id//:/_}
  catalog_gate "$routes_dir/$safe.json" "$id"
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

bash scripts/qa/t111.sh "$evidence/gate-t111" \
  2>&1 | tee "$evidence/gate-t111.txt"
grep -q 'T111 QA happy path complete' "$evidence/gate-t111.txt" \
  || fail "the T111 regression gate did not report green (see $evidence/gate-t111.txt)"
ok "T111 regression gate green: the keybindings, diagnostics and storage panels still hold (gate-t111/)"

log "T112 QA happy path complete"
