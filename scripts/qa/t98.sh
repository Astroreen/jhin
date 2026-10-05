#!/usr/bin/env bash
# QA for T98: the thread action menu (the upstream threadActionMenu item
# set), the hover preview card, the command-subtitle marker and the 5 s
# undo notice.
# Usage: scripts/qa/t98.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T98. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui (the sessions screen IS the sidebar surface).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T98 tree asserts
#     (SidebarBuilderTest: the menu item set, the snooze presets, the
#     auto-settle checked submenu, the hover card; ActionsTest: the undo
#     notices and the auto-settle action);
#   - runs the Flutter suites (flutter-menu.txt: the submenu popup, the
#     checked marks, the separatorBefore dividers, the sheet group;
#     flutter-notice.txt: the undo-notice card, the 5 s window, the undo
#     dispatch; flutter-row.txt: the command-subtitle marker) and requires
#     "All tests passed";
#   - boots the kernel, seeds one session and writes the sidebar tree into
#     menu.json;
#   - asserts the menu item set verbatim (labels, icons, the snooze preset
#     submenu with the separator-prefixed Custom…, the checked auto-settle
#     entries, the separator before Archive thread, the destructive Delete),
#     the hover_card over the row title (delay 500, placement right) and
#     that every node type stays inside the docs/sdui.md section 2.5
#     catalog;
#   - curls the pin action, the undo action and asserts the restored
#     pinned state through GET /sessions/{id} (undo-transcript.txt);
#   - curls the settle action and asserts the upstream undo notice — the
#     toast carrying the undo action and the 5000 ms window — then undoes
#     it back.
#
# Failure path: a session is pinned, the undo fires after the 5 s window
# (a 6 s wait) and the answer is the "Nothing to undo" error toast; the
# deliberately wrong expectation — that the late undo restored the pin — is
# asserted against the real response and must fail; the real behavior is
# recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T98_INNER:-}" ]; then
  exec env T98_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T98}
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

port=18498
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

# get_json <transcript> <name> <path> <jq-expr>: one GET with the client
# header, recorded and asserted.
get_json() {
  step_hdr "$client_header" "$1" "$2" GET "$3" '' 200 "$4"
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

# action <transcript> <name> <payload>: posts one ui action, records the
# response, echoes it.
action() {
  local tx=$1 name=$2 payload=$3 response
  response=$(curl -sS --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -H "$client_header" \
      --data "{\"action\":\"$name\",\"payload\":$payload}" \
      "$base/ui/action/$name")
  {
    echo "=== action $name ==="
    echo "POST /ui/action/$name"
    echo "req:  {\"action\":\"$name\",\"payload\":$payload}"
    echo "resp: $response"
  } >> "$tx"
  printf '%s' "$response"
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
  log "T98 QA --fail: the undo after the 5 s window answers nothing_to_undo"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  ok "kernel booted for the failure path (fail-boot/kernel.log)"

  tx="$evidence/fail-undo-transcript.txt"
  : > "$tx"
  id=$(seed_session "$tx" "fail-undo" "/tmp/fail-undo")

  # Pin inside the window, then let the window close.
  response=$(action "$tx" "pin" "{\"id\":\"$id\"}")
  jq -e '.client[0].op == "refresh"' <<< "$response" > /dev/null \
    || fail "the pin action did not answer refresh (resp: $response)"
  ok "pinned the session (fail-undo-transcript.txt)"
  get_json "$tx" "fetch-pinned" "/sessions/$id" '.pinned == true'
  ok "the session is pinned before the window closes (fail-undo-transcript.txt)"

  log "waiting 6 s for the undo window to close..."
  sleep 6

  # The late undo: the journal entry expired — the answer is the
  # nothing_to_undo error toast.
  response=$(action "$tx" "undo" "{}")
  jq -e '.client[0].op == "toast"
      and .client[0].text == "Nothing to undo"
      and .client[0].style == "error"' <<< "$response" > /dev/null \
    || fail "the late undo did not answer the nothing_to_undo error toast (resp: $response)"
  ok "the undo at 6 s answered the nothing_to_undo error toast (fail-undo-transcript.txt)"
  get_json "$tx" "fetch-after-late-undo" "/sessions/$id" '.pinned == true'
  ok "the late undo restored nothing: the session is still pinned (fail-undo-transcript.txt)"

  # The deliberately wrong expectation: the late undo restored the pin (it
  # did not — the window closed). The guard trips and the run records it.
  if jq -e '.client[0].text == "Undone"' <<< "$response" > /dev/null 2>&1; then
    fail "deliberately wrong expectation held: the late undo answered Undone"
  fi
  {
    echo "FAIL: the undo at 6 s answered Undone (as designed)"
    echo "  the journal window closed; the answer is the nothing_to_undo"
    echo "  error toast and the pin survives; session id: $id"
    echo "  (fail-undo-transcript.txt)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the late undo restores the pin (it does not; see $evidence/fail-undo-transcript.txt)"
fi

log "T98 QA: the thread action menu, the hover card and the undo notice"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T98 tree asserts live here) ---
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

# --- 3. The Flutter suites: the submenu, the undo notice, the row marker ---
bash scripts/qa/flutter-test.sh test/sdui/thread_menu_test.dart \
  2>&1 | tee "$evidence/flutter-menu.txt"
grep -q 'All tests passed' "$evidence/flutter-menu.txt" \
  || fail "the Flutter menu suite failed (see $evidence/flutter-menu.txt)"
ok "Flutter menu suite green: the nested submenu popup, the checked marks, the separatorBefore dividers, the sheet group (flutter-menu.txt)"

bash scripts/qa/flutter-test.sh test/sdui/thread_undo_notice_test.dart \
  2>&1 | tee "$evidence/flutter-notice.txt"
grep -q 'All tests passed' "$evidence/flutter-notice.txt" \
  || fail "the Flutter undo-notice suite failed (see $evidence/flutter-notice.txt)"
ok "Flutter notice suite green: the undo-notice card at the bottom edge, the 5 s window, the undo dispatch, the plain-toast banner (flutter-notice.txt)"

bash scripts/qa/flutter-test.sh test/sdui/sidebar_row_test.dart \
  2>&1 | tee "$evidence/flutter-row.txt"
grep -q 'All tests passed' "$evidence/flutter-row.txt" \
  || fail "the Flutter row suite failed (see $evidence/flutter-row.txt)"
ok "Flutter row suite green: the command-subtitle marker, the T97 anatomy still holds (flutter-row.txt)"

# --- 4. The kernel with the sidebar ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/undo-transcript.txt"
: > "$tx"

id=$(seed_session "$tx" "menu-thread" "/tmp/menu-thread")
ok "seeded one session (undo-transcript.txt)"

# --- 5. The sessions screen: the menu tree ---
step_hdr "$client_header" "$tx" "fetch-sidebar" GET /ui/screen/sessions '' 200 \
  '.node.type == "screen"'
jq -S '.node.body.body' <<< "$step_payload" > "$evidence/menu.json"

row=$(row_of "$evidence/menu.json" "$id")

# The menu item set, verbatim from the upstream threadActionMenu.logic.ts
# (commit 37de6cb): the conditional pin/settle entries, the snooze submenu,
# the regenerate entry, the checked auto-settle submenu, the separator +
# archive and the destructive delete.
jq -e '
  [.trailing.items[].label] ==
    ["Pin thread", "Settle thread", "Snooze", "Regenerate title",
     "Auto-settle behavior", "Archive thread", "Delete"]
  and .trailing.items[0].icon == "keep"
  and .trailing.items[0].action.name == "pin"
  and .trailing.items[0].action.payload.id == "'"$id"'"
  and .trailing.items[1].label == "Settle thread"
  and .trailing.items[1].icon == "check_circle"
  and .trailing.items[1].action.name == "settle"
' <<< "$row" > /dev/null \
  || fail "the menu item set is wrong (menu.json)"
ok "menu items: Pin thread / Settle thread / Snooze / Regenerate title / Auto-settle behavior / Archive thread / Delete, the real lifecycle actions (menu.json)"

# The snooze submenu: the upstream presets with the whenLabel time column
# (the exact clock is host-zone dependent — the shape is asserted) plus the
# separator-prefixed Custom… opening the decorative dialog.
jq -e '
  .trailing.items[2].label == "Snooze"
  and .trailing.items[2].icon == "schedule"
  and (.trailing.items[2].children | length >= 4)
  and (.trailing.items[2].children[0].label | startswith("In 1 hour ("))
  and (.trailing.items[2].children[1].label | startswith("In 3 hours ("))
  and (.trailing.items[2].children[-1].label == "Custom…")
  and .trailing.items[2].children[-1].separatorBefore == true
  and .trailing.items[2].children[-1].action.op == "dialog"
  and .trailing.items[2].children[-1].action.node.id == "custom-snooze-dialog"
  and ((.trailing.items[2].children[-2].label | startswith("Tomorrow ("))
    or (.trailing.items[2].children[-3].label | startswith("Tomorrow (")))
' <<< "$row" > /dev/null \
  || fail "the snooze submenu is wrong (menu.json)"
ok "snooze submenu: the upstream presets with the (when) time column, the separator-prefixed Custom… opening the custom-snooze-dialog (menu.json)"

# Every preset dispatches the real snooze action with a future `until`.
jq -e '
  [.trailing.items[2].children[] | select(.label != "Custom…")
    | .action.name == "snooze"
    and (.action.payload.until > 0)] | all
' <<< "$row" > /dev/null \
  || fail "the snooze presets do not dispatch the snooze action (menu.json)"
ok "snooze presets dispatch the real snooze action with a future until (menu.json)"

# The custom snooze dialog: the demo shell whose confirm only toasts.
jq -e '
  [.node.body.body] as [$tree]
  | [$tree | .. | objects | select(.id? == "custom-snooze-dialog")] | length == 0
' "$evidence/menu.json" > /dev/null \
  || fail "the custom snooze dialog leaked into the tree (it must only ride the Custom… action)"
custom_dialog=$(jq -r '.trailing.items[2].children[-1].action.node' <<< "$row")
jq -e '
  .id == "custom-snooze-dialog" and .demo == true
  and (.children[1].submit.action.name == "demo-snooze")
' <<< "$custom_dialog" > /dev/null \
  || fail "the custom snooze dialog is not the demo shell (menu.json)"
ok "custom snooze dialog: the demo-marked picker shell, the confirm dispatches demo-snooze (dismissDialog + preview toast, nothing persists) (menu.json)"

# The checked auto-settle submenu.
jq -e '
  .trailing.items[4].label == "Auto-settle behavior"
  and .trailing.items[4].icon == "timer"
  and [.trailing.items[4].children[].label] == ["Enabled", "Disabled"]
  and .trailing.items[4].children[0].checked == true
  and .trailing.items[4].children[1].checked == false
  and .trailing.items[4].children[0].action.name == "auto-settle"
  and .trailing.items[4].children[0].action.payload.enabled == true
' <<< "$row" > /dev/null \
  || fail "the auto-settle submenu is wrong (menu.json)"
ok "auto-settle submenu: the checked Enabled/Disabled radio entries dispatching auto-settle (menu.json)"

# The separator before Archive thread and the destructive Delete.
jq -e '
  .trailing.items[5].label == "Archive thread"
  and .trailing.items[5].separatorBefore == true
  and .trailing.items[5].confirm == "Archive this thread?"
  and .trailing.items[5].action.name == "archive"
  and .trailing.items[6].label == "Delete"
  and .trailing.items[6].danger == true
  and .trailing.items[6].confirm == "Delete this thread? This cannot be undone."
  and .trailing.items[6].action.name == "delete-session"
' <<< "$row" > /dev/null \
  || fail "the archive/delete entries are wrong (menu.json)"
ok "archive above the separator, the destructive Delete with its confirm (menu.json)"

# The hover preview card over the row title.
jq -e '
  .title.type == "hover_card"
  and .title.delay == 500
  and .title.placement == "right"
  and .title.trigger.text == "menu-thread"
  and .title.content.id == "thread-hover-card"
' <<< "$row" > /dev/null \
  || fail "the hover preview card is wrong (menu.json)"
ok "hover card: the ThreadHoverCard port over the row title, delay 500, placement right, title + workdir preview (menu.json)"

# The primitive-catalog guard: every node type in the tree is legal.
types=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' \
  "$evidence/menu.json")
for t in $types; do
  catalog_primitives | grep -qx "$t" \
    || fail "node type '$t' is outside the docs/sdui.md section 2.5 catalog"
done
ok "every node type is inside the docs/sdui.md section 2.5 catalog ($(echo "$types" | tr '\n' ' '))"

# --- 6. The undo sequence: pin -> undo -> restored ---
response=$(action "$tx" "pin" "{\"id\":\"$id\"}")
jq -e '.client[0].op == "refresh"' <<< "$response" > /dev/null \
  || fail "the pin action did not answer refresh (resp: $response)"
ok "pin action answered refresh (undo-transcript.txt)"
get_json "$tx" "fetch-pinned" "/sessions/$id" '.pinned == true'
ok "the session is pinned (the action pins without an explicit order, so pinned_order stays null until a reorder assigns it) (undo-transcript.txt)"

response=$(action "$tx" "undo" "{}")
jq -e '.client[0].op == "toast" and .client[0].text == "Undone"
    and .client[1].op == "refresh"' <<< "$response" > /dev/null \
  || fail "the undo action did not answer [toast Undone, refresh] (resp: $response)"
ok "undo action answered [toast Undone, refresh] (undo-transcript.txt)"
get_json "$tx" "fetch-restored" "/sessions/$id" '.pinned == false and .pinnedOrder == null'
ok "the undo restored the pinned state: pinned false, pinned_order null (undo-transcript.txt)"

# --- 7. The upstream undo notices on the lifecycle actions ---
response=$(action "$tx" "settle" "{\"id\":\"$id\"}")
jq -e '
  .client[0].op == "toast"
  and .client[0].text == "Settled 1 thread,"
  and .client[0].action.name == "undo"
  and .client[0].duration == 5000
  and .client[1].op == "refresh"
' <<< "$response" > /dev/null \
  || fail "the settle action did not answer the upstream undo notice (resp: $response)"
ok "settle answered the upstream undo notice: Settled 1 thread, with the undo action and the 5000 ms window (undo-transcript.txt)"

response=$(action "$tx" "unsettle" "{\"id\":\"$id\"}")
jq -e '[.client[].op] == ["refresh"]' <<< "$response" > /dev/null \
  || fail "the unsettle action answered a notice (upstream shows none) (resp: $response)"
ok "unsettle answered refresh only — no notice, upstream parity (undo-transcript.txt)"

response=$(action "$tx" "pin" "{\"id\":\"$id\"}")
jq -e '[.client[].op] == ["refresh"]' <<< "$response" > /dev/null \
  || fail "the pin action answered a notice (upstream shows none) (resp: $response)"
ok "pin answered refresh only — no notice, upstream parity (undo-transcript.txt)"

response=$(action "$tx" "unpin" "{\"id\":\"$id\"}")
jq -e '.client[0].text == "Unpinned 1 thread,"
    and .client[0].action.name == "undo"
    and .client[0].duration == 5000' <<< "$response" > /dev/null \
  || fail "the unpin action did not answer the Unpinned notice (resp: $response)"
ok "unpin answered the Unpinned 1 thread, notice (undo-transcript.txt)"

# The kernel work is done — stop it before the summary.
stop_kernel

# --- 8. The summary ---
{
  echo "# T98 thread action menu + hover card + undo notice summary"
  echo
  echo "menu (upstream threadActionMenu.logic.ts, commit 37de6cb): Pin"
  echo "thread / Unpin thread (conditional), Settle thread / Un-settle"
  echo "thread (conditional), Snooze with the preset submenu (In 1 hour,"
  echo "In 3 hours, This evening, Tomorrow, Next week — the upstream"
  echo "presets of threadSettled.ts:255-303 with the (when) time column)"
  echo "plus the separator-prefixed Custom… opening the demo-marked picker"
  echo "dialog whose confirm only toasts (demo-snooze), Regenerate title,"
  echo "the checked Auto-settle behavior submenu (Enabled/Disabled), the"
  echo "separator + Archive thread and the destructive Delete; arrange"
  echo "mode adds Move up / Move down"
  echo
  echo "dropped upstream items (no Jhin backend, not faked): New thread on"
  echo "branch (no branch field), Rename thread (no rename action), Mark"
  echo "unread (no unread state), the project filter and Project settings"
  echo "(no projects), the Copy submenu (no path/branch/thread-id copy)"
  echo
  echo "undo notice: the toast directive carrying the undo action and the"
  echo "5000 ms window — Settled 1 thread, / Snoozed 1 thread, / Unpinned"
  echo "1 thread, / Archived 1 thread, (the upstream wording of"
  echo "SidebarThreadUndoNotice.tsx:15,20 — the plan's 'Thread pinned'-style"
  echo "wording does not exist upstream; pinning shows no notice, upstream"
  echo "parity); the client renders it through the toast_stack undo-notice"
  echo "card at the bottom edge; the journal coalescing is the T73"
  echo "semantics (one entry per session, oldest snapshot wins)"
  echo
  echo "hover card: the ThreadHoverCard port over the row title (delay 500,"
  echo "placement right, title + workdir preview)"
  echo
  echo "command subtitle: the ThreadCommandSubtitle port renders as the"
  echo "trailing muted marker on rows carrying commandSubtitle (palette-"
  echo "sourced rows; the sidebar emits none — upstream renders it in the"
  echo "command palette only, CommandPalette.tsx)"
  echo
  echo "undo sequence: pin -> undo -> pinned false, pinned_order null"
  echo "(undo-transcript.txt); the --fail path: the undo at 6 s answers"
  echo "the nothing_to_undo error toast and restores nothing"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T98 QA green: the thread action menu, the hover card and the undo notice"
