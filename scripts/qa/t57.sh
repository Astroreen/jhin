#!/usr/bin/env bash
# QA for T57: golden/gesture-free render harness + primitive gallery.
# Usage: scripts/qa/t57.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T57. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - regenerates frontend/test/gallery/gallery_nodes.dart via the JVM probe
#     (./gradlew :jhin-plugin-ui-kit:test --tests '*GalleryDump*') —
#     transcript in evidence/T57/generator.txt;
#   - re-runs the probe a second time and diffs the two generated files to
#     prove it is idempotent (diff must be empty — appended to generator.txt,
#     also saved standalone as evidence/T57/idempotency.diff);
#   - copies the probe's per-primitive coverage table (written to
#     plugins/ui-kit/build/gallery/coverage.txt) to evidence/T57/coverage.txt
#     and asserts >= 84 fixtures total and all 42 current primitives present
#     with >= 1 fixture each;
#   - asserts frontend/test/gallery/goldens has >= 2 baseline PNGs;
#   - runs the gallery flutter suite (scripts/qa/flutter-test.sh test/gallery)
#     and asserts it reports "All tests passed!" — transcript in
#     evidence/T57/test.txt.
#
# --fail mode: reruns the probe/idempotency/coverage checks above, then
#   deliberately corrupts one committed baseline (overwrites the light
#   variant of the fixture-text-basic fixture with its dark counterpart —
#   the two are confirmed to render differently), reruns just that one
#   golden test (scripts/qa/flutter-test.sh test/gallery --plain-name
#   "fixture-text-basic (light)") and asserts it FAILS, copies Flutter's
#   produced diff artifact to evidence/T57/regression-diff.png, restores the
#   original baseline, and exits non-zero.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T57}
mkdir -p "$evidence"
: > "$evidence/checks.txt"

log() {
  printf '%s\n' "$*"
}

ok() {
  printf 'ok: %s\n' "$*" | tee -a "$evidence/checks.txt"
}

fail() {
  printf 'FAIL: %s\n' "$*" | tee -a "$evidence/checks.txt" >&2
  exit 1
}

log "T57 QA: golden gallery harness for the primitive catalog"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

dart_file=frontend/test/gallery/gallery_nodes.dart
coverage_src=plugins/ui-kit/build/gallery/coverage.txt

# --- 1. Regenerate the fixtures through the real Ui builders (JVM probe) ---
./gradlew :jhin-plugin-ui-kit:test --tests '*GalleryDump*' --rerun 2>&1 | tee "$evidence/generator.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/generator.txt" \
  || fail "GalleryDump probe did not report BUILD SUCCESSFUL (see $evidence/generator.txt)"
ok "GalleryDump probe green (./gradlew :jhin-plugin-ui-kit:test --tests '*GalleryDump*')"
[ -s "$dart_file" ] || fail "missing $dart_file after the probe ran"

# --- 2. Idempotency: snapshot, re-run, diff must be empty ---
snapshot=$(mktemp)
cp "$dart_file" "$snapshot"
./gradlew :jhin-plugin-ui-kit:test --tests '*GalleryDump*' --rerun >> "$evidence/generator.txt" 2>&1
if diff -u "$snapshot" "$dart_file" > "$evidence/idempotency.diff"; then
  printf '\n(idempotency check: gallery_nodes.dart is byte-identical across two probe runs — diff empty)\n' \
    >> "$evidence/generator.txt"
  ok "probe is idempotent: re-run produced a byte-identical $dart_file (diff empty)"
else
  cat "$evidence/idempotency.diff" >> "$evidence/generator.txt"
  rm -f "$snapshot"
  fail "probe is NOT idempotent: $dart_file changed between two runs (see $evidence/idempotency.diff)"
fi
rm -f "$snapshot"

# --- 3. Per-primitive coverage table ---
[ -s "$coverage_src" ] || fail "missing $coverage_src — did GalleryDump run?"
cp "$coverage_src" "$evidence/coverage.txt"

total=$(grep -m1 '^total=' "$evidence/coverage.txt" | cut -d= -f2)
primitives=$(grep -m1 '^primitives=' "$evidence/coverage.txt" | cut -d= -f2)
[ -n "$total" ] && [ "$total" -ge 84 ] \
  || fail "fixture total ($total) is below the required 84 (see $evidence/coverage.txt)"
ok "fixture total = $total (>= 84)"
[ -n "$primitives" ] && [ "$primitives" -eq 42 ] \
  || fail "primitive coverage ($primitives) != 42 current primitives (see $evidence/coverage.txt)"
ok "primitive coverage = $primitives (all 42 current primitives present)"

expected_primitives="screen nav container card text markdown rich_text code_block button input dropdown checkbox switch slider form list stream_view table divider spacer progress image figure chart_line chart_bar chart_pie drawer box row column flex expanded flexible sized_box align center aspect_ratio stack positioned wrap grid scroll"
for primitive in $expected_primitives; do
  count=$(grep -m1 "^${primitive}=" "$evidence/coverage.txt" | cut -d= -f2)
  [ -n "$count" ] && [ "$count" -ge 1 ] \
    || fail "primitive '$primitive' has no fixture in $evidence/coverage.txt"
done
ok "every one of the 42 current primitives has >= 1 fixture (coverage.txt)"

# --- 4. Golden baseline count ---
golden_count=$(ls frontend/test/gallery/goldens/*.png 2>/dev/null | wc -l | tr -d ' ')
[ "$golden_count" -ge 2 ] || fail "frontend/test/gallery/goldens has $golden_count PNGs, expected >= 2"
ok "frontend/test/gallery/goldens has $golden_count baseline PNGs"

if [ "$fail_mode" = "1" ]; then
  golden=frontend/test/gallery/goldens/fixture-text-basic-light.png
  other=frontend/test/gallery/goldens/fixture-text-basic-dark.png
  [ -f "$golden" ] && [ -f "$other" ] || fail "expected baselines missing: $golden / $other"

  backup=$(mktemp)
  cp "$golden" "$backup"
  rm -rf frontend/test/gallery/failures

  restore() {
    cp "$backup" "$golden"
    rm -f "$backup"
    rm -rf frontend/test/gallery/failures
  }
  trap restore EXIT

  # Overwrite the light baseline with the (confirmed different) dark one.
  cp "$other" "$golden"

  set +e
  scripts/qa/flutter-test.sh test/gallery --plain-name "fixture-text-basic (light)" \
    > "$evidence/test-fail.txt" 2>&1
  suite_status=$?
  set -e

  if [ "$suite_status" -eq 0 ]; then
    fail "--fail probe: the corrupted golden did not fail the suite (checker is broken) — see $evidence/test-fail.txt"
  fi
  ok "--fail probe: corrupted goldens/fixture-text-basic-light.png correctly failed the suite (see $evidence/test-fail.txt)"

  diff_png=frontend/test/gallery/failures/fixture-text-basic-light_isolatedDiff.png
  [ -s "$diff_png" ] || fail "expected diff artifact $diff_png was not produced by the failing run"
  cp "$diff_png" "$evidence/regression-diff.png"
  ok "diff artifact copied to $evidence/regression-diff.png"

  restore
  trap - EXIT

  printf 'FAIL (intentional): corrupted goldens/fixture-text-basic-light.png to prove the golden suite detects a visual regression\n' \
    | tee -a "$evidence/checks.txt"
  ok "--fail probe passed: the golden suite correctly rejects a corrupted baseline, and the original baseline was restored"
  fail "--fail mode: intentional failure-path exit"
fi

# --- 5. Happy path: the gallery suite itself must be green ---
scripts/qa/flutter-test.sh test/gallery 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "frontend gallery suite did not report 'All tests passed!' (see $evidence/test.txt)"
ok "frontend gallery suite green (scripts/qa/flutter-test.sh test/gallery; transcript in test.txt)"

log "T57 QA green: golden gallery harness for the primitive catalog verified"
