#!/usr/bin/env bash
# T307 QA — sub-agent activity bars in the run timeline.
#
# Proves, with a booted kernel, curl and jq only (browser tools are
# UNAVAILABLE in this environment — every browser step becomes
# evidence/T307/browser-unavailable.txt plus strengthened curl asserts, the
# T202–T208/T301–T306 precedent):
#   1. build + test gates: the kernel boot jar and the eight plugin jars
#      build and the two suites stay green (:jhin-plugin-ui-kit:test,
#      :jhin-plugin-ui-default:test — MessageCardBuilderTest, EventFramesTest,
#      EventKindsTest, ChatScreenTest among them); counts are summed from
#      the JUnit XML reports, failures/errors asserted 0;
#   2. static gates: the T307 sources carry the new surface — the
#      `subagent:` row-key construction and isSubagentPayloadEmpty of
#      MessageCardBuilder, the isSubagentPayloadEmpty call of EventFrames
#      and the fixtures/subagent-fixtures.json scenarios (bar-with-steps,
#      bar-only, malformed-steps);
#   3. wire gates: the kernel is booted with jhin.sessions + jhin.ui-kit +
#      jhin.ui + jhin.agent + jhin.llm + jhin.llm-builtin +
#      jhin.tools-builtin + jhin.qa-mock-llm into a temp JHIN_HOME with
#      JHIN_SESSIONS_QA=true and JHIN_UI_QAPROBE=true (the qaProbe switch
#      that resolves the qa-timeline screen). GET /ui/screen/qa-timeline
#      (the fixture-driven probe screen) saves the body to subagent.html
#      and proves the subagent bar contract: the bar-with-steps and the
#      bar-only scenarios render as right-aligned bars keyed
#      subagent:scout-1 (the row key + the right-alignment marker the
#      renderer emits), bar-with-steps carries the indented nested step
#      texts ("read 4 files", "find token expiry") and bar-only renders
#      without any nested step text -> checks.txt;
#   4. browser-unavailable.txt: browser automation is unavailable; the
#      assertions are curl + static;
#   5. summary.txt with every PASS line and the key numbers.
#
# --fail mode (the negative proof — must PASS, exit 0, into checks-fail.txt):
#   a. the malformed-steps scenario (steps that is not a list) renders the
#      unknown-card fallback, never an empty bar: the screen carries the
#      "Unknown event: subagent" placeholder text and the malformed row
#      region holds no bar markup (no subagent:scout-1 row key, no bar
#      icon) while the two well-formed bars stay keyed subagent:scout-1
#      -> malformed.txt.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with the eight plugin jars (plugin projects expose the plain `jar`
# task — the kernel is the only bootJar). jhin.security is deliberately
# absent: no bearer token is needed and the listener speaks plain HTTP on
# http://localhost:18443 (the kernel default 8443 is occupied on the QA
# machine; plan section 9 allows the QA-only plain-HTTP mode in scripts).
# The happy mode runs the two suites with --rerun; --fail keeps the build
# gate (the suites must be green) but skips the forced rerun to stay small.
#
# On any failure one line is appended to evidence/T307/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T307_INNER:-}" ]; then
    exec env T307_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."
ROOT="$(pwd)"

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
    fail_mode=1
    shift
fi

EVIDENCE="${1:-$ROOT/.sisyphus/evidence/T307}"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage'
MESSAGE_CARD_BUILDER="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/MessageCardBuilder.java"
EVENT_FRAMES="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/EventFrames.java"
SUBAGENT_FIXTURE="plugins/ui-default/src/main/resources/fixtures/subagent-fixtures.json"
PLUGINS="sessions ui-kit ui-default agent llm llm-builtin tools-builtin qa-mock-llm"

mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/failures.txt"
if [ "$fail_mode" = "1" ]; then
    checks="$EVIDENCE/checks-fail.txt"
else
    checks="$EVIDENCE/checks.txt"
fi
: > "$checks"

log() {
    printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$checks"
}

ok() {
    printf 'ok: %s\n' "$*" | tee -a "$checks"
}

fail() {
    printf 'FAIL: %s\n' "$*" | tee -a "$checks" >&2
    echo "FAIL: $*" >> "$EVIDENCE/failures.txt"
    exit 1
}

kernel_pid=""
home=""
cleanup() {
    if [ -n "$kernel_pid" ] && kill -0 "$kernel_pid" 2>/dev/null; then
        kill "$kernel_pid" 2>/dev/null || true
        wait "$kernel_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT

command -v jq > /dev/null 2>&1 || fail "jq is required for the wire asserts"

# count_matches <file|-> <pattern>: the occurrences of a fixed pattern (the
# screen HTML is one long line — count matches, never lines; "-" reads stdin).
count_matches() {
    { grep -oF -- "$2" "$1" 2>/dev/null || true; } | wc -l | tr -d ' '
}

# count_attr <dir> <attr>: the summed JUnit XML attribute of one suite.
count_attr() {
    grep -h -o "$2=\"[0-9]*\"" "$1"/TEST-*.xml 2>/dev/null | awk -F'"' '{s += $2} END {print s+0}'
}

# slice <file> <start-attr> <end-attr> <n>: the region of the flattened
# screen HTML from the '<div' opening the element that carries the n-th
# occurrence of <start-attr> up to (not including) the '<div' opening the
# element that carries the first occurrence of <end-attr> after it. Prints
# nothing when the markers are missing.
slice() {
    tr '\n' ' ' < "$1" | awk -v a="$2" -v b="$3" -v n="$4" '
        {
            s = $0
            pos = 0; cnt = 0
            while ((i = index(substr(s, pos + 1), a)) > 0) {
                pos = pos + i
                cnt++
                if (cnt == n) break
            }
            if (cnt != n) next
            beg = 1
            for (p = 1; p < pos;) {
                i = index(substr(s, p, pos - p + 3), "<div")
                if (i == 0) break
                cand = p + i - 1
                if (cand >= pos) break
                beg = cand
                p = cand + 4
            }
            rest = substr(s, pos + length(a))
            j = index(rest, b)
            if (j == 0) {
                print substr(s, beg)
                next
            }
            epos = pos + length(a) + j - 1
            ebeg = 1
            for (p = 1; p < epos;) {
                i = index(substr(s, p, epos - p + 3), "<div")
                if (i == 0) break
                cand = p + i - 1
                if (cand >= epos) break
                ebeg = cand
                p = cand + 4
            }
            print substr(s, beg, ebeg - beg)
        }'
}

# stage_jars <dir>: copies the eight plugin jars into <dir>, retrying
# briefly — a background IDE gradle build can be rewriting build/libs while
# we copy. Classifier jars (-plain/-sources/-javadoc) are never staged.
stage_jars() {
    local dest=$1 attempt p jar jars
    for attempt in 1 2 3 4 5; do
        rm -f "$dest"/*.jar 2>/dev/null || true
        jars=0
        for p in $PLUGINS; do
            jar=$(ls plugins/"$p"/build/libs/jhin-plugin-"$p"-*.jar 2>/dev/null \
                | grep -vE -- '-(plain|sources|javadoc)' | head -1) || jar=""
            if [ -z "$jar" ]; then
                break
            fi
            cp "$jar" "$dest/" || jar=""
            [ -n "$jar" ] || break
            jars=$((jars + 1))
        done
        [ "$jars" = "8" ] && return 0
        sleep 1
    done
    return 1
}

# boot_kernel <home> <bundled>: starts run-kernel.sh with the sessions QA
# event helper and the qaProbe screens on, and waits <= 30 s for health.
boot_kernel() {
    local home=$1 bundled=$2 start code
    JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" JHIN_SESSIONS_QA=true \
        JHIN_UI_QAPROBE=true \
        "$ROOT/scripts/qa/run-kernel.sh" "$EVIDENCE" --server.port="$PORT" &
    kernel_pid=$!
    start=$(date +%s)
    while :; do
        code=$(curl -s --max-time 2 -H "$CLIENT_API4" \
            -o "$EVIDENCE/health.body" -w '%{http_code}' \
            "$BASE/_jhin/health" 2>/dev/null) || code=000
        [ "$code" = "200" ] && break
        kill -0 "$kernel_pid" 2>/dev/null \
            || fail "kernel (pid $kernel_pid) exited before health answered (see $EVIDENCE/kernel.log)"
        [ $(( $(date +%s) - start )) -lt 30 ] \
            || fail "health endpoint did not answer 200 within 30 s (last code $code)"
        sleep 0.5
    done
    ok "kernel up on $BASE (pid $kernel_pid), GET /_jhin/health -> 200 in $(( $(date +%s) - start )) s"
}

# fetch_screen_html <screen-id> <out>: GET /ui/screen/<id> and the probe
# HTML body (the screen answers {"id":…,"html":…}).
fetch_screen_html() {
    local id=$1 out=$2 code
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/screen.json" \
        -w '%{http_code}' "$BASE/ui/screen/$id") \
        || fail "GET /ui/screen/$id: curl failed"
    [ "$code" = "200" ] || fail "GET /ui/screen/$id answered $code (expected 200): $(cat "$EVIDENCE/screen.json")"
    jq -r '.html' "$EVIDENCE/screen.json" > "$out"
    [ -s "$out" ] || fail "the $id screen carries no HTML ($out)"
}

build_and_test() {
    echo "== Step 1: build the jars + run the two test gates =="
    set +e
    ./gradlew --console=plain :kernel:bootJar \
        :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar \
        :jhin-plugin-agent:jar :jhin-plugin-llm:jar :jhin-plugin-llm-builtin:jar \
        :jhin-plugin-tools-builtin:jar :jhin-plugin-qa-mock-llm:jar \
        2>&1 | tee "$EVIDENCE/build.log"
    local build_status="${PIPESTATUS[0]}"
    set -e
    [ "$build_status" -eq 0 ] || fail "gradle build exited $build_status (see $EVIDENCE/build.log)"

    local rerun=""
    if [ "$fail_mode" = "0" ]; then
        rerun="--rerun"
    fi
    set +e
    ./gradlew --console=plain \
        :jhin-plugin-ui-kit:test $rerun \
        :jhin-plugin-ui-default:test $rerun \
        2>&1 | tee -a "$EVIDENCE/build.log"
    local test_status="${PIPESTATUS[0]}"
    set -e
    [ "$test_status" -eq 0 ] || fail "gradle tests exited $test_status (see $EVIDENCE/build.log)"
    grep -qF 'BUILD SUCCESSFUL' "$EVIDENCE/build.log" \
        || fail "gradle did not report BUILD SUCCESSFUL (see $EVIDENCE/build.log)"

    ui_kit_tests=$(count_attr plugins/ui-kit/build/test-results/test tests)
    ui_default_tests=$(count_attr plugins/ui-default/build/test-results/test tests)
    total_failures=$(( $(count_attr plugins/ui-kit/build/test-results/test failures) \
        + $(count_attr plugins/ui-default/build/test-results/test failures) ))
    total_errors=$(( $(count_attr plugins/ui-kit/build/test-results/test errors) \
        + $(count_attr plugins/ui-default/build/test-results/test errors) ))
    {
        echo "T307 test gates — the two suites green on the subagent bar surface:"
        grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
        echo ""
        echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests"
        echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (MessageCardBuilderTest, EventFramesTest, EventKindsTest, ChatScreenTest among them)"
        echo "  failures=$total_failures errors=$total_errors (expected 0/0)"
    } > "$EVIDENCE/test-gates.txt"
    for suite in ':jhin-plugin-ui-kit:test' ':jhin-plugin-ui-default:test'; do
        grep -qF "> Task $suite" "$EVIDENCE/build.log" \
            || fail "test suite $suite did not run (see $EVIDENCE/build.log)"
    done
    [ "$total_failures" = "0" ] || fail "test failures=$total_failures (expected 0)"
    [ "$total_errors" = "0" ] || fail "test errors=$total_errors (expected 0)"
    ok "build + two test gates green ($ui_kit_tests/$ui_default_tests tests, 0 failures; test-gates.txt)"
}

# seed_home <evidence-tag>: the temp JHIN_HOME + bundled dir and the eight
# staged jars; sets the globals `home` and `bundled`.
seed_home() {
    local tag=$1 jar_count
    home=$(mktemp -d /tmp/t307-home.XXXXXX)
    bundled=$(mktemp -d /tmp/t307-bundled.XXXXXX)
    stage_jars "$bundled" || fail "could not stage the eight plugin jars into $bundled"
    jar_count=$(ls "$bundled"/*.jar 2>/dev/null | wc -l | tr -d ' ')
    [ "$jar_count" = "8" ] || fail "expected 8 plugin jars in $bundled, got $jar_count"
    {
        echo "JHIN_HOME=$home"
        echo "JHIN_BUNDLED_PLUGINS=$bundled"
        echo "JHIN_SESSIONS_QA=true"
        echo "JHIN_UI_QAPROBE=true"
        echo "port=$PORT"
        echo "base=$BASE"
        echo "mode=plain HTTP loopback"
        echo "mode-reason=jhin.security is not loaded -> no TlsProvider registered -> the kernel"
        echo "            listener speaks plain HTTP. Plan section 9 allows the QA-only"
        echo "            plain-HTTP mode in scripts."
        echo "port-reason=the kernel default 8443 is occupied by another service on this machine"
        echo "plugins=jhin.sessions, jhin.ui-kit, jhin.ui, jhin.agent, jhin.llm,"
        echo "        jhin.llm-builtin, jhin.tools-builtin, jhin.qa-mock-llm"
        echo "plugin-reason=the T307 bars render from the fixtures/subagent-fixtures.json"
        echo "              scenarios of the qa-timeline probe screen (JHIN_UI_QAPROBE), no live"
        echo "              LLM run is needed; the agent/llm bundle is staged for the dependency"
        echo "              edges the screen registry expects."
    } > "$EVIDENCE/kernel-env-$tag.txt"
    ok "$jar_count jars staged for seeding (kernel-env-$tag.txt)"
}

# ---------------------------------------------------------- --fail mode
if [ "$fail_mode" = "1" ]; then
    echo "== T307 QA --fail: the negative proof must PASS =="

    build_and_test

    seed_home "fail"
    boot_kernel "$home" "$bundled"

    # ---- negative proof a: steps that is not a list -> the unknown card
    log "-- negative proof: the malformed-steps scenario must fall back to the unknown card"
    malformed="$EVIDENCE/malformed.txt"
    {
        echo "T307 --fail: the malformed-steps scenario renders the fallback card."
        echo "The fixture payload {\"id\":\"scout-1\",\"title\":\"Scout\",\"steps\":\"oops\"}"
        echo "carries steps that is not a list — MessageCardBuilder.subagentEventRow"
        echo "returns unknownEventRow(seq, \"subagent\") instead of the bar (the row"
        echo "never throws on any payload shape). The screen must therefore carry"
        echo "the \"Unknown event: subagent\" placeholder text and NO bar for that"
        echo "scenario: no subagent:scout-1 row key and no smart_toy bar icon in"
        echo "the malformed row region, while the two well-formed scenarios keep"
        echo "their subagent:scout-1 bars."
        echo ""
    } > "$malformed"

    fetch_screen_html "qa-timeline" "$EVIDENCE/subagent-fail.html"
    {
        echo "  GET /ui/screen/qa-timeline -> 200 (subagent-fail.html)"
        echo ""
    } >> "$malformed"

    unknown_hits=$(count_matches "$EVIDENCE/subagent-fail.html" 'Unknown event: subagent')
    bar_keys=$(count_matches "$EVIDENCE/subagent-fail.html" 'data-jhin-row-key="subagent:scout-1"')
    [ "$unknown_hits" -ge 1 ] \
        || fail "the screen carries no \"Unknown event: subagent\" fallback text (subagent-fail.html)"
    [ "$bar_keys" = "2" ] \
        || fail "the screen carries $bar_keys subagent:scout-1 bars (expected exactly 2 — the malformed scenario must not add a bar) (subagent-fail.html)"

    region=$(slice "$EVIDENCE/subagent-fail.html" \
        'data-jhin-row-key="event:unknown"' 'data-jhin-type="container"' 1)
    [ -n "$region" ] \
        || fail "the screen carries no event:unknown row region (subagent-fail.html)"
    printf '%s' "$region" > "$EVIDENCE/malformed-region.html"
    region_key=$(count_matches /dev/stdin 'subagent:scout-1' <<< "$region")
    region_icon=$(count_matches /dev/stdin 'smart_toy' <<< "$region")
    region_title=$(count_matches /dev/stdin 'Scout' <<< "$region")
    region_text=$(count_matches /dev/stdin 'Unknown event: subagent' <<< "$region")
    [ "$region_text" -ge 1 ] \
        || fail "the malformed row region carries no \"Unknown event: subagent\" text (malformed-region.html)"
    [ "$region_key" = "0" ] \
        || fail "the malformed row region still carries a subagent:scout-1 bar key (malformed-region.html)"
    [ "$region_icon" = "0" ] \
        || fail "the malformed row region still carries the bar icon smart_toy (malformed-region.html)"
    [ "$region_title" = "0" ] \
        || fail "the malformed row region still carries the bar title \"Scout\" (an empty bar) (malformed-region.html)"
    {
        echo "  malformed row region (the first event:unknown row, extracted from the screen):"
        printf '    %s\n' "$region" | cut -c1-600
        echo ""
        echo "  the fallback card text \"Unknown event: subagent\" is present"
        echo "  ($region_text hit(s) in the region, $unknown_hits on the screen) (PASS)"
        echo "  the malformed scenario renders no bar: no subagent:scout-1 row key"
        echo "  ($region_key hit(s) in the region; $bar_keys bar key(s) on the screen —"
        echo "  only bar-with-steps and bar-only), no smart_toy bar icon ($region_icon"
        echo "  hit(s)), no bar title \"Scout\" ($region_title hit(s)) (PASS)"
        echo ""
        echo "  The malformed-steps scenario degrades to the unknown placeholder card"
        echo "  instead of an empty bar: the negative proof that the subagent row"
        echo "  never throws and never renders a hollow bar on a malformed payload."
    } >> "$malformed"
    ok "malformed-steps -> the \"Unknown event: subagent\" fallback card (malformed.txt)"
    ok "malformed-steps -> no bar in its region (no subagent:scout-1 key, no smart_toy icon) (malformed.txt)"

    ok "T307 QA --fail: the negative proof PASS"
    {
        echo ""
        echo "T307 QA --fail — PASS"
        echo ""
        echo "  mode:              fail"
        echo "  malformed steps:   steps that is not a list renders the Unknown event: subagent"
        echo "                     fallback card with no bar in its region (malformed.txt)"
        echo "  bars kept:         the two well-formed scenarios stay keyed subagent:scout-1"
        echo "                     ($bar_keys bar key(s) on the screen)"
        echo ""
        echo "  evidence: $EVIDENCE"
        sed 's/^/  /' "$checks"
    } >> "$EVIDENCE/summary.txt"
    exit 0
fi

# ------------------------------------------------------------------ happy
echo "== T307 QA: sub-agent activity bars in the run timeline =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

build_and_test

# ------------------------------------------------------- static source gates
echo "== Step 2: the T307 surface in the sources =="
{
    echo "T307 static source gates — the new surface must exist in the sources"
    echo "the wire proofs exercise."
    echo ""
} > "$EVIDENCE/source-gates.txt"
static_ok=1
static_gate() {
    local file=$1 pattern=$2 label=$3 hits
    hits=$(grep -cF -- "$pattern" "$file" 2>/dev/null || true)
    printf '  %-52s %s hit(s)  %s\n' "$label" "$hits" \
        "$([ -n "$hits" ] && [ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" \
        | tee -a "$EVIDENCE/source-gates.txt" >> "$checks"
    [ -n "$hits" ] && [ "$hits" -ge 1 ] || static_ok=0
}
[ -f "$SUBAGENT_FIXTURE" ] || fail "$SUBAGENT_FIXTURE is missing"
static_gate "$MESSAGE_CARD_BUILDER" 'subagent:' 'MessageCardBuilder subagent: row-key construction'
static_gate "$MESSAGE_CARD_BUILDER" 'rowKey(EVENT_SUBAGENT' 'MessageCardBuilder subagent:<id> row key'
static_gate "$MESSAGE_CARD_BUILDER" 'isSubagentPayloadEmpty' 'MessageCardBuilder isSubagentPayloadEmpty'
static_gate "$EVENT_FRAMES" 'isSubagentPayloadEmpty' 'EventFrames isSubagentPayloadEmpty'
static_gate "$SUBAGENT_FIXTURE" 'bar-with-steps' 'subagent-fixtures bar-with-steps scenario'
static_gate "$SUBAGENT_FIXTURE" 'bar-only' 'subagent-fixtures bar-only scenario'
static_gate "$SUBAGENT_FIXTURE" 'malformed-steps' 'subagent-fixtures malformed-steps scenario'
[ "$static_ok" = "1" ] || fail "static source gates failed (see $EVIDENCE/source-gates.txt)"
ok "T307 sources carry the new surface (source-gates.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (eight plugin jars) =="
seed_home "happy"

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (QA helpers on, <= 30 s for health) =="
boot_kernel "$home" "$bundled"

# ------------------------------------------------------- the probe screen
echo "== Step 5: GET /ui/screen/qa-timeline — the fixture-driven subagent bars =="
fetch_screen_html "qa-timeline" "$EVIDENCE/subagent.html"
bar_keys=$(count_matches "$EVIDENCE/subagent.html" 'data-jhin-row-key="subagent:scout-1"')
[ "$bar_keys" -ge 2 ] \
    || fail "the qa-timeline screen carries $bar_keys subagent:scout-1 row key(s) (expected at least 2 — bar-with-steps + bar-only) (subagent.html)"

bar_steps=$(slice "$EVIDENCE/subagent.html" \
    'data-jhin-row-key="subagent:scout-1"' 'data-jhin-row-key="subagent:scout-1"' 1)
[ -n "$bar_steps" ] \
    || fail "the screen carries no bar-with-steps region (subagent.html)"
printf '%s' "$bar_steps" > "$EVIDENCE/bar-with-steps-region.html"
bar_only=$(slice "$EVIDENCE/subagent.html" \
    'data-jhin-row-key="subagent:scout-1"' 'data-jhin-row-key="event:unknown"' 2)
[ -n "$bar_only" ] \
    || fail "the screen carries no bar-only region (subagent.html)"
printf '%s' "$bar_only" > "$EVIDENCE/bar-only-region.html"

steps_align=$(count_matches "$EVIDENCE/bar-with-steps-region.html" 'justify-self: end')
steps_read=$(count_matches "$EVIDENCE/bar-with-steps-region.html" 'read 4 files')
steps_find=$(count_matches "$EVIDENCE/bar-with-steps-region.html" 'find token expiry')
only_align=$(count_matches "$EVIDENCE/bar-only-region.html" 'justify-self: end')
only_summary=$(count_matches "$EVIDENCE/bar-only-region.html" 'Search the codebase')
only_read=$(count_matches "$EVIDENCE/bar-only-region.html" 'read 4 files')
only_find=$(count_matches "$EVIDENCE/bar-only-region.html" 'find token expiry')

[ "$steps_align" -ge 1 ] \
    || fail "the bar-with-steps row carries no right-alignment marker (justify-self: end) (bar-with-steps-region.html)"
[ "$steps_read" -ge 1 ] \
    || fail "the bar-with-steps row carries no nested step text \"read 4 files\" (bar-with-steps-region.html)"
[ "$steps_find" -ge 1 ] \
    || fail "the bar-with-steps row carries no nested step text \"find token expiry\" (bar-with-steps-region.html)"
[ "$only_align" -ge 1 ] \
    || fail "the bar-only row carries no right-alignment marker (justify-self: end) (bar-only-region.html)"
[ "$only_summary" -ge 1 ] \
    || fail "the bar-only region carries no bar content (\"Search the codebase\") (bar-only-region.html)"
[ "$only_read" = "0" ] \
    || fail "the bar-only row still carries nested step text \"read 4 files\" (bar-only-region.html)"
[ "$only_find" = "0" ] \
    || fail "the bar-only row still carries nested step text \"find token expiry\" (bar-only-region.html)"

{
    echo "T307 screen — GET /ui/screen/qa-timeline (subagent.html, the fixture scenarios):"
    echo "  subagent:scout-1 rows: $bar_keys — the bar-with-steps and the bar-only"
    echo "  scenarios both render the right-aligned subagent bar keyed"
    echo "  subagent:<id> (PASS)"
    echo "  right-alignment marker justify-self: end: bar-with-steps $steps_align"
    echo "  hit(s), bar-only $only_align hit(s) — the bars ride right (the"
    echo "  centerRight align of the row container) (PASS)"
    echo "  nested step texts of bar-with-steps: \"read 4 files\" $steps_read hit(s),"
    echo "  \"find token expiry\" $steps_find hit(s) — the indented steps ride"
    echo "  under the bar (PASS)"
    echo "  bar-only without nested steps: \"read 4 files\" $only_read hit(s),"
    echo "  \"find token expiry\" $only_find hit(s), bar content \"Search the codebase\""
    echo "  $only_summary hit(s) — the bare rounded strip (PASS)"
} > "$EVIDENCE/screen-check.txt"
ok "screen: bar rows keyed subagent:scout-1 ($bar_keys) right-aligned (justify-self: end) (subagent.html)"
ok "screen: bar-with-steps carries the nested step texts \"read 4 files\" + \"find token expiry\" (subagent.html)"
ok "screen: bar-only renders without nested step text (subagent.html)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T307 browser steps — UNAVAILABLE in this environment.

Browser automation (the agent browser / screenshots / evaluate) cannot run
on this QA machine; the T202–T208/T301–T306 precedent applies: every
browser step is substituted with curl + static asserts.

Not executed (the plan's interactive/visual cases):
  - Watching the subagent bar slide to the right edge of the timeline lane
    (the centerRight alignment in a real layout): substituted by the
    subagent.html region asserts (the justify-self: end marker on the bar
    rows of bar-with-steps-region.html and bar-only-region.html).
  - Watching the nested steps indent under the bar and the bar-only strip
    render bare: substituted by the region asserts (the step texts inside
    the bar-with-steps region, absent from the bar-only region).
  - Watching the malformed payload degrade to the placeholder card instead
    of an empty bar: substituted by the --fail mode asserts (malformed.txt).

What IS proven here: the served qa-timeline probe screen carries the
subagent bars of the fixture scenarios — keyed subagent:<id>, right-aligned,
with the indented steps of bar-with-steps and the bare bar of bar-only —
all with curl.
EOF
ok "browser-unavailable.txt records the un-exercised visual cases"

# ---------------------------------------------------------------- summary
{
    echo "T307 QA — PASS"
    echo ""
    echo "  mode:              happy"
    echo "  suites:            :jhin-plugin-ui-kit:test $ui_kit_tests, :jhin-plugin-ui-default:test $ui_default_tests (0 failures)"
    echo "  probe screen:      GET /ui/screen/qa-timeline -> subagent.html (fixtures/subagent-fixtures.json)"
    echo "  subagent bars:     $bar_keys rows keyed subagent:scout-1 (bar-with-steps + bar-only), right-aligned"
    echo "                     (justify-self: end), nested steps \"read 4 files\" + \"find token expiry\""
    echo "                     under bar-with-steps, bar-only bare (screen-check.txt)"
    echo "  malformed:         steps that is not a list -> the Unknown event: subagent fallback card"
    echo "                     with no bar — proven in --fail mode"
    echo ""
    echo "  evidence: $EVIDENCE"
    sed 's/^/  /' "$checks"
} > "$EVIDENCE/summary.txt"
ok "T307 QA PASS (summary.txt)"
