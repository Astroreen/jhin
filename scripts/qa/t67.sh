#!/usr/bin/env bash
# QA for T67: command registry, when-contexts and keymap resolution.
# Usage: scripts/qa/t67.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T67. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - asserts the hardcode scan over frontend/lib is empty;
#   - runs flutter analyze and the full Flutter suite (transcript in
#     evidence/T67/test.txt) and asserts "All tests passed!";
#   - runs the keyboard evidence tests and tees their transcripts:
#     parse.txt (key parse matrix incl. the mod -> ctrl/meta mapping),
#     when.txt (when-context truth table), negative.txt (mod+ ignored,
#     unknown when=false, unknown command no-op);
#   - asserts the expected evidence lines are present in each transcript.
#
# --fail mode: runs a deliberately wrong expectation (the hardcode scan
#   "must find exactly 1 hit") against the real hit count, asserts the check
#   FAILS as designed, records the transcript as evidence/T67/checks-fail.txt
#   and exits non-zero (the intentional failure-path exit).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T67}
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

log "T67 QA: command registry, when-contexts and keymap resolution"
log "evidence dir: $evidence"

# --- 1. Hardcode scan over the Flutter client ---
hardcode_hits=$( (rg -n 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160' frontend/lib || true) | wc -l | tr -d ' ')
[ "$hardcode_hits" = "0" ] || fail "hardcode scan hit ($hardcode_hits, see above)"
ok "hardcode scan clean (no EdgeInsets.all(11/12), maxHeight: 240 or height: 160 in frontend/lib)"

if [ "$fail_mode" = "1" ]; then
  # Deliberate wrong expectation against the real hardcode scan: the scan
  # "must find exactly 1 hit". The check fails by design, proving the QA
  # harness reports failures instead of passing silently.
  if [ "$hardcode_hits" -eq 1 ]; then
    wrong_status=0
    wrong_line='ok: hardcode scan hits == 1 (deliberate wrong expectation unexpectedly held)'
  else
    wrong_status=1
    wrong_line="FAIL: hardcode scan hits == 1 — the deliberate wrong expectation failed as designed (actual hits=$hardcode_hits)"
  fi
  {
    printf 'T67 QA --fail: deliberate wrong expectation (hardcode scan hits == 1)\n'
    printf '%s\n' "$wrong_line"
  } | tee "$evidence/checks-fail.txt"
  [ "$wrong_status" -eq 1 ] \
    || fail "--fail mode: the deliberate wrong expectation did not fail (harness is broken)"
  printf 'ok: the deliberate wrong expectation failed as designed — see checks-fail.txt\n' \
    | tee -a "$evidence/checks.txt"
  fail "--fail mode: intentional failure-path exit"
fi

# --- 2. Flutter analyze ---
analyze_log=$(mktemp)
(cd frontend && flutter analyze) > "$analyze_log" 2>&1 \
  || { cat "$analyze_log"; fail "flutter analyze failed (see output above)"; }
grep -q 'No issues found' "$analyze_log" \
  || { cat "$analyze_log"; fail "flutter analyze reported issues (see output above)"; }
ok "flutter analyze clean"

# --- 3. The full Flutter suite ---
scripts/qa/flutter-test.sh 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "flutter suite did not report 'All tests passed!' (see $evidence/test.txt)"
suite_count=$(grep -oE '\+[0-9]+' "$evidence/test.txt" | tr -d '+' | sort -n | tail -1)
ok "flutter suite green ($suite_count tests; transcript in test.txt)"

# --- 4. Keyboard evidence transcripts ---
scripts/qa/flutter-test.sh test/keyboard --plain-name 'key parse matrix' \
  2>&1 | tee "$evidence/parse.txt"
grep -q 'All tests passed!' "$evidence/parse.txt" \
  || fail "parse matrix test failed (see $evidence/parse.txt)"
grep -q 'mod+enter platform=linux -> ctrl+enter' "$evidence/parse.txt" \
  || fail "parse.txt lacks the mod -> ctrl mapping for linux"
grep -q 'mod+enter platform=windows -> ctrl+enter' "$evidence/parse.txt" \
  || fail "parse.txt lacks the mod -> ctrl mapping for windows"
grep -q 'mod+enter platform=macOS -> meta+enter' "$evidence/parse.txt" \
  || fail "parse.txt lacks the mod -> meta mapping for macOS"
ok "key parse matrix recorded (parse.txt incl. mod -> ctrl on linux/windows, mod -> meta on macOS)"

scripts/qa/flutter-test.sh test/keyboard --plain-name 'truth table (evidence' \
  2>&1 | tee "$evidence/when.txt"
grep -q 'All tests passed!' "$evidence/when.txt" \
  || fail "when truth table test failed (see $evidence/when.txt)"
for context in composerFocus composerDraft turnRunning editableFocus isWeb \
    isDesktop sidebarFocus paletteOpen modalOpen; do
  grep -q "^$context false -> true" "$evidence/when.txt" \
    || fail "when.txt lacks the truth-table row for $context"
done
grep -q 'unknown name: evaluate(nope) = false' "$evidence/when.txt" \
  || fail "when.txt lacks the unknown-name = false row"
ok "when-context truth table recorded (when.txt: 9 contexts + negations, unknown = false)"

scripts/qa/flutter-test.sh test/keyboard --plain-name 'negative cases (evidence' \
  2>&1 | tee "$evidence/negative.txt"
grep -q 'All tests passed!' "$evidence/negative.txt" \
  || fail "negative cases test failed (see $evidence/negative.txt)"
grep -q "parse('mod+') -> null (ignored)" "$evidence/negative.txt" \
  || fail "negative.txt lacks the mod+ ignored row"
grep -q 'evaluate(.nope.) -> false' "$evidence/negative.txt" \
  || fail "negative.txt lacks the unknown when=false row"
grep -q "dispatch('no.such.command') -> no-op, no throw" "$evidence/negative.txt" \
  || fail "negative.txt lacks the unknown command no-op row"
ok "negative cases recorded (negative.txt: mod+ ignored, unknown when=false, unknown command no-op)"

log "T67 QA green: command registry, when-contexts and keymap resolution verified"
