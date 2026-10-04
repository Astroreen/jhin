#!/usr/bin/env bash
# QA for T71: sessions migration v2 and the store API for lifecycle fields.
# Usage: scripts/qa/t71.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T71. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - runs ./gradlew :jhin-plugin-sessions:test --rerun (transcript in
#     test.txt) and requires BUILD SUCCESSFUL;
#   - copies the v1→v2 upgrade dumps written by SessionSchemaUpgradeTest to
#     evidence/T71/upgrade/{before.sql,after.sql,rows.json} and asserts the
#     pre-v2 rows read back pinned=0, auto_settle=1, auto_settle_suppressed=0
#     with the other lifecycle columns NULL (the SQLite ALTER TABLE ADD COLUMN
#     default probe);
#   - copies the negative-path transcript to evidence/T71/negative.txt and
#     asserts it pins migration idempotence (the version-table guard, raw v2
#     SQL re-apply failing with duplicate column) and the PluginException on a
#     patch with pinned for an unknown session.
#   Evidence: test.txt, upgrade/{before.sql,after.sql,rows.json}, negative.txt,
#   checks.txt.
#
# --fail mode: reruns the same pipeline, then asserts a deliberately wrong
#   expectation (the pre-v2 rows have pinned=1) against the real rows.json,
#   records the transcript in checks-fail.txt and exits non-zero — proving the
#   checker fails instead of passing silently.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T71}
mkdir -p "$evidence/upgrade"

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

log "T71 QA: sessions migration v2 and store API for lifecycle fields"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

# --- 1. The sessions JVM suite ---
./gradlew :jhin-plugin-sessions:test --rerun 2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-sessions:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' plugins/sessions/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok ":jhin-plugin-sessions:test green ($test_count tests; transcript in test.txt)"

# --- 2. The v1→v2 upgrade dumps ---
upgrade_src=plugins/sessions/build/upgrade
for name in before.sql after.sql rows.json; do
  [ -s "$upgrade_src/$name" ] || fail "missing $upgrade_src/$name — did SessionSchemaUpgradeTest run?"
  cp "$upgrade_src/$name" "$evidence/upgrade/$name"
done
grep -q 'pinned INT DEFAULT 0' "$evidence/upgrade/after.sql" \
  || fail "after.sql does not show the v2 lifecycle columns (see $evidence/upgrade/after.sql)"
if grep -q 'pinned INT' "$evidence/upgrade/before.sql"; then
  fail "before.sql already shows lifecycle columns — not a v1 schema dump"
fi
ok "upgrade dumps copied (before.sql = v1 schema, after.sql = v2 schema)"

rows="$evidence/upgrade/rows.json"
for probe in '"pinned": 0' '"auto_settle": 1' '"auto_settle_suppressed": 0' \
             '"pinned_order": null' '"settled_at": null' '"snoozed_until": null' \
             '"archived_at": null' '"sort_order": null' '"settled_reason": null'; do
  grep -q "$probe" "$rows" || fail "rows.json misses the pre-v2 default probe $probe (see $rows)"
done
ok "pre-v2 rows read back pinned=0, auto_settle=1, auto_settle_suppressed=0, others NULL"

# --- 3. The negative-path transcript ---
[ -s "$upgrade_src/negative.txt" ] || fail "missing $upgrade_src/negative.txt — did negativeProbes run?"
cp "$upgrade_src/negative.txt" "$evidence/negative.txt"
grep -q 'migration idempotence holds' "$evidence/negative.txt" \
  || fail "negative.txt misses the migration idempotence probe (see $evidence/negative.txt)"
grep -q 'duplicate column' "$evidence/negative.txt" \
  || fail "negative.txt misses the raw v2 SQL re-apply failure probe (see $evidence/negative.txt)"
grep -q 'PluginException' "$evidence/negative.txt" \
  || fail "negative.txt misses the unknown-session patch probe (see $evidence/negative.txt)"
ok "negative probes recorded (v2 re-run is a no-op, patch-unknown throws PluginException)"

if [ "$fail_mode" = "1" ]; then
  # Deliberate wrong expectation against the real rows.json: the pre-v2 rows
  # "must have pinned=1". The check fails by design, proving the harness
  # reports failures instead of passing silently.
  if grep -q '"pinned": 1' "$rows"; then
    wrong_status=0
    wrong_line='ok: pre-v2 rows have pinned=1 (deliberate wrong expectation unexpectedly held)'
  else
    wrong_status=1
    wrong_line="FAIL: pre-v2 rows have pinned=1 — the deliberate wrong expectation failed as designed (rows.json shows pinned=0)"
  fi
  printf 'T71 QA --fail: deliberate wrong expectation (pre-v2 rows have pinned=1)\n%s\n' \
    "$wrong_line" | tee -a "$checks"
  [ "$wrong_status" -eq 1 ] \
    || fail "--fail mode: the deliberate wrong expectation did not fail (harness is broken)"
  fail "--fail mode: intentional failure-path exit"
fi

log "T71 QA: all checks green"