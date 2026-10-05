#!/usr/bin/env bash
# QA for T86: the client theme application — the contrast indirection, the
# runtime data switches and the primitive purity gate. Usage:
# scripts/qa/t86.sh [--fail] [evidence-dir]. Default evidence dir:
# .sisyphus/evidence/T86. Exits non-zero on the first failed assertion; a
# stuck step fails the run instead of hanging (whole-run watchdog). Pure
# client task: no kernel boot, no JVM suites (no Java changed).
#
# Happy path:
#   - runs the Flutter design suites (transcript in flutter-design.txt) and
#     the sdui suites (flutter-sdui.txt) and requires "All tests passed";
#   - sweeps the primitive sources for literal colours (`Color(0x`) and
#     literal all-sides insets (`EdgeInsets.all(`) into sweep.txt — the
#     sweep must be empty;
#   - runs the token golden test with the dump dir pointed at
#     token-goldens/ and asserts the four dumps (iris/jhin × light/dark)
#     each carry the boosted (30%) contrast palette as JSON.
#
# Failure path: a fixture primitive with a reintroduced `Color(0xFF000000)`
# is dropped into lib/sdui/primitives/, the purity test must FAIL, the
# sweep must go non-empty, and the fixture is removed again — recorded in
# checks-fail.txt.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T86_INNER:-}" ]; then
  exec env T86_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T86}
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

fixture="frontend/lib/sdui/primitives/_t86_purity_fixture.dart"
cleanup_fixture() {
  if [ -f "$fixture" ]; then
    rm -f "$fixture"
  fi
}
trap cleanup_fixture EXIT

if [ "$fail_mode" = "1" ]; then
  log "T86 QA --fail: a reintroduced literal colour must fail the purity gate"
  log "evidence dir: $evidence"

  cat > "$fixture" <<'DART'
import 'package:flutter/material.dart';

/// T86 --fail fixture: a deliberately reintroduced literal colour.
Widget t86Fixture() => ColoredBox(color: const Color(0xFF000000));
DART

  purity="$evidence/purity-fail.txt"
  if bash scripts/qa/flutter-test.sh test/sdui/primitive_purity_test.dart \
      > "$purity" 2>&1; then
    fail "the purity test passed despite the reintroduced Color(0xFF000000) (see $purity)"
  fi
  grep -q 'Some tests failed' "$purity" \
    || fail "the purity run did not report the failure (see $purity)"
  ok "the purity test failed on the fixture primitive (purity-fail.txt)"

  sweep="$evidence/sweep-fail.txt"
  grep -rn 'Color(0x\|EdgeInsets\.all(' frontend/lib/sdui/primitives/ > "$sweep" 2>&1 || true
  if [ -s "$sweep" ]; then
    ok "the sweep went non-empty on the fixture (sweep-fail.txt)"
  else
    fail "the sweep stayed empty despite the fixture primitive (see $sweep)"
  fi

  cleanup_fixture
  {
    echo "FAIL: fixture primitive with Color(0xFF000000) reintroduced the literal colour (as designed)"
    echo "  purity test: failed as required (purity-fail.txt)"
    echo "  sweep: non-empty (sweep-fail.txt)"
    echo "  fixture removed again; the tree is clean"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the fixture primitive is still in the tree (it is removed; see $evidence/sweep-fail.txt)"
fi

log "T86 QA: theme application, contrast indirection and runtime switches"
log "evidence dir: $evidence"

# --- 1. The Flutter design suites ---
bash scripts/qa/flutter-test.sh test/design 2>&1 | tee "$evidence/flutter-design.txt"
grep -q 'All tests passed' "$evidence/flutter-design.txt" \
  || fail "the Flutter design suites failed (see $evidence/flutter-design.txt)"
design_count=$(grep -oE '\+[0-9]+:' "$evidence/flutter-design.txt" | tail -1 | tr -d '+:')
ok "Flutter design suites green ($design_count tests; transcript in flutter-design.txt)"

# --- 2. The Flutter sdui suites (the purity gate lives here) ---
bash scripts/qa/flutter-test.sh test/sdui 2>&1 | tee "$evidence/flutter-sdui.txt"
grep -q 'All tests passed' "$evidence/flutter-sdui.txt" \
  || fail "the Flutter sdui suites failed (see $evidence/flutter-sdui.txt)"
ok "Flutter sdui suites green: the purity gate and the reduced-motion switch (flutter-sdui.txt)"

# --- 3. The literal-colour sweep over the primitive sources ---
sweep="$evidence/sweep.txt"
grep -rn 'Color(0x\|EdgeInsets\.all(' frontend/lib/sdui/primitives/ > "$sweep" 2>&1 || true
if [ -s "$sweep" ]; then
  fail "literal colours or insets remain in the primitives (see $sweep)"
fi
ok "no literal colour or EdgeInsets.all in frontend/lib/sdui/primitives/ (sweep.txt)"

# --- 4. The token goldens: two themes x two modes, boost 30 ---
goldens="$evidence/token-goldens"
rm -rf "$goldens"
# flutter test runs with cwd=frontend/, so the dump dir must be absolute.
bash scripts/qa/flutter-test.sh test/design/token_golden_test.dart \
  --dart-define="TOKEN_GOLDEN_DIR=$(readlink -f "$goldens")" \
  2>&1 | tee "$evidence/flutter-goldens.txt"
grep -q 'All tests passed' "$evidence/flutter-goldens.txt" \
  || fail "the token golden test failed (see $evidence/flutter-goldens.txt)"
for id in iris-light iris-dark jhin-light jhin-dark; do
  file="$goldens/token-golden-$id.json"
  [ -f "$file" ] || fail "the golden dump for $id is missing (token-goldens/)"
  jq -e '.theme == "iris-light" or .theme == "iris-dark" or .theme == "jhin-light" or .theme == "jhin-dark"' \
    "$file" > /dev/null || fail "the $id dump carries no theme id (token-goldens/)"
  jq -e '.contrastBoost == 30' "$file" > /dev/null \
    || fail "the $id dump is not the boost-30 palette (token-goldens/)"
  jq -e '.colors["contrast-foreground"] != null and .colors["contrast-border"] != null' \
    "$file" > /dev/null \
    || fail "the $id dump misses the contrast-resolved names (token-goldens/)"
done
ok "token goldens: iris/jhin x light/dark dumped with the boost-30 contrast palette (token-goldens/)"

# --- 5. The boosted foreground really moved (the acceptance spot check) ---
for id in iris-dark jhin-dark; do
  file="$goldens/token-golden-$id.json"
  fg=$(jq -r '.colors["foreground"]' "$file")
  boosted=$(jq -r '.colors["contrast-foreground"]' "$file")
  [ "$fg" != "$boosted" ] \
    || fail "the $id boosted foreground equals the raw foreground (token-goldens/)"
done
ok "the boosted contrast foreground differs from the raw palette foreground (iris-dark, jhin-dark)"

log "T86 QA green: theme application, contrast indirection and runtime switches verified"
