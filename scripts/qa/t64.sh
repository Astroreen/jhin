#!/usr/bin/env bash
# QA for T64: the menu/sheet/dialog/banner client primitives and the dialog
# directive `kind` (docs/sdui.md §2.5–§2.6).
# Usage: scripts/qa/t64.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T64. The directory is gitignored;
# the task commit stages it with `git add -f`.
#
# Happy path (exit 0):
#   - test.txt: the full frontend suite (scripts/qa/flutter-test.sh) followed
#     by ./gradlew :jhin-plugin-ui-kit:test (the ui-kit suite with the four
#     new builders and their conformance keys) — both green;
#   - menu-tree.txt: the widget-tree excerpt of the open menu incl. its 4
#     items, from the T64_MENU_TREE markers of test/primitives_batch9_test.dart;
#   - degrade.txt: the unknown-dialog-kind proof (kind "nope" renders the
#     content as a card, zero exceptions — T64_UNKNOWN_KIND) and the narrow
#     menu variant proof (below the breakpoint the items open as a bottom
#     sheet and still dispatch — T64_NARROW_MENU);
#   - goldens.txt: the golden delta transcript — zero modified pre-existing
#     baselines (git status) and the new T64 baselines listed (the 8 new
#     gallery fixtures x light/dark);
#   - checks.txt: the ok/FAIL line log including `flutter analyze`, the
#     hardcode scan (rg 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160'
#     frontend/lib must be 0 hits) and the golden counts.
#
# --fail mode (exit 1): re-runs the whole flow into checks-fail.txt, then
#   trips a deliberately wrong expectation — "the open menu shows 5 items"
#   must NOT hold (the evidence records items=4) — recording the trip in
#   checks-fail.txt and exiting non-zero to prove the checker fails when the
#   behavior is different.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T64}
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

log "T64 QA: menu, sheet, dialog node and banner primitives"
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
ok "ui-kit module suite green (conformance passes with the T64 builders; appended to test.txt)"

# --- 3. Open-menu tree with its 4 items (menu-tree.txt) ---
{
  echo "T64 open-menu widget tree excerpt (docs/sdui.md §2.6 \`menu\`)"
  echo
  echo "The trigger tap opens the popup with exactly 4 items: two action"
  echo "items (one \`danger\`+\`confirm\`), one \`disabled\` entry and one"
  echo "\`divider\` entry (acceptance 1)."
  echo
} > "$evidence/menu-tree.txt"
scripts/qa/flutter-test.sh test/primitives_batch9_test.dart \
    --plain-name "exactly 4 items" >> "$evidence/menu-tree.txt" 2>&1 \
  || fail "menu-tree tests failed (see $evidence/menu-tree.txt)"
grep -q 'All tests passed!' "$evidence/menu-tree.txt" \
  || fail "menu-tree tests did not report 'All tests passed!'"
grep -q 'T64_MENU_TREE_BEGIN' "$evidence/menu-tree.txt" \
  || fail "menu-tree markers missing (see $evidence/menu-tree.txt)"
grep -q 'T64_MENU_TREE_END' "$evidence/menu-tree.txt" \
  || fail "menu-tree markers missing (see $evidence/menu-tree.txt)"
grep -q 'T64_MENU_TREE items=4 entries=4 labels=Open|Delete|Disabled|divider' \
  "$evidence/menu-tree.txt" \
  || fail "menu-tree 4-item marker missing (see $evidence/menu-tree.txt)"
grep -q 'item\[3\]' "$evidence/menu-tree.txt" \
  || fail "menu-tree excerpt is missing its fourth item (see $evidence/menu-tree.txt)"
ok "menu-tree.txt written: the open menu tree excerpt with its 4 items"

# --- 4. Degrades: unknown dialog kind + narrow menu variant (degrade.txt) ---
{
  echo "T64 degrade proofs (docs/sdui.md §2.4, plan T64 failure path)"
  echo
  echo "An unknown \`dialog\` directive kind degrades to a \`card\` render of"
  echo "the content with zero exceptions. Below the \`menu\` breakpoint the"
  echo "items open as a bottom sheet and still dispatch."
  echo
} > "$evidence/degrade.txt"
scripts/qa/flutter-test.sh test/primitives_batch9_test.dart \
    --plain-name "unknown kind" >> "$evidence/degrade.txt" 2>&1 \
  || fail "unknown-kind degrade test failed (see $evidence/degrade.txt)"
scripts/qa/flutter-test.sh test/primitives_batch9_test.dart \
    --plain-name "below the breakpoint" >> "$evidence/degrade.txt" 2>&1 \
  || fail "narrow menu test failed (see $evidence/degrade.txt)"
grep -q 'All tests passed!' "$evidence/degrade.txt" \
  || fail "degrade proof tests did not report 'All tests passed!'"
grep -q 'T64_UNKNOWN_KIND kind=nope rendered=card exceptions=0' \
  "$evidence/degrade.txt" \
  || fail "unknown-kind proof marker missing (see $evidence/degrade.txt)"
grep -q 'T64_NARROW_MENU width=400 breakpoint=900 variant=bottom-sheet items=4 dispatched=1' \
  "$evidence/degrade.txt" \
  || fail "narrow-menu proof marker missing (see $evidence/degrade.txt)"
ok "degrade.txt written: unknown kind falls back to card, narrow menu opens as a bottom sheet"

# --- 5. Golden delta transcript (goldens.txt) ---
golden_count=$(ls frontend/test/gallery/goldens/*.png 2>/dev/null | wc -l | tr -d ' ')
new_count=$(git status --porcelain frontend/test/gallery/goldens/ | grep -c '^??' || true)
modified_count=$(git status --porcelain frontend/test/gallery/goldens/ | grep -c '^ M' || true)
{
  echo "T64 golden delta (frontend/test/gallery/goldens)"
  echo
  echo "New T64 baselines are created once by:"
  echo "  scripts/qa/flutter-test.sh test/gallery --update-goldens"
  echo "Pre-existing baselines must stay byte-identical (0 modified)."
  echo
  echo "modified pre-existing baselines: $modified_count (want 0)"
  echo "new baselines: $new_count (the 8 T64 gallery fixtures x light/dark)"
  echo "total baseline PNGs: $golden_count"
  echo
  echo "git status --porcelain frontend/test/gallery/goldens/:"
  git status --porcelain frontend/test/gallery/goldens/
} > "$evidence/goldens.txt"
[ "$modified_count" = "0" ] \
  || fail "pre-existing golden baselines were modified (see $evidence/goldens.txt)"
[ "$golden_count" -ge 213 ] \
  || fail "expected >= 213 baseline PNGs (197 pre-existing + 16 T64), got $golden_count"
ok "goldens.txt written: 0 modified pre-existing baselines, $new_count new T64 baselines ($golden_count total)"

{
  echo
  echo "golden baselines: $golden_count ($new_count new for T64, 0 modified)"
} >> "$checks"

if [ "$fail_mode" = "1" ]; then
  # --- --fail: positive re-verification, then a deliberate wrong expectation ---
  capture=$(mktemp)
  trap 'rm -f "$capture"' EXIT
  scripts/qa/flutter-test.sh test/primitives_batch9_test.dart \
      --plain-name "exactly 4 items" > "$capture" 2>&1 \
    || fail "menu-tree re-verification failed (see $checks)"
  grep -q 'All tests passed!' "$capture" \
    || fail "menu-tree tests did not report 'All tests passed!'"
  {
    echo
    echo "T64 menu-tree re-verification (--fail mode):"
  } >> "$checks"
  grep 'T64_MENU_TREE' "$capture" >> "$checks" || true
  ok "--fail proof tests passed: the open menu shows its 4 items"
  # The deliberately wrong expectation: "the open menu shows 5 items".
  # The evidence records items=4, so the wrong grep must miss and the
  # checker must exit non-zero.
  if grep -q 'T64_MENU_TREE items=5' "$capture"; then
    fail "--fail probe: wrong expectation ('the open menu shows 5 items') unexpectedly held (checker is broken)"
  fi
  printf 'wrong expectation tripped: the evidence records items=4, not 5\n' \
    | tee -a "$checks"
  printf -- '--fail exit code 1 (intentional failure-path exit)\n' | tee -a "$checks"
  fail "--fail mode: intentional failure-path exit"
fi

printf 'happy exit code 0\n' | tee -a "$checks"
log "T64 QA green: menu, sheet, dialog node and banner primitives verified"
