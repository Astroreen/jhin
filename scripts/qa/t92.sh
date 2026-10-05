#!/usr/bin/env bash
# QA for T92: the `scroll_fade` primitive and the duty-cycled status
# indicators (the `progress` `statusPulse` modes).
# Usage: scripts/qa/t92.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T92. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit and
# jhin.ui plus the QA-only level-3 probe screen (the jhin.ui config switch
# qaProbe, set here through the JHIN_UI_QAPROBE environment variable; default
# off, no product surface).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt, §15.4: the goldens
#     run on the flutter_test VM target);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL;
#   - runs the two Flutter suites (flutter-primitives.txt: the scroll_fade
#     edge/mode/degrade and virtualized-toggle assertions, the statusPulse
#     pulse/ping/skeleton modes, the ≤16-frames-per-2s-cycle-at-120Hz duty
#     bound, the complete-indicator no-animation rule and the
#     ThreadStatusIndicators composition) and requires "All tests passed";
#   - writes the pixel goldens into goldens/ (flutter test --update-goldens
#     with T92_GOLDEN_DIR: the topbar fade light + dark, the virtualized
#     rest/scrolled pair and the mid-cycle pulse dot light + dark) and
#     re-runs the suites without the update flag to prove the frames are
#     byte-stable (flutter-goldens.txt, flutter-goldens-verify.txt);
#   - fetches GET /ui/screen/qa-level3 at api=3;schema=4 and asserts the
#     scroll_fade node passes through with its props and the four
#     statusPulse indicator nodes carry their modes, including the complete
#     indicator (value 1.0 + ping) (probe-l3.json);
#   - fetches the same screen at api=2;schema=3 and asserts the documented
#     downgrades: scroll_fade -> a scroll wrapping the same child, and
#     statusPulse stripped from every indicator (probe-l2.json);
#   - asserts the docs/sdui.md section 2.5 catalog extraction still reports
#     exactly 68 names and records the goldens diffstat (goldens-diffstat.txt).
#
# Failure path: a deliberately broken probe test — a `progress` with
# `value: 1.0` and `statusPulse: ping` expected to render the animating ping
# ring, while the primitive renders the static complete bar and never
# animates (docs/sdui.md section 2.6: "a complete indicator (value ≥ 1.0)
# renders the static complete bar and never animates") — fails against the
# static render; the run asserts the probe failed with no animating ring
# present (probe-complete.txt), removes the fixture, then the deliberately
# wrong expectation — "the broken probe passed" — trips (checks-fail.txt,
# exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T92_INNER:-}" ]; then
  exec env T92_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T92}
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

port=18492
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
  ( JHIN_HOME="$home" JHIN_UI_QAPROBE=true \
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

# fetch_probe <header> <transcript> <name> <out-json>: the probe screen node
fetch_probe() {
  local hdr=$1 tx=$2 name=$3 out=$4
  step_hdr "$hdr" "$tx" "$name" GET /ui/screen/qa-level3 '' 200 '.node.type == "screen"'
  jq -S .node <<< "$step_payload" > "$out"
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

# The T92 --fail probe fixture: deliberately broken — the complete indicator
# (value 1.0 + statusPulse ping) expected to render the animating ping ring,
# while the primitive renders the static complete bar and never animates
# (docs/sdui.md section 2.6; the T92 acceptance).
probe_fixture="frontend/test/sdui/t92_complete_probe_test.dart"
cleanup_probe() {
  if [ -f "$probe_fixture" ]; then
    rm -f "$probe_fixture"
  fi
}
trap cleanup_probe EXIT

if [ "$fail_mode" = "1" ]; then
  log "T92 QA --fail: a complete indicator (value 1.0) never animates"
  log "evidence dir: $evidence"

  cat > "$probe_fixture" <<'DART'
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/sdui/render_context.dart';
import 'package:jhin/sdui/ui_node.dart';
import 'package:jhin/sdui/ui_registry.dart';
import 'package:jhin/sdui/ui_state.dart';

/// T92 QA --fail probe: deliberately broken — the complete indicator
/// (`value: 1.0` + `statusPulse: ping`) expected to render the animating
/// ping ring, while the primitive renders the static complete bar and never
/// animates (docs/sdui.md section 2.6).
void main() {
  testWidgets('the complete indicator animates the ping ring', (tester) async {
    tester.view.physicalSize = const Size(300, 200);
    tester.view.devicePixelRatio = 1.0;
    const node = {
      'type': 'progress',
      'id': 'probe-complete',
      'kind': 'linear',
      'value': 1.0,
      'statusPulse': 'ping',
    };
    final design = JhinTheme.from();
    await tester.pumpWidget(MaterialApp(
      theme: design.light,
      home: JhinDesignScope(
        design: design,
        child: Scaffold(
          body: Center(
            child: Builder(
              builder: (context) => RenderContext(
                state: UiState(),
                registry: UiRegistry.standard(),
                patches: {},
                setState: (_, __) {},
                patch: (_, __) {},
                navigate: (_) {},
                dispatch: (_) async {},
                openStream: (_, {onStatus}) => const Stream.empty(),
                runDirectives: (_) async {},
                confirm: (_, __) {},
              ).build(context, UiNode.fromJson(node)),
            ),
          ),
        ),
      ),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(Opacity), findsOneWidget,
        reason: 'the ping ring must animate on the complete indicator');
  });
}
DART

  probe="$evidence/probe-complete.txt"
  if bash scripts/qa/flutter-test.sh test/sdui/t92_complete_probe_test.dart \
      > "$probe" 2>&1; then
    fail "the complete-indicator probe passed despite the broken fixture (see $probe)"
  fi
  grep -q 'Found 0 widgets with type "Opacity"' "$probe" \
    || fail "the complete-indicator probe did not fail on the static render (see $probe)"
  ok "a complete indicator (value 1.0) never animates — the static complete bar wins (probe-complete.txt)"

  cleanup_probe
  {
    echo "FAIL: the complete indicator rendered the animating ping ring (as designed)"
    echo "  complete-indicator probe: failed as required, no animating ring was rendered (probe-complete.txt)"
    echo "  fixture removed again; the tree is clean"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the broken complete-indicator probe is still in the tree (it is removed; see $evidence/probe-complete.txt)"
fi

log "T92 QA: the scroll_fade primitive and the duty-cycled status indicators"
log "evidence dir: $evidence"

# --- 1. The toolchain (§15.4: the target that produced the goldens) ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "goldens produced on the flutter_test VM target ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites ---
./gradlew :jhin-plugin-ui-default:test :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; transcript in test.txt)"

# --- 3. The two Flutter suites ---
bash scripts/qa/flutter-test.sh test/sdui/scroll_fade_test.dart test/sdui/status_indicators_test.dart \
  2>&1 | tee "$evidence/flutter-primitives.txt"
grep -q 'All tests passed' "$evidence/flutter-primitives.txt" \
  || fail "the Flutter primitive suites failed (see $evidence/flutter-primitives.txt)"
ok "Flutter suites green: scroll_fade edge/mode/degrade + virtualized toggle, statusPulse pulse/ping/skeleton modes, the ≤16-frames-per-2s-cycle-at-120Hz duty bound, the complete-indicator no-animation rule and the ThreadStatusIndicators composition (flutter-primitives.txt)"

# --- 4. The goldens: the fade and the pulse dot, light + dark ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/scroll_fade_test.dart test/sdui/status_indicators_test.dart \
  --update-goldens \
  --dart-define="T92_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
for frame in scroll-fade-light scroll-fade-dark \
             scroll-fade-virtualized-rest scroll-fade-virtualized-scrolled \
             status-pulse-light status-pulse-dark; do
  [ -s "$goldens/$frame.png" ] \
    || fail "the golden $frame.png is missing or empty (goldens/)"
done
ok "goldens: 6 frames written (the topbar fade light + dark, the virtualized rest/scrolled pair and the mid-cycle pulse dot light + dark) (goldens/)"

# --- 5. The verification pass: the same suites without --update-goldens
#        must match the written frames byte-for-byte ---
bash scripts/qa/flutter-test.sh test/sdui/scroll_fade_test.dart test/sdui/status_indicators_test.dart \
  --dart-define="T92_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged from the written frames (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

# --- 6. The kernel with the QA probe screen enabled ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui plus the qaProbe level-3 probe screen (kernel.log)"

tx="$evidence/roundtrip.txt"
: > "$tx"

hdr_l3='api=3; version=0.3.0; schema=4; caps=sse'
hdr_l2='api=2; version=0.3.0; schema=3; caps=sse'

# --- 7. The probe screen at level 3: the fade and the indicators pass
#        through ---
fetch_probe "$hdr_l3" "$tx" "probe-l3" "$evidence/probe-l3.json"
jq -e '[.. | objects | select(.id? == "probe-scroll-fade")][0] |
    .type == "scroll_fade"
    and .edge == "top" and .height == 24 and .mode == "topbar"
    and (.child | type == "object" and .type == "text")' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "the level-3 probe tree does not carry the scroll_fade node with its props (probe-l3.json)"
for probe_id in probe-pulse probe-ping probe-skeleton; do
  jq -e --arg id "$probe_id" \
      '[.. | objects | select(.id? == $id)][0] |
       .type == "progress" and .statusPulse != null' \
    "$evidence/probe-l3.json" > /dev/null \
    || fail "the level-3 probe tree does not carry the '$probe_id' indicator with its statusPulse mode (probe-l3.json)"
done
jq -e '[.. | objects | select(.id? == "probe-pulse")][0].statusPulse == "pulse"' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "probe-pulse does not carry the pulse mode (probe-l3.json)"
jq -e '[.. | objects | select(.id? == "probe-ping")][0].statusPulse == "ping"' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "probe-ping does not carry the ping mode (probe-l3.json)"
jq -e '[.. | objects | select(.id? == "probe-skeleton")][0].statusPulse == "skeleton"' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "probe-skeleton does not carry the skeleton mode (probe-l3.json)"
jq -e '[.. | objects | select(.id? == "probe-complete")][0] |
    .type == "progress" and .value == 1.0 and .statusPulse == "ping"' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "the level-3 probe tree does not carry the complete indicator (value 1.0 + ping) (probe-l3.json)"
ok "probe screen at api=3;schema=4: scroll_fade (edge/height/mode/child) and the four statusPulse indicators (pulse, ping, skeleton, complete value 1.0 + ping) pass through (probe-l3.json)"

# --- 8. The probe screen at level 2: the documented downgrade map ---
fetch_probe "$hdr_l2" "$tx" "probe-l2" "$evidence/probe-l2.json"
used=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' "$evidence/probe-l2.json")
if grep -qx "scroll_fade" <<< "$used"; then
  fail "the level-2 tree still carries the level-3 type 'scroll_fade' (probe-l2.json)"
fi
jq -e '[.. | objects | select(.id? == "probe-scroll-fade")][0] | .type == "scroll" and (.children | length) == 1' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "scroll_fade did not degrade to a scroll wrapping the same child (probe-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-scroll-fade")][0] |
    (has("edge") or has("height") or has("mode")) | not' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "the scroll_fade fade props survived the downgrade (probe-l2.json)"
for probe_id in probe-pulse probe-ping probe-skeleton probe-complete; do
  jq -e --arg id "$probe_id" \
      '[.. | objects | select(.id? == $id)][0] | has("statusPulse") | not' \
    "$evidence/probe-l2.json" > /dev/null \
    || fail "the level-2 tree still carries statusPulse on '$probe_id' (probe-l2.json)"
done
jq -e '[.. | objects | select(.id? == "probe-complete")][0] | .type == "progress" and .value == 1.0' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "the complete indicator lost its value through the downgrade (probe-l2.json)"
ok "probe screen at api=2;schema=3: scroll_fade -> scroll wrapping the same child, statusPulse stripped from every indicator (probe-l2.json)"

# --- 9. The docs catalog: still exactly 68 names ---
catalog=$(catalog_primitives)
count=$(grep -c . <<< "$catalog")
[ "$count" = "68" ] \
  || fail "the docs/sdui.md section 2.5 catalog extraction reports $count names, not 68"
ok "catalog extraction reports exactly 68 names (scroll_fade registered since T88; the statusPulse row landed in section 2.6)"

# The kernel work is done — stop it before the diffstat so a lingering
# graceful shutdown never delays the run end.
stop_kernel

# --- 10. The goldens diffstat ---
{
  echo "# goldens diffstat (T92)"
  echo
  echo "## git diff --stat (tracked golden sources)"
  git diff --stat -- plugins/ui-kit/src/test/resources/regression frontend/test/gallery/goldens frontend/test/gallery/gallery_nodes.dart || true
  echo
  echo "## new golden files (git status --porcelain)"
  git status --porcelain -- plugins/ui-kit/src/test/resources/regression frontend/test/gallery/goldens .sisyphus/evidence/T92/goldens || true
} > "$evidence/goldens-diffstat.txt"
ok "goldens diffstat recorded (goldens-diffstat.txt)"

log "T92 QA green: the scroll_fade primitive and the duty-cycled status indicators verified"
