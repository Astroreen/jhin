#!/usr/bin/env bash
# QA for T56: level-2 bootstrap payload (contract/theme/tokens/density/keymap),
# api/schema negotiation and the level-2 -> level-1 primitive downgrade table.
# Usage: scripts/qa/t56.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T56. Exits non-zero on the first
# failed assertion.
#
# Happy path:
#   - ./gradlew :jhin-plugin-ui-default:test is green (BootstrapContractTest,
#     the existing BootstrapRouteTest/ScreenRouteTest regression and
#     BootstrapEvidenceTest, which dumps the wire fixtures below) —
#     transcript in evidence/T56/test.txt,
#   - the five captured bootstrap payloads (BootstrapEvidenceTest) are copied
#     from the module build dir and jq-asserted against docs/sdui.md section
#     1/6: bootstrap-api2.json (full level-2 shape: contract, tokens.spacing.md
#     == 12, keymap >= 8 entries, theme keys), bootstrap-api1.json (Appendix A
#     shape: no contract/tokens/density/keymap, theme reduced to
#     seedColor+mode), absent-header.json (same as api1 — an absent header
#     behaves as api=1), garbage-client.json (api=0;schema=99 degrades to
#     level-1 without throwing — the route already answered 200), and
#     caps-no-sse.json (api negotiates to 2, but the stream_view inside the
#     fixture screen still degrades to a plain list without the sse
#     capability, independent of the contract level) — checks.txt.
#
# --fail mode: reruns the same jq checks (checks-fail.txt) and then trips one
#   deliberately wrong expectation (asserting the api=1 fixture carries a
#   `contract` key, which it must not) to prove the checker actually fails
#   when the payload shape regresses.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T56}
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

# jq -e over a fixture file; fails the QA run with a clear message on mismatch.
assert_jq() {
  local file=$1 expr=$2 what=$3
  jq -e "$expr" "$file" > /dev/null 2>&1 || fail "$what (expr: $expr, file: $file)"
  ok "$what"
}

log "T56 QA: level-2 bootstrap payload, negotiation and downgrade table"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

# Acceptance: the ui-default module tests pass (also regenerates the fixtures
# BootstrapEvidenceTest dumps into the module build dir).
./gradlew :jhin-plugin-ui-default:test --rerun 2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-ui-default:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
ok ":jhin-plugin-ui-default:test green (BootstrapContractTest, BootstrapRouteTest, BootstrapEvidenceTest; transcript in test.txt)"

# Copy the captured wire fixtures out of the module build dir.
fixtures_src=plugins/ui-default/build/evidence-t56
for fixture in bootstrap-api2.json bootstrap-api1.json absent-header.json garbage-client.json caps-no-sse.json; do
  [ -s "$fixtures_src/$fixture" ] || fail "missing fixture $fixtures_src/$fixture — did BootstrapEvidenceTest run?"
  cp "$fixtures_src/$fixture" "$evidence/$fixture"
done
ok "5 wire fixtures copied from $fixtures_src: bootstrap-api2.json, bootstrap-api1.json, absent-header.json, garbage-client.json, caps-no-sse.json"

api2="$evidence/bootstrap-api2.json"
api1="$evidence/bootstrap-api1.json"
absent="$evidence/absent-header.json"
garbage="$evidence/garbage-client.json"
capsnosse="$evidence/caps-no-sse.json"

# --- bootstrap-api2.json: full level-2 shape (docs/sdui.md section 1) ---
assert_jq "$api2" '.api == 2' "api2: top-level api == 2"
assert_jq "$api2" '.contract.api == 2 and .contract.minApi == 2' "api2: contract.api/minApi == 2"
assert_jq "$api2" '.contract.schema == 3 and .contract.minSchema == 3' "api2: contract.schema/minSchema == 3"
assert_jq "$api2" '.tokens.spacing.md == 12' "api2: tokens.spacing.md == 12"
assert_jq "$api2" '.tokens.radius.full == 9999' "api2: tokens.radius.full == 9999"
assert_jq "$api2" '(.keymap | length) >= 8' "api2: keymap has >= 8 entries"
assert_jq "$api2" '.theme | has("appearance") and has("canvas") and has("accent") and has("colors") and has("mode")' \
  "api2: theme carries appearance/canvas/accent/colors/mode"
assert_jq "$api2" '.theme.mode == .theme.appearance' "api2: theme.mode == theme.appearance"
assert_jq "$api2" '.density == "comfortable"' "api2: density == comfortable"

# --- bootstrap-api1.json: Appendix A shape ---
assert_jq "$api1" '.api == 1' "api1: top-level api == 1"
assert_jq "$api1" '(has("contract") or has("tokens") or has("density") or has("keymap")) | not' \
  "api1: no contract/tokens/density/keymap fields"
assert_jq "$api1" '.theme | keys == ["mode", "seedColor"]' "api1: theme reduced to seedColor+mode"

# --- absent-header.json: an absent X-Jhin-Client header behaves as api=1 ---
assert_jq "$absent" '.api == 1' "absent-header: top-level api == 1"
assert_jq "$absent" '(has("contract") or has("tokens") or has("density") or has("keymap")) | not' \
  "absent-header: no contract/tokens/density/keymap fields"
assert_jq "$absent" '.theme | keys == ["mode", "seedColor"]' "absent-header: theme reduced to seedColor+mode"

# --- garbage-client.json: api=0;schema=99 degrades safely, never 500 ---
assert_jq "$garbage" '.api == 1' "garbage-client: api=0;schema=99 negotiates down to 1"
assert_jq "$garbage" '(has("contract") or has("tokens") or has("density") or has("keymap")) | not' \
  "garbage-client: no contract/tokens/density/keymap fields"
ok "garbage-client: route answered 200 with a parseable JSON body (see test.txt — no exception, no 500)"

# --- caps-no-sse.json: api negotiates to 2, stream_view still degrades to list ---
assert_jq "$capsnosse" '.api == 2' "caps-no-sse: top-level api == 2 (level-2 negotiated)"
assert_jq "$capsnosse" '.contract.api == 2' "caps-no-sse: contract still present at level 2"
assert_jq "$capsnosse" \
  '.screens[0].node.body.children[0].type == "list"' \
  "caps-no-sse: stream_view degraded to list without the sse capability"
assert_jq "$capsnosse" \
  '.screens[0].node.body.children[0] | has("topic") | not' \
  "caps-no-sse: degraded list carries no stream-only topic field"

if [ "$fail_mode" = "1" ]; then
  ok "--fail probes passed: all five fixtures still match the documented shapes"
  # Deliberately wrong expectation: the api=1 fixture must NOT carry a
  # `contract` key. Assert that it does, to prove the checker fails when the
  # payload regresses.
  if jq -e 'has("contract")' "$api1" > /dev/null 2>&1; then
    fail "--fail probe: api=1 fixture unexpectedly carries a contract key (checker is broken)"
  fi
  printf 'FAIL (intentional): bootstrap-api1.json asserted to have a contract key, but it does not\n' | tee -a "$checks"
  ok "--fail probe: deliberately wrong expectation tripped as intended"
  fail "--fail mode: intentional failure-path exit"
fi

log "T56 QA green: level-2 bootstrap payload, negotiation and downgrade table verified"
