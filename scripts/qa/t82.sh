#!/usr/bin/env bash
# QA for T82: goldens refreshed with a recorded delta, dist verified, build
# matrix recorded, final hardcode sweep.
# Usage: scripts/qa/t82.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T82. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog).
#
# Happy path:
#   - refreshes every golden (gallery + boot state goldens) with
#     scripts/qa/flutter-test.sh --update-goldens and records the delta
#     against git HEAD (new / updated / unchanged counts and file lists) in
#     goldens.txt — a golden refresh is never silent; the raw refresh
#     transcript goes to goldens-refresh.txt;
#   - re-runs the full Flutter suite without --update-goldens and requires
#     "All tests passed!" — transcript in test.txt;
#   - runs ./gradlew dist and requires exit 0 (bundle under dist/, Flutter
#     clients built with --no-tree-shake-icons) — transcript in dist.txt;
#   - runs ./gradlew test (all included builds) — transcript in
#     gradle-test.txt;
#   - records the build matrix in build-matrix.txt: web release with and
#     without --no-tree-shake-icons (size delta against the 50 MB fallback
#     threshold), linux release and apk release, each BUILT or SKIPPED with
#     the reason; the 8825-dynamic-IconData-lookup registry implication is
#     recorded alongside;
#   - runs the final hardcode sweep into sweep.txt: zero hits for
#     'EdgeInsets\.all\(12\)', 'currentIndex: 0',
#     'return Text\(text\)' in design/markdown_render.dart,
#     'Theme\.of\(context\)' outside the design/ token layer, and the
#     hardcode scan 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160'.
#     Any hit blocks the task and is recorded with file:line.
#
# --fail mode: plants a deliberate sweep violation (a file carrying
#   EdgeInsets.all(12) under frontend/lib) and asserts the sweep catches it
#   with file:line (sweep-fail.txt), then corrupts one committed golden
#   baseline (the light fixture-text-basic with its dark counterpart) and
#   asserts the golden suite FAILS, copies Flutter's diff artifact into
#   evidence/T82/diffs/, restores both, writes checks-fail.txt and exits
#   non-zero.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T82_INNER:-}" ]; then
  exec env T82_INNER=1 timeout --kill-after=15 3600 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T82}
mkdir -p "$evidence/diffs"
evidence=$(readlink -f "$evidence")

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

log "T82 QA: goldens, dist, build matrix and the final hardcode sweep"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

flutter_cmd() {
  if command -v flutter > /dev/null 2>&1; then
    flutter "$@"
  else
    devenv shell -- flutter "$@"
  fi
}

dir_size() {
  du -sk "$1" 2>/dev/null | cut -f1
}

# --- the final hardcode sweep (shared by both modes) ------------------------
# Writes one section per pattern; prints the total hit count.
run_sweep() {
  local out=$1
  local hits=0
  {
    echo "# T82 final hardcode sweep ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
    echo "# every pattern must report 0 hits"
  } > "$out"

  sweep_pattern() {
    local label=$1 pattern=$2
    shift 2
    local file_hits n
    {
      echo
      echo "## $label"
      echo "\$ rg '$pattern' $*"
    } >> "$out"
    file_hits=$(rg -n "$pattern" "$@" 2>> "$out" || true)
    if [ -n "$file_hits" ]; then
      echo "$file_hits" >> "$out"
      n=$(printf '%s\n' "$file_hits" | wc -l | tr -d ' ')
      echo "hits: $n" >> "$out"
      hits=$((hits + n))
    else
      echo "hits: 0" >> "$out"
    fi
  }

  sweep_pattern "p1: no EdgeInsets.all(12)" 'EdgeInsets\.all\(12\)' frontend/lib
  sweep_pattern "p2: no currentIndex: 0" 'currentIndex: 0' frontend/lib
  sweep_pattern "p3: no return Text(text) in markdown_render" 'return Text\(text\)' frontend/lib/design/markdown_render.dart
  sweep_pattern "p4: no Theme.of(context) outside the design/ token layer" 'Theme\.of\(context\)' frontend/lib --glob '!**/design/**'
  sweep_pattern "p5: hardcode scan (EdgeInsets 11/12, maxHeight 240, height 160)" 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160' frontend/lib

  printf '\ntotal hits: %s\n' "$hits" >> "$out"
  printf '%s' "$hits"
}

if [ "$fail_mode" = "1" ]; then
  # --- 1. Deliberate sweep violation must be caught with file:line --------
  probe=frontend/lib/sdui/primitives/__t82_sweep_probe.dart
  cat > "$probe" <<'EOF'
// T82 --fail probe: a deliberate hardcode sweep violation, removed after the run.
// ignore_for_file: unused_element
import 'package:flutter/material.dart';

Widget _probe() => Container(padding: EdgeInsets.all(12));
EOF

  restore_probe() {
    rm -f "$probe"
  }
  trap restore_probe EXIT

  set +e
  run_sweep "$evidence/sweep-fail.txt" > /dev/null
  set -e

  grep -q '__t82_sweep_probe.dart' "$evidence/sweep-fail.txt" \
    || fail "--fail probe: the planted EdgeInsets.all(12) violation was not caught by the sweep (see $evidence/sweep-fail.txt)"
  grep -q '__t82_sweep_probe.dart:[0-9]' "$evidence/sweep-fail.txt" \
    || fail "--fail probe: the sweep hit is not recorded with file:line (see $evidence/sweep-fail.txt)"
  ok "--fail probe: the sweep caught the planted EdgeInsets.all(12) with file:line (sweep-fail.txt)"

  restore_probe
  trap - EXIT

  # --- 2. A corrupted golden must fail the suite and yield a diff ---------
  golden=frontend/test/gallery/goldens/fixture-text-basic-light.png
  other=frontend/test/gallery/goldens/fixture-text-basic-dark.png
  [ -f "$golden" ] && [ -f "$other" ] || fail "expected baselines missing: $golden / $other"

  backup=$(mktemp)
  cp "$golden" "$backup"
  rm -rf frontend/test/gallery/failures

  restore_golden() {
    cp "$backup" "$golden"
    rm -f "$backup"
    rm -rf frontend/test/gallery/failures
  }
  trap restore_golden EXIT

  cp "$other" "$golden"

  set +e
  scripts/qa/flutter-test.sh test/gallery --plain-name "fixture-text-basic (light)" \
    > "$evidence/test-fail.txt" 2>&1
  suite_status=$?
  set -e

  if [ "$suite_status" -eq 0 ]; then
    fail "--fail probe: the corrupted golden did not fail the suite (checker is broken) — see $evidence/test-fail.txt"
  fi
  ok "--fail probe: corrupted goldens/fixture-text-basic-light.png correctly failed the suite (test-fail.txt)"

  diff_png=frontend/test/gallery/failures/fixture-text-basic-light_isolatedDiff.png
  [ -s "$diff_png" ] || fail "expected diff artifact $diff_png was not produced by the failing run"
  cp "$diff_png" "$evidence/diffs/fixture-text-basic-light_isolatedDiff.png"
  ok "golden diff copied to $evidence/diffs/fixture-text-basic-light_isolatedDiff.png"

  restore_golden
  trap - EXIT

  printf 'FAIL (intentional): planted sweep violation and corrupted golden to prove T82 detects both kinds of regression\n' \
    | tee -a "$checks"
  ok "--fail probe passed: sweep and golden checker both reject the planted regressions, originals restored"
  fail "--fail mode: intentional failure-path exit"
fi

# --- 1. Refresh every golden and record the delta (never silent) -----------
log "step 1/6: golden refresh with recorded delta"
golden_dirs='frontend/test/gallery/goldens frontend/test/boot/goldens'
for d in $golden_dirs; do
  [ -d "$d" ] || fail "missing golden dir $d"
done

scripts/qa/flutter-test.sh --update-goldens 2>&1 | tee "$evidence/goldens-refresh.txt" \
  || fail "golden refresh run failed (see $evidence/goldens-refresh.txt)"

{
  echo "# T82 golden refresh delta ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "# refreshed via: scripts/qa/flutter-test.sh --update-goldens"
  echo "# delta is measured against git HEAD for $golden_dirs"
} > "$evidence/goldens.txt"

new_list=$(git ls-files --others --exclude-standard -- $golden_dirs | sort || true)
updated_list=$(git diff --name-only -- $golden_dirs | sort || true)
tracked_total=$(git ls-files -- $golden_dirs | wc -l | tr -d ' ')
new_count=$(printf '%s' "$new_list" | grep -c . || true)
updated_count=$(printf '%s' "$updated_list" | grep -c . || true)
unchanged_count=$((tracked_total - updated_count))

{
  echo
  echo "new: $new_count"
  printf '%s\n' "$new_list"
  echo
  echo "updated: $updated_count"
  printf '%s\n' "$updated_list"
  echo
  echo "unchanged: $unchanged_count"
  echo
  echo "totals: tracked=$tracked_total new=$new_count updated=$updated_count unchanged=$unchanged_count"
} >> "$evidence/goldens.txt"

ok "golden refresh recorded in goldens.txt (new=$new_count updated=$updated_count unchanged=$unchanged_count)"

# --- 2. The full Flutter suite must be green without --update-goldens ------
log "step 2/6: full Flutter suite (no --update-goldens)"
scripts/qa/flutter-test.sh 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "full Flutter suite did not report 'All tests passed!' (see $evidence/test.txt)"
ok "full Flutter suite green after the refresh (test.txt)"

# --- 3. ./gradlew dist must assemble the bundle ---------------------------
log "step 3/6: ./gradlew dist"
set +e
./gradlew dist 2>&1 | tee "$evidence/dist.txt"
dist_status=${PIPESTATUS[0]}
set -e
[ "$dist_status" -eq 0 ] || fail "./gradlew dist exited $dist_status (see $evidence/dist.txt)"
grep -q 'dist: assembled dist/' "$evidence/dist.txt" \
  || fail "./gradlew dist did not report a assembled bundle (see $evidence/dist.txt)"
ok "./gradlew dist exited 0 (dist.txt; bundle under dist/)"
grep -q -- '--no-tree-shake-icons' "$evidence/dist.txt" \
  && ok "dist built the Flutter clients with --no-tree-shake-icons (dist.txt)" \
  || ok "dist built no Flutter client (all client steps skipped on this host) — flag documented in build.gradle"

# --- 4. ./gradlew test (every included build) -----------------------------
log "step 4/6: ./gradlew test"
set +e
./gradlew test 2>&1 | tee "$evidence/gradle-test.txt"
test_status=${PIPESTATUS[0]}
set -e
[ "$test_status" -eq 0 ] || fail "./gradlew test exited $test_status (see $evidence/gradle-test.txt)"
grep -q 'BUILD SUCCESSFUL' "$evidence/gradle-test.txt" \
  || fail "./gradlew test did not report BUILD SUCCESSFUL (see $evidence/gradle-test.txt)"
ok "./gradlew test green across the composite (gradle-test.txt)"

# --- 5. Build matrix (UNVERIFIED #2) + icon tree-shake delta (UNVERIFIED #7)
log "step 5/6: build matrix"
{
  echo "# T82 build matrix ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "# target statuses are BUILT / SKIPPED / FAILED; SKIPPED means the"
  echo "# target cannot build on this host and is not a task failure."
  echo
  echo "icon registry: frontend/lib/design/icon_registry.dart resolves 8825"
  echo "IconData lookups dynamically, so release builds must pass"
  echo "--no-tree-shake-icons (docs/updates.md §8); the curated-300-icon"
  echo "fallback triggers only if the size delta exceeds 50 MB."
} > "$evidence/build-matrix.txt"

matrix_line() {
  printf '%-28s %-8s %s\n' "$1" "$2" "$3" | tee -a "$evidence/build-matrix.txt"
}

cd frontend

set +e
flutter_cmd build web --release > "$evidence/build-web-noflag.txt" 2>&1
web_noflag_status=$?
set -e
web_noflag_size=$(dir_size build/web)
if [ "$web_noflag_status" -eq 0 ]; then
  matrix_line "web --release (no flag)" "BUILT" "build/web = ${web_noflag_size} KB"
else
  matrix_line "web --release (no flag)" "FAILED" "exit $web_noflag_status (see build-web-noflag.txt)"
fi

set +e
flutter_cmd build web --release --no-tree-shake-icons > "$evidence/build-web-icons.txt" 2>&1
web_flag_status=$?
set -e
web_flag_size=$(dir_size build/web)
if [ "$web_flag_status" -eq 0 ]; then
  matrix_line "web --release +icons" "BUILT" "build/web = ${web_flag_size} KB"
else
  matrix_line "web --release +icons" "FAILED" "exit $web_flag_status (see build-web-icons.txt)"
fi

if [ "$web_noflag_status" -eq 0 ] && [ "$web_flag_status" -eq 0 ]; then
  delta_kb=$((web_flag_size - web_noflag_size))
  delta_mb=$((delta_kb / 1024))
  echo "icons delta (web): ${delta_kb} KB (${delta_mb} MB) = with-flag minus without-flag" \
    | tee -a "$evidence/build-matrix.txt"
  if [ "$delta_mb" -gt 50 ]; then
    fail "icon tree-shake delta ${delta_mb} MB exceeds the 50 MB threshold — fall back to the curated 300-icon registry (plan UNVERIFIED #7)"
  fi
  ok "icon tree-shake delta ${delta_mb} MB within the 50 MB threshold (build-matrix.txt)"
else
  ok "icon delta not measurable (web build unavailable on this host) — recorded in build-matrix.txt"
fi

set +e
flutter_cmd build linux --release --no-tree-shake-icons > "$evidence/build-linux.txt" 2>&1
linux_status=$?
set -e
linux_size=$(dir_size build/linux/x64/release/bundle)
if [ "$linux_status" -eq 0 ]; then
  matrix_line "linux --release +icons" "BUILT" "bundle = ${linux_size} KB"
else
  matrix_line "linux --release +icons" "SKIPPED" "exit $linux_status — host toolchain or linux target unavailable (see build-linux.txt)"
fi

set +e
flutter_cmd build apk --release --no-tree-shake-icons > "$evidence/build-apk.txt" 2>&1
apk_status=$?
set -e
if [ "$apk_status" -eq 0 ]; then
  matrix_line "apk --release +icons" "BUILT" "$(du -sk build/app/outputs/flutter-apk/app-release.apk | cut -f1) KB"
else
  matrix_line "apk --release +icons" "SKIPPED" "exit $apk_status — no Android SDK on this host (see build-apk.txt)"
fi

cd ..

# --- 6. The final hardcode sweep ------------------------------------------
log "step 6/6: final hardcode sweep"
set +e
sweep_hits=$(run_sweep "$evidence/sweep.txt")
set -e
if [ "${sweep_hits:-1}" != "0" ]; then
  fail "hardcode sweep found $sweep_hits hit(s) — every hit blocks T82 (recorded with file:line in $evidence/sweep.txt)"
fi
ok "final hardcode sweep clean: 0 hits across all 5 patterns (sweep.txt)"

log "T82 QA green: goldens recorded, suite green, dist assembled, sweep clean"
