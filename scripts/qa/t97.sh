#!/usr/bin/env bash
# QA for T97: the sidebar header + footer blocks, the thread row anatomy and
# the full status-indicator set.
# Usage: scripts/qa/t97.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T97. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit and
# jhin.ui (the sessions screen IS the sidebar surface).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T97 tree asserts
#     (SidebarBuilderTest: the header/footer blocks, the row anatomy, the
#     status-kind mapping, the unknown-status idle fallback);
#   - runs the Flutter row-anatomy suite (flutter-row.txt: the ten-kind
#     cluster with the literal tooltips, the hover reveal, the selected ring,
#     the dragging card, the search-match pill, the section filter with the
#     match-count line) and the T92 indicator suite (flutter-status.txt) and
#     requires "All tests passed"; the row-anatomy golden is regenerated into
#     goldens/;
#   - boots the kernel, seeds one session per status kind (working,
#     monitoring, needs-approval, needs-answer, failed, limited, snoozed,
#     settled, pinned and the plain active one) and writes the sidebar split
#     tree into row-anatomy.json;
#   - asserts the header block (wordmark, "Search threads" input, "New
#     thread" primary button with the create-session dialog, demo-marked
#     chevron), the footer block (the Online status dot, the account chip,
#     the Settings navigate and the openProfiles buttons), the list search
#     spec, the per-row statusIndicators kinds, the row anatomy (the
#     semibold truncated title, the Project context chip tooltip, the
#     hover-revealed trailing cluster with the search-match spec) and that
#     every node type stays inside the docs/sdui.md section 2.5 catalog;
#   - fetches the same screen at api=2;schema=3 and asserts the split
#     downgrade keeps the sections (row-anatomy-l2.json);
#   - writes the upstream-lucide -> Material icon mapping table into
#     icon-map.json (the plan section 15.5 record).
#
# Failure path: a session with the unknown status "bogus-status" is seeded;
# the deliberately wrong expectation — that the unknown kind passes through
# as "bogus-status" in statusIndicators — is asserted against the real tree
# and must fail (the mapping falls back to idle and logs); the fallback
# (idle in the tree + the log line in kernel.log) is recorded in
# checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T97_INNER:-}" ]; then
  exec env T97_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T97}
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

port=18497
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

# patch_status <transcript> <id> <status>: sets one session's status.
patch_status() {
  local tx=$1 id=$2 status=$3 response
  response=$(curl -sS --max-time 10 -X PATCH \
      -H 'Content-Type: application/json' \
      -H "$client_header" \
      --data "{\"status\":\"$status\"}" \
      "$base/sessions/$id")
  {
    echo "=== status $id -> $status ==="
    echo "PATCH /sessions/$id"
    echo "resp: $response"
  } >> "$tx"
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

# settle_session <transcript> <id>: settles one session.
settle_session() {
  local tx=$1 id=$2 response
  response=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -H "$client_header" \
      --data '{}' \
      "$base/sessions/$id/settle")
  {
    echo "=== settle $id ==="
    echo "POST /sessions/$id/settle"
    echo "resp: $response"
  } >> "$tx"
}

# pin_session <transcript> <id>: pins one session.
pin_session() {
  local tx=$1 id=$2 response
  response=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -H "$client_header" \
      --data '{}' \
      "$base/sessions/$id/pin")
  {
    echo "=== pin $id ==="
    echo "POST /sessions/$id/pin"
    echo "resp: $response"
  } >> "$tx"
}

# row_of <file> <session-id>: the row node of one session, over the split
# tree (the split's first pane carries the section list).
row_of() {
  local file=$1 id=$2
  jq -r --arg rid "session-row:$id" \
    '[.. | objects | select(.id? == $rid)][0]' "$file"
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
  log "T97 QA --fail: an unknown status kind renders the fallback idle indicator and logs"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  ok "kernel booted for the failure path (fail-boot/kernel.log)"

  tx="$evidence/fail-seed.txt"
  : > "$tx"
  bogus_id=$(seed_session "$tx" "fail-bogus" "/tmp/fail-bogus")
  patch_status "$tx" "$bogus_id" "bogus-status"
  ok "seeded one session and set the unknown status bogus-status (fail-seed.txt)"

  step_hdr "$client_header" "$tx" "fetch-sidebar" GET /ui/screen/sessions '' 200 \
    '.node.type == "screen"'
  jq -S '.node.body.body' <<< "$step_payload" > "$evidence/row-anatomy-fail.json"

  # The fallback: the unknown status renders the idle indicator.
  row=$(row_of "$evidence/row-anatomy-fail.json" "$bogus_id")
  kinds=$(jq -r '.statusIndicators | join(",")' <<< "$row")
  if [ "$kinds" = "idle" ]; then
    ok "fallback: the unknown status renders the idle indicator (row-anatomy-fail.json)"
  else
    fail "the unknown status did not fall back to idle (got: $kinds)"
  fi
  if grep -q 'unknown session status' "$kernel_log_dir/kernel.log"; then
    ok "fallback: the mapping logged the unknown status (fail-boot/kernel.log)"
  else
    fail "the fallback did not log (fail-boot/kernel.log)"
  fi

  # The deliberately wrong expectation: the unknown kind passes through as
  # "bogus-status". The mapping keeps it out, so the assertion must fail —
  # the guard trips and the run records the trip.
  if [ "$kinds" = "bogus-status" ]; then
    fail "deliberately wrong expectation held: the unknown status passed through as bogus-status"
  fi
  {
    echo "FAIL: the unknown status kind passed through as bogus-status (as designed)"
    echo "  the mapping falls back to idle and logs; the tree carries statusIndicators [idle]"
    echo "  session id: $bogus_id (row-anatomy-fail.json)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the unknown status kind passes through (it does not; see $evidence/row-anatomy-fail.json)"
fi

log "T97 QA: the sidebar header + footer, the row anatomy and the status indicators"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T97 tree asserts live here) ---
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

# --- 3. The Flutter suites: the row anatomy + the T92 indicators ---
# The row-anatomy golden is regenerated into goldens/ (flutter test
# --update-goldens with T97_GOLDEN_DIR) and then verified byte-identical
# by a second pass without the flag (the t93 canon).
bash scripts/qa/flutter-test.sh test/sdui/sidebar_row_test.dart \
  --update-goldens \
  --dart-define=T97_GOLDEN_DIR="$(pwd)/$evidence/goldens" \
  2>&1 | tee "$evidence/flutter-row-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-row-goldens.txt" \
  || fail "the Flutter row-anatomy golden run failed (see $evidence/flutter-row-goldens.txt)"
[ -s "$evidence/goldens/sidebar-row-anatomy-light.png" ] \
  || fail "the row-anatomy golden is missing or empty (goldens/)"

bash scripts/qa/flutter-test.sh test/sdui/sidebar_row_test.dart \
  --dart-define=T97_GOLDEN_DIR="$(pwd)/$evidence/goldens" \
  2>&1 | tee "$evidence/flutter-row.txt"
grep -q 'All tests passed' "$evidence/flutter-row.txt" \
  || fail "the Flutter row-anatomy suite failed (see $evidence/flutter-row.txt)"
ok "Flutter row suite green: the ten-kind cluster, the hover reveal, the row states, the search-match pill and the section filter; the row-anatomy golden regenerated and verified byte-identical (flutter-row.txt, flutter-row-goldens.txt)"

bash scripts/qa/flutter-test.sh test/sdui/status_indicators_test.dart \
  2>&1 | tee "$evidence/flutter-status.txt"
grep -q 'All tests passed' "$evidence/flutter-status.txt" \
  || fail "the Flutter indicator suite failed (see $evidence/flutter-status.txt)"
ok "Flutter indicator suite green: the T92 duty-cycle modes still hold (flutter-status.txt)"

# --- 4. The kernel with the sidebar ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/seed.txt"
: > "$tx"

active_id=$(seed_session "$tx" "active-thread" "/tmp/active-thread")
working_id=$(seed_session "$tx" "working-thread" "/tmp/working-thread")
patch_status "$tx" "$working_id" "working"
monitoring_id=$(seed_session "$tx" "monitoring-thread" "/tmp/monitoring-thread")
patch_status "$tx" "$monitoring_id" "monitoring"
approval_id=$(seed_session "$tx" "approval-thread" "/tmp/approval-thread")
patch_status "$tx" "$approval_id" "needs-approval"
answer_id=$(seed_session "$tx" "answer-thread" "/tmp/answer-thread")
patch_status "$tx" "$answer_id" "needs-answer"
failed_id=$(seed_session "$tx" "failed-thread" "/tmp/failed-thread")
patch_status "$tx" "$failed_id" "failed"
limited_id=$(seed_session "$tx" "limited-thread" "/tmp/limited-thread")
patch_status "$tx" "$limited_id" "limited"
snoozed_id=$(seed_session "$tx" "snoozed-thread" "/tmp/snoozed-thread")
snooze_session "$tx" "$snoozed_id" 3600000
settled_id=$(seed_session "$tx" "settled-thread" "/tmp/settled-thread")
settle_session "$tx" "$settled_id"
pinned_id=$(seed_session "$tx" "pinned-thread" "/tmp/pinned-thread")
pin_session "$tx" "$pinned_id"
ok "seeded ten sessions, one per status kind (seed.txt)"

# --- 5. The sessions screen: the sidebar tree ---
step_hdr "$client_header" "$tx" "fetch-sidebar" GET /ui/screen/sessions '' 200 \
  '.node.type == "screen"'
jq -S '.node.body.body' <<< "$step_payload" > "$evidence/row-anatomy.json"

# The split metrics (the T96 regression anchor).
jq -e '.type == "split" and .id == "sidebar-split"
    and .persistKey == "chat_thread_sidebar_width"
    and .initial == 256 and .min == 208 and .minSecond == 640' \
  "$evidence/row-anatomy.json" > /dev/null \
  || fail "the sidebar split does not carry the persisted metrics (row-anatomy.json)"
ok "split metrics: persistKey chat_thread_sidebar_width, initial 256, min 208, minSecond 640 (row-anatomy.json)"

# The header block: wordmark, search input, New thread button, chevron.
jq -e '
  .first.header.id == "sidebar-header"
  and (.first.header.children[0].children[0].text == "Jhin")
  and (.first.header.children[0].children[0].bold == true)
  and (.first.header.children[0].children[2].type == "icon_button")
  and (.first.header.children[0].children[2].icon == "chevron_right")
  and (.first.header.children[0].children[2].demo == true)
  and (.first.header.children[1].children[0].type == "input")
  and (.first.header.children[1].children[0].id == "sidebarSearch")
  and (.first.header.children[1].children[0].placeholder == "Search threads")
  and (.first.header.children[1].children[1].type == "button")
  and (.first.header.children[1].children[1].label == "New thread")
  and (.first.header.children[1].children[1].style == "primary")
  and (.first.header.children[1].children[1].action.op == "dialog")
  and (.first.header.children[1].children[1].action.node.id == "new-thread-dialog")
' "$evidence/row-anatomy.json" > /dev/null \
  || fail "the header block is wrong (row-anatomy.json)"
ok "header: bold Jhin wordmark, Search threads input, New thread primary button opening the create-session dialog, demo-marked chevron (row-anatomy.json)"

# The dialog form submits the real create-session action.
jq -e '
  .first.header.children[1].children[1].action.node.children[1].submit.action.name
    == "create-session"
  and (.first.header.children[1].children[1].action.node.children[1].submit.action.include
    == ["newThreadTitle", "newThreadWorkdir"])
' "$evidence/row-anatomy.json" > /dev/null \
  || fail "the new-thread dialog does not submit create-session (row-anatomy.json)"
ok "new-thread dialog: the form submits the real create-session action with the two inputs included (row-anatomy.json)"

# The footer block: connection dot, account chip, Settings, profiles.
jq -e '
  .first.footer.id == "sidebar-footer"
  and (.first.footer.children[0].id == "sidebar-status-dot")
  and (.first.footer.children[0].tooltip == "Online")
  and (.first.footer.children[0].children[0].color == "$color.success")
  and (.first.footer.children[0].children[1].text == "Online")
  and (.first.footer.children[1].type == "avatar")
  and (.first.footer.children[1].initials == "LO")
  and (.first.footer.children[2].text == "local")
  and (.first.footer.children[3].icon == "settings")
  and (.first.footer.children[3].tooltip == "Settings")
  and (.first.footer.children[3].action.op == "navigate")
  and (.first.footer.children[3].action.screen == "settings")
  and (.first.footer.children[4].action.op == "openProfiles")
' "$evidence/row-anatomy.json" > /dev/null \
  || fail "the footer block is wrong (row-anatomy.json)"
ok "footer: Online status dot, local account chip (initials LO), Settings navigate, openProfiles profile switch (row-anatomy.json)"

# The list search spec.
jq -e '.first.search == {key: "sidebarSearch", fields: ["title", "subtitle"]}' \
  "$evidence/row-anatomy.json" > /dev/null \
  || fail "the list search spec is wrong (row-anatomy.json)"
ok "search spec: key sidebarSearch over the title/subtitle fields (row-anatomy.json)"

# The row anatomy of the plain active row. Since T98 the title slot is the
# hover preview card; the semibold truncated title is its trigger.
row=$(row_of "$evidence/row-anatomy.json" "$active_id")
jq -e '
  .title.type == "hover_card" and .title.delay == 500 and .title.placement == "right"
  and .title.trigger.fontSize == 14 and .title.trigger.fontWeight == 600
  and .title.trigger.maxLines == 1 and .title.trigger.ellipsis == true
  and .subtitle.children[0].color == "$color.sidebar-muted-foreground"
  and .subtitle.children[1].id == "thread-context-chip"
  and .subtitle.children[1].tooltip == "Project: /tmp/active-thread"
  and .subtitle.children[1].child.fontSize == 12
  and .hoverReveal == true
  and .searchMatch.key == "sidebarSearch"
  and .searchMatch.minChars == 2
  and .trailing.type == "menu"
' <<< "$row" > /dev/null \
  || fail "the row anatomy is wrong (row-anatomy.json)"
ok "row anatomy: hover-card-wrapped semibold truncated title, muted workdir + Project chip (px-1.5 py-0.5 text-xs tooltip), hover-revealed trailing with the search-match spec and the overflow menu (row-anatomy.json)"

# The status kinds, one row per kind.
assert_kinds() {
  local id=$1 expected=$2 name=$3
  local row kinds
  row=$(row_of "$evidence/row-anatomy.json" "$id")
  kinds=$(jq -r '.statusIndicators | join(",")' <<< "$row")
  [ "$kinds" = "$expected" ] \
    || fail "$name: statusIndicators '$kinds' != '$expected' (row-anatomy.json)"
}
assert_kinds "$active_id" "idle" "active"
assert_kinds "$working_id" "working" "working"
assert_kinds "$monitoring_id" "monitoring" "monitoring"
assert_kinds "$approval_id" "needs-approval" "needs-approval"
assert_kinds "$answer_id" "needs-answer" "needs-answer"
assert_kinds "$failed_id" "failed" "failed"
assert_kinds "$limited_id" "limited" "limited"
assert_kinds "$snoozed_id" "snoozed" "snoozed"
assert_kinds "$settled_id" "settled" "settled"
assert_kinds "$pinned_id" "idle,pinned" "pinned"
ok "status kinds: working/monitoring/needs-approval/needs-answer/failed/limited/snoozed/settled/idle + pinned appended, one row per kind (row-anatomy.json)"

# The primitive-catalog guard: every node type in the tree is legal.
types=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' \
  "$evidence/row-anatomy.json")
for t in $types; do
  catalog_primitives | grep -qx "$t" \
    || fail "node type '$t' is outside the docs/sdui.md section 2.5 catalog"
done
ok "every node type is inside the docs/sdui.md section 2.5 catalog ($(echo "$types" | tr '\n' ' '))"

# --- 6. The same screen at level 2: the split downgrade keeps the sections ---
step_hdr 'api=2; version=0.3.0; schema=3; caps=sse' "$tx" "fetch-sidebar-l2" \
  GET /ui/screen/sessions '' 200 '.node.type == "screen"'
jq -S '.node.body.body' <<< "$step_payload" > "$evidence/row-anatomy-l2.json"
jq -e '.type == "column" and ([.children[].type] | index("list") != null)' \
  "$evidence/row-anatomy-l2.json" > /dev/null \
  || fail "the level-2 split downgrade does not keep the panes as children (row-anatomy-l2.json)"
jq -e '[.children[] | select(.type == "list")][0].sections | length == 5' \
  "$evidence/row-anatomy-l2.json" > /dev/null \
  || fail "the level-2 tree does not carry the five sections (row-anatomy-l2.json)"
ok "level-2 tree: the split downgrade (split -> column, the panes as children) keeps the five sections (row-anatomy-l2.json)"

# The kernel work is done — stop it before the summary.
stop_kernel

# --- 7. The icon mapping table (the plan section 15.5 record) ---
cat > "$evidence/icon-map.json" << 'EOF'
{
  "note": "The T97 status-indicator icon mapping: the plan's ten-kind set onto the client icon registry (frontend/lib/design/icon_registry.dart, 8825 Material entries). Upstream lucide names verified against the t3code checkout (commit 37de6cb); gaps fall back to the nearest Material glyph (plan section 15.5).",
  "upstreamCommit": "37de6cb",
  "mappings": [
    {"kind": "working", "upstream": "Loader (spinner)", "upstreamAnchor": "components/Sidebar.logic.ts:1178-1185 (pulse: true)", "registry": null, "rendering": "progress statusPulse:pulse dot (the T92 duty-cycle spinner), no glyph"},
    {"kind": "idle", "upstream": "Circle (the unlabeled resting state)", "upstreamAnchor": "components/Sidebar.logic.ts:940-943 (no pill for the resting state)", "registry": "circle", "rendering": "12 px muted circle, no tooltip"},
    {"kind": "monitoring", "upstream": "Eye", "upstreamAnchor": "plan T97 step 3 (no upstream status anchor)", "registry": "visibility", "rendering": "12 px info eye, tooltip Monitoring"},
    {"kind": "needs-approval", "upstream": "AlertCircle", "upstreamAnchor": "plan T97 step 3 (upstream label: Pending Approval, Sidebar.logic.ts:1164-1171)", "registry": "error_outline", "rendering": "12 px warning glyph, tooltip Needs approval"},
    {"kind": "needs-answer", "upstream": "AlertCircle", "upstreamAnchor": "plan T97 step 3 (upstream label: Awaiting Input, Sidebar.logic.ts:1172-1177)", "registry": "error_outline", "rendering": "12 px info glyph, tooltip Needs answer"},
    {"kind": "failed", "upstream": "AlertTriangle", "upstreamAnchor": "components/Sidebar.tsx:1304-1307 (icon failed, text-error)", "registry": "warning_amber", "rendering": "12 px error glyph, tooltip Failed"},
    {"kind": "limited", "upstream": "Zap", "upstreamAnchor": "components/Sidebar.tsx:1300-1303 (label Limited, text-warning)", "registry": "bolt", "rendering": "12 px warning glyph, tooltip Limited"},
    {"kind": "snoozed", "upstream": "Pause", "upstreamAnchor": "plan T97 step 3 (no upstream status anchor)", "registry": "pause_circle", "rendering": "12 px muted glyph, tooltip Snoozed"},
    {"kind": "settled", "upstream": "CheckCircle", "upstreamAnchor": "plan T97 step 3 (upstream Done: Sidebar.tsx:1308-1311)", "registry": "check_circle", "rendering": "12 px muted glyph, tooltip Settled"},
    {"kind": "unread", "upstream": "filled dot + ping", "upstreamAnchor": "components/Sidebar.tsx:1305-1311 (Done, text-success)", "registry": null, "rendering": "6 px success dot, progress statusPulse:ping, tooltip Unread"},
    {"kind": "pinned", "upstream": "Lock", "upstreamAnchor": "components/Sidebar.tsx:1089-1096 (the pin glyph stays visible while pinned)", "registry": "lock", "rendering": "12 px muted glyph, tooltip Pinned"},
    {"kind": "row-menu", "upstream": "MoreVertical / EllipsisVertical", "upstreamAnchor": "components/Sidebar.tsx (row overflow trigger)", "registry": "more_vert", "rendering": "the overflow menu trigger"},
    {"kind": "row-search", "upstream": "Search", "upstreamAnchor": "components/sidebar/SidebarThreadHeader.tsx:66", "registry": "search", "rendering": "the header search affordance"},
    {"kind": "row-new-thread", "upstream": "SquarePen", "upstreamAnchor": "components/sidebar/SidebarThreadHeader.tsx:63,117-127", "registry": "add", "rendering": "the New thread button icon (the plan's primary button)"},
    {"kind": "row-settings", "upstream": "Settings", "upstreamAnchor": "components/sidebar/SidebarChrome.tsx:196-201", "registry": "settings", "rendering": "the footer Settings icon button"},
    {"kind": "row-profile", "upstream": "(no upstream anchor: the client-owned profile surface)", "upstreamAnchor": "plan T97 step 1b", "registry": "person", "rendering": "the footer profile-switch icon button"},
    {"kind": "row-chevron", "upstream": "SidebarTrigger (panel collapse)", "upstreamAnchor": "components/sidebar/SidebarChrome.tsx:47-52", "registry": "chevron_right", "rendering": "the collapsed-state chevron (demo-marked)"}
  ]
}
EOF
ok "icon mapping table recorded (icon-map.json)"

# --- 8. The summary ---
{
  echo "# T97 sidebar header + row anatomy + status indicators summary"
  echo
  echo "header: bold Jhin wordmark, Search threads input (state key"
  echo "sidebarSearch), New thread primary button opening the new-thread"
  echo "dialog (the form submits the real create-session action),"
  echo "demo-marked collapsed-state chevron"
  echo
  echo "footer: Online status dot (the ConnectionStatusDot port), account"
  echo "chip (initials avatar + handle), Settings (navigate settings),"
  echo "profile switch (the client-owned openProfiles directive)"
  echo
  echo "search: the list search spec filters the section items client-side"
  echo "against title/subtitle (ASCII case-folded), the match-count line"
  echo "renders above the sections, the search-match pill shows from two"
  echo "characters in the hover-revealed trailing cluster"
  echo
  echo "row anatomy: status indicator cluster -> semibold truncated title ->"
  echo "muted workdir + Project context chip (px-1.5 py-0.5 text-xs,"
  echo "tooltip Project: ...) -> trailing (search-match marker + overflow"
  echo "menu, revealed on hover); row states default/hover"
  echo "(sidebar-row-hover)/selected (sidebar-row-active + ring)/dragging"
  echo
  echo "status kinds: working (pulse), idle (12 px circle), monitoring"
  echo "(eye), needs-approval/needs-answer (alert-circle), failed"
  echo "(alert-triangle), limited (zap), snoozed (pause), settled"
  echo "(check-circle), unread (6 px dot, ping), pinned (lock); unknown"
  echo "statuses fall back to idle and log; the icon mapping is"
  echo "icon-map.json"
  echo
  echo "level-2 downgrade: the split panes become children, the sections"
  echo "pass through unchanged"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T97 QA green: the sidebar header + footer, the row anatomy and the status indicators"
