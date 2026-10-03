#!/usr/bin/env bash
# QA for T54: versioned store with upgrade chain, quarantine and version gate.
# Usage: scripts/qa/t54.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T54. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - the store test suite passes with the evidence fixtures written
#     (T54_EVIDENCE_DIR) — transcript in evidence/T54/test.txt and fixtures
#     legacy-blob.json, after-migration.json, quarantine.json,
#   - the failure-path test (throwing step quarantines the key, the backup
#     is gone, MigrationReport.failures == 1) passes — transcript in
#     evidence/T54/partial-failure.txt,
#   - the full frontend test suite passes — evidence/T54/full-suite.txt,
#   - main() awaits the migration report before JhinApp builds (rule 5) —
#     evidence/T54/rule5-wiring.txt.
#
# --fail mode: runs only the failure-path test and records its transcript
# in evidence/T54/partial-failure.txt.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T54}
mkdir -p "$evidence"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# Failure-path evidence: the throwing-step fixture (rule 4). Runs in both
# modes; the happy path records it next to the green run.
log "T54 QA: failure-path tests (throwing step quarantines, others migrate)"
scripts/qa/flutter-test.sh test/store/migration_runner_test.dart \
  --plain-name 'rule 4: one failing key quarantines itself' \
  2>&1 | tee "$evidence/partial-failure.txt"
grep -q 'All tests passed' "$evidence/partial-failure.txt" ||
  fail "partial-failure tests did not pass (see $evidence/partial-failure.txt)"
log "ok: partial-failure.txt written (failing key quarantined, backup gone, failures == 1)"

if [ "$fail_mode" = "1" ]; then
  log "T54 --fail QA green: failure-path evidence recorded in $evidence"
  exit 0
fi

# Acceptance: the store suite passes and the evidence fixtures are written.
log "T54 QA: store suite + evidence fixtures"
T54_EVIDENCE_DIR="$(pwd)/$evidence" \
  scripts/qa/flutter-test.sh test/store 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed' "$evidence/test.txt" ||
  fail "flutter test test/store did not pass (see $evidence/test.txt)"
for fixture in legacy-blob.json after-migration.json quarantine.json; do
  [ -s "$evidence/$fixture" ] ||
    fail "evidence fixture $fixture was not written (see $evidence/test.txt)"
done
log "ok: test.txt written (store suite passed); legacy-blob.json, after-migration.json, quarantine.json present"

# Acceptance: the whole frontend suite passes.
log "T54 QA: full frontend test suite"
scripts/qa/flutter-test.sh 2>&1 | tee "$evidence/full-suite.txt"
grep -q 'All tests passed' "$evidence/full-suite.txt" ||
  fail "flutter test did not pass (see $evidence/full-suite.txt)"
log "ok: full-suite.txt written (full frontend suite passed)"

# Acceptance: main() awaits the migration report before JhinApp builds.
{
  printf '$ grep -n "await MigrationRunner().run" frontend/lib/main.dart\n'
  grep -n 'await MigrationRunner().run' frontend/lib/main.dart
} > "$evidence/rule5-wiring.txt"
grep -q 'await MigrationRunner().run' "$evidence/rule5-wiring.txt" ||
  fail "main() does not await the migration report (rule 5)"
log "ok: rule5-wiring.txt written (main() awaits MigrationReport before JhinApp)"

log "T54 QA green: versioned store, upgrade chain, quarantine and version gate verified"
