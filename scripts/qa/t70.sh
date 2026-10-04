#!/usr/bin/env bash
# QA for T70: persisted keybindings with user overrides and the settings
# surface.
# Usage: scripts/qa/t70.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T70. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - asserts the hardcode scan over frontend/lib is empty;
#   - runs flutter analyze and the full Flutter suite (transcript in
#     evidence/T70/test.txt) and asserts "All tests passed!";
#   - runs the T70 evidence tests and tees their transcripts:
#     rebind.txt (rebind -> restart -> new chord fires, old chord dead, plus
#     the override surviving an upgrade that adds a new default),
#     corrupt.txt (corrupt keybindings blob -> server defaults + the raw
#     bytes quarantined);
#   - runs the ui-default plugin suite (keybind actions, keyboard rows,
#     header parsing) and tees evidence/T70/java.txt;
#   - asserts the expected evidence lines are present in each transcript.
#
# --fail mode: runs a deliberately wrong expectation (the corrupt-blob
#   transcript "must lack the quarantine line") against the real transcript,
#   asserts the check FAILS as designed, records the transcript as
#   evidence/T70/checks-fail.txt and exits non-zero (the intentional
#   failure-path exit).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T70}
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

log "T70 QA: persisted keybindings, user overrides and the settings surface"
log "evidence dir: $evidence"

# --- 1. Hardcode scan over the Flutter client ---
hardcode_hits=$( (rg -n 'EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160' frontend/lib || true) | wc -l | tr -d ' ')
[ "$hardcode_hits" = "0" ] || fail "hardcode scan hit ($hardcode_hits, see above)"
ok "hardcode scan clean (no EdgeInsets.all(11/12), maxHeight: 240 or height: 160 in frontend/lib)"

if [ "$fail_mode" = "1" ]; then
  # Deliberate wrong expectation against the hardcode scan: the scan
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
    printf 'T70 QA --fail: deliberate wrong expectation (hardcode scan hits == 1)\n'
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

# --- 4. Keybinding evidence transcripts ---
scripts/qa/flutter-test.sh test/keyboard/keybindings_persistence_test.dart \
  --plain-name 'evidence T70' 2>&1 | tee "$evidence/rebind.txt"
grep -q 'All tests passed!' "$evidence/rebind.txt" \
  || fail "rebind evidence tests failed (see $evidence/rebind.txt)"
grep -q 'rebind composer.send: mod+enter -> mod+shift+enter' "$evidence/rebind.txt" \
  || fail "rebind.txt lacks the rebind row"
grep -q 'store read-back after restart' "$evidence/rebind.txt" \
  || fail "rebind.txt lacks the restart store read-back"
grep -q 'effective: mod+shift+enter -> composer.send (fires)' "$evidence/rebind.txt" \
  || fail "rebind.txt lacks the new-chord fires row"
grep -q 'effective: mod+enter -> none (old chord dead)' "$evidence/rebind.txt" \
  || fail "rebind.txt lacks the old-chord dead row"
grep -q 'override kept: mod+shift+enter -> composer.send' "$evidence/rebind.txt" \
  || fail "rebind.txt lacks the override-survives-upgrade row"
grep -q 'new default active: mod+1 -> thread.jump1' "$evidence/rebind.txt" \
  || fail "rebind.txt lacks the new-default active row"
ok "rebind transcript recorded (rebind.txt: restart read-back, new chord fires, old dead, upgrade keeps the override)"

scripts/qa/flutter-test.sh test/store/keymap_store_test.dart \
  --plain-name 'corrupted keybindings blob' 2>&1 | tee "$evidence/corrupt.txt"
grep -q 'All tests passed!' "$evidence/corrupt.txt" \
  || fail "corrupt-blob evidence test failed (see $evidence/corrupt.txt)"
grep -q 'load -> 0 override rules (server defaults active)' "$evidence/corrupt.txt" \
  || fail "corrupt.txt lacks the server-defaults fallback row"
grep -q 'quarantine copy migration.quarantine:keybindings:1 == raw' "$evidence/corrupt.txt" \
  || fail "corrupt.txt lacks the quarantine copy row"
grep -q 'quarantine list contains keybindings' "$evidence/corrupt.txt" \
  || fail "corrupt.txt lacks the quarantine list row"
grep -q 'original key untouched: true' "$evidence/corrupt.txt" \
  || fail "corrupt.txt lacks the raw-bytes-preserved row"
ok "corrupt transcript recorded (corrupt.txt: defaults + quarantine copy + raw bytes preserved)"

# --- 5. The ui-default plugin suite (routes) ---
./gradlew :jhin-plugin-ui-default:test 2>&1 | tee "$evidence/java.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/java.txt" \
  || fail ":jhin-plugin-ui-default:test did not succeed (see $evidence/java.txt)"
ok ":jhin-plugin-ui-default:test green (keybind actions, keyboard rows, header parsing)"

log "T70 QA green: persisted keybindings and the settings surface verified"
