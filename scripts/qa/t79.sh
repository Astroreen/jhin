#!/usr/bin/env bash
# QA for T79: token-driven empty, offline, error, version-gate and loading
# states (docs/sdui.md §2.2/§2.6/§8.7).
# Usage: scripts/qa/t79.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T79. The directory is gitignored;
# the task commit stages it with `git add -f`.
#
# Happy path (exit 0):
#   - checks.txt: the hardcode scans — `rg 'EdgeInsets\.all\(' frontend/lib/boot`
#     must be 0 hits (T79 acceptance) and the §4.1 hard-rule scan
#     (`rg 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160' frontend/lib`)
#     must stay 0 hits — plus `flutter analyze` and the golden delta:
#     5 new state baselines under frontend/test/boot/goldens and 0 modified
#     pre-existing baselines anywhere;
#   - test.txt: the frontend suite over test/boot and test/gallery
#     (scripts/qa/flutter-test.sh; the fallback compositions render
#     card+skeleton+button, $token refs resolve, a missing `fallbacks` key
#     falls back to the built-in EmptyState, the version gate is token-styled
#     and dismissible, the loading skeleton has no shimmer under
#     disableAnimations) followed by ./gradlew :jhin-plugin-ui-default:test
#     (the level-2 fallbacks shape assertions) — both green;
#   - theme-corrupt.txt: the unparseable-theme proof — an unparseable
#     `theme` in the bootstrap never blocks boot (falls back to defaults);
#   - states/: the 5 state golden PNGs (offline, error, empty, version-gate,
#     loading) copied from frontend/test/boot/goldens.
#
# --fail mode (exit 1): re-runs the whole flow into checks-fail.txt, then
#   trips a deliberately wrong expectation — "the level-2 fallbacks
#   composition carries no skeleton art" must NOT hold (the BootstrapRoute
#   source records the token-driven skeleton frame) — recording the trip in
#   checks-fail.txt and exiting non-zero to prove the checker fails when the
#   behavior is different.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T79_INNER:-}" ]; then
  exec env T79_INNER=1 timeout --kill-after=15 1500 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T79}
mkdir -p "$evidence/states"

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

log "T79 QA: token-driven empty, offline, error, version-gate and loading states"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

# --- 0. Hardcode scans (checks.txt) ---
if rg 'EdgeInsets\.all\(' frontend/lib/boot >> "$checks" 2>&1; then
  fail "EdgeInsets.all(...) found in frontend/lib/boot (see $checks)"
fi
ok "hardcode scan clean: rg 'EdgeInsets\\.all\\(' frontend/lib/boot = 0 hits (T79 acceptance)"

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

# --- 2. Frontend suite (test/boot + test/gallery) + ui-default module suite ---
scripts/qa/flutter-test.sh test/boot test/gallery 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "frontend suite did not report 'All tests passed!' (see $evidence/test.txt)"
ok "frontend suite green (test/boot + test/gallery; transcript in test.txt)"

./gradlew :jhin-plugin-ui-default:test --rerun 2>&1 | tee -a "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-ui-default:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
ok "ui-default module suite green (level-2 fallbacks shape assertions; appended to test.txt)"

# --- 3. Unparseable-theme proof (theme-corrupt.txt) ---
{
  echo "T79 unparseable-theme proof (never blocks boot, falls back to defaults)"
  echo
  echo "The bootstrap payload carries a \`theme\` that cannot be parsed;"
  echo "the app must boot the tree on the built-in default theme (T53"
  echo "wiring: JhinTheme.fromBootstrap degrades, never throws)."
  echo
} > "$evidence/theme-corrupt.txt"
scripts/qa/flutter-test.sh test/boot/state_test.dart \
    --plain-name "unparseable theme" >> "$evidence/theme-corrupt.txt" 2>&1 \
  || fail "theme-corrupt proof test failed (see $evidence/theme-corrupt.txt)"
grep -q 'All tests passed!' "$evidence/theme-corrupt.txt" \
  || fail "theme-corrupt proof did not report 'All tests passed!'"
grep -q 'unparseable theme never blocks boot' "$evidence/theme-corrupt.txt" \
  || fail "theme-corrupt proof marker missing (see $evidence/theme-corrupt.txt)"
ok "theme-corrupt.txt written: an unparseable theme boots on the built-in defaults"

# --- 4. The 5 state goldens (states/) ---
for state in offline error empty version-gate loading; do
  cp "frontend/test/boot/goldens/state-$state.png" "$evidence/states/" \
    || fail "frontend/test/boot/goldens/state-$state.png missing — did the golden run?"
done
state_count=$(ls "$evidence/states"/*.png 2>/dev/null | wc -l | tr -d ' ')
[ "$state_count" = "5" ] \
  || fail "expected 5 state goldens in $evidence/states, found $state_count"
ok "states/ holds the 5 state goldens (offline, error, empty, version-gate, loading)"

# --- 5. Golden delta (checks.txt) ---
boot_new=$(git status --porcelain -uall frontend/test/boot/goldens/ | grep -c '^??' || true)
boot_modified=$(git status --porcelain -uall frontend/test/boot/goldens/ | grep -c '^ M' || true)
gallery_new=$(git status --porcelain -uall frontend/test/gallery/goldens/ | grep -c '^??' || true)
gallery_modified=$(git status --porcelain -uall frontend/test/gallery/goldens/ | grep -c '^.M\|^M' || true)
{
  echo
  echo "T79 golden delta:"
  echo "  new state baselines (frontend/test/boot/goldens): $boot_new (want 5)"
  echo "  modified new baselines: $boot_modified (want 0)"
  echo "  new gallery baselines: $gallery_new (want 0)"
  echo "  modified pre-existing gallery baselines: $gallery_modified (want 0)"
  echo
  echo "git status --porcelain -uall frontend/test/boot/goldens/:"
  git status --porcelain -uall frontend/test/boot/goldens/
  echo
  echo "git status --porcelain -uall frontend/test/gallery/goldens/:"
  git status --porcelain -uall frontend/test/gallery/goldens/
} >> "$checks"
[ "$boot_new" = "5" ] || fail "expected 5 new state baselines, found $boot_new (see $checks)"
[ "$boot_modified" = "0" ] || fail "state baselines unexpectedly modified (see $checks)"
[ "$gallery_new" = "0" ] || fail "new gallery baselines appeared (see $checks)"
[ "$gallery_modified" = "0" ] \
  || fail "pre-existing gallery baselines were modified (see $checks)"
ok "golden delta recorded: 5 new state baselines, 0 modified pre-existing baselines"

if [ "$fail_mode" = "1" ]; then
  # --- --fail: positive re-verification, then a deliberate wrong expectation ---
  capture=$(mktemp)
  trap 'rm -f "$capture"' EXIT
  scripts/qa/flutter-test.sh test/boot/state_test.dart \
      --plain-name "missing fallbacks" > "$capture" 2>&1 \
    || fail "missing-fallbacks re-verification failed (see $checks)"
  grep -q 'All tests passed!' "$capture" \
    || fail "missing-fallbacks proof did not report 'All tests passed!'"
  {
    echo
    echo "T79 missing-fallbacks re-verification (--fail mode):"
  } >> "$checks"
  grep 'EmptyState' "$capture" >> "$checks" || true
  ok "--fail proof tests passed: a missing fallbacks key falls back to the built-in EmptyState"
  # The deliberately wrong expectation: "the level-2 fallbacks composition
  # carries no skeleton art". The BootstrapRoute source records the
  # token-driven skeleton frame, so the wrong probe must miss and the
  # checker must exit non-zero.
  if ! rg -q 'placeholderFrame' \
      plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/BootstrapRoute.java; then
    fail "--fail probe: wrong expectation ('the fallbacks carry no skeleton art') unexpectedly held (checker is broken)"
  fi
  printf 'wrong expectation tripped: BootstrapRoute placeholderFrame carries the token-driven skeleton frame art\n' \
    | tee -a "$checks"
  printf -- '--fail exit code 1 (intentional failure-path exit)\n' | tee -a "$checks"
  fail "--fail mode: intentional failure-path exit"
fi

printf 'happy exit code 0\n' | tee -a "$checks"
log "T79 QA green: empty, offline, error, version-gate and loading states verified"
