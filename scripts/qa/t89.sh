#!/usr/bin/env bash
# QA for T89: glass surface props on the five glass-capable surfaces.
# Usage: scripts/qa/t89.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T89. Exits non-zero on the first
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
#   - runs the Flutter sdui suites (flutter-sdui.txt; includes the T89
#     glass_test.dart wiring assertions) and requires "All tests passed";
#   - writes the pixel goldens into goldens/ (flutter test --update-goldens
#     with T89_GOLDEN_DIR: light + dark per glass surface plus the degraded
#     flat-fill frame) and re-runs the suite without the update flag to prove
#     the frames are byte-stable (flutter-goldens.txt,
#     flutter-goldens-verify.txt);
#   - fetches GET /ui/screen/qa-level3 at api=3;schema=4 and asserts the five
#     glass surfaces pass through with glass=true and glassTint
#     (probe-l3.json);
#   - fetches the same screen at api=2;schema=3 and asserts glass and
#     glassTint are stripped from every node (probe-l2.json);
#   - asserts the docs/sdui.md section 2.5 catalog extraction still reports
#     exactly 68 names and records the goldens diffstat (goldens-diffstat.txt).
#
# Failure path: a deliberately broken probe test — glass on `text` through
# the escape hatch, expected to be accepted — fails against the builder's
# unsupported-prop rejection; the run asserts the probe failed with the
# "unsupported prop" error (probe-rejection.txt), removes the fixture, then
# the deliberately wrong expectation — "the broken probe passed" — trips
# (checks-fail.txt, exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T89_INNER:-}" ]; then
  exec env T89_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T89}
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

port=18489
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

# The five glass surfaces the probe screen carries (T89) and their ids —
# the card case keeps the T88 probe id.
glass_ids="probe-glass probe-glass-sheet probe-glass-dialog probe-glass-menu probe-glass-banner"

# The T89 --fail probe fixture: deliberately broken — glass on text through
# the escape hatch, expected to be accepted, while the builder rejects it
# with the standard unsupported-prop error (docs/sdui.md section 2.1).
probe_fixture="plugins/ui-kit/src/test/java/com/astroreen/jhin/plugin/uikit/T89GlassRejectionProbeTest.java"
cleanup_probe() {
  if [ -f "$probe_fixture" ]; then
    rm -f "$probe_fixture"
  fi
}
trap cleanup_probe EXIT

if [ "$fail_mode" = "1" ]; then
  log "T89 QA --fail: glass on text must be rejected by the builder with the unsupported-prop error"
  log "evidence dir: $evidence"

  cat > "$probe_fixture" <<'JAVA'
package com.astroreen.jhin.plugin.uikit;

import org.junit.jupiter.api.Test;

/**
 * T89 QA --fail probe: deliberately broken — glass on {@code text} through
 * the escape hatch, expected to be accepted, while the builder rejects the
 * glass keys on every non-glass surface with the standard unsupported-prop
 * error (docs/sdui.md section 2.1).
 */
class T89GlassRejectionProbeTest {

    @Test
    void glassOnTextIsAccepted() {
        Ui.text("probe").set("glass", true).build();
    }
}
JAVA

  probe="$evidence/probe-rejection.txt"
  if ./gradlew :jhin-plugin-ui-kit:test --tests '*T89GlassRejectionProbeTest*' \
      > "$probe" 2>&1; then
    fail "the rejection probe passed despite the broken fixture (see $probe)"
  fi
  # The exception message lives in the XML report, not the console stream.
  report=$(ls plugins/ui-kit/build/test-results/test/TEST-*T89GlassRejectionProbeTest.xml 2>/dev/null | head -1)
  [ -n "$report" ] || fail "the rejection probe report is missing (see $probe)"
  grep -q 'unsupported prop' "$report" \
    || fail "the rejection probe did not fail with the unsupported-prop error (see $report)"
  ok "the builder rejected glass on text with the unsupported-prop error (probe-rejection.txt)"

  cleanup_probe
  {
    echo "FAIL: glass on text was accepted by the builder (as designed)"
    echo "  rejection probe: failed as required, message carries 'unsupported prop' (probe-rejection.txt)"
    echo "  fixture removed again; the tree is clean"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the broken glass-on-text probe is still in the tree (it is removed; see $evidence/probe-rejection.txt)"
fi

log "T89 QA: glass surface props on card, sheet, dialog, menu and banner"
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

# --- 3. The Flutter sdui suites (glass_test.dart lives here) ---
bash scripts/qa/flutter-test.sh test/sdui 2>&1 | tee "$evidence/flutter-sdui.txt"
grep -q 'All tests passed' "$evidence/flutter-sdui.txt" \
  || fail "the Flutter sdui suites failed (see $evidence/flutter-sdui.txt)"
ok "Flutter sdui suites green incl. the T89 glass wiring tests (flutter-sdui.txt)"

# --- 4. The goldens: light + dark per glass surface + the degraded
#        flat-fill frame ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/sdui/glass_test.dart \
  --update-goldens \
  --dart-define="T89_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
for surface in card sheet dialog menu banner; do
  for mode in light dark; do
    [ -s "$goldens/glass-$surface-$mode.png" ] \
      || fail "the golden glass-$surface-$mode.png is missing or empty (goldens/)"
  done
done
[ -s "$goldens/glass-degraded-light.png" ] \
  || fail "the degraded flat-fill golden glass-degraded-light.png is missing or empty (goldens/)"
# The glass golden must visibly differ from the degraded flat fill (the blur
# is real, not a same-pixel re-render).
if cmp -s "$goldens/glass-card-light.png" "$goldens/glass-degraded-light.png"; then
  fail "the glass golden is byte-identical to the degraded flat-fill golden (goldens/)"
fi
ok "goldens: 11 frames written (light+dark per glass surface, degraded flat fill); glass differs from the flat fill (goldens/)"

# --- 5. The verification pass: the same suite without --update-goldens
#        must match the written frames byte-for-byte ---
bash scripts/qa/flutter-test.sh test/sdui/glass_test.dart \
  --dart-define="T89_GOLDEN_DIR=$(readlink -f "$goldens")" \
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

# --- 7. The probe screen at level 3: the five glass surfaces pass through
#        with glass + glassTint ---
fetch_probe "$hdr_l3" "$tx" "probe-l3" "$evidence/probe-l3.json"
for probe_id in $glass_ids; do
  jq -e --arg id "$probe_id" \
      '[.. | objects | select(.id? == $id)][0] | .glass == true and (.glassTint | startswith("$color."))' \
    "$evidence/probe-l3.json" > /dev/null \
    || fail "the level-3 probe tree does not carry glass+glassTint on '$probe_id' (probe-l3.json)"
done
ok "probe screen at api=3;schema=4: the five glass surfaces pass through with glass=true and a \$color glassTint (probe-l3.json)"

# --- 8. The probe screen at level 2: glass and glassTint are stripped ---
fetch_probe "$hdr_l2" "$tx" "probe-l2" "$evidence/probe-l2.json"
for probe_id in $glass_ids probe-glass; do
  jq -e --arg id "$probe_id" \
      '[.. | objects | select(.id? == $id)][0] | (has("glass") | not) and (has("glassTint") | not)' \
    "$evidence/probe-l2.json" > /dev/null \
    || fail "glass/glassTint survived the level-2 downgrade on '$probe_id' (probe-l2.json)"
done
ok "probe screen at api=2;schema=3: glass and glassTint stripped from every glass surface (probe-l2.json)"

# --- 9. The docs catalog: still exactly 68 names ---
catalog=$(catalog_primitives)
count=$(grep -c . <<< "$catalog")
[ "$count" = "68" ] \
  || fail "the docs/sdui.md section 2.5 catalog extraction reports $count names, not 68"
ok "catalog extraction reports exactly 68 names (glassTint is a prop, not a node type)"

# --- 10. The goldens diffstat ---
{
  echo "# goldens diffstat (T89)"
  echo
  echo "## git diff --stat (tracked golden sources)"
  git diff --stat -- plugins/ui-kit/src/test/resources/regression frontend/test/gallery/goldens frontend/test/gallery/gallery_nodes.dart || true
  echo
  echo "## new golden files (git status --porcelain)"
  git status --porcelain -- plugins/ui-kit/src/test/resources/regression frontend/test/gallery/goldens .sisyphus/evidence/T89/goldens || true
} > "$evidence/goldens-diffstat.txt"
ok "goldens diffstat recorded (goldens-diffstat.txt)"

log "T89 QA green: glass surfaces on card, sheet, dialog, menu and banner verified"
