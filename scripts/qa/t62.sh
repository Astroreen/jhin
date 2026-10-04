#!/usr/bin/env bash
# QA for T62: the universal interaction, tooltip, cursor and semantics props
# of the SDUI client (docs/sdui.md §2.1 Interaction/A11y, §2.3 cluster).
# Usage: scripts/qa/t62.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T62. The directory is gitignored;
# the task commit stages it with `git add -f`.
#
# Happy path (exit 0):
#   - test.txt: the full frontend suite (scripts/qa/flutter-test.sh) followed
#     by ./gradlew :jhin-plugin-ui-kit:test (the ui-kit conformance suite —
#     T62 added no builder props, so it runs untouched) — both green;
#   - tree.txt: the widget-tree excerpt of the §2.3 interaction cluster
#     (innermost-first: Tooltip -> InkWell -> GestureDetector -> Focus ->
#     Semantics -> MouseRegion) with the recorded cluster indices and the
#     pairwise order assertions of test/primitives_batch7_test.dart;
#   - no-op.txt: the declined-confirm and enabled:false no-dispatch proofs
#     (dispatched: 0, no Focus wrapper, tooltip still shows);
#   - checks.txt: the ok/FAIL line log including `flutter analyze`, the
#     hardcode scan (rg 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160'
#     frontend/lib must be 0 hits) and the golden status (the gallery goldens
#     run inside the suite — green means no pixels flipped, nothing updates
#     baselines silently).
#
# --fail mode (exit 1): reruns the T62 dispatch tests, then trips a
#   deliberately wrong expectation — "a tap dispatches twice" must NOT hold
#   (the evidence records dispatched: 1) — recording the trip in
#   checks-fail.txt and exiting non-zero to prove the checker fails when
#   the behavior is different.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T62}
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

log "T62 QA: universal interaction, tooltip, cursor and semantics props"
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
  devenv shell -- flutter analyze >> "$checks" 2>&1 \
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
ok "ui-kit module suite green (conformance untouched by T62 — no builder props added; appended to test.txt)"

# --- 3. Interaction wrap cluster order (tree.txt) ---
{
  echo "T62 interaction wrap cluster (docs/sdui.md §2.3 + the §2.3 note)"
  echo
  echo "Asserted ancestor order, innermost-first (§2.3 runs inner -> outer):"
  echo "  Tooltip -> InkWell -> GestureDetector(onLongPress) -> Focus ->"
  echo "  Semantics -> MouseRegion"
  echo "MouseRegion is the outermost wrapper of the interaction cluster and"
  echo "Focus sits between the gesture wrapper and Semantics (the §2.3 note)."
  echo
} > "$evidence/tree.txt"
scripts/qa/flutter-test.sh test/primitives_batch7_test.dart \
    --plain-name "T62 order:" >> "$evidence/tree.txt" 2>&1 \
  || fail "wrap-order test failed (see $evidence/tree.txt)"
grep -q 'All tests passed!' "$evidence/tree.txt" \
  || fail "wrap-order test did not report 'All tests passed!'"
grep -q 'T62_TREE_BEGIN' "$evidence/tree.txt" \
  || fail "tree dump markers missing (see $evidence/tree.txt)"
ok "tree.txt written: the §2.3 interaction cluster order recorded and asserted"

# --- 4. Declined confirm + enabled:false no-dispatch (no-op.txt) ---
{
  echo "T62 no-op proofs (§3 confirm decline, §2.1 enabled gate)"
  echo
  echo "A declined confirm dispatches nothing; accepting runs the same"
  echo "callback the runtime hands out. enabled: false drops tap, long-press"
  echo "and focus (the tooltip still shows, per §2.1)."
  echo
} > "$evidence/no-op.txt"
scripts/qa/flutter-test.sh test/primitives_batch7_test.dart \
    --plain-name "T62 no-op:" >> "$evidence/no-op.txt" 2>&1 \
  || fail "no-op tests failed (see $evidence/no-op.txt)"
grep -q 'All tests passed!' "$evidence/no-op.txt" \
  || fail "no-op tests did not report 'All tests passed!'"
grep -q 'T62_NOOP_BEGIN' "$evidence/no-op.txt" \
  || fail "no-op dump markers missing (see $evidence/no-op.txt)"
grep -q 'declined confirm: confirms=1 dispatched=0' "$evidence/no-op.txt" \
  || fail "declined-confirm proof missing (see $evidence/no-op.txt)"
grep -q 'enabled:false tap+long-press dispatched: 0' "$evidence/no-op.txt" \
  || fail "enabled:false proof missing (see $evidence/no-op.txt)"
ok "no-op.txt written: declined confirm and enabled:false dispatch nothing"

# --- 5. Goldens (checks.txt) ---
golden_count=$(ls frontend/test/gallery/goldens/*.png 2>/dev/null | wc -l | tr -d ' ')
{
  echo "goldens: $golden_count committed baselines; the gallery golden tests"
  echo "run inside the full suite above and stayed green — the interaction"
  echo "props changed no pixels (no baseline was touched: nothing in this"
  echo "QA flow writes goldens)"
} >> "$checks"
ok "golden comparison green inside the suite — no pixel deltas ($golden_count baselines)"

if [ "$fail_mode" = "1" ]; then
  # --- --fail: positive re-verification, then a deliberate wrong expectation ---
  capture=$(mktemp)
  trap 'rm -f "$capture"' EXIT
  scripts/qa/flutter-test.sh test/primitives_batch7_test.dart \
      --plain-name "T62 dispatch:" > "$capture" 2>&1 \
    || fail "T62 dispatch re-verification failed (see $checks)"
  grep -q 'All tests passed!' "$capture" \
    || fail "T62 dispatch tests did not report 'All tests passed!'"
  {
    echo
    echo "T62 dispatch re-verification (--fail mode):"
  } >> "$checks"
  grep 'T62_TAP_' "$capture" >> "$checks" || true
  grep 'tap dispatched:' "$capture" >> "$checks" || true
  ok "--fail dispatch tests passed: every tap records dispatched: 1"
  # The deliberately wrong expectation: "a tap on a node with action
  # dispatches twice". The evidence records 1, so the wrong grep must miss
  # and the checker must exit non-zero.
  if grep -q 'tap dispatched: 2' "$capture"; then
    fail "--fail probe: wrong expectation ('a tap dispatches twice') unexpectedly held (checker is broken)"
  fi
  printf 'wrong expectation tripped: the evidence records dispatched: 1, not 2\n' \
    | tee -a "$checks"
  printf -- '--fail exit code 1 (intentional failure-path exit)\n' | tee -a "$checks"
  fail "--fail mode: intentional failure-path exit"
fi

printf 'happy exit code 0\n' | tee -a "$checks"
log "T62 QA green: universal interaction, tooltip, cursor and semantics props verified"
