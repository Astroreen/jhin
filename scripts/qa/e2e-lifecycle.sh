#!/usr/bin/env bash
# QA for T81: full-bundle lifecycle e2e, upgrade path and contract-level downgrade.
# Usage: scripts/qa/e2e-lifecycle.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T81. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). Kernels are stopped with SIGTERM and
# reaped with `wait`; JSON assertions run with jq and the sweep backdating runs
# through sqlite3 against the kernel database in JHIN_HOME (both present on the
# QA machine).
#
# The kernel boots with the ten default plugin jars (run-kernel.sh, TLS via
# jhin.security — the e2e-bundle pattern; the device token comes from a CLI
# single-use enrollment code). Lifecycle and screens are driven over curl.
#
# Happy path:
#   - builds the kernel boot jar and the ten default plugin jars and writes the
#     v1 upgrade fixture through V1FixtureTest (build/v1-fixture/jhin.db);
#   - boots the full bundle (kernel.log), enrolls a device (cli-*.txt,
#     enroll.json, health.json) and seeds three sessions in distinct states:
#     one active, one pinned, one settled (lifecycle-transcript.txt);
#   - asserts the sidebar node tree memberships of GET /ui/screen/sessions
#     (sidebar.json: Pinned/Active/Snoozed/Settled, rows session-row:<id>):
#     the pinned session is in Pinned only, the active in Active, the settled
#     in Settled (collapsible, collapsed);
#   - drives the lifecycle over curl and asserts the sidebar membership after
#     every step: settle -> undo inside 5 s restores the session
#     (undo-transcript.txt: toast "Undone" + refresh), snooze -> wake,
#     pin -> unpin, archive -> restore; the session_updated SSE frames land in
#     events.json (raw stream in sse-raw.txt);
#   - captures GET /_jhin/bootstrap at api=2 and api=1 (bootstrap-api2.json,
#     bootstrap-api1.json) and proves the level-1 shape carries zero level-2
#     keys (bootstrap-diff.txt);
#   - auto-settle sweep: restarts the same JHIN_HOME with
#     jhin.sessions.inactivityMs=1000 and short sweep delays, backdates one
#     fresh idle session and the pinned session to now-10s and asserts the
#     sweep settles both with settled_reason=inactive (sweep-transcript.txt,
#     sidebar-sweep.json) — the pinned one keeps its pin and stays in Pinned;
#   - upgrade path: copies the v1 fixture into a scratch JHIN_HOME as
#     data/jhin.db, captures the schema and rows (upgrade-before.sql), boots
#     the kernel (sessions plugin) and captures them again (upgrade-after.sql,
#     upgrade-rows.json): the nine lifecycle columns appear and the three
#     pre-v2 rows survive with pinned=0, auto_settle=1,
#     auto_settle_suppressed=0; the client store migrates through the T54
#     harness (test/store/evidence_test.dart, T54_EVIDENCE_DIR): the legacy
#     schema:1 blobs (store/legacy-blob.json) come out enveloped
#     (store/after-migration.json, store-test.txt).
#   Evidence: run.txt, checks.txt, kernel.log, fail-boot/ (mode artifacts),
#   cli-*.txt, enroll.json, health.json, lifecycle-transcript.txt,
#   undo-transcript.txt, events.json, sse-raw.txt, sidebar.json,
#   sidebar-after-undo.json, sidebar-sweep.json, bootstrap-api{1,2}.json,
#   bootstrap-diff.txt, sweep-boot/, sweep-transcript.txt, upgrade-fixture-test.txt,
#   upgrade-boot/, upgrade-before.sql, upgrade-after.sql, upgrade-rows.json,
#   store-test.txt, store/.
#
# --fail mode: boots the same bundle, archives a session and settles it
#   (409 invalid_transition recorded in negative.txt), then asserts a
#   deliberately wrong expectation (the settle answered 200) against the real
#   transcript, records the run in checks-fail.txt and exits non-zero — proving
#   the checker fails instead of passing silently.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${E2E_LIFECYCLE_INNER:-}" ]; then
  exec env E2E_LIFECYCLE_INNER=1 timeout --kill-after=15 1500 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T81}
mkdir -p "$evidence"
if [ "$fail_mode" = "1" ]; then
  exec > >(tee "$evidence/run-fail.txt") 2>&1
else
  exec > >(tee "$evidence/run.txt") 2>&1
fi

kernel_pid=""
home=""
token=""
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
  printf '%s %s\n' "$(date +%H:%M:%S)" "$*"
}

ok() {
  printf 'ok: %s\n' "$*" | tee -a "$checks"
}

fail() {
  printf 'FAIL: %s\n' "$*" | tee -a "$checks" >&2
  exit 1
}

command -v jq > /dev/null || fail "jq is required"
command -v sqlite3 > /dev/null || fail "sqlite3 is required for the sweep backdating"

port=18481
base="https://localhost:$port"
client_hdr='X-Jhin-Client: api=2; version=1.0.0; schema=3; caps=sse'
api1_hdr='X-Jhin-Client: api=1; version=0.2.0; caps=sse'
plugin_ids="sessions security llm llm-builtin agent tools-builtin mcp ui-kit ui-default reload"

kernel_jar() {
  ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$' | head -1
}

# wait_health <url> <timeout-seconds>: poll until the health endpoint answers
wait_health() {
  local url=$1 deadline=$(( $(date +%s) + $2 ))
  until curl -k -sf --max-time 3 -H "$client_hdr" "$url" > /dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

stop_kernel() {
  if [ -n "$kernel_pid" ] && ps -p "$kernel_pid" > /dev/null 2>&1; then
    kill "$kernel_pid" 2>/dev/null || true
    wait "$kernel_pid" 2>/dev/null || true
  fi
  kernel_pid=""
}

build_all() {
  local tasks=":kernel:bootJar"
  for id in $plugin_ids; do
    tasks="$tasks :jhin-plugin-$id:jar"
  done
  # shellcheck disable=SC2086
  ./gradlew $tasks
}

# seed_home: creates a fresh JHIN_HOME holding the ten default plugin jars
# (everything the release bundle ships except the example and the qa mock).
seed_home() {
  home=$(mktemp -d /tmp/e2e-lifecycle-home.XXXXXX)
  mkdir -p "$home/plugins"
  local id f
  for id in $plugin_ids; do
    for f in "plugins/$id/build/libs/jhin-plugin-$id-"*.jar; do
      case "$f" in
        *-plain.jar | *-sources.jar | *-javadoc.jar) continue ;;
      esac
      cp "$f" "$home/plugins/"
    done
  done
  [ "$(ls "$home/plugins"/*.jar | wc -l)" = "10" ] \
    || fail "seed_home must copy exactly ten plugin jars (got: $(ls "$home/plugins"))"
}

# boot_bundle <kernel-log-dir>: starts the kernel on $port against $home and
# waits for the TLS health endpoint.
boot_bundle() {
  local log_dir=$1
  mkdir -p "$log_dir"
  JHIN_HOME="$home" scripts/qa/run-kernel.sh "$log_dir" --server.port="$port" &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 60 \
    || fail "the kernel did not become healthy (see $log_dir/kernel.log)"
}

# enroll <artifact-dir>: issues one enrollment code through the admin CLI and
# exchanges it for a device token (the e2e-bundle pattern).
enroll() {
  local dir=$1 jar code
  mkdir -p "$dir"
  jar=$(kernel_jar)
  if ! env JHIN_HOME="$home" timeout 120 java -jar "$jar" cli create-account qa \
      > "$dir/cli-create-account.txt" 2>&1; then
    grep -q 'already exists' "$dir/cli-create-account.txt" \
      || fail "cli create-account qa failed (see $dir/cli-create-account.txt)"
  fi
  env JHIN_HOME="$home" timeout 120 java -jar "$jar" cli create-enrollment qa \
    > "$dir/cli-create-enrollment.txt" 2>&1 \
    || fail "cli create-enrollment qa failed (see $dir/cli-create-enrollment.txt)"
  code=$(sed -n 's/^code: //p' "$dir/cli-create-enrollment.txt")
  [ -n "$code" ] || fail "create-enrollment printed no code (see $dir/cli-create-enrollment.txt)"
  curl -k -sS --max-time 15 -X POST "$base/enroll" -H "$client_hdr" \
    -H 'Content-Type: application/json' \
    -d "{\"code\":\"$code\",\"deviceName\":\"e2e-lifecycle\"}" > "$dir/enroll.json" \
    || fail "POST /enroll failed"
  token=$(jq -r '.token' "$dir/enroll.json")
  [ -n "$token" ] && [ "$token" != "null" ] \
    || fail "POST /enroll returned no token (see $dir/enroll.json)"
}

# step <transcript> <name> <method> <path> <body> <expected-status> <jq-expr>
# Appends the request, status and response to the transcript and asserts both
# the status and the jq expression over the response body. The last response
# body is left in $step_payload for the caller.
step() {
  local tx=$1 name=$2 method=$3 path=$4 body=$5 expected=$6 expr=$7
  local response status payload
  response=$(curl -k -sS --max-time 10 -X "$method" \
      -H 'Content-Type: application/json' \
      -H "$client_hdr" \
      -H "Authorization: Bearer $token" \
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

# session_json <id>: the session object out of GET /sessions
session_json() {
  curl -k -sS --max-time 10 -H "$client_hdr" -H "Authorization: Bearer $token" \
    "$base/sessions" | jq -c --arg id "$1" '.[] | select(.id == $id)'
}

# fetch_sidebar <out-file>: GET /ui/screen/sessions -> the .node.body.sidebar
# object (four sections, rows id session-row:<id>).
fetch_sidebar() {
  local out=$1 response status payload
  response=$(curl -k -sS --max-time 10 -X GET -H "$client_hdr" \
      -H "Authorization: Bearer $token" \
      --data '' \
      -w $'\n%{http_code}' "$base/ui/screen/sessions")
  status=${response##*$'\n'}
  payload=${response%$'\n'*}
  [ "$status" = "200" ] \
    || fail "fetch sidebar: expected 200, got $status (resp: $payload)"
  jq -e '.node.body.sidebar.sections | length == 4' <<< "$payload" > /dev/null \
    || fail "fetch sidebar: expected 4 sections (resp: $payload)"
  jq '.node.body.sidebar' <<< "$payload" > "$out"
}

# expect_in <sidebar-file> <label> <session-id>: the session sits in the section
expect_in() {
  jq -e --arg label "$2" --arg id "$3" \
    '[.sections[] | select(.label == $label) | .items[]? | select(.id == ("session-row:" + $id))] | length > 0' \
    "$1" > /dev/null \
    || fail "session $3 must appear in section $2 (see $1)"
}

# expect_absent <sidebar-file> <session-id>: the session sits in no section
expect_absent() {
  jq -e --arg id "$2" \
    '[.sections[] | .items[]? | select(.id == ("session-row:" + $id))] | length == 0' \
    "$1" > /dev/null \
    || fail "session $2 must appear in no section (see $1)"
}

now_ms() {
  date +%s%3N
}

# backdate <id> <ms-ago>: ages updated_at so the inactivity threshold is met
backdate() {
  local id=$1 ms_ago=$2 ts
  ts=$(( $(now_ms) - ms_ago ))
  sqlite3 "$home/data/jhin.db" \
    "UPDATE jhin_sessions_sessions SET updated_at = $ts WHERE id = '$id';"
  [ "$(sqlite3 "$home/data/jhin.db" \
      "SELECT updated_at FROM jhin_sessions_sessions WHERE id = '$id';")" = "$ts" ] \
    || fail "backdate did not stick for $id"
}

if [ "$fail_mode" = "1" ]; then
  log "T81 QA --fail: the checker must fail on a deliberately wrong expectation"
  log "evidence dir: $evidence"
  build_all
  seed_home
  boot_bundle "$evidence/fail-boot"
  enroll "$evidence/fail-boot"
  neg="$evidence/negative.txt"
  : > "$neg"
  step "$neg" create POST /sessions '{"title":"t81-fail","workdir":"/tmp/t81-fail"}' 201 '.id | length > 0'
  fail_id=$(jq -r '.id' <<< "$step_payload")
  step "$neg" archive POST "/sessions/$fail_id/archive" '' 200 '.archivedAt != null'
  step "$neg" settle-after-archive POST "/sessions/$fail_id/settle" '{"reason":"manual"}' 409 '.error == "invalid_transition"'
  grep -q 'invalid_transition' "$neg" || fail "negative.txt is missing the 409 evidence"
  # deliberate wrong expectation: the probe above answered 409 (not 200)
  fail "deliberately wrong expectation: settle on an archived session answered 200 (see $neg)"
fi

log "T81 QA: full-bundle lifecycle e2e, upgrade path and contract-level downgrade"
log "evidence dir: $evidence"

# --- 1. Build the kernel and the ten default plugin jars ---
build_all
ok "kernel boot jar and the ten default plugin jars built"

# --- 2. The v1 upgrade fixture (T71 JDBC technique) ---
./gradlew :jhin-plugin-sessions:test --tests com.astroreen.jhin.plugin.sessions.V1FixtureTest \
  2>&1 | tee "$evidence/upgrade-fixture-test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/upgrade-fixture-test.txt" \
  || fail "V1FixtureTest did not report BUILD SUCCESSFUL (see $evidence/upgrade-fixture-test.txt)"
fixture_db=plugins/sessions/build/v1-fixture/jhin.db
[ -f "$fixture_db" ] || fail "the v1 fixture was not written: $fixture_db"
ok "v1 fixture written by V1FixtureTest ($fixture_db)"

# --- 3. Boot the full bundle and enroll a device ---
seed_home
boot_bundle "$evidence"
ok "kernel booted with the ten default plugins on $base (kernel.log)"
curl -k -sS --max-time 10 -H "$client_hdr" "$base/_jhin/health" > "$evidence/health.json" \
  || fail "GET /_jhin/health failed"
for id in jhin.sessions jhin.security jhin.llm jhin.llm-builtin jhin.agent \
          jhin.tools-builtin jhin.mcp jhin.ui-kit jhin.ui jhin.reload; do
  jq -e --arg id "$id" '.plugins[] | select(.id == $id)' "$evidence/health.json" > /dev/null \
    || fail "health does not list $id (see $evidence/health.json)"
done
ok "health lists all ten plugins (health.json)"
enroll "$evidence"
ok "device enrolled through the CLI single-use code (enroll.json, cli-*.txt)"

# --- 4. Seed three sessions in distinct states ---
tx="$evidence/lifecycle-transcript.txt"
: > "$tx"
step "$tx" create-active POST /sessions '{"title":"t81-active","workdir":"/tmp/t81/active"}' 201 '.id | length > 0'
s_active=$(jq -r '.id' <<< "$step_payload")
step "$tx" create-pinned POST /sessions '{"title":"t81-pinned","workdir":"/tmp/t81/pinned"}' 201 '.id | length > 0'
s_pinned=$(jq -r '.id' <<< "$step_payload")
step "$tx" create-settled POST /sessions '{"title":"t81-settled","workdir":"/tmp/t81/settled"}' 201 '.id | length > 0'
s_settled=$(jq -r '.id' <<< "$step_payload")
step "$tx" pin POST "/sessions/$s_pinned/pin" '{"order":1}' 200 \
  '.pinned == true and .pinnedOrder == 1'
step "$tx" settle POST "/sessions/$s_settled/settle" '{"reason":"manual"}' 200 \
  '.settledReason == "manual" and .settledAt != null'
{
  echo "=== seed ==="
  echo "active:  $s_active (no pin, no settle)"
  echo "pinned:  $s_pinned (pinned order=1)"
  echo "settled: $s_settled (settled_reason=manual)"
} >> "$tx"

# --- 5. Sidebar node tree memberships at the seed state ---
fetch_sidebar "$evidence/sidebar.json"
expect_in "$evidence/sidebar.json" Pinned "$s_pinned"
expect_in "$evidence/sidebar.json" Active "$s_active"
expect_in "$evidence/sidebar.json" Settled "$s_settled"
jq -e '[.sections[].items[]? | select(.id | startswith("session-row:"))] | length == 3' \
  "$evidence/sidebar.json" > /dev/null \
  || fail "sidebar.json must carry exactly three session-row:<id> rows"
jq -e '.sections[] | select(.label == "Settled") | .collapsible == true and .collapsed == true' \
  "$evidence/sidebar.json" > /dev/null \
  || fail "the Settled shelf must be collapsible and collapsed (sidebar.json)"
pinned_only=$(jq -r --arg id "$s_pinned" \
  '[.sections[] | select(any(.items[]?; .id == ("session-row:" + $id))) | .label] | length' \
  "$evidence/sidebar.json")
[ "$pinned_only" = "1" ] || fail "the pinned session must sit in exactly one section (sidebar.json)"
ok "sidebar memberships at seed: Pinned=$s_pinned, Active=$s_active, Settled=$s_settled (sidebar.json)"

# --- 6. settle -> undo inside 5 s restores the session ---
undo_tx="$evidence/undo-transcript.txt"
: > "$undo_tx"
step "$undo_tx" settle-active POST "/sessions/$s_active/settle" '{"reason":"manual"}' 200 \
  '.settledReason == "manual" and .settledAt != null'
fetch_sidebar "$evidence/.sidebar-tmp.json"
expect_in "$evidence/.sidebar-tmp.json" Settled "$s_active"
echo "assert: after settle the active session sits in Settled -- ok" >> "$undo_tx"
undo_body='{"action":"undo","payload":{}}'
undo_ok='(.client | length) == 2 and .client[0].op == "toast" and .client[0].text == "Undone" and .client[1].op == "refresh"'
step "$undo_tx" undo-settle POST /ui/action/undo "$undo_body" 200 "$undo_ok"
step "$undo_tx" state-after-undo GET /sessions '' 200 \
  "any(.[]; .id == \"$s_active\" and .settledAt == null and .settledReason == null)"
fetch_sidebar "$evidence/sidebar-after-undo.json"
expect_in "$evidence/sidebar-after-undo.json" Active "$s_active"
{
  echo "assert: undo inside the 5 s window restored the session (settledAt null,"
  echo "  settledReason null) and the sidebar moved it back to Active"
} >> "$undo_tx"
ok "settle -> undo inside 5 s restores the session and its sidebar membership (undo-transcript.txt)"

# --- 7. snooze -> wake, pin -> unpin, archive -> restore ---
step "$tx" snooze POST "/sessions/$s_active/snooze" '{"durationMs":3600000}' 200 \
  '.snoozedUntil != null'
fetch_sidebar "$evidence/.sidebar-tmp.json"
expect_in "$evidence/.sidebar-tmp.json" Snoozed "$s_active"
step "$tx" wake POST "/sessions/$s_active/wake" '' 200 '.snoozedUntil == null'
fetch_sidebar "$evidence/.sidebar-tmp.json"
expect_in "$evidence/.sidebar-tmp.json" Active "$s_active"
step "$tx" pin-active POST "/sessions/$s_active/pin" '{"order":2}' 200 \
  '.pinned == true and .pinnedOrder == 2'
fetch_sidebar "$evidence/.sidebar-tmp.json"
expect_in "$evidence/.sidebar-tmp.json" Pinned "$s_active"
step "$tx" unpin-active POST "/sessions/$s_active/unpin" '' 200 \
  '.pinned == false and .pinnedOrder == null'
fetch_sidebar "$evidence/.sidebar-tmp.json"
expect_in "$evidence/.sidebar-tmp.json" Active "$s_active"
step "$tx" archive-active POST "/sessions/$s_active/archive" '' 200 '.archivedAt != null'
fetch_sidebar "$evidence/.sidebar-tmp.json"
expect_absent "$evidence/.sidebar-tmp.json" "$s_active"
step "$tx" restore-active POST "/sessions/$s_active/restore" '' 200 '.archivedAt == null'
fetch_sidebar "$evidence/.sidebar-tmp.json"
expect_in "$evidence/.sidebar-tmp.json" Active "$s_active"
{
  echo "=== membership after every step ==="
  echo "snooze -> Snoozed, wake -> Active, pin -> Pinned, unpin -> Active,"
  echo "archive -> absent, restore -> Active (asserted on each fetched tree)"
} >> "$tx"
ok "snooze/wake, pin/unpin and archive/restore move the sidebar membership (lifecycle-transcript.txt)"

# --- 8. session_updated SSE frames ---
raw="$evidence/sse-raw.txt"
timeout 4 curl -k -sN -H "$client_hdr" -H "Authorization: Bearer $token" \
  "$base/sessions/$s_active/events?fromSeq=0" > "$raw" || true
awk '/^event: session_updated$/ { if (getline > 0) { sub(/^data: /, ""); print } }' "$raw" \
  > "$evidence/events.jsonl"
jq -s '.' "$evidence/events.jsonl" > "$evidence/events.json"
jq -e 'length >= 6' "$evidence/events.json" > /dev/null \
  || fail "expected at least 6 session_updated frames for the active session, got $(jq 'length' "$evidence/events.json") (see $raw)"
jq -e --arg id "$s_active" \
  'all(.[]; ((.payload // .) | tostring | contains($id)))' "$evidence/events.json" > /dev/null \
  || fail "not every session_updated frame carries the active session (see $evidence/events.json)"
ok "events.json holds $(jq 'length' "$evidence/events.json") session_updated frames (raw in sse-raw.txt)"

# --- 9. bootstrap api=2 vs api=1 ---
curl -k -sS --max-time 10 -H "$client_hdr" "$base/_jhin/bootstrap" \
  > "$evidence/bootstrap-api2.json" || fail "GET /_jhin/bootstrap (api=2) failed"
curl -k -sS --max-time 10 -H "$api1_hdr" "$base/_jhin/bootstrap" \
  > "$evidence/bootstrap-api1.json" || fail "GET /_jhin/bootstrap (api=1) failed"
jq -e '.contract.api == 2 and .contract.minApi == 2 and .contract.schema == 3 and .contract.minSchema == 3' \
  "$evidence/bootstrap-api2.json" > /dev/null \
  || fail "api=2 bootstrap lacks the level-2 contract (see $evidence/bootstrap-api2.json)"
jq -e 'has("tokens") and has("keymap")' "$evidence/bootstrap-api2.json" > /dev/null \
  || fail "api=2 bootstrap lacks tokens/keymap (see $evidence/bootstrap-api2.json)"
jq -e '(has("contract") or has("tokens") or has("density") or has("keymap")) | not' \
  "$evidence/bootstrap-api1.json" > /dev/null \
  || fail "api=1 bootstrap leaks level-2 keys (see $evidence/bootstrap-api1.json)"
jq -nr \
  --slurpfile api1 "$evidence/bootstrap-api1.json" \
  --slurpfile api2 "$evidence/bootstrap-api2.json" \
  '(["contract","tokens","density","keymap"]) as $l2 |
   "api1 keys:\n\($api1[0] | keys | join(", "))\n\napi2 keys:\n\($api2[0] | keys | join(", "))\n\nlevel-2 keys: \($l2 | join(", "))\nlevel-2 keys in api2: \([$l2[] | select(. as $k | $api2[0] | has($k))] | join(", "))\nlevel-2 keys in api1: \([$l2[] | select(. as $k | $api1[0] | has($k))] | join(", "))\n\nassert: the level-1 shape carries zero level-2 keys (contract/tokens/density/keymap)\n"' \
  > "$evidence/bootstrap-diff.txt"
grep -q '^level-2 keys in api2: contract, tokens, density, keymap$' "$evidence/bootstrap-diff.txt" \
  || fail "bootstrap-diff.txt: api=2 must carry all four level-2 keys (see $evidence/bootstrap-diff.txt)"
grep -q '^level-2 keys in api1: $' "$evidence/bootstrap-diff.txt" \
  || fail "bootstrap-diff.txt: api=1 must carry zero level-2 keys (see $evidence/bootstrap-diff.txt)"
ok "bootstrap api2 vs api1: level-1 shape carries zero level-2 keys (bootstrap-diff.txt)"

# --- 10. auto-settle sweep on a restarted bundle ---
stop_kernel
cat > "$home/config.json" <<EOF
{
  "jhin.sessions": {
    "inactivityMs": 1000,
    "sweepInitialDelayMs": 1000,
    "sweepIntervalMs": 2000
  }
}
EOF
boot_bundle "$evidence/sweep-boot"
enroll "$evidence/sweep-boot"
ok "kernel restarted with inactivityMs=1000 and short sweep delays (sweep-boot/kernel.log)"

sw_tx="$evidence/sweep-transcript.txt"
: > "$sw_tx"
step "$sw_tx" create-idle POST /sessions '{"title":"t81-idle","workdir":"/tmp/t81/idle"}' 201 '.id | length > 0'
s_idle=$(jq -r '.id' <<< "$step_payload")
{
  echo "=== seed ==="
  echo "idle:   $s_idle (fresh, no pin, no run)"
  echo "pinned: $s_pinned (pinned order=1 since the first boot)"
} >> "$sw_tx"
backdate "$s_idle" 10000
backdate "$s_pinned" 10000
{
  echo "=== backdate ==="
  echo "updated_at of the idle and the pinned session set to now-10s via sqlite3 on $home/data/jhin.db"
} >> "$sw_tx"
sleep 8
{
  echo "=== sweep result (after 8 s, sweeps every 2 s) ==="
} >> "$sw_tx"
idle_json=$(session_json "$s_idle")
pinned_json=$(session_json "$s_pinned")
settled_json=$(session_json "$s_settled")
{
  echo "idle:   $idle_json"
  echo "pinned: $pinned_json"
  echo "settled: $settled_json (untouched since the first boot)"
} >> "$sw_tx"
jq -e '.settledAt != null and .settledReason == "inactive"' <<< "$idle_json" > /dev/null \
  || fail "the idle session did not settle with settled_reason=inactive (see $sw_tx)"
echo "assert idle: settled with settled_reason=inactive -- ok" >> "$sw_tx"
jq -e '.settledAt != null and .settledReason == "inactive"
       and .pinned == true and .pinnedOrder == 1' <<< "$pinned_json" > /dev/null \
  || fail "the pinned session did not settle or lost its pin (see $sw_tx)"
echo "assert pinned: settled with settled_reason=inactive AND kept pinned/pinned_order -- ok" >> "$sw_tx"
jq -e '.settledReason == "manual"' <<< "$settled_json" > /dev/null \
  || fail "the manually settled session lost its settled_reason (see $sw_tx)"
echo "assert settled: settled_reason stays manual -- ok" >> "$sw_tx"
grep -q 'settlement sweep' "$evidence/sweep-boot/kernel.log" \
  || fail "sweep-boot/kernel.log carries no sweep lines"
fetch_sidebar "$evidence/sidebar-sweep.json"
expect_in "$evidence/sidebar-sweep.json" Settled "$s_idle"
expect_in "$evidence/sidebar-sweep.json" Pinned "$s_pinned"
jq -e --arg id "$s_pinned" \
  '[.sections[] | select(.label == "Settled") | .items[]? | select(.id == ("session-row:" + $id))] | length == 0' \
  "$evidence/sidebar-sweep.json" > /dev/null \
  || fail "the auto-settled pinned session must not leak into Settled (sidebar-sweep.json)"
echo "assert sidebar: idle moved to Settled, pinned stays in Pinned only -- ok" >> "$sw_tx"
ok "sweep settles the idle and the pinned session (pin kept) (sweep-transcript.txt, sidebar-sweep.json)"

# --- 11. upgrade path: a real v1 jhin.db booted through the kernel ---
stop_kernel
up_home=$(mktemp -d /tmp/e2e-lifecycle-upgrade.XXXXXX)
mkdir -p "$up_home/data" "$up_home/plugins"
cp "$fixture_db" "$up_home/data/jhin.db"
cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$up_home/plugins/"
up_db="$up_home/data/jhin.db"
{
  echo "-- T81 upgrade capture: BEFORE the kernel boot (v1 schema)"
  echo "-- schema:"
  sqlite3 "$up_db" ".schema jhin_sessions_sessions"
  echo "-- rows:"
  sqlite3 "$up_db" "SELECT * FROM jhin_sessions_sessions ORDER BY id;"
  echo "-- plugin schema bookkeeping:"
  sqlite3 "$up_db" "SELECT plugin_id, version FROM _jhin_plugin_schema ORDER BY version;"
} > "$evidence/upgrade-before.sql"
before_rows=$(sqlite3 -json "$up_db" "SELECT * FROM jhin_sessions_sessions ORDER BY id;")

up_log_dir="$evidence/upgrade-boot"
mkdir -p "$up_log_dir"
JHIN_HOME="$up_home" scripts/qa/run-kernel.sh "$up_log_dir" --server.port=18483 &
kernel_pid=$!
wait_health "http://localhost:18483/_jhin/health" 60 \
  || fail "the upgrade kernel did not become healthy (see $up_log_dir/kernel.log)"
ok "kernel booted against the v1 jhin.db (upgrade-boot/kernel.log)"
stop_kernel

{
  echo "-- T81 upgrade capture: AFTER the kernel boot (v2 schema)"
  echo "-- schema:"
  sqlite3 "$up_db" ".schema jhin_sessions_sessions"
  echo "-- rows:"
  sqlite3 "$up_db" "SELECT * FROM jhin_sessions_sessions ORDER BY id;"
  echo "-- plugin schema bookkeeping:"
  sqlite3 "$up_db" "SELECT plugin_id, version FROM _jhin_plugin_schema ORDER BY version;"
} > "$evidence/upgrade-after.sql"
after_rows=$(sqlite3 -json "$up_db" "SELECT * FROM jhin_sessions_sessions ORDER BY id;")
jq -n --argjson before "$before_rows" --argjson after "$after_rows" \
  '{before: $before, after: $after}' > "$evidence/upgrade-rows.json"

for col in pinned pinned_order settled_at snoozed_until archived_at auto_settle \
           sort_order settled_reason auto_settle_suppressed; do
  grep -q "$col" "$evidence/upgrade-after.sql" \
    || fail "the v2 migration did not add column $col (see $evidence/upgrade-after.sql)"
done
for col in pinned pinned_order settled_at snoozed_until archived_at auto_settle \
           sort_order settled_reason auto_settle_suppressed; do
  if grep -q "$col" "$evidence/upgrade-before.sql"; then
    fail "the v1 schema unexpectedly carries column $col (see $evidence/upgrade-before.sql)"
  fi
done
grep -q '^jhin\.sessions|2$' "$evidence/upgrade-after.sql" \
  || fail "_jhin_plugin_schema has no version 2 row after the boot (see $evidence/upgrade-after.sql)"
jq -e '(.before | length) == 3 and (.after | length) == 3' "$evidence/upgrade-rows.json" > /dev/null \
  || fail "expected 3 rows before and after the upgrade (see $evidence/upgrade-rows.json)"
jq -e '([.after[] | {id, account_id, title, workdir, model, provider_id, status, created_at, updated_at}]) == .before' \
  "$evidence/upgrade-rows.json" > /dev/null \
  || fail "the pre-v2 rows did not survive intact (see $evidence/upgrade-rows.json)"
jq -e 'all(.after[]; .pinned == 0 and .auto_settle == 1 and .auto_settle_suppressed == 0
       and .settled_at == null and .snoozed_until == null and .archived_at == null
       and .pinned_order == null and .sort_order == null and .settled_reason == null)' \
  "$evidence/upgrade-rows.json" > /dev/null \
  || fail "the pre-v2 rows lack the lifecycle defaults (see $evidence/upgrade-rows.json)"
ok "v1 jhin.db migrated in place: 9 columns added, 3 rows intact with defaults (upgrade-{before,after}.sql, upgrade-rows.json)"

# --- 12. client store: the T54 migration harness on a legacy schema:1 blob ---
store="$evidence/store"
mkdir -p "$store"
store=$(readlink -f "$store")
if command -v flutter > /dev/null 2>&1 || command -v devenv > /dev/null 2>&1; then
  T54_EVIDENCE_DIR="$store" scripts/qa/flutter-test.sh test/store/evidence_test.dart \
    2>&1 | tee "$evidence/store-test.txt"
  grep -q 'All tests passed' "$evidence/store-test.txt" \
    || fail "the store evidence test did not pass (see $evidence/store-test.txt)"
  [ -f "$store/legacy-blob.json" ] && [ -f "$store/after-migration.json" ] \
    || fail "the T54 harness wrote no fixtures into $store (see $evidence/store-test.txt)"
  jq -e '[.[] | (if type == "string" then (fromjson? // .) else . end) | select(type == "array")] | length >= 1' \
    "$store/legacy-blob.json" > /dev/null \
    || fail "legacy-blob.json holds no raw schema:1 list (see $store/legacy-blob.json)"
  jq -e '[.[] | (if type == "string" then (fromjson? // .) else . end) | select(type == "object" and has("schema") and has("data"))] | length >= 2' \
    "$store/after-migration.json" > /dev/null \
    || fail "after-migration.json holds no migrated envelopes (see $store/after-migration.json)"
  ok "client store: legacy schema:1 blobs migrate to envelopes (store/, store-test.txt)"
else
  {
    echo "T81 degrade note: neither flutter nor devenv is on PATH on this host;"
    echo "the T54 client-store migration harness could not run here."
    echo "Covered on toolchain hosts by scripts/qa/t54.sh (test/store)."
  } | tee "$evidence/store-test.txt"
  ok "client-store migration skipped: no flutter toolchain (degrade note in store-test.txt)"
fi

rm -f "$evidence/.sidebar-tmp.json"
log "T81 QA green: lifecycle e2e, upgrade path and contract-level downgrade (evidence in $evidence)"
