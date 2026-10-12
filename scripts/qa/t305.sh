#!/usr/bin/env bash
# T305 QA — real tool cards, collapsible tool groups and live activity rows.
#
# Proves, with a booted kernel, curl and jq only (browser tools are
# UNAVAILABLE in this environment — every browser step becomes
# evidence/T305/browser-unavailable.txt plus strengthened curl asserts, the
# T202–T208/T301–T304 precedent):
#   1. build + test gates: the kernel boot jar and the eight plugin jars
#      build and the two suites stay green (:jhin-plugin-ui-kit:test,
#      :jhin-plugin-ui-default:test — MessageCardBuilderTest, EventKindsTest,
#      StreamRouteTest among them); counts are summed from the JUnit XML
#      reports, failures/errors asserted 0;
#   2. static gates: the T305 sources carry the new surface — the live and
#      done tool rows and the folded group header of MessageCardBuilder
#      (LIVE_TOOL_SHINE, workLiveToolRow, workDoneToolRow, workGroupRow,
#      the "Unknown event: " placeholder), the tool_use/tool_result
#      translation of EventFrames (useTool/settleTool), the synchronous
#      collapse fast-path of timeline.js (initCollapseFastPath,
#      toggleAttribute("hidden")) and the live-tool-shine rule of
#      components.css;
#   3. wire gates: the kernel is booted with jhin.sessions + jhin.ui-kit +
#      jhin.ui + jhin.agent + jhin.llm + jhin.llm-builtin +
#      jhin.tools-builtin + jhin.qa-mock-llm into a temp JHIN_HOME with
#      JHIN_SESSIONS_QA=true (the POST /sessions/{id}/events QA helper) and
#      JHIN_UI_QAPROBE=true. One session is seeded through the QA events
#      endpoint with the real wire payloads (docs/sdui.md section 5):
#      3 adjacent tool_use (id c1..c3, name read) + 3 matching tool_result
#      — the consecutive-same-name fold to one group of count 3 — and 5
#      tool_result events whose structured payloads are real tool-call
#      cards with the five statuses pending/running/success/error/cancelled
#      (the full tool cards). GET /ui/screen/chat:<sessionId> saves the
#      timeline body to timeline.html and proves the 5 real tool-call cards
#      (row key event:tool-call, one card/chevron/body anatomy each) with
#      the five status chips Pending/Running/Done/Error/Cancelled plus the
#      6 work rows of the folded run. GET /ui/stream/session/<id>?fromSeq=0
#      saves the translated replay to frames.jsonl and proves node/replace
#      frames with ev- ids, the live tool row carrying the live-tool-shine
#      layer (the LiveActivityRow shine) and the folded workGroupRow group
#      header with the count badge 3;
#   4. expand.txt: the tool-card chevron of the screen HTML carries exactly
#      one data-jhin-action {"op":"patch","id":"ev-<seq>-body","html":…} —
#      the expansion patches ONLY the body element, never the card or the
#      row — and the body element ships in the DOM behind the bare hidden
#      attribute; timeline.js toggles hidden client-side
#      (initCollapseFastPath, toggleAttribute("hidden")). The greps and
#      quotes land in expand.txt;
#   5. browser-unavailable.txt: the chevron click, the shine animation and
#      the live group fold cannot be exercised here; the file names the
#      curl + static substitutes;
#   6. summary.txt with every PASS line and the key numbers.
#
# Note on the group fold: the ChatScreen history renderer emits one row per
# stored event (the T101 design, unchanged by T305); the consecutive
# tool_use fold of EventFrames.Translator is the event-stream translation
# the live client materializes into the timeline DOM. The group header with
# the count badge is therefore asserted on frames.jsonl — the plan's
# "session HTML" is the screen body plus the stream frames.
#
# --fail mode (the negative proof — must PASS, exit 0, into checks-fail.txt):
#   a. an unknown tool name never throws and renders the documented
#      placeholder instead of a broken card: one tool_use with a blank name
#      and one tool_result whose structured tool-call payload carries a
#      blank name on the real payload shape (the arguments key —
#      MessageCardBuilderTest
#      aBlankToolNameOnTheRealPayloadFallsBackToTheUnknownPlaceholderCard)
#      answer 200 and the screen renders the "Unknown event: tool-call"
#      placeholder card -> unknown-tool.txt. (A structured payload without
#      the arguments key is the synthetic demo shape and renders the
#      nameless standard card, not the placeholder — the placeholder proof
#      needs the real payload shape.)
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
# On any failure one line is appended to evidence/T305/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T305_INNER:-}" ]; then
    exec env T305_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."
ROOT="$(pwd)"

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
    fail_mode=1
    shift
fi

EVIDENCE="${1:-$ROOT/.sisyphus/evidence/T305}"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage'
MESSAGE_CARD_BUILDER="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/MessageCardBuilder.java"
EVENT_FRAMES="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/EventFrames.java"
TIMELINE_JS="plugins/ui-default/src/main/resources/web/js/timeline.js"
COMPONENTS_CSS="plugins/ui-default/src/main/resources/web/css/components.css"
PLUGINS="sessions ui-kit ui-default agent llm llm-builtin tools-builtin qa-mock-llm"

mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/failures.txt"
if [ "$fail_mode" = "1" ]; then
    checks="$EVIDENCE/checks-fail.txt"
else
    checks="$EVIDENCE/checks.txt"
fi
: > "$checks"
if [ "$fail_mode" = "0" ]; then
    : > "$EVIDENCE/frames.jsonl"
fi

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
        code=$(curl -s --max-time 2 -o "$EVIDENCE/health.body" -w '%{http_code}' \
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

# create_session <title> <workdir-json> -> prints the session id. The workdir
# is a JSON string fragment ("\"/tmp/t305/wd\"").
create_session() {
    local title=$1 workdir=$2 code id
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
        -o "$EVIDENCE/session-$title.json" -w '%{http_code}' \
        -d "{\"title\":\"$title\",\"workdir\":$workdir}" "$BASE/sessions") \
        || fail "POST /sessions ($title): curl failed"
    [ "$code" = "201" ] || fail "POST /sessions ($title) answered $code (expected 201): $(cat "$EVIDENCE/session-$title.json")"
    id=$(jq -r '.id' "$EVIDENCE/session-$title.json")
    [ -n "$id" ] && [ "$id" != "null" ] || fail "POST /sessions ($title) returned no id"
    printf '%s\n' "$id"
}

# post_event <session-id> <wire-type> <payload-json> <out>: appends one
# event through the JHIN_SESSIONS_QA helper (POST /sessions/{id}/events,
# body {"type":…,"payload":…}) and asserts the 201.
post_event() {
    local id=$1 type=$2 payload=$3 out=$4 code
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
        -o "$out" -w '%{http_code}' \
        -d "{\"type\":\"$type\",\"payload\":$payload}" "$BASE/sessions/$id/events") \
        || fail "POST /sessions/$id/events ($type): curl failed"
    [ "$code" = "201" ] || fail "POST /sessions/$id/events ($type) answered $code (expected 201): $(cat "$out")"
}

# fetch_chat_html <session-id> <out>: GET /ui/screen/chat:<id> and the
# timeline HTML body (the screen answers {"id":…,"html":…}).
fetch_chat_html() {
    local id=$1 out=$2 code
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/screen.json" \
        -w '%{http_code}' "$BASE/ui/screen/chat:$id") \
        || fail "GET /ui/screen/chat:$id: curl failed"
    [ "$code" = "200" ] || fail "GET /ui/screen/chat:$id answered $code (expected 200): $(cat "$EVIDENCE/screen.json")"
    jq -r '.html' "$EVIDENCE/screen.json" > "$out"
    [ -s "$out" ] || fail "the chat screen carries no HTML ($out)"
}

# fetch_frames <session-id> <out>: the SSE replay of the session stream
# (fromSeq=0 is the full history) — the data: lines are the SDUI frames.
fetch_frames() {
    local id=$1 out=$2
    curl -s -N --max-time 10 -H "$CLIENT_API4" \
        "$BASE/ui/stream/session/$id?fromSeq=0" 2>/dev/null \
        | grep '^data: ' | sed 's/^data: //' > "$out" || true
    [ -s "$out" ] || fail "the session stream replayed no frames ($out)"
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
        echo "T305 test gates — the two suites green on the tool-card surface:"
        grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
        echo ""
        echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests"
        echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (MessageCardBuilderTest, EventKindsTest, StreamRouteTest among them)"
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

# ---------------------------------------------------------- --fail mode
if [ "$fail_mode" = "1" ]; then
    echo "== T305 QA --fail: the negative proof must PASS =="

    build_and_test

    home=$(mktemp -d /tmp/t305-home.XXXXXX)
    bundled=$(mktemp -d /tmp/t305-bundled.XXXXXX)
    stage_jars "$bundled" || fail "could not stage the eight plugin jars into $bundled"
    boot_kernel "$home" "$bundled"

    # ---- negative proof a: blank tool name -> Unknown event placeholder
    log "-- negative proof: a blank tool name must render the Unknown event placeholder, never throw"
    unknown="$EVIDENCE/unknown-tool.txt"
    {
        echo "T305 --fail: a tool payload with a blank name is an unknown tool."
        echo "The renderer never throws and never emits a broken card: the real"
        echo "tool-call payload shape (the arguments key) with a blank name"
        echo "degrades to the documented \"Unknown event: <kind>\" placeholder"
        echo "card (MessageCardBuilderTest"
        echo "aBlankToolNameOnTheRealPayloadFallsBackToTheUnknownPlaceholderCard,"
        echo "MessageCardBuilder.unknownEventRow)."
        echo ""
    } > "$unknown"

    f=$(create_session "fail-unknown" '"/tmp/t305/fail"')
    post_event "$f" "tool_use" \
        '{"id":"u1","name":"","arguments":"{\"path\":\"x\"}"}' \
        "$EVIDENCE/fail-event-tool-use.json"
    post_event "$f" "tool_result" \
        '{"id":"r1","name":"","structured":{"type":"tool-call","name":"","status":"error","arguments":"{}"}}' \
        "$EVIDENCE/fail-event-tool-result.json"
    {
        echo "  seed: POST /sessions -> $f (fail-unknown)"
        echo "  POST /sessions/$f/events tool_use {\"id\":\"u1\",\"name\":\"\",\"arguments\":\"{\\\"path\\\":\\\"x\\\"}\"} -> 201"
        echo "  POST /sessions/$f/events tool_result {\"id\":\"r1\",\"name\":\"\",\"structured\":"
        echo "    {\"type\":\"tool-call\",\"name\":\"\",\"status\":\"error\",\"arguments\":\"{}\"}} -> 201"
        echo ""
    } >> "$unknown"

    fetch_chat_html "$f" "$EVIDENCE/fail-timeline.html"
    {
        echo "  GET /ui/screen/chat:$f -> 200 (the blank name never throws) (PASS)"
        echo ""
    } >> "$unknown"
    hits=$(count_matches "$EVIDENCE/fail-timeline.html" 'Unknown event: ')
    [ "$hits" -ge 1 ] \
        || fail "the chat screen renders no Unknown event placeholder for a blank tool name (fail-timeline.html)"
    {
        echo "  the screen renders the placeholder card instead of a broken card"
        echo "  ($hits \"Unknown event: \" occurrence(s) in fail-timeline.html) (PASS):"
        grep -o 'Unknown event: [^<]*' "$EVIDENCE/fail-timeline.html" | sort -u | sed 's/^/    /'
        echo ""
        echo "  Unknown event: tool-call is the placeholder row (row key"
        echo "  event:unknown) of the standard tool-card dispatch — the blank"
        echo "  name on the real payload shape degrades, the request answers 200."
    } >> "$unknown"
    ok "blank tool name -> \"Unknown event: tool-call\" placeholder, screen 200 (unknown-tool.txt)"

    ok "T305 QA --fail: the negative proof PASS"
    exit 0
fi

# ------------------------------------------------------------------ happy
echo "== T305 QA: real tool cards, collapsible tool groups and live activity rows =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

build_and_test

# ------------------------------------------------------- static source gates
echo "== Step 2: the T305 surface in the sources =="
{
    echo "T305 static source gates — the new surface must exist in the sources"
    echo "the wire proofs exercise."
    echo ""
} > "$EVIDENCE/source-gates.txt"
static_ok=1
static_gate() {
    local file=$1 pattern=$2 label=$3 hits
    hits=$(grep -cF -- "$pattern" "$file" || true)
    printf '  %-52s %s hit(s)  %s\n' "$label" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" >> "$EVIDENCE/source-gates.txt"
    [ "$hits" -ge 1 ] || static_ok=0
}
static_gate "$MESSAGE_CARD_BUILDER" 'LIVE_TOOL_SHINE' 'MessageCardBuilder live-tool-shine constant'
static_gate "$MESSAGE_CARD_BUILDER" 'workLiveToolRow' 'MessageCardBuilder live tool row'
static_gate "$MESSAGE_CARD_BUILDER" 'workDoneToolRow' 'MessageCardBuilder done tool row'
static_gate "$MESSAGE_CARD_BUILDER" 'workGroupRow' 'MessageCardBuilder folded group row'
static_gate "$MESSAGE_CARD_BUILDER" 'Unknown event: ' 'MessageCardBuilder Unknown event placeholder'
static_gate "$EVENT_FRAMES" 'useTool' 'EventFrames tool_use translation'
static_gate "$EVENT_FRAMES" 'settleTool' 'EventFrames tool_result translation'
static_gate "$TIMELINE_JS" 'initCollapseFastPath' 'timeline.js collapse fast-path'
static_gate "$TIMELINE_JS" 'toggleAttribute("hidden")' 'timeline.js hidden toggle'
static_gate "$COMPONENTS_CSS" 'live-tool-shine' 'components.css live-tool-shine rule'
[ "$static_ok" = "1" ] || fail "static source gates failed (see $EVIDENCE/source-gates.txt)"
ok "T305 sources carry the new surface (source-gates.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (eight plugin jars) =="
home=$(mktemp -d /tmp/t305-home.XXXXXX)
bundled=$(mktemp -d /tmp/t305-bundled.XXXXXX)
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
    echo "plugin-reason=the T305 timeline is driven by the real tool event payloads of"
    echo "              the sessions QA helper (JHIN_SESSIONS_QA), no live LLM run is"
    echo "              needed; the agent/llm bundle is staged for the dependency edges"
    echo "              the chat screen expects."
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding (kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (QA helpers on, <= 30 s for health) =="
boot_kernel "$home" "$bundled"

# ------------------------------------------------------------------- seed
echo "== Step 5: seed one session with the real tool event payloads =="
s=$(create_session "qa-tools" '"/tmp/t305/wd"')
for i in 1 2 3; do
    post_event "$s" "tool_use" \
        '{"id":"c'"$i"'","name":"read","arguments":"{\"path\":\"README.md\"}"}' \
        "$EVIDENCE/event-tool-use-c$i.json"
done
for i in 1 2 3; do
    post_event "$s" "tool_result" \
        '{"id":"c'"$i"'","name":"read","content":"hello"}' \
        "$EVIDENCE/event-tool-result-c$i.json"
done
i=0
for st in pending running success error cancelled; do
    i=$((i + 1))
    post_event "$s" "tool_result" \
        '{"id":"s'"$i"'","name":"write","structured":{"type":"tool-call","name":"write","status":"'"$st"'","arguments":"{\"path\":\"a.txt\"}"}}' \
        "$EVIDENCE/event-tool-result-s$i.json"
done
{
    echo "T305 seeding — the sessions QA helper (POST /sessions/{id}/events):"
    echo "  qa-tools -> $s (workdir /tmp/t305/wd)"
    echo "  3 adjacent tool_use (c1..c3, name read, arguments {\"path\":\"README.md\"})"
    echo "  + 3 matching tool_result (c1..c3, content hello) — the consecutive"
    echo "    same-name run that folds into one group of count 3"
    echo "  + 5 tool_result (s1..s5, name write) with structured tool-call cards"
    echo "    of the five statuses: pending, running, success, error, cancelled"
} > "$EVIDENCE/seeded.txt"
ok "seeded 11 tool events on session $s via POST /sessions/{id}/events (seeded.txt)"

# ------------------------------------------------------- the screen timeline
echo "== Step 6: GET /ui/screen/chat:<id> — tool cards with the five chips =="
fetch_chat_html "$s" "$EVIDENCE/timeline.html"
cards=$(count_matches "$EVIDENCE/timeline.html" 'data-jhin-row-key="event:tool-call"')
[ "$cards" = "5" ] \
    || fail "the chat screen renders $cards tool-call cards (expected 5) (timeline.html)"
chevron_anatomy=$(count_matches "$EVIDENCE/timeline.html" '-chevron"')
[ "$chevron_anatomy" -ge 5 ] \
    || fail "the tool cards carry no chevron anatomy (chevron markers: $chevron_anatomy) (timeline.html)"
body_anatomy=$(count_matches "$EVIDENCE/timeline.html" '-body" hidden')
[ "$body_anatomy" -ge 5 ] \
    || fail "the tool cards carry no hidden body anatomy (body markers: $body_anatomy) (timeline.html)"
work_rows=$(count_matches "$EVIDENCE/timeline.html" 'data-jhin-row-key="work:log"')
[ "$work_rows" = "6" ] \
    || fail "the folded run renders $work_rows work rows (expected 6: 3 tool_use + 3 tool_result) (timeline.html)"
for chip in Pending Running Done Error Cancelled; do
    hits=$(count_matches "$EVIDENCE/timeline.html" ">$chip<")
    [ "$hits" -ge 1 ] || fail "the chat screen is missing the $chip status chip (timeline.html)"
    printf '  chip %-10s %s hit(s)\n' "$chip" "$hits" >> "$checks"
done
ok "chat screen: 5 real tool-call cards with the five status chips (timeline.html)"
ok "chat screen: 6 work rows of the 3-call folded run (work:log) (timeline.html)"

# ------------------------------------------------------- the stream frames
echo "== Step 7: GET /ui/stream/session/<id>?fromSeq=0 — the translated frames =="
fetch_frames "$s" "$EVIDENCE/frames.jsonl"
frames_count=$(wc -l < "$EVIDENCE/frames.jsonl" | tr -d ' ')
node_count=$(jq -r 'select(.node) | 1' "$EVIDENCE/frames.jsonl" | wc -l | tr -d ' ')
replace_count=$(jq -r 'select(.replace) | 1' "$EVIDENCE/frames.jsonl" | wc -l | tr -d ' ')
[ "$frames_count" -ge 11 ] \
    || fail "the replay carries $frames_count frames (expected at least 11 for the 11 seeded events) (frames.jsonl)"
[ "$node_count" -ge 6 ] && [ "$replace_count" -ge 5 ] \
    || fail "the replay carries $node_count node / $replace_count replace frames (expected >= 6 / >= 5) (frames.jsonl)"
jq -e -s 'all(.[]; (keys | length) == 1 and (keys[0] == "node" or keys[0] == "replace"
    or keys[0] == "patch" or keys[0] == "remove" or keys[0] == "client"))' \
    "$EVIDENCE/frames.jsonl" > /dev/null \
    || fail "frames.jsonl carries a line that is not a frame envelope"
bad_ids=$(jq -r 'select(.node or .replace) | (.node // .replace).id' "$EVIDENCE/frames.jsonl" \
    | { grep -vE '^ev-[0-9]+$' || true; } | wc -l | tr -d ' ')
[ "$bad_ids" = "0" ] \
    || fail "node/replace frames carry ids outside the ev-<seq> vocabulary (frames.jsonl)"
group_headers=$(jq -r 'select(.replace) | .replace.html' "$EVIDENCE/frames.jsonl" \
    | count_matches /dev/stdin 'data-jhin-row-key="work:group"')
count_badges=$(jq -r 'select(.replace) | .replace.html' "$EVIDENCE/frames.jsonl" \
    | count_matches /dev/stdin 'jhin-badge">3<')
group_toggles=$(jq -r 'select(.replace) | .replace.html' "$EVIDENCE/frames.jsonl" \
    | count_matches /dev/stdin '-toggle"')
[ "$group_headers" -ge 1 ] \
    || fail "the folded run carries no workGroupRow group header on the stream (frames.jsonl)"
[ "$count_badges" -ge 1 ] \
    || fail "the group header carries no count badge 3 (frames.jsonl)"
[ "$group_toggles" -ge 1 ] \
    || fail "the group header carries no ev-<seq>-toggle line (frames.jsonl)"
shine_rows=$(jq -r 'select(.node) | .node.html' "$EVIDENCE/frames.jsonl" \
    | count_matches /dev/stdin 'live-tool-shine')
[ "$shine_rows" -ge 1 ] \
    || fail "the live tool row carries no live-tool-shine layer (frames.jsonl)"
{
    echo "T305 stream replay — GET /ui/stream/session/$s?fromSeq=0 (frames.jsonl):"
    echo "  $frames_count frames: $node_count node / $replace_count replace, every"
    echo "  node/replace id is ev-<seq>"
    echo "  the consecutive tool_use run folds to one workGroupRow group header"
    echo "  (row key work:group) carrying the count badge 3 — $group_headers replace"
    echo "  frame(s) of the header, $count_badges with the settled count badge 3"
    echo "  the live tool row carries the live-tool-shine layer ($shine_rows node"
    echo "  frame(s)) — the LiveActivityRow shine of a running call"
    echo ""
    echo "  sample group header (the last replace frame):"
    jq -r 'select(.replace) | .replace.html' "$EVIDENCE/frames.jsonl" | tail -1 \
        | sed 's/^/    /' | cut -c1-400
} > "$EVIDENCE/frames-check.txt"
ok "frames: $node_count node / $replace_count replace with ev- ids (frames.jsonl)"
ok "group fold: workGroupRow header with the count badge 3 on the event stream (frames.jsonl)"
ok "live activity row: live-tool-shine on the running tool row (frames.jsonl)"

# ------------------------------------------------------------- expansion
echo "== Step 8: expansion patches only ev-<seq>-body (expand.txt) =="
chevron=$( { grep -o '<[^>]*data-jhin-id="ev-[0-9]*-chevron"[^>]*>' "$EVIDENCE/timeline.html" || true; } | head -1)
[ -n "$chevron" ] || fail "the chat screen carries no tool-card chevron (timeline.html)"
chevron_id=$(printf '%s' "$chevron" | { grep -o 'data-jhin-id="ev-[0-9]*-chevron"' || true; } | head -1 \
    | sed 's/.*ev-//;s/-chevron"//')
[ -n "$chevron_id" ] || fail "could not read the chevron row id out of the screen (timeline.html)"
action=$(printf '%s' "$chevron" | { grep -o "data-jhin-action='[^']*'" || true; } | head -1 \
    | sed "s/^data-jhin-action='//;s/'\$//")
[ -n "$action" ] || fail "the tool-card chevron carries no data-jhin-action (timeline.html)"
action_json=$(printf '%s' "$action" \
    | sed 's/&quot;/"/g; s/&#39;/'"'"'/g; s/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g')
printf '%s' "$action_json" | jq -e --arg body "ev-$chevron_id-body" '
        .op == "patch"
        and .id == $body
        and (.html | length > 0)
        and (keys == ["html","id","op"])
    ' > /dev/null \
    || fail "the chevron action is not a single patch targeting only ev-$chevron_id-body: $action_json"
body_tag=$( { grep -o '<[^>]*data-jhin-id="ev-'"$chevron_id"'-body"[^>]*>' "$EVIDENCE/timeline.html" || true; } | head -1)
[ -n "$body_tag" ] || fail "the tool card carries no ev-$chevron_id-body element (timeline.html)"
printf '%s' "$body_tag" | grep -q ' hidden[ >]' \
    || fail "the body element does not carry the bare hidden attribute: $body_tag"
if printf '%s' "$body_tag" | grep -q 'hidden='; then
    fail "the body hidden attribute is not bare: $body_tag"
fi
grep -qF 'initCollapseFastPath' "$TIMELINE_JS" \
    || fail "timeline.js does not register the collapse fast-path"
grep -qF 'toggleAttribute("hidden")' "$TIMELINE_JS" \
    || fail "timeline.js does not toggle the hidden attribute client-side"
{
    echo "T305 expansion — the chevron patches ONLY the body, client-side."
    echo ""
    echo "screen HTML (timeline.html), the tool-card chevron of row ev-$chevron_id:"
    printf '  %s\n' "$chevron" | cut -c1-400
    echo ""
    echo "  data-jhin-action unescaped -> one patch directive (jq assert PASS):"
    printf '%s\n' "$action_json" | jq -c '{op: .op, id: .id, htmlBytes: (.html | length)}' | sed 's/^/    /'
    echo "    keys == [\"html\",\"id\",\"op\"] and .id == \"ev-$chevron_id-body\" — the"
    echo "    expansion patches ONLY the body element, never the card or the row;"
    echo "    .html carries the rendered body content the patch swaps in."
    echo ""
    echo "screen HTML (timeline.html), the body element behind the expansion:"
    printf '  %s\n' "$body_tag"
    echo "    bare hidden attribute (HTML boolean) — the body ships collapsed;"
    echo "    no hidden= value form is used."
    echo ""
    echo "timeline.js client-side toggle (greps, quoted):"
    grep -nF 'initCollapseFastPath' "$TIMELINE_JS" | sed 's/^/  /'
    grep -nF 'toggleAttribute("hidden")' "$TIMELINE_JS" | sed 's/^/  /'
    echo "    the bubble-phase fast-path flips hidden on the already-rendered"
    echo "    ev-<seq>-body before the patch round-trip; the generic action"
    echo "    patch stays the source of truth."
} > "$EVIDENCE/expand.txt"
ok "chevron action is one patch targeting ev-$chevron_id-body only (expand.txt)"
ok "body element carries the bare hidden attribute (expand.txt)"
ok "timeline.js toggles hidden client-side (expand.txt)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T305 browser steps — UNAVAILABLE in this environment.

Browser tooling (the agent browser / screenshots / evaluate) cannot run on
this QA machine; the T202–T208/T301–T304 precedent applies: every browser
step is recorded here and substituted with curl + static asserts.

Not executed (the plan's interactive/visual cases):
  - Clicking the tool-card chevron and watching the body expand: substituted
    by the expand.txt asserts (the chevron carries exactly one
    {"op":"patch","id":"ev-<seq>-body"} directive, the body ships with the
    bare hidden attribute, and timeline.js initCollapseFastPath toggles
    hidden client-side).
  - The LiveActivityRow shine animation over a running tool card: substituted
    by the frames.jsonl assert (the live node frame carries the
    live-tool-shine layer) and the components.css live-tool-shine rule.
  - The live fold of consecutive tool calls into one group header: substituted
    by the frames.jsonl asserts (workGroupRow replace frames carrying the
    count badge 3).

What IS proven here: the served chat screen renders the 5 real tool-call
cards with the five status chips, the SSE replay translates the same events
into node/replace frames with ev- ids, the folded group header carries the
count badge 3, and the --fail mode proves a blank tool name degrades to the
"Unknown event: tool-call" placeholder without throwing.
EOF
ok "browser-unavailable.txt records the un-exercised visual cases"

# ---------------------------------------------------------------- summary
{
    echo "T305 QA — PASS"
    echo ""
    echo "  mode:              happy"
    echo "  suites:            :jhin-plugin-ui-kit:test $ui_kit_tests, :jhin-plugin-ui-default:test $ui_default_tests (0 failures)"
    echo "  tool cards:        5 real tool-call cards (event:tool-call) with the five status chips"
    echo "                     Pending/Running/Done/Error/Cancelled (timeline.html)"
    echo "  folded run:        6 work rows of the 3-call run on the screen (timeline.html);"
    echo "                     the fold to one workGroupRow header with the count badge 3 lives"
    echo "                     on the event stream translation (frames.jsonl)"
    echo "  frames:            $frames_count frames — $node_count node / $replace_count replace with ev- ids,"
    echo "                     the live tool row carries live-tool-shine (frames.jsonl)"
    echo "  expansion:         the chevron action is a single patch targeting ev-<seq>-body only,"
    echo "                     the body carries the bare hidden attribute and timeline.js toggles"
    echo "                     hidden client-side (expand.txt)"
    echo "  negative:          a blank tool name renders the \"Unknown event: tool-call\""
    echo "                     placeholder and never throws (proven in --fail mode)"
    echo ""
    echo "  evidence: $EVIDENCE"
    sed 's/^/  /' "$checks"
} > "$EVIDENCE/summary.txt"
ok "T305 QA PASS (summary.txt)"
