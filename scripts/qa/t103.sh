#!/usr/bin/env bash
# QA for T103: the full composer — the header control row (the seven
# decorative pickers: model, provider, effort, access mode, workspace, git
# branch, host — each a demo button whose picker opens a dialog list that
# sets local state and toasts), the context chips row (the six upstream
# ContextChip kinds), the decorative context-window meter (the gradient bar
# with the hard 50/80 stops), the 160px minimum-height draft textarea, the
# footer row (attach, voice, the prompt-stash menu, the queue badge, the
# real send action, the stop button visible only while a run is live and the
# Direct/Queue/Steer split menu) and the keyboard layer (the T68 semantics
# kept plus the upstream chords: the seven picker chords and the
# turnRunning-gated alternate send).
# Usage: scripts/qa/t103.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T103. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit
# and jhin.ui plus the QA switches (JHIN_SESSIONS_QA for the event-append
# helper).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T103 asserts
#     (ComposerRowsTest: the pickers, the dialog composites, the chips, the
#     meter, the footer, the seeds; ContextChipAccentsTest: the Dart kind
#     accents equal the upstream oklch literals through the Oklch port);
#   - runs the Flutter composer suite (flutter-composer.txt: the chip tint,
#     the meter stops, the min-height growth, the inline composites, the
#     mod+shift+m chord through the runtime, the empty-draft no-op) and
#     requires "All tests passed";
#   - writes the composer golden (composer-rows-light.png) and proves it
#     byte-stable (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - boots the kernel, seeds a session, fetches the chat screen into
#     composer.json and asserts the composer control surface over the wire:
#     the seven demo pickers with dialog actions and chord hints, the dialog
#     options dispatching the inline composite (setState + preview toast),
#     the six chip kinds, the meter gradient with the 50/80 stops, the
#     160px textarea constraint, the footer affordances, the queue badge's
#     when-expression, the stash menu/dialog, the real send action and the
#     runLive-gated stop button;
#   - asserts every node type stays inside the docs/sdui.md section 2.5
#     catalog and the default keymap carries the T103 chords.
#
# Failure path: the real behavior holds first (an empty draft posts no send
# and shows the inline error — proven in the Flutter suite), then the
# deliberately wrong expectation — that an empty draft posts the send action
# — is run through the Flutter suite with T103_FAIL_MODE=1 and must fail;
# the real behavior is recorded in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T103_INNER:-}" ]; then
  exec env T103_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T103}
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

port=18503
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
  ( JHIN_HOME="$home" JHIN_SESSIONS_QA=true \
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
  log "T103 QA --fail: send with an empty draft is a no-op with no network call"
  log "evidence dir: $evidence"

  # The real behavior holds: the empty-draft send posts nothing and shows
  # the inline error instead (the T68 validation gate).
  if bash scripts/qa/flutter-test.sh test/sdui/composer_test.dart \
      2>&1 | tee "$evidence/flutter-real.txt" | grep -q 'All tests passed'; then
    ok "the real behavior holds: the empty draft posts no send (flutter-real.txt)"
  else
    fail "the real behavior does not hold (see $evidence/flutter-real.txt)"
  fi

  # The deliberately wrong expectation: an empty draft posts the send
  # action. The inverted suite must fail.
  if bash scripts/qa/flutter-test.sh test/sdui/composer_test.dart \
      --dart-define=T103_FAIL_MODE=true \
      2>&1 | tee "$evidence/flutter-fail.txt" | grep -q 'All tests passed'; then
    fail "deliberately wrong expectation held: the empty draft posted a send"
  fi
  {
    echo "FAIL: an empty draft posts the send action (as designed)"
    echo "  the real behavior is the opposite: the empty draft dispatches"
    echo "  nothing — no network call — and the inline error"
    echo "  (\"Write a message first\") shows instead (the T68 validation"
    echo "  gate); the inverted suite failed as required"
    echo "  (flutter-fail.txt); the real behavior is recorded in"
    echo "  flutter-real.txt"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: an empty draft posted a send (it does not; see $evidence/flutter-fail.txt)"
fi

log "T103 QA: the full composer — control rows, chips, stash and key chords"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T103 composer asserts live here) ---
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

# --- 3. The Flutter composer suite ---
bash scripts/qa/flutter-test.sh test/sdui/composer_test.dart \
  2>&1 | tee "$evidence/flutter-composer.txt"
grep -q 'All tests passed' "$evidence/flutter-composer.txt" \
  || fail "the Flutter composer suite failed (see $evidence/flutter-composer.txt)"
ok "Flutter composer suite green: the chip tint, the meter stops, the min-height growth, the inline composites, the mod+shift+m chord, the empty-draft no-op (flutter-composer.txt)"

# --- 4. The golden: the composer rows ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/composer_test.dart \
  --update-goldens \
  --dart-define="T103_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
[ -s "$goldens/composer-rows-light.png" ] \
  || fail "the golden composer-rows-light.png is missing or empty (goldens/)"
ok "golden written (goldens/composer-rows-light.png)"

# The verification pass: the same suite without --update-goldens must match
# the written frame byte-for-byte.
bash scripts/qa/flutter-test.sh test/sdui/composer_test.dart \
  --dart-define="T103_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged from the written frame (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 5. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui plus the QA switches (kernel.log)"

tx="$evidence/probe-transcript.txt"
: > "$tx"

# --- 6. The chat screen: the composer control surface over the wire ---
session_id=$(seed_session "$tx" "composer-demo" "/tmp/composer-demo")
step_hdr "$client_header" "$tx" "fetch-chat" GET "/ui/screen/chat:$session_id" '' 200 \
  '.node.type == "screen"'
jq -S '[.. | objects | select(.id? == "composer")][0]' <<< "$step_payload" \
  > "$evidence/composer.json"
ok "seeded one session and dumped the composer subtree (composer.json)"

# The header control row: the seven demo pickers, each opening its dialog.
jq -e '
  [.. | objects | select(.id? == "composer-controls")][0]
  | ([.. | objects | select(.type? == "button" and .demo? == true
        and (.action.op? == "dialog"))] | length) == 7
  and ([.. | objects | select(.type? == "row")
        | select(.id? | strings | endswith("-control")) | .id] | length) == 7
' "$evidence/composer.json" > /dev/null \
  || fail "the header control row does not carry the seven demo pickers (composer.json)"
ok "header control row: seven demo pickers, each with a dialog action (composer.json)"

# The model picker dialog: the options dispatch the inline composite
# (setState + preview toast) and the title row carries the chord hint.
jq -e '
  [.. | objects | select(.id? == "composer-model-dialog")][0]
  | ([.. | objects | select(.type? == "button" and .action.client?)] | length) == 4
  and ([.. | objects | select(.type? == "button" and .action.client?)]
        | map(.label) | unique | sort) == ["GPT-5 Codex", "Gemini 3 Pro", "Opus 4.6", "Sonnet 4.6"]
  and ([.. | objects | select(.type? == "button" and .action.client?)][0]
        | .action.client[0] == {"op":"setState","id":"chat_model","value":"Opus 4.6"}
        and (.action.client[1].text | contains("preview only")))
  and ([.. | objects | select(.type? == "kbd")][0].chord) == "mod+shift+m"
  and ([.. | objects | select(.type? == "button" and .action.op? == "dismissDialog")][0].label) == "Done"
' "$evidence/composer.json" > /dev/null \
  || fail "the model picker dialog lost the composite options or the chord hint (composer.json)"
ok "model picker dialog: the options dispatch setState + preview toast, the title carries mod+shift+m, Done closes (composer.json)"

# The other six dialogs exist with their option sets (each dialog node is
# embedded in both the picker button and its chevron, so it occurs twice).
for dialog in provider effort mode workspace branch host; do
  jq -e --arg d "composer-$dialog-dialog" '
    [.. | objects | select(.id? == $d)] | length > 0
  ' "$evidence/composer.json" > /dev/null \
    || fail "the $dialog picker dialog is missing (composer.json)"
done
jq -e '
  [.. | objects | select(.id? == "composer-effort-dialog")][0]
  | ([.. | objects | select(.type? == "button" and .action.client?)] | length) == 3
' "$evidence/composer.json" > /dev/null \
  || fail "the effort picker dialog lost its Low/Med/High options (composer.json)"
ok "the six remaining picker dialogs render with their option lists (composer.json)"

# The context chips row: the six ContextChip kinds.
jq -e '
  [.. | objects | select(.id? == "composer-chips")][0]
  | ([.. | objects | select(.type? == "chip") | .kind]) ==
    ["mention", "skill", "thread", "image", "file", "terminal"]
  and ([.. | objects | select(.type? == "chip") | .demo] | all(. == true))
' "$evidence/composer.json" > /dev/null \
  || fail "the context chips row lost the six kinds (composer.json)"
ok "context chips: mention, skill, thread, image, file, terminal — all demo-marked (composer.json)"

# The context meter: the demo gradient bar with the hard 50/80 stops.
jq -e '
  [.. | objects | select(.id? == "context-meter")][0]
  | .type == "box" and .height == 6 and .demo == true
  and (.gradient.colors | join(",")) == "$color.success,$color.success,$color.warning,$color.warning,$color.error,$color.error"
  and .gradient.stops == [0, 0.5, 0.5, 0.8, 0.8, 1]
' "$evidence/composer.json" > /dev/null \
  || fail "the context meter lost the 50/80 gradient stops (composer.json)"
ok "context meter: the demo gradient bar, green/yellow/red at the 50/80 stops (composer.json)"

# The draft textarea: the 160px minimum height constraint.
jq -e '
  [.. | objects | select(.type? == "textarea" and .id? == "messageInput")][0]
  | .constraints.minHeight == 160 and .minLines == 1 and .maxLines == 8
' "$evidence/composer.json" > /dev/null \
  || fail "the draft textarea lost the 160px minimum height (composer.json)"
ok "draft textarea: the 160px minimum-height constraint (COMPOSER_MIN_HEIGHT) (composer.json)"

# The footer row: attach + voice (demo composites), the queue badge on the
# dispatch state, the real send action and the split menu.
jq -e '
  [.. | objects | select(.id? == "composer-footer")][0]
  | ([.. | objects | select(.type? == "icon_button" and .demo? == true)
        | .icon] | sort) == ["attach_file", "mic"]
  and ([.. | objects | select(.type? == "button" and .id? == "composer-send")][0]
        | .icon == "send"
        and .action.name == "send" and .action.path == "/ui/action/send")
  and ([.. | objects | select(.id? == "queue-badge")][0]
        | .demo == true and .count == 2 and .when == "chat_dispatch == '"'"'queue'"'"'")
' "$evidence/composer.json" > /dev/null \
  || fail "the footer row lost the attach/voice affordances, the send action or the queue badge (composer.json)"
ok "footer row: demo attach + voice, the real send action, the queue badge on chat_dispatch (composer.json)"

# The send split menu and the stash menu/dialog.
jq -e '
  [.. | objects | select(.id? == "composer-send-menu")][0]
  | ([.items[] | .label]) == ["Direct", "Queue", "Steer"]
  and (.items[1].action.client[0] == {"op":"setState","id":"chat_dispatch","value":"queue"})
' "$evidence/composer.json" > /dev/null \
  || fail "the send split menu lost the Direct/Queue/Steer items (composer.json)"
jq -e '
  ([.. | objects | select(.id? == "composer-stash-menu")][0].demo) == true
  and ([.. | objects | select(.id? == "composer-stash-dialog")][0]
        | ([.. | objects | select(.type? == "input") | .id]) == ["stash-prompt", "stash-name"])
' "$evidence/composer.json" > /dev/null \
  || fail "the prompt stash lost its menu or the Stash Prompt / Stash Name inputs (composer.json)"
ok "send split menu (Direct/Queue/Steer) and the stash menu with the two inputs (composer.json)"

# The stop button: present only while the mock turnRunning state is set.
jq -e '
  [.. | objects | select(.id? == "composer-stop")] | length == 0
' "$evidence/composer.json" > /dev/null \
  || fail "the stop button rendered on an idle session (composer.json)"
append_resp=$(curl -sS --max-time 10 -X POST \
    -H 'Content-Type: application/json' -H "$client_header" \
    --data '{"type":"run_start","payload":{"runId":"r1"}}' \
    "$base/sessions/$session_id/events")
{
  echo "=== append run_start ==="
  echo "POST /sessions/$session_id/events"
  echo "resp: $append_resp"
} >> "$tx"
step_hdr "$client_header" "$tx" "fetch-chat-running" GET "/ui/screen/chat:$session_id" '' 200 \
  '.node.type == "screen"'
jq -S '[.. | objects | select(.id? == "composer")][0]' <<< "$step_payload" \
  > "$evidence/composer-running.json"
jq -e '
  [.. | objects | select(.id? == "composer-stop")][0]
  | .icon == "stop" and .tooltip == "Interrupt"
  and .action.name == "cancel"
' "$evidence/composer-running.json" > /dev/null \
  || fail "the stop button is missing while a run is live (composer-running.json)"
ok "stop button: appears only while a run is live, posting the real cancel action (composer-running.json)"

# The seed carriers: the invisible inputs of the decorative defaults.
jq -e '
  [.. | objects | select(.type? == "container" and .visible? == false)][0]
  | ([.. | objects | select(.type? == "input") | .id] | sort) ==
    (["chat_model", "chat_provider", "chat_effort", "chat_mode",
      "chat_workspace", "chat_branch", "chat_host", "chat_dispatch"] | sort)
' "$evidence/composer.json" > /dev/null \
  || fail "the decorative seed carriers are wrong (composer.json)"
ok "seed carriers: the eight invisible inputs of the decorative defaults (composer.json)"

# The primitive-catalog guard: every node type in the composer tree is legal.
types=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' \
  "$evidence/composer.json")
for t in $types; do
  catalog_primitives | grep -qx "$t" \
    || fail "node type '$t' is outside the docs/sdui.md section 2.5 catalog"
done
ok "every composer node type is inside the docs/sdui.md section 2.5 catalog"

# The default keymap carries the T103 chords.
step_hdr "$client_header" "$tx" "fetch-bootstrap" GET "/_jhin/bootstrap" '' 200 \
  '.keymap | length > 0'
jq -e '
  [.keymap[] | select(.command == "composer.sendAlternate")][0]
  | .key == "mod+enter" and .when == "composerFocus && turnRunning"
' <<< "$step_payload" > /dev/null \
  || fail "the default keymap lost the turnRunning-gated alternate send (bootstrap)"
jq -e '
  ([.keymap[] | select(.command == "modelPicker.toggle")][0].key) == "mod+shift+m"
  and ([.keymap[] | select(.command == "composer.host")][0].key) == "mod+shift+h"
  and ([.keymap[] | select(.command == "composer.effort")][0].key) == "mod+shift+e"
  and ([.keymap[] | select(.command == "composer.mode")][0].key) == "mod+shift+a"
  and ([.keymap[] | select(.command == "composer.workspace")][0].key) == "mod+shift+x"
  and ([.keymap[] | select(.command == "composer.branch")][0].key) == "mod+shift+g"
  and ([.keymap[] | select(.command == "composer.previousWorktree")][0].key) == "mod+shift+l"
' <<< "$step_payload" > /dev/null \
  || fail "the default keymap lost the picker chords (bootstrap)"
ok "default keymap: mod+enter alternate (turnRunning-gated) and the seven picker chords (bootstrap)"

# The kernel work is done — stop it before the summary.
stop_kernel

# --- 7. The summary ---
{
  echo "# T103 composer control rows, chips, stash and key chords summary"
  echo
  echo "upstream anchors (commit 37de6cb): the composer control look"
  echo "(components/chat/ComposerControl.tsx:17-26), the model picker and"
  echo "control row (ChatComposer.tsx:5375-5555, the data-composer-shortcut"
  echo "chords TraitsPicker.tsx:648, BranchToolbar.tsx:209-211,"
  echo "BranchToolbarEnvironmentSelector.tsx:109), the effort traits picker"
  echo "(TraitsPicker.tsx:648), the runtime/plan mode controls"
  echo "(ChatComposer.tsx:1232-1360), the footer attach control"
  echo "(ChatComposer.tsx:7496-7504), the stop button (the destructive round"
  echo "square, ComposerPrimaryActions.tsx:123-145), the send split semantics"
  echo "(ComposerPrimaryActions.tsx:250-334), the stash drawer"
  echo "(ComposerStashMenu.tsx:38-145, the empty-state wording at 135-143),"
  echo "the ContextChip pill kinds (components/ContextChip.tsx:25-83), the"
  echo "inline chip truncation (components/composerInlineChip.ts:4-14) and"
  echo "the chords (packages/shared/src/keybindings.ts:47-76)."
  echo
  echo "plan-vs-upstream discrepancies:"
  echo "- the plan's ContextWindowMeter is a decorative gradient bar"
  echo "  green/yellow/red at 50/80%; the upstream meter is a circular ring"
  echo "  with an error tint above 90% and a linear bar only inside its"
  echo "  popover (ContextWindowMeter.tsx:36-39,118-129) — the plan wins"
  echo "- the plan's COMPOSER_MIN_HEIGHT (160) has no upstream constant; the"
  echo "  upstream composer sizes itself from its content and paddings — the"
  echo "  plan wins (the wire constraint on the textarea)"
  echo "- the plan's footer voice (Microphone) button has no upstream"
  echo "  counterpart in the composer (the only upstream Microphone lives in"
  echo "  components/device/DeviceToolsPanel.tsx) — the plan wins (a demo-"
  echo "  marked decorative affordance)"
  echo "- the plan's send split-button (Direct/Queue/Steer menu) upstream is"
  echo "  a single send button whose label/behavior flips between Submit /"
  echo "  Queue message / Steer message with mod+click alternating"
  echo "  (ComposerPrimaryActions.tsx:255-334) — the plan wins (the menu"
  echo "  carries the three modes as demo-marked state flips)"
  echo "- the plan's mod+Alt+Enter \"send-and-background\": upstream binds"
  echo "  sendBackground only on draft threads (draftThreadRoute,"
  echo "  packages/shared/src/keybindings.ts:56-66) and sendAndNewThread on"
  echo "  regular threads (composer-logic.ts:62 maps it to the background"
  echo "  intent); Jhin has no draft route and T68's composer.sendAndNew is"
  echo "  exactly that background-intent send, so the T68 mod+alt+enter"
  echo "  binding stands and the draft branch is dropped"
  echo "- the mod+Enter alternate rule (composer.sendAlternate, the opposite"
  echo "  queue/steer action) is bound with the upstream turnRunning gate;"
  echo "  the WhenContext carries turnRunning but no live source feeds it"
  echo "  yet (the run lifecycle is server-side), so the rule is reserved:"
  echo "  the idle mod+enter keeps the T68 send and the alternate fires only"
  echo "  once a live turnRunning source exists — the split menu carries the"
  echo "  same Direct/Queue/Steer state"
  echo "- upstream shows no kbd pill on the header controls (the chords ride"
  echo "  data-composer-shortcut attributes); the Jhin dialogs carry the"
  echo "  chord as a kbd pill in the title row — the plan's \"kbd hint\" wins"
  echo
  echo "wire contract: the pickers are demo buttons whose action opens a"
  echo "dialog list; the options dispatch the inline directive composite"
  echo "({client: [setState, toast]}, docs/sdui.md section 3) so a selection"
  echo "changes the interpolated label and toasts with no round-trip; the"
  echo "decorative defaults ride invisible seeded inputs; the send and stop"
  echo "buttons stay real actions; the decorative controls carry demo:true"
  echo
  echo "goldens: composer-rows-light.png; the --fail path: the empty-send"
  echo "inversion fails as required (no network call on an empty draft)"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T103 QA green: the full composer — control rows, chips, stash and key chords"
