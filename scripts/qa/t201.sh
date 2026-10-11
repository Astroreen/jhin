#!/usr/bin/env bash
# T201 QA — ui-kit: XSS-safe HTML renderer, token CSS and the raw escape hatch.
#
# Proves, without a human in the loop:
#   1. the ui-kit test suite is green (HtmlRenderer + per-family renderers,
#      markdown, the raw hatch, the sweep, and the chunk 1-2 suites);
#   2. the XSS matrix evidence exists and every rendered output in it carries
#      zero raw <script (inputs may show it);
#   3. the raw escape hatch renders its payload verbatim (raw-hatch.txt);
#   4. NEGATIVE: the RawEscapeSweepTest result reports 0 Ui.raw( uses under
#      plugins/ui-default/src/main/java (raw-sweep.txt).
#
# The evidence artifacts are written by the tests themselves when
# JHIN_EVIDENCE_DIR is set (this script exports it). Runs from the repository
# root; curl-free (gradle + evidence checks only).
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EVIDENCE="$ROOT/.sisyphus/evidence/T201"

mkdir -p "$EVIDENCE"
export JHIN_EVIDENCE_DIR="$EVIDENCE"

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== T201 QA: XSS-safe HTML renderer, token CSS and the raw escape hatch =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

# ---------------------------------------------------------------- 1. tests
echo "== Step 1: gradle :jhin-plugin-ui-kit:test =="
set +e
./gradlew --console=plain :jhin-plugin-ui-kit:test --rerun 2>&1 | tee "$EVIDENCE/test.txt"
GRADLE_STATUS="${PIPESTATUS[0]}"
set -e
[ "$GRADLE_STATUS" -eq 0 ] || fail ":jhin-plugin-ui-kit:test exited $GRADLE_STATUS (see $EVIDENCE/test.txt)"
echo "-- OK: :jhin-plugin-ui-kit:test green ($EVIDENCE/test.txt)"

# ------------------------------------------------------- 2. the XSS matrix
echo "== Step 2: XSS matrix — zero raw <script in rendered output =="
MATRIX="$EVIDENCE/xss-matrix.txt"
[ -s "$MATRIX" ] || fail "missing evidence $MATRIX (JHIN_EVIDENCE_DIR did not reach the tests)"
grep '^output=' "$MATRIX" > "$EVIDENCE/xss-outputs.txt" || true
OUTPUT_COUNT="$(grep -c '^output=' "$MATRIX" || echo 0)"
echo "-- rendered outputs recorded: $OUTPUT_COUNT (minimum 4)"
[ "$OUTPUT_COUNT" -ge 4 ] || fail "XSS matrix records $OUTPUT_COUNT outputs, expected >= 4"
if grep -q '<script' "$EVIDENCE/xss-outputs.txt"; then
    echo "-- offending output lines:" >&2
    grep '<script' "$EVIDENCE/xss-outputs.txt" >&2
    fail "XSS matrix contains a raw <script in rendered output (see $EVIDENCE/xss-outputs.txt)"
fi
echo "-- OK: 0 raw <script in rendered output ($EVIDENCE/xss-outputs.txt)"
for position in text label title markdown; do
    grep -q "^position=$position\$" "$MATRIX" || fail "XSS matrix misses position=$position"
done
echo "-- OK: positions text/label/title/markdown all recorded"

# -------------------------------------------------------- 3. the raw hatch
echo "== Step 3: the Ui.raw escape hatch renders verbatim =="
HATCH="$EVIDENCE/raw-hatch.txt"
[ -s "$HATCH" ] || fail "missing evidence $HATCH"
grep -q 'contains-verbatim=true' "$HATCH" || fail "raw hatch does not render its payload verbatim (see $HATCH)"
grep -q 'contains-escaped=false' "$HATCH" || fail "raw hatch payload was escaped — the hatch is broken (see $HATCH)"
echo "-- OK: Ui.raw payload rendered verbatim, unescaped ($HATCH)"

# --------------------------------------------------------- 4. the sweep
echo "== Step 4: NEGATIVE — 0 Ui.raw( uses under ui-default =="
SWEEP="$EVIDENCE/raw-sweep.txt"
[ -s "$SWEEP" ] || fail "missing evidence $SWEEP"
grep -q 'offenders=0' "$SWEEP" || fail "product screens use Ui.raw( (see $SWEEP)"
grep -q 'result=0 uses' "$SWEEP" || fail "sweep result line missing (see $SWEEP)"
echo "-- OK: 0 Ui.raw( uses under plugins/ui-default ($SWEEP)"

echo
echo "== T201 QA PASSED =="
echo "evidence: $EVIDENCE"
ls -1 "$EVIDENCE"
