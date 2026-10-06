#!/usr/bin/env bash
# QA for T119: the golden refresh, the full-catalog gallery dump and the
# manual screenshot checklist (plan section T119; docs/sdui.md section 2.5).
#
# This is a golden/artifact todo: no kernel boots. The delivered surface is
# the regenerated golden set (ui-kit wire-JSON + committed Flutter pixel
# goldens), the full 68-name catalog gallery under evidence/T119/gallery/ and
# the operator-run screenshot checklist under evidence/T119/screens/.
#
# Happy path:
#   - records the toolchain version (flutter-version.txt, section 15.3: the
#     goldens run on the flutter_test VM target);
#   - runs the ui-kit and ui-default JVM suites (test.txt) and requires
#     BUILD SUCCESSFUL; the ui-kit suite regenerates the full-catalog gallery
#     (GalleryDump.dumpFullCatalogGallery);
#   - asserts the gallery has exactly 68 entries and that its names equal the
#     docs/sdui.md section 2.5 catalog extraction (catalog_primitives());
#   - runs the full Flutter suite (flutter-test.txt) and requires
#     "All tests passed" with the recorded test count;
#   - regenerates the committed Flutter goldens (gallery + boot) with
#     --update-goldens and asserts the tree is byte-stable (no diff);
#   - records the golden diffstat vs the pre-plan goldens
#     (golden-diffstat.txt) and the screenshot checklist presence
#     (screens/checklist.md lists all 26 section 4.2 rows).
#
# Failure path: one intentionally stale golden (a mutated copy of
# 00-screen.json) must fail UiRegressionTest; the real behavior is proven
# first, the fixture is restored, then the deliberately wrong expectation —
# "the stale golden passed" — trips (checks-fail.txt, exit non-zero).
# Usage: scripts/qa/t119.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T119. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). Uses only curl-free tooling: jq, awk, grep, git and gradle.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T119_INNER:-}" ]; then
  exec env T119_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T119}
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

# catalog_primitives: the docs/sdui.md section 2.5 primitive names (the same
# extraction every QA script uses).
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

# The pre-plan commit (the parent of the first phase-A todo, T83): the
# diffstat baseline. Guarded so a shallow checkout still records the counts.
PRE_PLAN=11dceea

# The T119 --fail fixture: a mutated copy of the first regression golden.
stale_fixture="plugins/ui-kit/src/test/resources/regression/00-screen.json"
stale_backup=""
restore_stale() {
  if [ -n "$stale_backup" ] && [ -f "$stale_backup" ]; then
    cp "$stale_backup" "$stale_fixture"
    rm -f "$stale_backup"
    stale_backup=""
  fi
}
trap restore_stale EXIT

if [ "$fail_mode" = "1" ]; then
  log "T119 QA --fail: an intentionally stale golden must fail UiRegressionTest"
  log "evidence dir: $evidence"

  [ -f "$stale_fixture" ] || fail "the regression golden $stale_fixture is missing"
  stale_backup=$(mktemp)
  cp "$stale_fixture" "$stale_backup"

  # Mutate the golden: change the screen title so the byte compare diverges.
  jq -c '.title = "STALE T119 GOLDEN"' "$stale_fixture" > "$stale_fixture.tmp"
  mv "$stale_fixture.tmp" "$stale_fixture"

  probe="$evidence/stale-golden.txt"
  if ./gradlew :jhin-plugin-ui-kit:test --rerun \
      --tests "com.astroreen.jhin.plugin.uikit.UiRegressionTest" \
      > "$probe" 2>&1; then
    restore_stale
    fail "the stale golden passed UiRegressionTest (see $probe)"
  fi
  grep -q 'UiRegressionTest' "$probe" \
    || fail "the stale-golden run did not exercise UiRegressionTest (see $probe)"
  ok "the intentionally stale golden failed UiRegressionTest (stale-golden.txt)"

  restore_stale
  # Prove the restore: the suite is green again.
  if ! ./gradlew :jhin-plugin-ui-kit:test --rerun \
      --tests "com.astroreen.jhin.plugin.uikit.UiRegressionTest" \
      > "$evidence/stale-golden-restored.txt" 2>&1; then
    fail "the restored golden still fails UiRegressionTest (see $evidence/stale-golden-restored.txt)"
  fi
  ok "the golden was restored and UiRegressionTest is green again (stale-golden-restored.txt)"

  {
    echo "FAIL: the intentionally stale golden passed UiRegressionTest (as designed)"
    echo "  the real behavior is the opposite: the mutated 00-screen.json failed the byte compare"
    echo "  the fixture was restored; UiRegressionTest is green again"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the stale golden passed UiRegressionTest (it fails; see $evidence/stale-golden.txt)"
fi

log "T119 QA: the golden refresh, the full-catalog gallery and the screenshot checklist"
log "evidence dir: $evidence"

# --- 1. The toolchain (section 15.3: the target that produced the goldens) ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "goldens produced on the flutter_test VM target ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the ui-kit suite regenerates the full gallery) ---
./gradlew :jhin-plugin-ui-kit:test --rerun :jhin-plugin-ui-default:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-kit and ui-default suites green ($test_count tests; test.txt)"

# --- 3. The full-catalog gallery: exactly 68 entries matching the docs ---
gallery="$evidence/gallery"
[ -f "$gallery/count.txt" ] \
  || fail "the gallery count.txt is missing (GalleryDump.dumpFullCatalogGallery did not run)"
gallery_count=$(tr -d '[:space:]' < "$gallery/count.txt")
[ "$gallery_count" = "68" ] \
  || fail "the gallery has $gallery_count entries, expected 68 (see $gallery/count.txt)"
catalog_primitives > "$evidence/catalog.txt"
jq -r '.[].name' "$gallery/gallery.json" | sort -u > "$evidence/gallery-names.txt"
if ! diff -q "$evidence/catalog.txt" "$evidence/gallery-names.txt" > /dev/null; then
  fail "the gallery names differ from the docs/sdui.md section 2.5 catalog (see gallery-names.txt)"
fi
ok "the full-catalog gallery has exactly 68 entries matching catalog_primitives() (gallery/)"

# --- 4. The full Flutter suite ---
bash scripts/qa/flutter-test.sh test \
  2>&1 | tee "$evidence/flutter-test.txt"
grep -q 'All tests passed' "$evidence/flutter-test.txt" \
  || fail "the Flutter suite failed (see $evidence/flutter-test.txt)"
flutter_count=$(grep -oE '\+[0-9]+' "$evidence/flutter-test.txt" | tail -n 1 | tr -d '+')
ok "the full Flutter suite is green ($flutter_count tests; flutter-test.txt)"

# --- 5. The committed Flutter goldens: regenerate and prove byte-stable ---
bash scripts/qa/flutter-test.sh test/gallery --update-goldens \
  > "$evidence/flutter-goldens-gallery.txt" 2>&1
grep -q 'All tests passed' "$evidence/flutter-goldens-gallery.txt" \
  || fail "the gallery golden regeneration failed (see $evidence/flutter-goldens-gallery.txt)"
bash scripts/qa/flutter-test.sh test/boot --update-goldens \
  > "$evidence/flutter-goldens-boot.txt" 2>&1
grep -q 'All tests passed' "$evidence/flutter-goldens-boot.txt" \
  || fail "the boot golden regeneration failed (see $evidence/flutter-goldens-boot.txt)"
if ! git diff --quiet -- frontend/test/gallery/goldens frontend/test/boot/goldens; then
  fail "the regenerated committed goldens differ from the tree (unexpected pixel drift)"
fi
ok "the committed gallery + boot goldens regenerate byte-identically (flutter-goldens-gallery.txt, flutter-goldens-boot.txt)"

# --- 6. The golden diffstat vs the pre-plan goldens ---
{
  echo "# T119 golden diffstat vs the pre-plan goldens"
  echo
  if git cat-file -e "$PRE_PLAN^{commit}" 2> /dev/null; then
    echo "pre-plan commit: $PRE_PLAN ($(git log -1 --format=%s "$PRE_PLAN"))"
    echo "current commit:  $(git rev-parse --short HEAD) ($(git log -1 --format=%s HEAD))"
    echo
    echo "## ui-kit wire-JSON regression goldens"
    git diff --stat "$PRE_PLAN" HEAD -- plugins/ui-kit/src/test/resources/regression
    echo
    echo "## committed Flutter pixel goldens"
    git diff --stat "$PRE_PLAN" HEAD -- frontend/test/gallery/goldens frontend/test/boot/goldens
    echo
    echo "## change summary by status"
    echo "ui-kit regression JSON:"
    git diff --name-status "$PRE_PLAN" HEAD -- plugins/ui-kit/src/test/resources/regression \
      | awk '{print "  "$1}' | sort | uniq -c
    echo "committed Flutter PNG:"
    git diff --name-status "$PRE_PLAN" HEAD -- frontend/test/gallery/goldens frontend/test/boot/goldens \
      | awk '{print "  "$1}' | sort | uniq -c
  else
    echo "pre-plan commit $PRE_PLAN not present in this checkout; recording counts only"
  fi
  echo
  echo "## current committed golden counts"
  echo "  ui-kit regression JSON: $(ls plugins/ui-kit/src/test/resources/regression/*.json | wc -l)"
  echo "  gallery PNG:            $(ls frontend/test/gallery/goldens/*.png | wc -l)"
  echo "  boot PNG:               $(ls frontend/test/boot/goldens/*.png | wc -l)"
  echo
  echo "## T119 regenerated evidence goldens"
  echo "  evidence PNG frames:    $(find "$evidence/goldens" -name '*.png' 2> /dev/null | wc -l)"
  echo "  evidence token dumps:   $(find "$evidence/goldens/tokens" -name '*.json' 2> /dev/null | wc -l)"
} > "$evidence/golden-diffstat.txt"
ok "golden diffstat recorded (golden-diffstat.txt)"

# --- 7. The manual screenshot checklist: all 26 section 4.2 rows ---
checklist="$evidence/screens/checklist.md"
[ -f "$checklist" ] \
  || fail "the screenshot checklist is missing (see $checklist)"
rows=$(grep -cE '^\| [0-9]+ \|' "$checklist")
[ "$rows" -ge 26 ] \
  || fail "the screenshot checklist lists $rows rows, expected at least 26 (see $checklist)"
grep -q 'checked' "$checklist" \
  || fail "the screenshot checklist has no checked-status column (see $checklist)"
ok "the screenshot checklist lists $rows section 4.2 rows with a checked-status column (screens/checklist.md)"

log "T119 QA green: goldens refreshed, the 68-entry gallery and the screenshot checklist verified"
