#!/usr/bin/env bash
# QA for T80: docs/code conformance and documentation coverage.
# Usage: scripts/qa/t80.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T80. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The evidence is doc-coverage.txt and conformance.txt.
#
# Happy path:
#   - runs the ui-kit suite (UiConformanceTest included, the T55 conformance
#     check) and writes the gradle transcript to conformance.txt; requires
#     BUILD SUCCESSFUL and a green UiConformanceTest result (0 failures,
#     0 errors — no undocumented keys and no unreachable doc keys);
#   - proves the documentation coverage with rg into doc-coverage.txt:
#     'qa-mock-llm' in AGENTS.md; 'ctx\.sched', 'SessionLifecycleService',
#     'TitleService', 'UndoJournal', 'RunActivityService' and 'session_updated'
#     in docs/plugin-dev.md; '--no-tree-shake-icons' in README.md.
#
# Failure path: a deliberately wrong expectation — that 'UndoJournal' is
# absent from docs/plugin-dev.md — asserted against the real file; the checker
# must fail (checks-fail.txt and doc-coverage-fail.txt, exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T80_INNER:-}" ]; then
  exec env T80_INNER=1 timeout --kill-after=15 600 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T80}
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

command -v rg > /dev/null || fail "rg is required"

# require_hit <pattern> <file> <label>: the pattern must hit the file; the
# matching lines are appended to the coverage transcript.
require_hit() {
  local pattern=$1 file=$2 label=$3
  {
    echo "=== $label ==="
    echo "pattern: $pattern"
    echo "file:    $file"
    if rg -n -- "$pattern" "$file"; then
      echo "result:  hit"
    else
      echo "result:  MISS"
    fi
    echo
  } >> "$coverage"
  rg -q -- "$pattern" "$file" \
    || fail "$label: pattern '$pattern' not found in $file (see $coverage)"
  ok "$label: '$pattern' hits $file"
}

if [ "$fail_mode" = "1" ]; then
  log "T80 QA --fail: the checker must fail on a deliberately wrong expectation"
  log "evidence dir: $evidence"
  coverage="$evidence/doc-coverage-fail.txt"
  : > "$coverage"
  {
    echo "=== deliberate wrong expectation ==="
    echo "pattern: UndoJournal"
    echo "file:    docs/plugin-dev.md"
    rg -n -- 'UndoJournal' docs/plugin-dev.md || echo "(no matches)"
    echo
  } >> "$coverage"
  # the real file documents UndoJournal, so this expectation must not hold
  if rg -q -- 'UndoJournal' docs/plugin-dev.md; then
    fail "deliberately wrong expectation held: UndoJournal is documented (see $coverage)"
  fi
  fail "deliberately wrong expectation: UndoJournal is absent from docs/plugin-dev.md (see $coverage)"
fi

log "T80 QA: docs/code conformance and documentation coverage"
log "evidence dir: $evidence"

# --- 1. The conformance suite (T55) ---
./gradlew :jhin-plugin-ui-kit:test --rerun 2>&1 | tee "$evidence/conformance.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/conformance.txt" \
  || fail "the ui-kit suite did not report BUILD SUCCESSFUL (see $evidence/conformance.txt)"
conf_xml=plugins/ui-kit/build/test-results/test/TEST-com.astroreen.jhin.plugin.uikit.UiConformanceTest.xml
[ -f "$conf_xml" ] || fail "UiConformanceTest result missing: $conf_xml"
grep -q 'failures="0" errors="0"' "$conf_xml" \
  || fail "UiConformanceTest reports failures (see $conf_xml and $evidence/conformance.txt)"
ok "UiConformanceTest green: 0 undocumented keys, 0 unreachable doc keys (conformance.txt)"

# --- 2. Documentation coverage ---
coverage="$evidence/doc-coverage.txt"
: > "$coverage"
require_hit 'qa-mock-llm' AGENTS.md 'AGENTS.md lists qa-mock-llm'
require_hit 'ctx\.sched' docs/plugin-dev.md 'plugin-dev.md documents ctx.sched()'
require_hit 'SessionLifecycleService' docs/plugin-dev.md 'plugin-dev.md documents SessionLifecycleService'
require_hit 'TitleService' docs/plugin-dev.md 'plugin-dev.md documents TitleService'
require_hit 'UndoJournal' docs/plugin-dev.md 'plugin-dev.md documents UndoJournal'
require_hit 'RunActivityService' docs/plugin-dev.md 'plugin-dev.md documents RunActivityService'
require_hit 'session_updated' docs/plugin-dev.md 'plugin-dev.md documents session_updated'
require_hit --no-tree-shake-icons README.md 'README.md documents --no-tree-shake-icons'

log "T80 QA green: evidence in $evidence"
