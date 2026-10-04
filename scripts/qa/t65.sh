#!/usr/bin/env bash
# QA for T65: the `tabs`, `segmented` and `shell` client primitives and the
# `nav` v2 surface (docs/sdui.md §2.5–§2.6).
# Usage: scripts/qa/t65.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T65. The directory is gitignored;
# the task commit stages it with `git add -f`.
#
# Happy path (exit 0):
#   - test.txt: the full frontend suite (scripts/qa/flutter-test.sh) followed
#     by ./gradlew :jhin-plugin-ui-kit:test (the ui-kit suite with the tabs/
#     segmented/shell builders and their conformance keys) — both green;
#   - missing-body.txt: the shell degrade proof (a shell without `body`
#     renders a card with "Missing body", zero exceptions — T65_MISSING_BODY);
#   - activeid-fallback.txt: the unknown-`activeId` proof (a miss falls back
#     to `activeIndex` and never crashes — T65_ACTIVEID_FALLBACK) and the
#     `collapsed` patch proof (patch to 56, patch back to 280 —
#     T65_PATCH_COLLAPSED);
#   - goldens.txt + goldens/: the golden delta transcript — zero modified
#     pre-existing baselines (git status) — and copies of the two shell
#     baselines (shell-wide.png / shell-narrow.png) with the 14 new T65
#     baselines listed;
#   - checks.txt: the ok/FAIL line log including `flutter analyze`, the
#     hardcode scan (rg 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160'
#     frontend/lib must be 0 hits) and the test/golden counts.
#
# --fail mode (exit 1): re-runs the whole flow into checks-fail.txt, then
#   trips a deliberately wrong expectation — "the shell sidebar is 300 wide"
#   must NOT hold (the evidence records sidebar=280) — recording the trip in
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

evidence=${1:-.sisyphus/evidence/T65}
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

log "T65 QA: shell, tabs, nav v2 and segmented control"
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
ok "ui-kit module suite green (the T65 builders + conformance; appended to test.txt)"

# --- 3. Missing-body degrade proof (missing-body.txt) ---
{
  echo "T65 shell degrade proof (docs/sdui.md §2.6 \`shell\`)"
  echo
  echo "A shell without \`body\` degrades to a card with the text"
  echo "\"Missing body\" — zero exceptions (acceptance 7)."
  echo
} > "$evidence/missing-body.txt"
scripts/qa/flutter-test.sh test/primitives_batch10_test.dart \
    --plain-name "missing body" >> "$evidence/missing-body.txt" 2>&1 \
  || fail "missing-body test failed (see $evidence/missing-body.txt)"
grep -q 'All tests passed!' "$evidence/missing-body.txt" \
  || fail "missing-body test did not report 'All tests passed!'"
grep -q 'T65_MISSING_BODY rendered=card text=Missing body exceptions=0' \
  "$evidence/missing-body.txt" \
  || fail "missing-body proof marker missing (see $evidence/missing-body.txt)"
ok "missing-body.txt written: a body-less shell degrades to a 'Missing body' card"

# --- 4. activeId fallback + collapsed patch proofs (activeid-fallback.txt) ---
{
  echo "T65 nav v2 / shell patch proofs (docs/sdui.md §2.6 \`nav\`, \`shell\`)"
  echo
  echo "An unknown \`activeId\` falls back to \`activeIndex\` and never"
  echo "crashes (acceptance 4). A \`patch\` frame on the shell node id flips"
  echo " \`collapsed\` to the 56 collapsed width and back to 280"
  echo "(acceptance 8)."
  echo
} > "$evidence/activeid-fallback.txt"
scripts/qa/flutter-test.sh test/primitives_batch10_test.dart \
    --plain-name "unknown activeId" >> "$evidence/activeid-fallback.txt" 2>&1 \
  || fail "activeId fallback test failed (see $evidence/activeid-fallback.txt)"
scripts/qa/flutter-test.sh test/primitives_batch10_test.dart \
    --plain-name "collapsed patches" >> "$evidence/activeid-fallback.txt" 2>&1 \
  || fail "collapsed patch test failed (see $evidence/activeid-fallback.txt)"
grep -q 'All tests passed!' "$evidence/activeid-fallback.txt" \
  || fail "proof tests did not report 'All tests passed!'"
grep -q 'T65_ACTIVEID_FALLBACK activeId=nope matched=0 fallback=activeIndex:1 crash=0' \
  "$evidence/activeid-fallback.txt" \
  || fail "activeId fallback proof marker missing (see $evidence/activeid-fallback.txt)"
grep -q 'T65_PATCH_COLLAPSED id=shell collapsed=true width=56' \
  "$evidence/activeid-fallback.txt" \
  || fail "collapsed patch proof marker missing (see $evidence/activeid-fallback.txt)"
grep -q 'T65_PATCH_COLLAPSED id=shell collapsed=false width=280' \
  "$evidence/activeid-fallback.txt" \
  || fail "collapsed patch-back proof marker missing (see $evidence/activeid-fallback.txt)"
ok "activeid-fallback.txt written: unknown activeId degrades, collapsed patches to 56 and back"

# --- 5. Golden delta transcript (goldens.txt + goldens/) ---
golden_count=$(ls frontend/test/gallery/goldens/*.png 2>/dev/null | wc -l | tr -d ' ')
new_count=$(git status --porcelain frontend/test/gallery/goldens/ | grep -c '^??' || true)
modified_count=$(git status --porcelain frontend/test/gallery/goldens/ | grep -c '^ M' || true)
mkdir -p "$evidence/goldens"
cp frontend/test/gallery/goldens/shell-wide.png "$evidence/goldens/shell-wide.png"
cp frontend/test/gallery/goldens/shell-narrow.png "$evidence/goldens/shell-narrow.png"
{
  echo "T65 golden delta (frontend/test/gallery/goldens)"
  echo
  echo "New T65 baselines were created once by:"
  echo "  scripts/qa/flutter-test.sh test/gallery --update-goldens"
  echo "  scripts/qa/flutter-test.sh test/primitives_batch10_test.dart --update-goldens"
  echo "Pre-existing baselines must stay byte-identical (0 modified)."
  echo
  echo "modified pre-existing baselines: $modified_count (want 0)"
  echo "new baselines: $new_count (12 T65 gallery fixtures x light/dark"
  echo "  + shell-wide.png + shell-narrow.png)"
  echo "total baseline PNGs: $golden_count (213 pre-existing + 14 T65)"
  echo
  echo "the two shell baselines are copied to $evidence/goldens/:"
  echo "  shell-wide.png (1200x800, sidebar 280 + header + body + detail + rail)"
  echo "  shell-narrow.png (700x800, sidebar as drawer + hamburger)"
  echo
  echo "git status --porcelain frontend/test/gallery/goldens/:"
  git status --porcelain frontend/test/gallery/goldens/
} > "$evidence/goldens.txt"
[ "$modified_count" = "0" ] \
  || fail "pre-existing golden baselines were modified (see $evidence/goldens.txt)"
[ "$new_count" = "14" ] \
  || fail "expected 14 new baselines, got $new_count (see $evidence/goldens.txt)"
[ "$golden_count" -ge 227 ] \
  || fail "expected >= 227 baseline PNGs (213 pre-existing + 14 T65), got $golden_count"
ok "goldens.txt written: 0 modified pre-existing baselines, $new_count new T65 baselines ($golden_count total)"

{
  echo
  echo "golden baselines: $golden_count ($new_count new for T65, 0 modified)"
} >> "$checks"

if [ "$fail_mode" = "1" ]; then
  # --- --fail: positive re-verification, then a deliberate wrong expectation ---
  capture=$(mktemp)
  trap 'rm -f "$capture"' EXIT
  scripts/qa/flutter-test.sh test/primitives_batch10_test.dart \
      --plain-name "wide surface" > "$capture" 2>&1 \
    || fail "shell-wide re-verification failed (see $checks)"
  grep -q 'All tests passed!' "$capture" \
    || fail "shell-wide tests did not report 'All tests passed!'"
  {
    echo
    echo "T65 shell-wide re-verification (--fail mode):"
  } >> "$checks"
  grep 'T65_SHELL_WIDE' "$capture" >> "$checks" || true
  ok "--fail proof tests passed: the wide shell sidebar is 280 wide"
  # The deliberately wrong expectation: "the shell sidebar is 300 wide".
  # The evidence records sidebar=280, so the wrong grep must miss and the
  # checker must exit non-zero.
  if grep -q 'T65_SHELL_WIDE .*sidebar=300' "$capture"; then
    fail "--fail probe: wrong expectation ('the shell sidebar is 300 wide') unexpectedly held (checker is broken)"
  fi
  printf 'wrong expectation tripped: the evidence records sidebar=280, not 300\n' \
    | tee -a "$checks"
  printf -- '--fail exit code 1 (intentional failure-path exit)\n' | tee -a "$checks"
  fail "--fail mode: intentional failure-path exit"
fi

ok "T65 QA complete (happy path)"
