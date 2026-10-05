#!/usr/bin/env bash
# QA for T93: the `diff_view` primitive — the decorative diff renderer with
# the unified and split views and the two colour schemes.
# Usage: scripts/qa/t93.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T93. Exits non-zero on the first
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
#   - runs the Flutter suite (flutter-primitives.txt: the unified/split
#     structure, the client-side view toggle with no dispatch and the patch
#     overlay, the blue-orange lane mapping, the ambient-switch fallback,
#     the shared demo affordance and the per-line degradation) and requires
#     "All tests passed";
#   - writes the pixel goldens into goldens/ (flutter test --update-goldens
#     with T93_GOLDEN_DIR: the 3-hunk fixture in both views and both colour
#     schemes, light, plus the dark unified frame — every frame carries the
#     shared demo marker) and re-runs the suite without the update flag to
#     prove the frames are byte-stable (flutter-goldens.txt,
#     flutter-goldens-verify.txt);
#   - fetches GET /ui/screen/qa-level3 at api=3;schema=4 and asserts the two
#     diff_view nodes pass through with their props (probe-l3.json);
#   - fetches the same screen at api=2;schema=3 and asserts the documented
#     downgrade: diff_view -> a code_block carrying the file name and the
#     hunk headers, the demo marker kept (probe-l2.json);
#   - asserts the docs/sdui.md section 2.5 catalog extraction still reports
#     exactly 68 names and records the goldens diffstat (goldens-diffstat.txt).
#
# Failure path: a deliberately broken builder probe — a `diff_view` without
# `demo: true` expected to build, while the builder fails with
# `demo marker required` (docs/sdui.md section 2.6: the primitive is
# decorative and always carries the marker) — fails against the builder
# throw; the run asserts the probe failed with that message (probe-demo.txt),
# removes the fixture, then the deliberately wrong expectation — "the broken
# probe passed" — trips (checks-fail.txt, exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T93_INNER:-}" ]; then
  exec env T93_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T93}
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

port=18493
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

# The T93 --fail probe fixture: deliberately broken — the decorative
# diff_view without the demo marker expected to build, while the builder
# fails with "demo marker required" (docs/sdui.md section 2.6; the T93
# acceptance).
probe_fixture="plugins/ui-kit/src/test/java/com/astroreen/jhin/plugin/uikit/T93DemoProbeTest.java"
cleanup_probe() {
  if [ -f "$probe_fixture" ]; then
    rm -f "$probe_fixture"
  fi
}
trap cleanup_probe EXIT

if [ "$fail_mode" = "1" ]; then
  log "T93 QA --fail: a diff_view without demo: true fails the builder"
  log "evidence dir: $evidence"

  cat > "$probe_fixture" <<'JAVA'
package com.astroreen.jhin.plugin.uikit;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** T93 QA --fail probe: deliberately broken — the decorative diff_view
 * without the demo marker expected to build, while the builder fails with
 * "demo marker required" (docs/sdui.md section 2.6). */
class T93DemoProbeTest {

    @Test
    void aDiffViewWithoutTheDemoMarkerBuilds() {
        String thrown = null;
        try {
            Ui.diffView()
                    .id("probe-no-demo")
                    .file("probe.ts")
                    .hunk(Ui.diffHunk("@@ -1,2 +1,2 @@")
                            .line(Ui.diffLine("add").newNo(1).text("added")))
                    .build();
        } catch (IllegalArgumentException e) {
            thrown = e.getMessage();
        }
        // Deliberately wrong: expects the builder NOT to throw.
        assertThat(thrown)
                .as("the builder must not throw without the demo marker")
                .isNull();
    }
}
JAVA

  probe="$evidence/probe-demo.txt"
  if ./gradlew :jhin-plugin-ui-kit:test --rerun \
      --tests "com.astroreen.jhin.plugin.uikit.T93DemoProbeTest" \
      > "$probe" 2>&1; then
    fail "the demo-marker probe passed despite the broken fixture (see $probe)"
  fi
  # The assertion message lands in the JUnit XML report, not the console.
  grep -q 'demo marker required' "$probe" \
    || grep -q 'demo marker required' \
        plugins/ui-kit/build/test-results/test/TEST-com.astroreen.jhin.plugin.uikit.T93DemoProbeTest.xml \
    || fail "the demo-marker probe did not fail on the missing marker (see $probe)"
  ok "a diff_view without demo: true fails the builder with 'demo marker required' (probe-demo.txt)"

  cleanup_probe
  {
    echo "FAIL: the diff_view without the demo marker built (as designed)"
    echo "  demo-marker probe: failed as required, the builder threw 'demo marker required' (probe-demo.txt)"
    echo "  fixture removed again; the tree is clean"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the broken demo-marker probe is still in the tree (it is removed; see $evidence/probe-demo.txt)"
fi

log "T93 QA: the diff_view primitive with the unified and split rendering"
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

# --- 3. The Flutter suite ---
bash scripts/qa/flutter-test.sh test/sdui/diff_view_test.dart \
  2>&1 | tee "$evidence/flutter-primitives.txt"
grep -q 'All tests passed' "$evidence/flutter-primitives.txt" \
  || fail "the Flutter primitive suite failed (see $evidence/flutter-primitives.txt)"
ok "Flutter suite green: diff_view unified/split structure, the client-side view toggle (no dispatch, patch overlay), the blue-orange lane mapping, the ambient-switch fallback, the shared demo affordance and the per-line degradation (flutter-primitives.txt)"

# --- 4. The goldens: both views x both colour schemes, plus the dark frame ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/diff_view_test.dart \
  --update-goldens \
  --dart-define="T93_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
for frame in diff-view-unified-default-light diff-view-unified-blue-orange-light \
             diff-view-split-default-light diff-view-split-blue-orange-light \
             diff-view-unified-default-dark; do
  [ -s "$goldens/$frame.png" ] \
    || fail "the golden $frame.png is missing or empty (goldens/)"
done
ok "goldens: 5 frames written (the 3-hunk fixture in both views and both colour schemes, light, plus the dark unified frame; every frame carries the shared demo marker) (goldens/)"

# --- 5. The verification pass: the same suite without --update-goldens
#        must match the written frames byte-for-byte ---
bash scripts/qa/flutter-test.sh test/sdui/diff_view_test.dart \
  --dart-define="T93_GOLDEN_DIR=$(readlink -f "$goldens")" \
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

# --- 7. The probe screen at level 3: the diff_view nodes pass through ---
fetch_probe "$hdr_l3" "$tx" "probe-l3" "$evidence/probe-l3.json"
jq -e '[.. | objects | select(.id? == "probe-diff-view")][0] |
    .type == "diff_view"
    and .file == "docs/sdui.md" and .language == "markdown"
    and .view == "unified" and .colorScheme == "default"
    and .stats.additions == 2 and .stats.deletions == 1
    and .demo == true
    and (.hunks | type == "array" and length == 1)
    and (.hunks[0].header | startswith("@@"))
    and (.hunks[0].lines | length == 3)
    and ([.hunks[0].lines[].kind] | unique | sort == ["add", "ctx", "del"])' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "the level-3 probe tree does not carry the unified diff_view node with its props (probe-l3.json)"
jq -e '[.. | objects | select(.id? == "probe-diff-view-split")][0] |
    .type == "diff_view"
    and .view == "split" and .colorScheme == "blue-orange"
    and .demo == true
    and (.hunks | length == 1)' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "the level-3 probe tree does not carry the split blue-orange diff_view node (probe-l3.json)"
ok "probe screen at api=3;schema=4: both diff_view nodes (unified/default and split/blue-orange) pass through with file, language, view, colorScheme, stats, demo and hunks (probe-l3.json)"

# --- 8. The probe screen at level 2: the documented downgrade map ---
fetch_probe "$hdr_l2" "$tx" "probe-l2" "$evidence/probe-l2.json"
used=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' "$evidence/probe-l2.json")
if grep -qx "diff_view" <<< "$used"; then
  fail "the level-2 tree still carries the level-3 type 'diff_view' (probe-l2.json)"
fi
jq -e '[.. | objects | select(.id? == "probe-diff-view")][0] |
    .type == "code_block"
    and (.code | startswith("docs/sdui.md"))
    and (.code | contains("@@ -1,3 +1,4 @@"))
    and .demo == true' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "diff_view did not degrade to a code_block carrying the file name and the hunk headers with the demo marker kept (probe-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-diff-view")][0] |
    (has("hunks") or has("view") or has("colorScheme") or has("stats")) | not' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "the diff_view diff props survived the downgrade (probe-l2.json)"
ok "probe screen at api=2;schema=3: diff_view -> code_block carrying the file name and the hunk headers, demo kept, the diff props dropped (probe-l2.json)"

# --- 9. The docs catalog: still exactly 68 names ---
catalog=$(catalog_primitives)
count=$(grep -c . <<< "$catalog")
[ "$count" = "68" ] \
  || fail "the docs/sdui.md section 2.5 catalog extraction reports $count names, not 68"
ok "catalog extraction reports exactly 68 names (diff_view registered since T88; the typed builder and the client primitive landed in T93)"

# The kernel work is done — stop it before the diffstat so a lingering
# graceful shutdown never delays the run end.
stop_kernel

# --- 10. The goldens diffstat ---
{
  echo "# goldens diffstat (T93)"
  echo
  echo "## git diff --stat (tracked golden sources)"
  git diff --stat -- plugins/ui-kit/src/test/resources/regression frontend/test/gallery/goldens frontend/test/gallery/gallery_nodes.dart || true
  echo
  echo "## new golden files (git status --porcelain)"
  git status --porcelain -- plugins/ui-kit/src/test/resources/regression frontend/test/gallery/goldens .sisyphus/evidence/T93/goldens || true
} > "$evidence/goldens-diffstat.txt"
ok "goldens diffstat recorded (goldens-diffstat.txt)"

log "T93 QA green: the diff_view primitive with the unified and split rendering verified"
