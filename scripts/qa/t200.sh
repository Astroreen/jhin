#!/usr/bin/env bash
# T200 QA — contract level 4 specification + ADR.
#
# Proves, without a human in the loop:
#   1. the SDK contract constants are at level 4 / schema 5 (gradle test);
#   2. docs/sdui.md is an HTML-wire document (>= 20 lines mentioning html);
#   3. the 426 upgrade rule is specified (>= 2 occurrences of 426);
#   4. the heading list of docs/sdui.md is captured as evidence;
#   5. NEGATIVE: no screen/frame payload still carries a node tree.
#
# Runs from the repository root; curl-free (docs + gradle only).
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EVIDENCE="$ROOT/.sisyphus/evidence/T200"
SPEC="docs/sdui.md"
ADR="docs/web-client.md"

mkdir -p "$EVIDENCE"

# rg is not guaranteed in the QA environment; every count below goes through
# this wrapper so the script is self-sufficient with plain grep.
count_lines() { # count_lines <pattern> <file>  -> matching LINE count
    if command -v rg >/dev/null 2>&1; then
        rg -c -- "$1" "$2" 2>/dev/null || echo 0
    else
        grep -c -- "$1" "$2" 2>/dev/null || echo 0
    fi
}

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== T200 QA: SDUI contract level 4 =="
echo "-- repository root: $ROOT"
if command -v rg >/dev/null 2>&1; then
    echo "-- search tool: rg"
else
    echo "-- search tool: grep (rg unavailable)"
fi

# ---------------------------------------------------------------- 1. SDK test
# Task addressing note: settings.gradle declares `includeBuild 'sdk'` without
# an explicit name, so the composite build name is the DIRECTORY (`sdk`) and
# the SDK test task is `:sdk:test`. (`:jhin-sdk` is the sdk build's own
# rootProject.name and is not an addressable path from the root build.)
SDK_TEST_TASK=":sdk:test"
echo "== Step 1: gradle $SDK_TEST_TASK =="
set +e
./gradlew --console=plain "$SDK_TEST_TASK" 2>&1 | tee "$EVIDENCE/test.txt"
GRADLE_STATUS="${PIPESTATUS[0]}"
set -e
[ "$GRADLE_STATUS" -eq 0 ] || fail "$SDK_TEST_TASK exited $GRADLE_STATUS (see $EVIDENCE/test.txt)"
echo "-- OK: $SDK_TEST_TASK green"

echo "== Step 2: the SDK constants are level 4 / schema 5 =="
CONST_FILE="sdk/src/main/java/com/astroreen/jhin/sdk/ApiVersion.java"
grep -q 'SDUI_CONTRACT = 4;' "$CONST_FILE"     || fail "SDUI_CONTRACT is not 4"
grep -q 'SDUI_CONTRACT_MIN = 4;' "$CONST_FILE" || fail "SDUI_CONTRACT_MIN is not 4"
grep -q 'CLIENT_SCHEMA = 5;' "$CONST_FILE"     || fail "CLIENT_SCHEMA is not 5"
grep -q 'CLIENT_SCHEMA_MIN = 5;' "$CONST_FILE" || fail "CLIENT_SCHEMA_MIN is not 5"
grep -q 'CURRENT = 1;' "$CONST_FILE"           || fail "the plugin contract level CURRENT must stay 1"
{
    echo "SDUI_CONTRACT     = 4"
    echo "SDUI_CONTRACT_MIN = 4"
    echo "CLIENT_SCHEMA     = 5"
    echo "CLIENT_SCHEMA_MIN = 5"
    echo "CURRENT           = 1 (plugin contract, untouched)"
} > "$EVIDENCE/constants.txt"
echo "-- OK: constants at level 4 / schema 5 ($EVIDENCE/constants.txt)"

# ------------------------------------------------------- 3. the spec is HTML
echo "== Step 3: docs/sdui.md speaks HTML =="
HTML_HITS="$(count_lines 'html' "$SPEC")"
echo "-- lines mentioning html: $HTML_HITS (minimum 20)"
[ "$HTML_HITS" -ge 20 ] || fail "docs/sdui.md mentions html on $HTML_HITS lines, expected >= 20"

grep -q 'level 4' "$SPEC"   || fail "docs/sdui.md does not announce level 4"
grep -q 'api=4' "$SPEC"     || fail "docs/sdui.md does not contain api=4"
grep -q '"html"' "$SPEC"    || fail "docs/sdui.md does not contain an \"html\" payload key"
grep -q '"replace"' "$SPEC" || fail "docs/sdui.md does not contain the \"replace\" frame"
echo "-- OK: level 4, api=4, \"html\" and \"replace\" all present"

echo "== Step 4: the 426 upgrade rule is specified =="
UPGRADE_HITS="$(count_lines '426' "$SPEC")"
echo "-- lines mentioning 426: $UPGRADE_HITS (minimum 2)"
[ "$UPGRADE_HITS" -ge 2 ] || fail "docs/sdui.md mentions 426 on $UPGRADE_HITS lines, expected >= 2"
grep -q 'contract_upgrade' "$SPEC" || fail "the 426 body (contract_upgrade) is not specified"
grep -q '"minApi":4' "$SPEC"       || fail "the 426 body does not carry minApi:4"

echo "== Step 5: the ADR names every data-jhin-* attribute =="
for attr in data-jhin-type data-jhin-id data-jhin-when data-jhin-template \
            data-jhin-action data-jhin-confirm data-jhin-icon; do
    grep -q -- "$attr" "$ADR" || fail "$ADR does not name $attr"
done
echo "-- OK: all seven data-jhin-* attributes documented in $ADR"

echo "== Step 6: heading list -> evidence =="
grep '^#' "$SPEC" > "$EVIDENCE/headings.txt"
echo "-- $(wc -l < "$EVIDENCE/headings.txt") headings written to $EVIDENCE/headings.txt"

# ------------------------------------------------- 7. NEGATIVE: no node wire
# Rule: at level 4 no screen, frame or directive payload may carry a node tree
# under a `node` key — the payload field is `html`. The frame DISCRIMINATOR is
# still named `node` ({"node": {"id": …, "html": …}}), and the prose still
# discusses the server-side node model ("node tree", "UiNode", "every node"),
# so this check is deliberately narrow:
#   * it only looks at a `node` key that INTRODUCES an object
#     ("node": { … , or node: { … ),
#   * a line that also carries an "html" key is allowed (that is the level-4
#     frame discriminator carrying an HTML fragment),
#   * Appendix A is excluded: it records the level-1 shape as history.
echo "== Step 7: negative check — no node-tree payload on the wire =="
APPENDIX_LINE="$(grep -n '^## Appendix A' "$SPEC" | head -1 | cut -d: -f1 || true)"
if [ -n "${APPENDIX_LINE:-}" ]; then
    BODY_LINES=$((APPENDIX_LINE - 1))
    echo "-- Appendix A (historical) starts at line $APPENDIX_LINE; checking lines 1-$BODY_LINES"
else
    BODY_LINES="$(wc -l < "$SPEC")"
    echo "-- no appendix found; checking all $BODY_LINES lines"
fi

head -n "$BODY_LINES" "$SPEC" \
    | grep -nE '"node"[[:space:]]*:|[[:space:]]node:[[:space:]]*\{|\{node:' \
    | grep -v '"html"' > "$EVIDENCE/no-node-wire.txt" || true

OFFENDERS="$(wc -l < "$EVIDENCE/no-node-wire.txt")"
if [ "$OFFENDERS" -ne 0 ]; then
    echo "-- offending lines:" >&2
    cat "$EVIDENCE/no-node-wire.txt" >&2
    fail "$OFFENDERS node-tree payload(s) still in $SPEC (see $EVIDENCE/no-node-wire.txt)"
fi
echo "-- OK: 0 node-tree payloads outside the historical appendix ($EVIDENCE/no-node-wire.txt is empty)"

echo
echo "== T200 QA PASSED =="
echo "evidence: $EVIDENCE"
ls -1 "$EVIDENCE"
