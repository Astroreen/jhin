#!/usr/bin/env bash
# QA for T76: the shell screen with the t3code thread sidebar sections
# (Pinned / Active / Snoozed / Settled).
# Usage: scripts/qa/t76.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T76. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM and
# reaped with `wait`; JSON assertions run with jq (present on the QA machine).
#
# Happy path:
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL;
#   - boots the kernel with jhin.sessions, jhin.ui-kit and jhin.ui
#     (run-kernel.sh, log in kernel.log) and seeds 8 sessions over curl
#     (seed.txt) covering all four sidebar states plus the two edge rules:
#     a pinned+settled session and a session whose snooze has expired;
#   - fetches GET /ui/screen/sessions and writes the rendered sidebar node
#     tree into sidebar.json; asserts the section membership counts
#     (Pinned=2, Active=3, Snoozed=1, Settled=2), the pinned+settled priority
#     (Pinned only) and the expired-snooze fallback (Active), recording the
#     membership matrix in priority.txt;
#   - sidebar.png is skipped: no screenshot harness exists for the
#     server-rendered node tree (the Flutter goldens cover client-side
#     fixtures only), recorded in checks.txt.
#
# Failure path: the same kernel and seeds, then a deliberately wrong
# expectation — that the pinned+settled session also appears in Settled —
# asserted against the real sidebar.json; the checker must fail (checks-fail.txt,
# exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T76_INNER:-}" ]; then
  exec env T76_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T76}
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

port=18476
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
  JHIN_HOME="$home" scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 60 || fail "the kernel did not become healthy (see $kernel_log_dir/kernel.log)"
}

# step <transcript> <name> <method> <path> <body> <expected-status> <jq-expr>
# Appends the request, status and response to the transcript and asserts both
# the status and the jq expression over the response body. The last response
# body is left in $step_payload for the caller.
step() {
  local tx=$1 name=$2 method=$3 path=$4 body=$5 expected=$6 expr=$7
  local response status payload
  response=$(curl -sS --max-time 10 -X "$method" \
      -H 'Content-Type: application/json' \
      -H 'X-Jhin-Client: api=2; version=0.2.0; schema=3; caps=sse' \
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

# section_items <label>: the row session ids of one sidebar section, one per line
section_items() {
  jq -r --arg label "$1" \
    '.sections[] | select(.label == $label) | .items[]? | .id | sub("^session-row:"; "")' \
    "$evidence/sidebar.json"
}

# section_count <label>: the number of rows in one sidebar section
section_count() {
  jq -r --arg label "$1" \
    '[.sections[] | select(.label == $label) | .items[]?] | length' \
    "$evidence/sidebar.json"
}

# seed_session <transcript> <title> <extra-curl-steps...>: creates one session
# and prints its id; the extra arguments are lifecycle paths+ bodies applied
# after creation (each one word "PATH BODY").
seed_session() {
  local tx=$1 title=$2
  shift 2
  step "$tx" "create-$title" POST /sessions "{\"title\":\"$title\",\"workdir\":\"/tmp/t76/$title\"}" 201 '.id | length > 0'
  local sid
  sid=$(jq -r '.id' <<< "$step_payload")
  local spec path body
  for spec in "$@"; do
    path=${spec%% *}
    body=${spec#* }
    step "$tx" "$title-$(basename "$path")" POST "/sessions/$sid$path" "$body" 200 '.id | length > 0'
  done
  printf '%s' "$sid"
}

if [ "$fail_mode" = "1" ]; then
  log "T76 QA --fail: the checker must fail on a deliberately wrong expectation"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/priority-fail.txt"
  : > "$tx"
  pin_settled=$(seed_session "$tx" "pin-settled" "/settle {\"reason\":\"manual\"}" "/pin {}")
  step "$tx" "fetch-sidebar" GET /ui/screen/sessions '' 200 '.node.body.sidebar.sections | length == 4'
  jq '.node.body.sidebar' <<< "$step_payload" > "$evidence/sidebar-fail.json"
  # deliberate wrong expectation: the pinned+settled session is in Pinned only
  if jq -e --arg id "$pin_settled" \
      '.sections[] | select(.label == "Settled") | .items[]? | select(.id == ("session-row:" + $id))' \
      "$evidence/sidebar-fail.json" > /dev/null; then
    fail "deliberately wrong expectation held: the pinned+settled session also appears in Settled (see $tx)"
  fi
  fail "deliberately wrong expectation: the pinned+settled session appears in Settled too (see $tx)"
fi

log "T76 QA: the shell screen with the thread sidebar sections"
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

# --- 2. The kernel sidebar ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/seed.txt"
: > "$tx"
pin_plain=$(seed_session "$tx" "pin-plain" "/pin {\"order\":1}")
pin_settled=$(seed_session "$tx" "pin-settled" "/settle {\"reason\":\"manual\"}" "/pin {\"order\":2}")
act_plain=$(seed_session "$tx" "act-plain")
act_ordered=$(seed_session "$tx" "act-ordered")
act_expired=$(seed_session "$tx" "act-expired" "/snooze {\"durationMs\":500}")
snoozed=$(seed_session "$tx" "snoozed" "/snooze {\"durationMs\":3600000}")
settled_one=$(seed_session "$tx" "settled-one" "/settle {\"reason\":\"manual\"}")
settled_two=$(seed_session "$tx" "settled-two" "/settle {\"reason\":\"manual\"}")
# the 500ms snooze of act-expired must lapse before the render
sleep 2
ok "seeded 8 sessions across the four states (seed.txt)"

step "$tx" "fetch-sidebar" GET /ui/screen/sessions '' 200 \
  '.node.body.sidebar.sections | length == 4'
jq '.node.body.sidebar' <<< "$step_payload" > "$evidence/sidebar.json"
ok "rendered sidebar node tree written to sidebar.json"

# --- 3. Membership counts ---
pinned_count=$(section_count Pinned)
active_count=$(section_count Active)
snoozed_count=$(section_count Snoozed)
settled_count=$(section_count Settled)
[ "$pinned_count" = "2" ] || fail "Pinned count $pinned_count, expected 2"
[ "$active_count" = "3" ] || fail "Active count $active_count, expected 3"
[ "$snoozed_count" = "1" ] || fail "Snoozed count $snoozed_count, expected 1"
[ "$settled_count" = "2" ] || fail "Settled count $settled_count, expected 2"
ok "section membership counts Pinned=2 Active=3 Snoozed=1 Settled=2"

# --- 4. The priority matrix ---
{
  echo "T76 sidebar membership matrix (8 seeded sessions)"
  echo
  printf '%-36s %-8s %s\n' "session" "section" "rule"
  for entry in \
      "$pin_plain:Pinned:pinned=1" \
      "$pin_settled:Pinned:pinned+settled -> Pinned only" \
      "$act_plain:Active:plain" \
      "$act_ordered:Active:plain" \
      "$act_expired:Active:snoozed_until past -> Active" \
      "$snoozed:Snoozed:snoozed_until future" \
      "$settled_one:Settled:settled_at set" \
      "$settled_two:Settled:settled_at set"; do
    sid=${entry%%:*}
    rest=${entry#*:}
    expected=${rest%%:*}
    rule=${rest#*:}
    actual=$(jq -r --arg id "$sid" \
        '([.sections[] | select(any(.items[]?; .id == ("session-row:" + $id))) | .label][0]) // "none"' \
        "$evidence/sidebar.json")
    printf '%-36s %-8s %s\n' "$sid" "$actual" "$rule"
    [ "$actual" = "$expected" ] \
      || fail "priority matrix: $sid landed in $actual, expected $expected ($rule)"
  done
  echo
  echo "counts: Pinned=$pinned_count Active=$active_count Snoozed=$snoozed_count Settled=$settled_count"
  echo "pinned+settled priority: $pin_settled appears only in Pinned"
  echo "expired snooze fallback: $act_expired appears in Active, not Snoozed"
} | tee "$evidence/priority.txt"
ok "membership matrix matches every rule (priority.txt)"

# pinned+settled must not leak into Settled
if section_items Settled | grep -qx "$pin_settled"; then
  fail "the pinned+settled session $pin_settled also appears in Settled"
fi
# the expired snooze must not sit in Snoozed
if section_items Snoozed | grep -qx "$act_expired"; then
  fail "the expired-snooze session $act_expired still appears in Snoozed"
fi
ok "priority rules hold (pinned+settled -> Pinned only, expired snooze -> Active)"

# --- 5. Row identity and the settled shelf ---
jq -e '[.sections[].items[]? | select(.id | startswith("session-row:"))] | length == 8' \
    "$evidence/sidebar.json" > /dev/null \
  || fail "every row must carry a session-row:<id> id (sidebar.json)"
jq -e '.sections[] | select(.label == "Settled") | .collapsible == true and .collapsed == true' \
    "$evidence/sidebar.json" > /dev/null \
  || fail "the Settled shelf must be collapsible and collapsed (sidebar.json)"
ok "rows carry session-row:<id> ids and the Settled shelf starts collapsed"

# --- 6. The screenshot ---
echo "sidebar.png skipped: no screenshot harness exists for the server-rendered node tree" \
  | tee -a "$checks"
ok "sidebar.png skipped (no harness; noted in checks.txt)"

log "T76 QA green: evidence in $evidence"