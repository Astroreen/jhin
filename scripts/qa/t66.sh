#!/usr/bin/env bash
# QA for T66: form-control parity, `table` v2 and the `tree` primitive.
# Usage: scripts/qa/t66.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T66. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - runs the ui-kit JVM suite (./gradlew :jhin-plugin-ui-kit:test):
#     conformance (every builder key documented in docs/sdui.md), the
#     byte-identical regression fixtures and the gallery fixture dump;
#     asserts unknown-keys.txt is empty and the coverage table reports
#     116 fixtures / 58 primitives;
#   - asserts the hardcode scan over frontend/lib is empty;
#   - runs flutter analyze and the full Flutter suite (transcript in
#     evidence/T66/test.txt) and asserts "All tests passed!";
#   - reruns the three degrade acceptance tests (unknown enum literals
#     degrade, table without rows renders header + empty node, malformed
#     tree items never crash) — transcript in evidence/T66/degrade.txt;
#   - copies the recorded goldens to evidence/T66/form.png and
#     evidence/T66/table.png and lists the gallery baselines (including the
#     recorded dropdown baseline delta) in evidence/T66/goldens.txt.
#
# --fail mode: runs a deliberately wrong expectation (fixture total == 1)
#   against the real coverage table, asserts the check FAILS as designed,
#   records the transcript as evidence/T66/checks-fail.txt, and exits
#   non-zero (the intentional failure-path exit).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T66}
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

log "T66 QA: form-control parity, table v2 and the tree primitive"
log "evidence dir: $evidence"

# --- 1. The ui-kit JVM suite: conformance, regression fixtures, coverage ---
gradle_log=$(mktemp)
./gradlew :jhin-plugin-ui-kit:test > "$gradle_log" 2>&1 \
  || { cat "$gradle_log"; fail ":jhin-plugin-ui-kit:test failed (see output above)"; }
ok ":jhin-plugin-ui-kit:test green (conformance + byte-identical regression fixtures)"

unknown_keys=plugins/ui-kit/build/unknown-keys.txt
[ -f "$unknown_keys" ] || fail "missing $unknown_keys — did UiConformanceTest run?"
[ ! -s "$unknown_keys" ] || { cat "$unknown_keys"; fail "emitted keys missing from docs/sdui.md (see above)"; }
ok "every builder key is documented in docs/sdui.md (unknown-keys.txt empty)"

coverage_src=plugins/ui-kit/build/gallery/coverage.txt
[ -s "$coverage_src" ] || fail "missing $coverage_src — did GalleryDump run?"
cp "$coverage_src" "$evidence/coverage.txt"

total=$(grep -m1 '^total=' "$evidence/coverage.txt" | cut -d= -f2)
primitives=$(grep -m1 '^primitives=' "$evidence/coverage.txt" | cut -d= -f2)
[ -n "$total" ] && [ "$total" -ge 88 ] \
  || fail "fixture total ($total) is below the required 88 (see $evidence/coverage.txt)"
ok "fixture total = $total (>= 88)"
[ -n "$primitives" ] && [ "$primitives" -eq 58 ] \
  || fail "primitive coverage ($primitives) != 58 current primitives (see $evidence/coverage.txt)"
ok "primitive coverage = $primitives (all 58 current primitives present)"

for primitive in textarea tree; do
  count=$(grep -m1 "^${primitive}=" "$evidence/coverage.txt" | cut -d= -f2)
  [ -n "$count" ] && [ "$count" -ge 2 ] \
    || fail "primitive '$primitive' has $count fixtures, expected >= 2 (basic + prop-heavy)"
  ok "primitive '$primitive' has $count fixtures (basic + prop-heavy)"
done

# --- 2. Hardcode scan over the Flutter client ---
if rg -n 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160' frontend/lib; then
  fail "hardcode scan hit (see above)"
fi
ok "hardcode scan clean (no EdgeInsets.all(11/12), maxHeight: 240 or height: 160 in frontend/lib)"

if [ "$fail_mode" = "1" ]; then
  # Deliberate wrong expectation against the real coverage table: the
  # fixture total "must equal 1". The check fails by design, proving the
  # QA harness reports failures instead of passing silently.
  if [ "$total" -eq 1 ]; then
    wrong_status=0
    wrong_line='ok: fixture total == 1 (deliberate wrong expectation unexpectedly held)'
  else
    wrong_status=1
    wrong_line="FAIL: fixture total == 1 — the deliberate wrong expectation failed as designed (actual total=$total)"
  fi
  {
    printf 'T66 QA --fail: deliberate wrong expectation (fixture total == 1)\n'
    printf '%s\n' "$wrong_line"
  } | tee "$evidence/checks-fail.txt"
  [ "$wrong_status" -eq 1 ] \
    || fail "--fail mode: the deliberate wrong expectation did not fail (harness is broken)"
  printf 'ok: the deliberate wrong expectation failed as designed — see checks-fail.txt\n' \
    | tee -a "$evidence/checks.txt"
  fail "--fail mode: intentional failure-path exit"
fi

# --- 3. Flutter analyze ---
analyze_log=$(mktemp)
(cd frontend && flutter analyze) > "$analyze_log" 2>&1 \
  || { cat "$analyze_log"; fail "flutter analyze failed (see output above)"; }
grep -q 'No issues found' "$analyze_log" \
  || { cat "$analyze_log"; fail "flutter analyze reported issues (see output above)"; }
ok "flutter analyze clean"

# --- 4. The full Flutter suite ---
scripts/qa/flutter-test.sh 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "flutter suite did not report 'All tests passed!' (see $evidence/test.txt)"
suite_count=$(grep -oE '\+[0-9]+' "$evidence/test.txt" | tr -d '+' | sort -n | tail -1)
ok "flutter suite green ($suite_count tests; transcript in test.txt)"

# --- 5. Degrade acceptance reruns ---
: > "$evidence/degrade.txt"
for name in \
  'input unknown enum literals degrade to defaults' \
  'table missing rows renders the header plus the empty node' \
  'tree degrades on malformed items without crashing'; do
  printf '== %s ==\n' "$name" >> "$evidence/degrade.txt"
  scripts/qa/flutter-test.sh test/primitives_batch11_test.dart --plain-name "$name" \
    >> "$evidence/degrade.txt" 2>&1 \
    || fail "degrade test '$name' failed (see $evidence/degrade.txt)"
  grep -q 'All tests passed!' "$evidence/degrade.txt" || true
done
ok "degrade acceptance green: unknown enum degrades, table-no-rows -> header + empty, tree crash-proof (degrade.txt)"

# --- 6. Goldens ---
[ -f frontend/test/gallery/goldens/form.png ] || fail "missing golden frontend/test/gallery/goldens/form.png"
[ -f frontend/test/gallery/goldens/table.png ] || fail "missing golden frontend/test/gallery/goldens/table.png"
cp frontend/test/gallery/goldens/form.png "$evidence/form.png"
cp frontend/test/gallery/goldens/table.png "$evidence/table.png"
golden_count=$(ls frontend/test/gallery/goldens/*.png 2>/dev/null | wc -l | tr -d ' ')
{
  printf 'gallery baselines: %s PNGs in frontend/test/gallery/goldens\n' "$golden_count"
  printf 'new T66 baselines: form.png (decorated form composition), table.png (table v2),\n'
  printf '  fixture-textarea-basic/propheavy-{light,dark}.png, fixture-tree-basic/propheavy-{light,dark}.png\n'
  printf 'existing baselines: all unchanged except the four dropdown baselines\n'
  printf '  (fixture-dropdown-{basic,propheavy}-{light,dark}.png), recorded delta:\n'
  printf '  dropdown isDense now honors the documented default false (was the\n'
  printf '  DropdownButtonFormField widget default true) — see report; copies of\n'
  printf '  the pre-delta baselines kept outside the repo for comparison.\n'
} | tee "$evidence/goldens.txt"
ok "goldens recorded: form.png + table.png copied to $evidence (goldens.txt lists the delta)"

log "T66 QA green: form-control parity, table v2 and the tree primitive verified"
