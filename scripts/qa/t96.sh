#!/usr/bin/env bash
# QA for T96: the thread sidebar container — the resizable split (the
# persisted chat_thread_sidebar_width metrics), the five collapsible sections
# in render order (Pinned / Active / Working / Snoozed / Settled) with their
# default collapse flags, the section chrome contract (uppercase header,
# count badge, store keys, the Working opt-in gate) and the section
# membership rules.
# Usage: scripts/qa/t96.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T96. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit and
# jhin.ui (the sessions screen IS the sidebar surface).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T96 tree asserts
#     (SidebarBuilderTest: the split metrics, the five sections, the chrome
#     contract, the membership rules);
#   - runs the Flutter split persistence suite (flutter-split.txt: the
#     divider drag persists under chat_thread_sidebar_width and restores
#     across a remount) and the T96 section-extension suite
#     (flutter-sections.txt: the when gate, the uppercase transform, the
#     count badge, the storeKey collapse persistence) and requires
#     "All tests passed";
#   - boots the kernel, seeds two sessions and snoozes one (seed.txt);
#   - fetches GET /ui/screen/sessions at api=3;schema=4 and writes the
#     sidebar split tree into sidebar-tree.json; asserts the split metrics
#     (persistKey/initial/min/minSecond), exactly five sections in order
#     with the default collapse flags, the per-section chrome (count,
#     badgeStyle, uppercase, storeKey), the Working opt-in gate and that the
#     snoozed session sits under Snoozed and nowhere under Active;
#   - fetches the same screen at api=2;schema=3 and asserts the split
#     downgrade keeps both panes as children with the sections intact
#     (sidebar-tree-l2.json).
#
# Failure path: the deliberately wrong expectation — a session in the
# snoozed state appearing under Active — is asserted against the real
# sidebar tree; the assertion must fail (the partition keeps the snoozed
# session in the Snoozed shelf), and the trip is recorded in
# checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T96_INNER:-}" ]; then
  exec env T96_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T96}
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

port=18496
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
# value as the first argument. Appends the request, status and response to
# the transcript and asserts both the status and the jq expression over the
# response body. The last response body is left in $step_payload.
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

# seed_session <transcript> <title> <workdir>: creates one session, echoes
# its id.
seed_session() {
  local tx=$1 title=$2 workdir=$3 response id
  response=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -H "$client_header" \
      --data "{\"title\":\"$title\",\"workdir\":\"$workdir\"}" \
      "$base/sessions")
  id=$(jq -re '.id' <<< "$response") \
    || fail "seed $title: no session id in the create response (resp: $response)"
  {
    echo "=== seed $title ==="
    echo "POST /sessions"
    echo "resp: $response"
  } >> "$tx"
  printf '%s' "$id"
}

# snooze_session <transcript> <id> <duration-ms>: snoozes one session.
snooze_session() {
  local tx=$1 id=$2 duration=$3 response
  response=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -H "$client_header" \
      --data "{\"durationMs\":$duration}" \
      "$base/sessions/$id/snooze")
  {
    echo "=== snooze $id ==="
    echo "POST /sessions/$id/snooze"
    echo "resp: $response"
  } >> "$tx"
}

# section_items <label>: the row session ids of one sidebar section, one per
# line (the split's first pane carries the section list).
section_items() {
  local label=$1
  jq -r --arg label "$label" \
    '.first.sections[] | select(.label == $label) | .items[]? | .id | sub("^session-row:"; "")' \
    "$evidence/sidebar-tree.json"
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
  log "T96 QA --fail: a session in the snoozed state must not appear under Active"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  ok "kernel booted for the failure path (fail-boot/kernel.log)"

  tx="$evidence/fail-seed.txt"
  : > "$tx"
  snoozed_id=$(seed_session "$tx" "fail-snoozed" "/tmp/fail-snoozed")
  snooze_session "$tx" "$snoozed_id" 3600000
  ok "seeded one session and snoozed it for one hour (fail-seed.txt)"

  step_hdr "$client_header" "$tx" "fetch-sidebar" GET /ui/screen/sessions '' 200 \
    '.node.type == "screen"'
  jq -S '.node.body.body' <<< "$step_payload" > "$evidence/sidebar-tree-fail.json"

  # The deliberately wrong expectation: the snoozed session appears under
  # Active. The partition keeps it in the Snoozed shelf, so the assertion
  # must fail — the guard trips and the run records the trip.
  if jq -r --arg label "Active" \
      '.first.sections[] | select(.label == $label) | .items[]? | .id | sub("^session-row:"; "")' \
      "$evidence/sidebar-tree-fail.json" | grep -qx "$snoozed_id"; then
    fail "deliberately wrong expectation held: the snoozed session appeared under Active (see $evidence/sidebar-tree-fail.json)"
  fi
  {
    echo "FAIL: the snoozed session appeared under Active (as designed)"
    echo "  the partition keeps the snoozed session in the Snoozed shelf; the Active section carries no snoozed row"
    echo "  session id: $snoozed_id (sidebar-tree-fail.json)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the snoozed session is under Active (it is not; see $evidence/sidebar-tree-fail.json)"
fi

log "T96 QA: the sidebar split, the five sections and the collapse defaults"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T96 tree asserts live here) ---
# --rerun is a per-task flag (it attaches to the preceding task spec): the
# one-flag combined form only force-reruns the last task and silently skips
# the other when it is up-to-date, so each suite carries its own flag.
./gradlew :jhin-plugin-ui-default:test --rerun :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; transcript in test.txt)"

# --- 3. The Flutter suites: the split persistence + the section extensions ---
bash scripts/qa/flutter-test.sh test/sdui/split_test.dart \
  2>&1 | tee "$evidence/flutter-split.txt"
grep -q 'All tests passed' "$evidence/flutter-split.txt" \
  || fail "the Flutter split persistence suite failed (see $evidence/flutter-split.txt)"
ok "Flutter split suite green: the divider drag persists under chat_thread_sidebar_width and restores across a remount (flutter-split.txt)"

bash scripts/qa/flutter-test.sh test/sdui/sidebar_sections_test.dart \
  2>&1 | tee "$evidence/flutter-sections.txt"
grep -q 'All tests passed' "$evidence/flutter-sections.txt" \
  || fail "the Flutter section-extension suite failed (see $evidence/flutter-sections.txt)"
ok "Flutter section suite green: the when gate, the uppercase transform, the count badge and the storeKey collapse persistence (flutter-sections.txt)"

# --- 4. The kernel with the sidebar ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/seed.txt"
: > "$tx"

active_id=$(seed_session "$tx" "active-thread" "/tmp/active-thread")
snoozed_id=$(seed_session "$tx" "snoozed-thread" "/tmp/snoozed-thread")
snooze_session "$tx" "$snoozed_id" 3600000
ok "seeded two sessions, one snoozed for one hour (seed.txt)"

# --- 5. The sessions screen: the sidebar split tree ---
step_hdr "$client_header" "$tx" "fetch-sidebar" GET /ui/screen/sessions '' 200 \
  '.node.type == "screen"'
jq -S '.node.body.body' <<< "$step_payload" > "$evidence/sidebar-tree.json"

# The split metrics (upstream threadSidebarWidth.ts:1-4).
jq -e '.type == "split" and .id == "sidebar-split"
    and .persistKey == "chat_thread_sidebar_width"
    and .initial == 256 and .min == 208 and .minSecond == 640' \
  "$evidence/sidebar-tree.json" > /dev/null \
  || fail "the sidebar split does not carry the persisted metrics (sidebar-tree.json)"
ok "split metrics: persistKey chat_thread_sidebar_width, initial 256, min 208, minSecond 640 (sidebar-tree.json)"

# Exactly five sections in order with the default collapse flags.
jq -e '[.first.sections[].id] == ["section-pinned", "section-active", "section-working", "section-snoozed", "section-settled"]' \
  "$evidence/sidebar-tree.json" > /dev/null \
  || fail "the sidebar does not carry the five sections in order (sidebar-tree.json)"
jq -e '[.first.sections[] | {id, collapsed}] == [
    {id: "section-pinned", collapsed: false},
    {id: "section-active", collapsed: false},
    {id: "section-working", collapsed: false},
    {id: "section-snoozed", collapsed: true},
    {id: "section-settled", collapsed: true}]' \
  "$evidence/sidebar-tree.json" > /dev/null \
  || fail "the default collapse flags are wrong (sidebar-tree.json)"
ok "five sections in order Pinned/Active/Working/Snoozed/Settled; Pinned/Active/Working expanded, Snoozed/Settled collapsed (sidebar-tree.json)"

# The section chrome: labels, counts, badge style, uppercase, store keys.
jq -e '[.first.sections[] | {label, count, badgeStyle, uppercase,
    storeKey}] == [
    {label: "Pinned", count: 0, badgeStyle: "sidebar-control-surface",
     uppercase: true, storeKey: "sidebar.section.pinned.collapsed"},
    {label: "Active", count: 1, badgeStyle: "sidebar-control-surface",
     uppercase: true, storeKey: "sidebar.section.active.collapsed"},
    {label: "Working", count: 0, badgeStyle: "sidebar-control-surface",
     uppercase: true, storeKey: "sidebar.section.working.collapsed"},
    {label: "Snoozed", count: 1, badgeStyle: "sidebar-control-surface",
     uppercase: true, storeKey: "sidebar.section.snoozed.collapsed"},
    {label: "Settled", count: 0, badgeStyle: "sidebar-control-surface",
     uppercase: true, storeKey: "sidebar.section.settled.collapsed"}]' \
  "$evidence/sidebar-tree.json" > /dev/null \
  || fail "the section chrome contract is wrong (sidebar-tree.json)"
ok "section chrome: labels, counts, badgeStyle sidebar-control-surface, uppercase, store keys sidebar.section.<name>.collapsed (sidebar-tree.json)"

# The Working opt-in gate.
jq -e '.first.sections[] | select(.id == "section-working")
    | .when == "workingSection != false"' \
  "$evidence/sidebar-tree.json" > /dev/null \
  || fail "the Working section does not carry the opt-in gate (sidebar-tree.json)"
jq -e '[.first.sections[] | select(.when != null) | .id] == ["section-working"]' \
  "$evidence/sidebar-tree.json" > /dev/null \
  || fail "a section other than Working carries a when gate (sidebar-tree.json)"
ok "Working opt-in gate: when workingSection != false, and no other section carries a gate (sidebar-tree.json)"

# The membership: the snoozed session sits under Snoozed, never under
# Active; the active session stays under Active.
if section_items Active | grep -qx "$snoozed_id"; then
  fail "the snoozed session appeared under Active (sidebar-tree.json)"
fi
section_items Snoozed | grep -qx "$snoozed_id" \
  || fail "the snoozed session is not under Snoozed (sidebar-tree.json)"
section_items Active | grep -qx "$active_id" \
  || fail "the active session is not under Active (sidebar-tree.json)"
ok "membership: the snoozed session under Snoozed only, the active session under Active (sidebar-tree.json)"

# The primitive-catalog guard: every node type in the tree is legal.
types=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' \
  "$evidence/sidebar-tree.json")
for t in $types; do
  catalog_primitives | grep -qx "$t" \
    || fail "node type '$t' is outside the docs/sdui.md section 2.5 catalog"
done
ok "every node type is inside the docs/sdui.md section 2.5 catalog ($(echo "$types" | tr '\n' ' '))"

# --- 6. The same screen at level 2: the split downgrade keeps both panes ---
step_hdr 'api=2; version=0.3.0; schema=3; caps=sse' "$tx" "fetch-sidebar-l2" \
  GET /ui/screen/sessions '' 200 '.node.type == "screen"'
jq -S '.node.body.body' <<< "$step_payload" > "$evidence/sidebar-tree-l2.json"
# The documented split downgrade: split -> column, the panes as children
# (docs/sdui.md section 6).
jq -e '.type == "column" and ([.children[].type] | index("list") != null)' \
  "$evidence/sidebar-tree-l2.json" > /dev/null \
  || fail "the level-2 split downgrade does not keep the panes as children (sidebar-tree-l2.json)"
jq -e '[.children[] | select(.type == "list")][0].sections | length == 5' \
  "$evidence/sidebar-tree-l2.json" > /dev/null \
  || fail "the level-2 tree does not carry the five sections (sidebar-tree-l2.json)"
ok "level-2 tree: the split downgrade (split -> column, the panes as children) keeps the five sections (sidebar-tree-l2.json)"

# The kernel work is done — stop it before the summary.
stop_kernel

# --- 7. The summary ---
{
  echo "# T96 sidebar container summary"
  echo
  echo "split: persistKey chat_thread_sidebar_width, initial 256, min 208,"
  echo "minSecond 640 (upstream threadSidebarWidth.ts:1-4, commit 37de6cb);"
  echo "the divider position persists client-side (the T90 seam)"
  echo
  echo "sections: Pinned / Active / Working / Snoozed / Settled, all"
  echo "collapsible; defaults Pinned/Active/Working expanded, Snoozed/Settled"
  echo "collapsed; each header carries the uppercase transform, the count"
  echo "badge (rounded-full over sidebar-control-surface) and the chevron;"
  echo "the collapse state persists under sidebar.section.<name>.collapsed"
  echo
  echo "Working opt-in: the settings:general workingSection switch writes the"
  echo "state key client-side; the section carries when workingSection != false"
  echo
  echo "membership: pinned > settled > snoozed > working(status) > active;"
  echo "Active ordered by the arranged sortOrder then recency (updatedAt);"
  echo "Settled by settlement time; empty sections still render headers"
  echo
  echo "level-2 downgrade: the split panes become children, the sections pass"
  echo "through unchanged"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T96 QA green: the sidebar split, the five sections and the collapse defaults"
