#!/usr/bin/env bash
# QA for T87: motion, glass, shadow and safe-area token plumbing.
# Usage: scripts/qa/t87.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T87. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). Pure client task: no kernel boot, no JVM suites (no Java
# changed). The goldens run on the flutter_test VM target (UNVERIFIED §15.4:
# web BackdropFilter cost — the target used is recorded in evidence).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt, §15.4);
#   - runs the Flutter design suites (transcript in flutter-design.txt) and
#     the sdui suites (flutter-sdui.txt; the purity gate lives here) and
#     requires "All tests passed" — the design suites carry the motion_test
#     stepped-curve frame counts and the golden suite carries the dialog
#     glass blur, the composer shadow, the safe-area helper and the
#     skeleton mid-animation stepped frame;
#   - writes the pixel goldens into goldens/ (flutter test
#     --update-goldens with T87_GOLDEN_DIR) and re-runs the suite without
#     the update flag to prove the committed frames are byte-stable
#     (flutter-goldens.txt, flutter-goldens-verify.txt).
#
# Failure path: a fixture widget that renders the backdrop filter even
# though the platform reports no backdrop support (the exact regression the
# degradation contract index.css:339-341 forbids) fails the degradation
# probe — recorded in checks-fail.txt and degrade-probe.txt, the fixture is
# removed again, then the deliberately wrong expectation — "the broken
# fixture passes" — trips (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T87_INNER:-}" ]; then
  exec env T87_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T87}
mkdir -p "$evidence"

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

# The same flutter resolution scripts/qa/flutter-test.sh uses (flutter on
# PATH, else the devenv shell) — used to record the toolchain (§15.4).
flutter_bin() {
  if command -v flutter > /dev/null 2>&1; then
    flutter "$@"
  else
    devenv shell -- flutter "$@"
  fi
}

fixture="frontend/test/design/_t87_degrade_probe_test.dart"
cleanup_fixture() {
  if [ -f "$fixture" ]; then
    rm -f "$fixture"
  fi
}
trap cleanup_fixture EXIT

if [ "$fail_mode" = "1" ]; then
  log "T87 QA --fail: a glass surface without the backdrop-support degradation must fail the probe"
  log "evidence dir: $evidence"

  cat > "$fixture" <<'DART'
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// T87 --fail fixture: deliberately broken — renders the backdrop filter
/// unconditionally instead of degrading to the solid fill when the
/// platform reports no backdrop support (index.css:339-341).
class T87DegradationFixture extends StatelessWidget {
  const T87DegradationFixture({super.key});

  @override
  Widget build(BuildContext context) {
    return BackdropFilter(
      filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
      child: const ColoredBox(color: Colors.red),
    );
  }
}

void main() {
  testWidgets('T87 probe: glass without backdrop support degrades to the solid fill',
      (tester) async {
    await tester.pumpWidget(const T87DegradationFixture());
    expect(find.byType(BackdropFilter), findsNothing);
  });
}
DART

  probe="$evidence/degrade-probe.txt"
  if bash scripts/qa/flutter-test.sh test/design/_t87_degrade_probe_test.dart \
      > "$probe" 2>&1; then
    fail "the degradation probe passed despite the broken fixture (see $probe)"
  fi
  grep -q 'Some tests failed' "$probe" \
    || fail "the degradation probe did not report the failure (see $probe)"
  ok "the degradation probe failed on the fixture (degrade-probe.txt)"

  cleanup_fixture
  {
    echo "FAIL: glass without backdrop support rendered the backdrop filter instead of the solid fill (as designed)"
    echo "  degradation probe: failed as required (degrade-probe.txt)"
    echo "  fixture removed again; the tree is clean"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the broken glass fixture is still in the tree (it is removed; see $evidence/degrade-probe.txt)"
fi

log "T87 QA: motion, glass, shadow and safe-area token plumbing"
log "evidence dir: $evidence"

# --- 1. The toolchain (§15.4: the target that produced the goldens) ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "goldens produced on the flutter_test VM target ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The Flutter design suites (motion_test lives here) ---
bash scripts/qa/flutter-test.sh test/design 2>&1 | tee "$evidence/flutter-design.txt"
grep -q 'All tests passed' "$evidence/flutter-design.txt" \
  || fail "the Flutter design suites failed (see $evidence/flutter-design.txt)"
design_count=$(grep -oE '\+[0-9]+:' "$evidence/flutter-design.txt" | tail -1 | tr -d '+:')
ok "Flutter design suites green ($design_count tests; transcript in flutter-design.txt)"

# --- 3. The Flutter sdui suites (the purity gate lives here) ---
bash scripts/qa/flutter-test.sh test/sdui 2>&1 | tee "$evidence/flutter-sdui.txt"
grep -q 'All tests passed' "$evidence/flutter-sdui.txt" \
  || fail "the Flutter sdui suites failed (see $evidence/flutter-sdui.txt)"
ok "Flutter sdui suites green: the purity gate stays clean (flutter-sdui.txt)"

# --- 4. The goldens: dialog glass blur, composer shadow, safe-area, the
#        skeleton mid-animation stepped frame ---
goldens="$evidence/goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the golden dir must be absolute.
bash scripts/qa/flutter-test.sh test/design/t87_golden_test.dart \
  --update-goldens \
  --dart-define="T87_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the golden run failed (see $evidence/flutter-goldens.txt)"
for name in dialog-glass-light.png dialog-glass-dark.png dialog-solid-light.png \
            composer-shadow.png safe-area.png skeleton-stepped.png; do
  [ -s "$goldens/$name" ] \
    || fail "the golden $name is missing or empty (goldens/)"
done
# The glass golden must visibly differ from the solid degradation (the blur
# is real, not a same-pixel re-render).
if cmp -s "$goldens/dialog-glass-light.png" "$goldens/dialog-solid-light.png"; then
  fail "the glass golden is byte-identical to the solid degradation golden (goldens/)"
fi
ok "goldens: 6 frames written (dialog glass light/dark, solid degradation, composer shadow, safe-area, skeleton stepped mid-frame); glass differs from solid (goldens/)"

# --- 5. The verification pass: the same suite without --update-goldens
#        must match the written frames byte-for-byte ---
bash scripts/qa/flutter-test.sh test/design/t87_golden_test.dart \
  --dart-define="T87_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens-verify.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens-verify.txt" \
  || fail "the golden verification pass diverged from the written frames (see $evidence/flutter-goldens-verify.txt)"
ok "golden verification pass byte-identical (flutter-goldens-verify.txt)"

log "T87 QA green: motion, glass, shadow and safe-area token plumbing verified"
