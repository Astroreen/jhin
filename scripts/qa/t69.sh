#!/usr/bin/env bash
# QA for T69: command palette, thread jumping and undo binding.
# Usage: scripts/qa/t69.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T69. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - asserts the hardcode scan over frontend/lib is empty;
#   - runs flutter analyze and asserts "No issues found";
#   - runs test/keyboard and the full Flutter suite (transcript in
#     evidence/T69/test.txt) and asserts "All tests passed!";
#   - runs :jhin-plugin-ui-default:test (SearchRouteTest,
#     SearchEvidenceTest, UiPluginTest) and appends it to test.txt;
#   - runs the T69 evidence tests and tees their transcripts:
#     palette-transcript.txt (open -> type -> navigate -> dispatch, plus the
#     jump3 navigation), undo-window.txt (nothing-to-undo toast, 404-safe
#     proof, success directives);
#   - copies search.json (SearchEvidenceTest wire samples) from the module
#     build dir and jq-asserts the documented result shape;
#   - asserts the expected evidence lines are present in each transcript.
#
# --fail mode: runs a deliberately wrong expectation (the hardcode scan
#   "must find exactly 1 hit") against the real hit count, asserts the check
#   FAILS as designed, records the transcript as evidence/T69/checks-fail.txt
#   and exits non-zero (the intentional failure-path exit).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T69}
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

assert_jq() {
  local file=$1 expr=$2 what=$3
  jq -e "$expr" "$file" > /dev/null 2>&1 || fail "$what (expr: $expr, file: $file)"
  ok "$what"
}

log "T69 QA: command palette, thread jumping and undo binding"
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
    printf 'T69 QA --fail: deliberate wrong expectation (hardcode scan hits == 1)\n'
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

# --- 3. Flutter suites ---
scripts/qa/flutter-test.sh test/keyboard 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "test/keyboard did not report 'All tests passed!' (see $evidence/test.txt)"
scripts/qa/flutter-test.sh 2>&1 | tee -a "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "flutter suite did not report 'All tests passed!' (see $evidence/test.txt)"
suite_count=$(grep -oE '\+[0-9]+' "$evidence/test.txt" | tr -d '+' | sort -n | tail -1)
ok "flutter suites green ($suite_count tests; transcript in test.txt)"

# --- 4. Java search endpoint tests ---
./gradlew :jhin-plugin-ui-default:test 2>&1 | tee -a "$evidence/test.txt" \
  || fail ":jhin-plugin-ui-default:test failed (see $evidence/test.txt)"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-ui-default:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
ok ":jhin-plugin-ui-default:test green (search title/user_message/message_end hits, short/blank queries)"

# --- 5. Palette + jump evidence transcript ---
scripts/qa/flutter-test.sh test/keyboard --plain-name 'evidence/palette:' \
  2>&1 | tee "$evidence/palette-transcript.txt"
grep -q 'All tests passed!' "$evidence/palette-transcript.txt" \
  || fail "palette evidence tests failed (see $evidence/palette-transcript.txt)"
scripts/qa/flutter-test.sh test/keyboard --plain-name 'evidence/jump:' \
  2>&1 | tee -a "$evidence/palette-transcript.txt"
grep -q 'All tests passed!' "$evidence/palette-transcript.txt" \
  || fail "jump evidence tests failed (see $evidence/palette-transcript.txt)"
grep -q 'evidence/palette: opened=true paletteOpen=true' "$evidence/palette-transcript.txt" \
  || fail "palette-transcript.txt lacks the open line"
grep -q 'evidence/palette: closed=true paletteOpen=false' "$evidence/palette-transcript.txt" \
  || fail "palette-transcript.txt lacks the close line"
grep -q "evidence/palette: query='s' localOnly=true .*searchPosts=0" \
  "$evidence/palette-transcript.txt" \
  || fail "palette-transcript.txt lacks the 1-char local-only line"
grep -q "evidence/palette: query='fix' searchPosts=1 body={query: fix} results=2" \
  "$evidence/palette-transcript.txt" \
  || fail "palette-transcript.txt lacks the one-search-POST line"
grep -q 'evidence/palette: arrowDown x3 -> index=3' "$evidence/palette-transcript.txt" \
  || fail "palette-transcript.txt lacks the arrow-down line"
grep -q 'evidence/palette: arrowUp x10 -> index=0 clamped=true' "$evidence/palette-transcript.txt" \
  || fail "palette-transcript.txt lacks the clamped arrow-up line"
grep -q 'evidence/palette: enter local dispatches=1 closed=true' \
  "$evidence/palette-transcript.txt" \
  || fail "palette-transcript.txt lacks the local-dispatch line"
grep -q 'evidence/palette: enter server -> navigated=chat:s1 closed=true' \
  "$evidence/palette-transcript.txt" \
  || fail "palette-transcript.txt lacks the server-dispatch line"
grep -q 'evidence/jump: jump3 -> navigated=chat:s3' "$evidence/palette-transcript.txt" \
  || fail "palette-transcript.txt lacks the jump3 line"
ok "palette + jump recorded (palette-transcript.txt: open -> type -> navigate -> dispatch, jump3)"

# --- 6. Undo evidence transcript ---
scripts/qa/flutter-test.sh test/keyboard --plain-name 'evidence/undo-window:' \
  2>&1 | tee "$evidence/undo-window.txt"
grep -q 'All tests passed!' "$evidence/undo-window.txt" \
  || fail "undo evidence tests failed (see $evidence/undo-window.txt)"
grep -q "evidence/undo-window: nothing-to-undo toast='Nothing to undo' style=error" \
  "$evidence/undo-window.txt" \
  || fail "undo-window.txt lacks the nothing-to-undo toast line"
grep -q "evidence/undo-window: 404 toast='Nothing to undo' crashed=false" \
  "$evidence/undo-window.txt" \
  || fail "undo-window.txt lacks the 404-safe line"
grep -q 'evidence/undo-window: success directives=toast,refresh' \
  "$evidence/undo-window.txt" \
  || fail "undo-window.txt lacks the success-directives line"
ok "undo recorded (undo-window.txt: no-window toast + 404-safe + success directives)"

# --- 7. Search endpoint wire samples ---
fixtures_src=plugins/ui-default/build/evidence-t69
[ -s "$fixtures_src/search.json" ] \
  || fail "missing $fixtures_src/search.json — did SearchEvidenceTest run?"
cp "$fixtures_src/search.json" "$evidence/search.json"
search_json="$evidence/search.json"
assert_jq "$search_json" '.titleHit.status == 200' "search: title hit answers 200"
assert_jq "$search_json" \
  '.titleHit.response.results[0] | .kind == "session" and (.action.op == "navigate") and (.action.screen | startswith("chat:"))' \
  "search: title hit is a session entry with a navigate action"
assert_jq "$search_json" '.userMessageHit.response.results[0].kind == "user_message"' \
  "search: user_message hit carries kind=user_message"
assert_jq "$search_json" '.messageEndHit.response.results[0].kind == "message_end"' \
  "search: message_end hit carries kind=message_end"
assert_jq "$search_json" '.shortQuery.response.results == []' \
  "search: 1-char query answers an empty list"
assert_jq "$search_json" '.blankQuery.response.results == []' \
  "search: blank query answers an empty list"
assert_jq "$search_json" \
  '.titleHit.response.results[0] | has("id") and has("title") and has("kind") and has("action")' \
  "search: entries carry id/title/kind/action"
ok "search.json recorded (endpoint response samples, jq-asserted)"

log "T69 QA green: command palette, thread jumping and undo binding verified"