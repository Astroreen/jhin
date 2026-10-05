#!/usr/bin/env bash
# QA for T95: the shell chrome — the 52 px top bar (wordmark, breadcrumb,
# control cluster), the workspace gutters with the safe-area insets, the page
# header row, the terminal drawer slot, the stage-art backdrop behind the
# sidebar and the 768 px responsive rule.
# Usage: scripts/qa/t95.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T95. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit and
# jhin.ui (the sessions screen IS the shell chrome surface).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T95 shell JSON tree
#     assert (ShellScreenTest) and the builder whitelist guard;
#   - runs the Flutter shell suite (flutter-shell.txt) and requires
#     "All tests passed";
#   - writes the four chrome goldens into goldens/ (wide light + dark, the
#     narrow viewport, the notched viewport) with T95_GOLDEN_DIR and
#     re-runs the suite against them byte-stable (flutter-goldens.txt,
#     flutter-goldens-verify.txt);
#   - boots the kernel and fetches the bootstrap at api=3;schema=4: the
#     theme.stageArt block carries the five stage-art hex tokens
#     (bootstrap.json);
#   - fetches the sessions screen at api=3;schema=4 and asserts the shell
#     JSON tree: breakpoint 768, stageBackdrop true, the topbar slot
#     (wordmark Jhin, the Workspace / Threads breadcrumb, the nav control
#     cluster), the compact topbar (the breadcrumb condensed to the current
#     title), the page header (title + arrange-toggle action) and the
#     body = the sidebar split (T96) (shell-tree.json);
#   - fetches the same screen at api=2;schema=3 and asserts the chrome slots
#     pass through unchanged (they are level-2 props; shell-tree-l2.json).
#
# Failure path: a temporary probe test expects a shell node with an unknown
# slot name (leftPanel) to be silently accepted while the builder whitelist
# rejects it at build time — the probe must fail naming the slot
# (probe-slot.txt), the temp file is removed and the deliberately wrong
# expectation trips (checks-fail.txt, exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T95_INNER:-}" ]; then
  exec env T95_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T95}
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
  if [ -n "${probe_file:-}" ] && [ -f "$probe_file" ]; then
    rm -f "$probe_file"
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

port=18495
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

# flutter_bin: the same flutter resolution scripts/qa/flutter-test.sh uses
flutter_bin() {
  if command -v flutter > /dev/null 2>&1; then
    flutter "$@"
  else
    devenv shell -- flutter "$@"
  fi
}

if [ "$fail_mode" = "1" ]; then
  log "T95 QA --fail: a shell node with an unknown slot name is rejected at build"
  log "evidence dir: $evidence"

  # The temporary probe: deliberately broken — it expects the unknown slot
  # to be silently accepted while the builder whitelist rejects it. The
  # cleanup trap removes the file.
  probe_file="plugins/ui-default/src/test/java/com/astroreen/jhin/plugin/ui/ShellSlotProbeTest.java"
  cat > "$probe_file" <<'JAVA'
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * T95 QA --fail probe (temporary file, deleted by the QA script): deliberately
 * broken — it expects a shell node with an unknown slot name to be silently
 * accepted while the builder whitelist rejects it at build time.
 */
class ShellSlotProbeTest {

    @Test
    void unknownSlotIsSilentlyAccepted() {
        UiNode node = Ui.shell().set("leftPanel", Ui.text("x").build()).build();
        assertThat(node.toJson()).containsKey("leftPanel");
    }
}
JAVA

  probe="$evidence/probe-slot.txt"
  if ./gradlew :jhin-plugin-ui-default:test \
        --tests 'com.astroreen.jhin.plugin.ui.ShellSlotProbeTest' --rerun \
        > "$probe" 2>&1; then
    fail "the probe passed despite the whitelist (see $probe)"
  fi
  grep -q 'unsupported prop leftPanel on shell' \
    plugins/ui-default/build/test-results/test/TEST-com.astroreen.jhin.plugin.ui.ShellSlotProbeTest.xml \
    || fail "the probe did not fail naming the unknown slot (see $probe)"
  ok "the builder whitelist tripped: the probe failed naming 'unsupported prop leftPanel on shell' (probe-slot.txt)"

  rm -f "$probe_file"
  probe_file=""
  if ./gradlew :jhin-plugin-ui-default:test \
        --tests 'com.astroreen.jhin.plugin.ui.ShellScreenTest' --rerun \
        >> "$probe" 2>&1; then
    ok "the real guard test (ShellScreenTest.unknownSlotNameIsRejectedAtBuild) passes after the probe"
  else
    fail "the real guard test failed after the probe was removed (see $probe)"
  fi

  {
    echo "FAIL: the unknown-slot guard tripped as designed (the probe expected a silent accept, the whitelist rejected it)"
    echo "  probe: ShellSlotProbeTest.unknownSlotIsSilentlyAccepted failed with 'unsupported prop leftPanel on shell' (probe-slot.txt)"
    echo "  the temporary probe file was removed; the permanent guard (ShellScreenTest) stays green"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the unknown slot was not rejected (it was; see $evidence/probe-slot.txt)"
fi

log "T95 QA: the shell chrome — topbar, gutters, breadcrumb, page header and stage backdrop"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T95 shell tree assert lives here) ---
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

# --- 3. The Flutter shell suite ---
bash scripts/qa/flutter-test.sh test/sdui/shell_test.dart \
  2>&1 | tee "$evidence/flutter-shell.txt"
grep -q 'All tests passed' "$evidence/flutter-shell.txt" \
  || fail "the Flutter shell suite failed (see $evidence/flutter-shell.txt)"
ok "Flutter shell suite green: the 52 px topbar, the gutters (20 px wide / 8 px narrow), the safe-area insets, the page header, the terminal 40% cap, the drawer overlay with backdrop and swipe, the motion.panel animation and the reduced-motion collapse (flutter-shell.txt)"

# --- 4. The goldens: the chrome wide light + dark, narrow and notched ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/shell_test.dart \
  --update-goldens \
  --dart-define="T95_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
for frame in shell-chrome-wide-light shell-chrome-wide-dark \
             shell-chrome-narrow shell-chrome-notched; do
  [ -s "$goldens/$frame.png" ] \
    || fail "the golden $frame.png is missing or empty (goldens/)"
done
ok "goldens: 4 frames written (the chrome wide light + dark, the narrow viewport and the notched viewport) (goldens/)"

# --- 5. The verification pass: the same suite without --update-goldens
#        must match the written frames byte-for-byte ---
bash scripts/qa/flutter-test.sh test/sdui/shell_test.dart \
  --dart-define="T95_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged from the written frames (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 6. The kernel with the shell chrome ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/roundtrip.txt"
: > "$tx"

hdr_l3='api=3; version=0.3.0; schema=4; caps=sse'
hdr_l2='api=2; version=0.3.0; schema=3; caps=sse'

# --- 7. The bootstrap: the theme.stageArt block ---
step_hdr "$hdr_l3" "$tx" "bootstrap" GET /_jhin/bootstrap '' 200 \
  '.theme.stageArt | length == 5'
jq -S .theme.stageArt <<< "$step_payload" > "$evidence/stage-art.json"
for key in stage-art-top stage-art-mid stage-art-bottom stage-art-highlight stage-art-line; do
  jq -e --arg key "$key" '.[$key] | test("^#[0-9a-f]{6}$")' \
    "$evidence/stage-art.json" > /dev/null \
    || fail "the stage-art token $key is not a #RRGGBB hex (stage-art.json)"
done
ok "bootstrap theme.stageArt carries the five stage-art hex tokens (stage-art.json)"

# --- 8. The sessions screen: the shell JSON tree ---
step_hdr "$hdr_l3" "$tx" "shell-tree" GET /ui/screen/sessions '' 200 \
  '.node.type == "screen"'
jq -S .node <<< "$step_payload" > "$evidence/shell-tree.json"

shell=$(jq '.body' "$evidence/shell-tree.json")
jq -e '.type == "shell" and .breakpoint == 768 and .stageBackdrop == true' \
  <<< "$shell" > /dev/null \
  || fail "the shell does not carry breakpoint 768 + stageBackdrop (shell-tree.json)"
for slot in topbar topbarCompact pageHeader body; do
  jq -e --arg slot "$slot" 'has($slot)' <<< "$shell" > /dev/null \
    || fail "the shell does not carry the $slot slot (shell-tree.json)"
done
jq -e '.topbar | [.. | objects | .text? // empty] | index("Jhin") != null
    and index("Workspace") != null and index("/") != null and index("Threads") != null' \
  <<< "$shell" > /dev/null \
  || fail "the topbar does not carry the wordmark and the Workspace / Threads breadcrumb (shell-tree.json)"
jq -e '.topbarCompact | [.. | objects | .text? // empty] | index("Jhin") != null
    and index("Threads") != null and index("Workspace") == null' \
  <<< "$shell" > /dev/null \
  || fail "the compact topbar does not condense the breadcrumb to the current title (shell-tree.json)"
jq -e '[.topbar.children[] | select(.type == "nav")][0].items
    | map(.screen) | index("sessions") != null and index("settings") != null' \
  <<< "$shell" > /dev/null \
  || fail "the topbar control cluster does not carry the app navigation (shell-tree.json)"
jq -e '.pageHeader | ([.. | objects | .text? // empty] | index("Threads")) != null
    and ([.. | objects | select(.type? == "button")][0].action.name == "arrange-toggle")' \
  <<< "$shell" > /dev/null \
  || fail "the page header does not carry the title and the arrange action (shell-tree.json)"
# Since T96 the body slot carries the sidebar split (the resizable
# sections | content row); the fixed-width sidebar slot is unset.
jq -e '.body.type == "split" and .body.persistKey == "chat_thread_sidebar_width"
    and (.body.first.sections | length == 5)' \
  <<< "$shell" > /dev/null \
  || fail "the body slot does not carry the five-section sidebar split (shell-tree.json)"
ok "sessions shell tree: breakpoint 768, stageBackdrop, topbar (wordmark + Workspace / Threads breadcrumb + nav cluster), compact topbar (current title only), page header (title + arrange-toggle), body = the five-section sidebar split (shell-tree.json)"

# --- 9. The same screen at level 2: the chrome slots pass through ---
step_hdr "$hdr_l2" "$tx" "shell-tree-l2" GET /ui/screen/sessions '' 200 \
  '.node.type == "screen"'
jq -S .node <<< "$step_payload" > "$evidence/shell-tree-l2.json"
l2shell=$(jq '.body' "$evidence/shell-tree-l2.json")
jq -e '.type == "shell" and .breakpoint == 768 and .stageBackdrop == true
    and has("topbar") and has("topbarCompact") and has("pageHeader")' \
  <<< "$l2shell" > /dev/null \
  || fail "the level-2 tree does not carry the chrome slots (shell-tree-l2.json)"
ok "level-2 tree carries the chrome slots unchanged (they are level-2 props) (shell-tree-l2.json)"

# The kernel work is done — stop it before the summary.
stop_kernel

# --- 10. The summary ---
{
  echo "# T95 shell chrome summary"
  echo
  echo "shell slots: topbar (52 px token height, gutters + safe-area),"
  echo "topbarCompact (breadcrumb condensed below 768 px), pageHeader"
  echo "(title + actions), terminal (grip + 40% narrow cap), stageBackdrop"
  echo "(the theme.stageArt gradient behind the sidebar under the fade mask)"
  echo
  echo "responsive rule: breakpoint 768 — below it the sidebar overlays as a"
  echo "drawer (openMobile, backdrop, tap/swipe to close), the right panel is"
  echo "hidden, the gutters compress to 0.5rem, the terminal caps at 40%"
  echo
  echo "motion: the sidebar open/close rides motion.panel over easeDrawer;"
  echo "reduced motion collapses the duration to 0"
  echo
  echo "theme.stageArt: the five stage-art hex tokens of the selected theme"
  echo
  echo "goldens: 4 frames (wide light + dark, narrow, notched), byte-stable"
  echo "on the verify pass"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T95 QA green: the shell chrome — topbar, gutters, breadcrumb, page header and stage backdrop"
