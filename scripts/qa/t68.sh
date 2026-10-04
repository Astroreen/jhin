#!/usr/bin/env bash
# QA for T68: composer keyboard flow — send, send-and-new, newline, recall.
# Usage: scripts/qa/t68.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T68. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - asserts the hardcode scan over frontend/lib is empty;
#   - runs flutter analyze and asserts "No issues found";
#   - runs test/keyboard and the full Flutter suite (transcript in
#     evidence/T68/test.txt) and asserts "All tests passed!";
#   - runs :jhin-plugin-ui-default:test and appends it to test.txt;
#   - runs the T68 evidence tests and tees their transcripts:
#     send.txt (exactly one send POST; Shift+Enter newline, 0 POSTs),
#     send-and-new.txt (send + create-session + navigate to chat:<id>),
#     recall.txt (history walk, decline on a non-empty draft, per-profile),
#     failure.txt (empty composer: 0 POSTs + errorText; create-session 4xx:
#     draft kept + toast);
#   - asserts the expected evidence lines are present in each transcript.
#
# --fail mode: runs a deliberately wrong expectation (the hardcode scan
#   "must find exactly 1 hit") against the real hit count, asserts the check
#   FAILS as designed, records the transcript as evidence/T68/checks-fail.txt
#   and exits non-zero (the intentional failure-path exit).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T68}
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

log "T68 QA: composer keyboard flow — send, send-and-new, newline, recall"
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
    printf 'T68 QA --fail: deliberate wrong expectation (hardcode scan hits == 1)\n'
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

# --- 3. Flutter suites (plan named test/keyboard test/sdui; the tree has
#        no test/sdui directory, so the keyboard suite runs first and the
#        full suite — acceptance 7 — covers the sdui tests) ---
scripts/qa/flutter-test.sh test/keyboard 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "test/keyboard did not report 'All tests passed!' (see $evidence/test.txt)"
scripts/qa/flutter-test.sh 2>&1 | tee -a "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "flutter suite did not report 'All tests passed!' (see $evidence/test.txt)"
suite_count=$(grep -oE '\+[0-9]+' "$evidence/test.txt" | tr -d '+' | sort -n | tail -1)
ok "flutter suites green ($suite_count tests; transcript in test.txt)"

# --- 4. Java action tests ---
./gradlew :jhin-plugin-ui-default:test 2>&1 | tee -a "$evidence/test.txt" \
  || fail ":jhin-plugin-ui-default:test failed (see $evidence/test.txt)"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-ui-default:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
ok ":jhin-plugin-ui-default:test green (send enqueues, create-session returns id, 4xx path)"

# --- 5. Composer evidence transcripts ---
scripts/qa/flutter-test.sh test/keyboard --plain-name 'evidence/send:' \
  2>&1 | tee "$evidence/send.txt"
grep -q 'All tests passed!' "$evidence/send.txt" \
  || fail "send evidence tests failed (see $evidence/send.txt)"
grep -q 'evidence/send: send posts=1 path=/ui/action/send' "$evidence/send.txt" \
  || fail "send.txt lacks the one-send-POST line"
grep -q 'messageInput: hello' "$evidence/send.txt" \
  || fail "send.txt lacks the send body line"
grep -q "evidence/send: newline inserted: 'hello' -> 'hello\\\\n'" "$evidence/send.txt" \
  || fail "send.txt lacks the shift+enter newline line"
grep -q 'evidence/send: posts after shift+enter=0' "$evidence/send.txt" \
  || fail "send.txt lacks the zero-POST newline line"
ok "send recorded (send.txt: exactly 1 send POST; Shift+Enter newline with 0 POSTs)"

scripts/qa/flutter-test.sh test/keyboard --plain-name 'evidence/send-and-new:' \
  2>&1 | tee "$evidence/send-and-new.txt"
grep -q 'All tests passed!' "$evidence/send-and-new.txt" \
  || fail "send-and-new evidence test failed (see $evidence/send-and-new.txt)"
grep -q 'evidence/send-and-new: send posts=1 create-session posts=1' \
  "$evidence/send-and-new.txt" \
  || fail "send-and-new.txt lacks the send + create-session POST line"
grep -q 'workdir: /tmp/work, model: echo' "$evidence/send-and-new.txt" \
  || fail "send-and-new.txt lacks the workdir/model carry-over line"
grep -q 'evidence/send-and-new: navigated=true' "$evidence/send-and-new.txt" \
  || fail "send-and-new.txt lacks the navigation line"
ok "send-and-new recorded (send-and-new.txt: send + create-session + navigate chat:<id>)"

scripts/qa/flutter-test.sh test/keyboard --plain-name 'evidence/recall:' \
  2>&1 | tee "$evidence/recall.txt"
grep -q 'All tests passed!' "$evidence/recall.txt" \
  || fail "recall evidence tests failed (see $evidence/recall.txt)"
grep -q "evidence/recall: ArrowUp -> 'second prompt'" "$evidence/recall.txt" \
  || fail "recall.txt lacks the first recall step"
grep -q "evidence/recall: ArrowUp -> 'first prompt'" "$evidence/recall.txt" \
  || fail "recall.txt lacks the second recall step"
grep -q 'evidence/recall: ArrowDown -> (cleared)' "$evidence/recall.txt" \
  || fail "recall.txt lacks the walk-and-clear step"
grep -q '(declined), caret 7 -> 3' "$evidence/recall.txt" \
  || fail "recall.txt lacks the declined-caret-move line"
grep -q 'profile A history invisible' "$evidence/recall.txt" \
  || fail "recall.txt lacks the per-profile isolation line"
ok "recall recorded (recall.txt: walk + clear, decline keeps the draft, per-profile)"

scripts/qa/flutter-test.sh test/keyboard --plain-name 'evidence/failure:' \
  2>&1 | tee "$evidence/failure.txt"
grep -q 'All tests passed!' "$evidence/failure.txt" \
  || fail "failure evidence tests failed (see $evidence/failure.txt)"
grep -q "evidence/failure: empty composer posts=0 errorText='Write a message first'" \
  "$evidence/failure.txt" \
  || fail "failure.txt lacks the empty-composer line"
grep -q "evidence/failure: create-session 400 draft kept='hello'" \
  "$evidence/failure.txt" \
  || fail "failure.txt lacks the 4xx-create-session draft-kept line"
ok "failure recorded (failure.txt: empty composer 0 POSTs + errorText; 4xx keeps the draft + toast)"

log "T68 QA green: composer keyboard flow verified"
