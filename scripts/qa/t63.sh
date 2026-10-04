#!/usr/bin/env bash
# QA for T63: the list_row/badge/chip/avatar/skeleton client primitives and
# the list v2 sections/onReorder/selection/empty surface (docs/sdui.md §2.6).
# Usage: scripts/qa/t63.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T63. The directory is gitignored;
# the task commit stages it with `git add -f`.
#
# Happy path (exit 0):
#   - test.txt: the full frontend suite (scripts/qa/flutter-test.sh) followed
#     by ./gradlew :jhin-plugin-ui-kit:test (the ui-kit suite with the five
#     new builders and their conformance keys) — both green;
#   - empty-section.txt: the empty-section proof (the section label plus the
#     list's `empty` node render) and the hidden chip delete-affordance proof
#     (`onDeleted` without an action -> no delete icon), from the T63_*
#     markers of test/primitives_batch8_test.dart;
#   - thread-row.png: the thread-row composition golden (acceptance 8),
#     copied from frontend/test/gallery/goldens/thread-row.png;
#   - goldens.txt: the golden delta transcript — zero modified pre-existing
#     baselines (git status) and the new T63 baselines listed;
#   - checks.txt: the ok/FAIL line log including `flutter analyze`, the
#     hardcode scan (rg 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160'
#     frontend/lib must be 0 hits) and the golden counts.
#
# --fail mode (exit 1): re-runs the whole flow into checks-fail.txt, then
#   trips a deliberately wrong expectation — "the empty section hides its
#   label" must NOT hold (the evidence records the label shown) — recording
#   the trip in checks-fail.txt and exiting non-zero to prove the checker
#   fails when the behavior is different.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T63}
mkdir -p "$evidence"

if [ "$fail_mode" = "1" ]; then
  checks=$evidence/checks-fail.txt
else
  checks=$evidence/checks.txt
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

log "T63 QA: list rows, sections, badges, chips, avatars and skeletons"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

# --- 0. Hardcode scan (checks.txt) ---
if rg 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160' frontend/lib \
    >> "$checks" 2>&1; then
  fail "hardcoded padding/height literals found in frontend/lib (see $checks)"
fi
ok "hardcode scan clean: rg 'EdgeInsets\\.all\\(1[12]\\)|maxHeight: 240|height: 160' frontend/lib = 0 hits"

# --- 1. flutter analyze (checks.txt) ---
if command -v flutter > /dev/null 2>&1; then
  (cd frontend && flutter analyze) >> "$checks" 2>&1 \
    || fail "flutter analyze reported issues (see $checks)"
else
  devenv shell -- bash -c 'cd frontend && flutter analyze' >> "$checks" 2>&1 \
    || fail "flutter analyze reported issues (see $checks)"
fi
ok "flutter analyze clean"

# --- 2. Full frontend suite + the ui-kit module suite (test.txt) ---
scripts/qa/flutter-test.sh 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "frontend suite did not report 'All tests passed!' (see $evidence/test.txt)"
ok "frontend suite green (scripts/qa/flutter-test.sh; transcript in test.txt)"

./gradlew :jhin-plugin-ui-kit:test --rerun 2>&1 | tee -a "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-ui-kit:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
ok "ui-kit module suite green (conformance passes with the T63 builders; appended to test.txt)"

# --- 3. Empty section + hidden chip affordance proofs (empty-section.txt) ---
{
  echo "T63 empty-section and hidden-affordance proofs (docs/sdui.md §2.6)"
  echo
  echo "A section with empty items still shows its label and renders the"
  echo "list's \`empty\` node (acceptance 6). A chip without an \`onDeleted\`"
  echo "action renders no delete affordance (acceptance 3)."
  echo
} > "$evidence/empty-section.txt"
scripts/qa/flutter-test.sh test/primitives_batch8_test.dart \
    --plain-name "empty section shows" >> "$evidence/empty-section.txt" 2>&1 \
  || fail "empty-section tests failed (see $evidence/empty-section.txt)"
scripts/qa/flutter-test.sh test/primitives_batch8_test.dart \
    --plain-name "without an action shows no delete affordance" \
    >> "$evidence/empty-section.txt" 2>&1 \
  || fail "hidden-affordance tests failed (see $evidence/empty-section.txt)"
grep -q 'All tests passed!' "$evidence/empty-section.txt" \
  || fail "proof tests did not report 'All tests passed!'"
grep -q 'T63_EMPTY_SECTION label=Section-C-shown empty-node=Nothing-here-shown' \
    "$evidence/empty-section.txt" \
  || fail "empty-section proof marker missing (see $evidence/empty-section.txt)"
grep -q 'T63_CHIP_HIDDEN affordance=absent' "$evidence/empty-section.txt" \
  || fail "hidden-affordance proof marker missing (see $evidence/empty-section.txt)"
ok "empty-section.txt written: empty section shows label + empty node, chip without onDeleted hides the delete affordance"

# --- 4. thread-row golden + golden delta transcript (thread-row.png, goldens.txt) ---
cp frontend/test/gallery/goldens/thread-row.png "$evidence/thread-row.png" \
  || fail "frontend/test/gallery/goldens/thread-row.png missing — did the golden run?"
ok "thread-row.png copied (acceptance 8 composition golden)"

golden_count=$(ls frontend/test/gallery/goldens/*.png 2>/dev/null | wc -l | tr -d ' ')
new_count=$(git status --porcelain frontend/test/gallery/goldens/ | grep -c '^??' || true)
modified_count=$(git status --porcelain frontend/test/gallery/goldens/ | grep -c '^ M' || true)
{
  echo "T63 golden delta (frontend/test/gallery/goldens)"
  echo
  echo "New T63 baselines are created once by:"
  echo "  scripts/qa/flutter-test.sh --update-goldens"
  echo "Pre-existing baselines must stay byte-identical (0 modified)."
  echo
  echo "modified pre-existing baselines: $modified_count (want 0)"
  echo "new baselines: $new_count (the 10 T63 gallery fixtures x light/dark"
  echo "  plus the thread-row golden)"
  echo "total baseline PNGs: $golden_count"
  echo
  echo "git status --porcelain frontend/test/gallery/goldens/:"
  git status --porcelain frontend/test/gallery/goldens/
} > "$evidence/goldens.txt"
[ "$modified_count" = "0" ] \
  || fail "pre-existing golden baselines were modified (see $evidence/goldens.txt)"
ok "goldens.txt written: 0 modified pre-existing baselines, $new_count new T63 baselines ($golden_count total)"

{
  echo
  echo "golden baselines: $golden_count ($new_count new for T63, 0 modified)"
} >> "$checks"

if [ "$fail_mode" = "1" ]; then
  # --- --fail: positive re-verification, then a deliberate wrong expectation ---
  capture=$(mktemp)
  trap 'rm -f "$capture"' EXIT
  scripts/qa/flutter-test.sh test/primitives_batch8_test.dart \
      --plain-name "empty section shows" > "$capture" 2>&1 \
    || fail "empty-section re-verification failed (see $checks)"
  grep -q 'All tests passed!' "$capture" \
    || fail "empty-section tests did not report 'All tests passed!'"
  {
    echo
    echo "T63 empty-section re-verification (--fail mode):"
  } >> "$checks"
  grep 'T63_EMPTY_SECTION' "$capture" >> "$checks" || true
  ok "--fail proof tests passed: empty section shows its label and the empty node"
  # The deliberately wrong expectation: "an empty section hides its label".
  # The evidence records the label shown, so the wrong grep must miss and the
  # checker must exit non-zero.
  if grep -q 'T63_EMPTY_SECTION label=Section-C-hidden' "$capture"; then
    fail "--fail probe: wrong expectation ('the empty section hides its label') unexpectedly held (checker is broken)"
  fi
  printf 'wrong expectation tripped: the evidence records label=Section-C-shown, not hidden\n' \
    | tee -a "$checks"
  printf -- '--fail exit code 1 (intentional failure-path exit)\n' | tee -a "$checks"
  fail "--fail mode: intentional failure-path exit"
fi

printf 'happy exit code 0\n' | tee -a "$checks"
log "T63 QA green: list rows, sections, badges, chips, avatars and skeletons verified"
