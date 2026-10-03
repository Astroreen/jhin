#!/usr/bin/env bash
# QA for T53: design tokens, generated theme and universal node styling.
# Usage: scripts/qa/t53.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T53. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - the full frontend test suite passes (scripts/qa/flutter-test.sh),
#     transcript in evidence/T53/test.txt,
#   - the generated theme carries a light+dark ThemeData pair
#     (`rg 'ThemeData\(' frontend/lib/design/theme.dart` >= 2 hits),
#   - the banned hardcoded layout numbers
#     (`EdgeInsets.all(11|12)`, `maxHeight: 240`, `height: 160`) have zero
#     hits under frontend/lib — transcript in evidence/T53/hardcode-scan.txt,
#   - the failure-path tests (unknown-token degrade + malformed-theme
#     fallback) pass — transcript in evidence/T53/token-fallback.txt.
#
# --fail mode: runs only the failure-path tests and records their
# transcript in evidence/T53/token-fallback.txt.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T53}
mkdir -p "$evidence"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# Failure-path evidence: unknown-token degrade + malformed-theme fallback.
# Runs in both modes; the happy path records it next to the green run.
log "T53 QA: failure-path tests (token fallback + malformed theme)"
scripts/qa/flutter-test.sh test/design/token_fallback_test.dart \
  2>&1 | tee "$evidence/token-fallback.txt"
grep -q 'All tests passed' "$evidence/token-fallback.txt" ||
  fail "token fallback tests did not pass (see $evidence/token-fallback.txt)"
log "ok: token-fallback.txt written (unknown-token degrade + malformed-theme fallback)"

if [ "$fail_mode" = "1" ]; then
  log "T53 --fail QA green: failure-path evidence recorded in $evidence"
  exit 0
fi

# Acceptance: the whole frontend suite passes.
log "T53 QA: full frontend test suite"
scripts/qa/flutter-test.sh 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed' "$evidence/test.txt" ||
  fail "flutter test did not pass (see $evidence/test.txt)"
log "ok: test.txt written (full frontend suite passed)"

# Acceptance: the generated theme carries a light+dark ThemeData pair.
theme_hits=$(rg -o 'ThemeData\(' frontend/lib/design/theme.dart | wc -l | tr -d ' ')
printf 'rg -o %s frontend/lib/design/theme.dart -> %s hits\n' \
  "'ThemeData\\('" "$theme_hits" > "$evidence/themedata-count.txt"
[ "$theme_hits" -ge 2 ] ||
  fail "design/theme.dart has only $theme_hits ThemeData( constructions (need >= 2)"
log "ok: themedata-count.txt written ($theme_hits ThemeData constructions >= 2)"

# Acceptance: zero hardcoded layout numbers under frontend/lib.
scan='EdgeInsets\.all\(1[12]\)|maxHeight: 240|height: 160'
if command -v rg > /dev/null 2>&1; then
  if rg -n "$scan" frontend/lib > "$evidence/hardcode-hits.txt" 2>&1; then
    cat "$evidence/hardcode-hits.txt"
    fail "hardcoded layout numbers found under frontend/lib"
  fi
  scan_tool="rg -n '$scan' frontend/lib"
else
  if grep -rnE "$scan" frontend/lib > "$evidence/hardcode-hits.txt" 2>&1; then
    cat "$evidence/hardcode-hits.txt"
    fail "hardcoded layout numbers found under frontend/lib"
  fi
  scan_tool="grep -rnE '$scan' frontend/lib"
fi
{
  printf '$ %s\n' "$scan_tool"
  printf '(no hits)\n'
} > "$evidence/hardcode-scan.txt"
log "ok: hardcode-scan.txt written (0 hits for the banned numbers)"

log "T53 QA green: tokens, generated theme and universal node styling verified"
