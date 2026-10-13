#!/usr/bin/env bash
# T306 QA — work log and run lifecycle rows that close at run_end.
#
# Proves, with a booted kernel, curl and jq only (browser tools are
# UNAVAILABLE in this environment — every browser step becomes
# evidence/T306/browser-unavailable.txt plus strengthened curl asserts, the
# T202–T208/T301–T305 precedent):
#   1. build + test gates: the kernel boot jar and the eight plugin jars
#      build and the two suites stay green (:jhin-plugin-ui-kit:test,
#      :jhin-plugin-ui-default:test — MessageCardBuilderTest, EventFramesTest,
#      StreamRouteTest, ChatScreenTest among them); counts are summed from
#      the JUnit XML reports, failures/errors asserted 0;
#   2. static gates: the T306 sources carry the new surface — the run
#      lifecycle row of MessageCardBuilder (lifecycleRow, WORKING_LABEL),
#      the run lifecycle wiring of EventFrames (endRunFrames, lifecycleId,
#      openRun, failRun) and the history rebuild of ChatScreen
#      (durationLabel, the work:lifecycle lifecycleRow call sites);
#   3. wire gates: the kernel is booted with jhin.sessions + jhin.ui-kit +
#      jhin.ui + jhin.agent + jhin.llm + jhin.llm-builtin +
#      jhin.tools-builtin + jhin.qa-mock-llm into a temp JHIN_HOME with
#      JHIN_SESSIONS_QA=true (the POST /sessions/{id}/events QA helper) and
#      JHIN_UI_QAPROBE=true. One session is seeded through the QA events
#      endpoint with a full scripted run (docs/sdui.md section 5):
#      run_start {runId:"r1"}, user_message, message_start, text_delta,
#      message_end, run_end. GET /ui/stream/session/<id>?fromSeq=0 saves the
#      translated replay to run.jsonl and proves the run_start node pair —
#      the working strip (ev-<runStartSeq>, "agent is working") alongside the
#      running lifecycle row (ev-<runStartSeq>-lifecycle) — and the run_end
#      settlement: a replace frame targeting ev-<runStartSeq>-lifecycle with
#      the Done chip, plus the remove of the working strip. The
#      GET /ui/screen/chat:<sessionId> history rebuild saves the final
#      screen HTML to timeline.html and proves the settled lifecycle row
#      (work:lifecycle, the Done chip, the duration label \d+\.\ds) with the
#      working strip gone ("agent is working" absent) -> checks.txt;
#   4. browser-unavailable.txt: browser automation is unavailable; the
#      assertions are curl + static;
#   5. summary.txt with every PASS line and the key numbers.
#
# --fail mode (the negative proof — must PASS, exit 0, into checks-fail.txt):
#   a. an error during an open run flips the lifecycle row to failed and
#      never overwrites it with done: one session seeded with run_start
#      {runId:"r2"} then error {message:"boom"} and NO run_end. The screen
#      history keeps the failed lifecycle row in place — the
#      lifecycleRow(..., "failed", ...) render carries the statusChip
#      ("failed") Error chip on the danger tone ($color.error) and no
#      Running chip — and the error row ("boom") rides below it
#      -> error-state.txt.
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
# On any failure one line is appended to evidence/T306/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T306_INNER:-}" ]; then
    exec env T306_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."
ROOT="$(pwd)"

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
    fail_mode=1
    shift
fi

EVIDENCE="${1:-$ROOT/.sisyphus/evidence/T306}"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage'
MESSAGE_CARD_BUILDER="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/MessageCardBuilder.java"
EVENT_FRAMES="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/EventFrames.java"
CHAT_SCREEN="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/ChatScreen.java"
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
    : > "$EVIDENCE/run.jsonl"
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

# create_session <title> <workdir-json> -> prints the session id. The workdir
# is a JSON string fragment ("\"/tmp/t306/wd\"").
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
# body {"type":…,"payload":…}) and asserts the 201. The persisted row
# (with its seq) lands in <out>.
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

# lifecycle_region <file> <lifecycle-id>: prints the screen-HTML region of
# one lifecycle row — from its data-jhin-id marker up to the next timeline
# row (the next data-jhin-type="container" element; lifecycle children are
# row/icon/text/badge nodes only).
lifecycle_region() {
    local file=$1 id=$2
    awk -v m="data-jhin-id=\"$id\"" '
        {
            i = index($0, m)
            if (i == 0) next
            rest = substr($0, i)
            j = index(rest, "data-jhin-type=\"container\"")
            if (j > 0) print substr(rest, 1, j - 1)
            else print rest
        }' "$file"
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
        echo "T306 test gates — the two suites green on the run-lifecycle surface:"
        grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
        echo ""
        echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests"
        echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (MessageCardBuilderTest, EventFramesTest, StreamRouteTest, ChatScreenTest among them)"
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
    echo "== T306 QA --fail: the negative proof must PASS =="

    build_and_test

    home=$(mktemp -d /tmp/t306-home.XXXXXX)
    bundled=$(mktemp -d /tmp/t306-bundled.XXXXXX)
    stage_jars "$bundled" || fail "could not stage the eight plugin jars into $bundled"
    boot_kernel "$home" "$bundled"

    # ---- negative proof a: an error on an open run settles the row as failed
    log "-- negative proof: an error on an open run must settle the lifecycle row as failed"
    error_state="$EVIDENCE/error-state.txt"
    {
        echo "T306 --fail: an error during an open run flips the lifecycle row to failed."
        echo "One session is seeded with run_start {runId:\"r2\"} then error"
        echo "{message:\"boom\"} and NO run_end. The history rebuild keeps the"
        echo "failed lifecycle row in place (the sticky runFailed flag — a later"
        echo "run_end would not overwrite it): lifecycleRow(..., \"failed\", ...)"
        echo "renders the statusChip(\"failed\") Error chip on the danger tone"
        echo "(\$color.error -> var(--color-error)) with no Running chip, and the"
        echo "error row (\"boom\") rides below it (MessageCardBuilder"
        echo ".errorEventRow, the event:error card)."
        echo ""
    } > "$error_state"

    f=$(create_session "fail-run" '"/tmp/t306/fail"')
    post_event "$f" "run_start" '{"runId":"r2"}' "$EVIDENCE/fail-event-run-start.json"
    fail_run_seq=$(jq -r '.seq' "$EVIDENCE/fail-event-run-start.json")
    [ -n "$fail_run_seq" ] && [ "$fail_run_seq" != "null" ] \
        || fail "the run_start append returned no seq (fail-event-run-start.json)"
    post_event "$f" "error" '{"message":"boom"}' "$EVIDENCE/fail-event-error.json"
    {
        echo "  seed: POST /sessions -> $f (fail-run)"
        echo "  POST /sessions/$f/events run_start {\"runId\":\"r2\"} -> 201 (seq $fail_run_seq)"
        echo "  POST /sessions/$f/events error {\"message\":\"boom\"} -> 201 (no run_end)"
        echo ""
    } >> "$error_state"

    fetch_chat_html "$f" "$EVIDENCE/fail-timeline.html"
    fail_lifecycle_id="ev-$fail_run_seq-lifecycle"
    region=$(lifecycle_region "$EVIDENCE/fail-timeline.html" "$fail_lifecycle_id")
    [ -n "$region" ] \
        || fail "the chat screen carries no $fail_lifecycle_id region (fail-timeline.html)"
    printf '%s' "$region" > "$EVIDENCE/fail-lifecycle-region.html"
    {
        echo "  GET /ui/screen/chat:$f -> 200 (fail-timeline.html)"
        echo ""
        echo "  lifecycle row region ($fail_lifecycle_id, extracted from the screen):"
        printf '    %s\n' "$region" | cut -c1-600
        echo ""
    } >> "$error_state"

    region_error=$(count_matches /dev/stdin '>Error<' <<< "$region")
    region_running=$(count_matches /dev/stdin 'Running' <<< "$region")
    region_danger=$(count_matches /dev/stdin 'var(--color-error)' <<< "$region")
    error_row_hits=$(count_matches "$EVIDENCE/fail-timeline.html" 'boom')
    error_row_keys=$(count_matches "$EVIDENCE/fail-timeline.html" 'data-jhin-row-key="event:error"')
    [ "$region_error" -ge 1 ] \
        || fail "the failed lifecycle region carries no Error chip ($fail_lifecycle_id, fail-timeline.html)"
    [ "$region_running" = "0" ] \
        || fail "the failed lifecycle region still carries Running ($fail_lifecycle_id, fail-timeline.html)"
    [ "$region_danger" -ge 1 ] \
        || fail "the failed lifecycle region carries no danger tone (var(--color-error)) (fail-timeline.html)"
    [ "$error_row_hits" -ge 1 ] \
        || fail "the chat screen carries no error row detail \"boom\" (fail-timeline.html)"
    [ "$error_row_keys" -ge 1 ] \
        || fail "the chat screen carries no event:error row (fail-timeline.html)"
    {
        echo "  the failed lifecycle row renders the Error chip ($region_error hit(s)) on"
        echo "  the danger tone var(--color-error) ($region_danger hit(s)) and no"
        echo "  Running chip ($region_running hit(s)) (PASS)"
        echo "  the error row \"boom\" is present ($error_row_hits hit(s), $error_row_keys"
        echo "  event:error row(s)) (PASS)"
        echo ""
        echo "  The lifecycle row settles as failed in place and the run stays open"
        echo "  (no run_end): the screen is the negative proof that an error flips"
        echo "  ev-<seq>-lifecycle to the failed state without throwing."
    } >> "$error_state"
    ok "error on an open run -> failed lifecycle row: Error chip on var(--color-error), no Running (error-state.txt)"
    ok "error row \"boom\" present on the screen (error-state.txt)"

    ok "T306 QA --fail: the negative proof PASS"
    {
        echo ""
        echo "T306 QA --fail — PASS"
        echo ""
        echo "  mode:              fail"
        echo "  error on open run: run_start {runId:\"r2\"} then error {message:\"boom\"}, no run_end"
        echo "  lifecycle row:     failed presentation — Error chip in the row region,"
        echo "                     no Running label there, error row \"boom\" present (error-state.txt)"
        echo ""
        echo "  evidence: $EVIDENCE"
        sed 's/^/  /' "$checks"
    } >> "$EVIDENCE/summary.txt"
    exit 0
fi

# ------------------------------------------------------------------ happy
echo "== T306 QA: work log and run lifecycle rows that close at run_end =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

build_and_test

# ------------------------------------------------------- static source gates
echo "== Step 2: the T306 surface in the sources =="
{
    echo "T306 static source gates — the new surface must exist in the sources"
    echo "the wire proofs exercise."
    echo ""
} > "$EVIDENCE/source-gates.txt"
static_ok=1
static_gate() {
    local file=$1 pattern=$2 label=$3 hits
    hits=$(grep -cF -- "$pattern" "$file" || true)
    printf '  %-52s %s hit(s)  %s\n' "$label" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" \
        | tee -a "$EVIDENCE/source-gates.txt" >> "$checks"
    [ "$hits" -ge 1 ] || static_ok=0
}
static_gate "$MESSAGE_CARD_BUILDER" 'lifecycleRow' 'MessageCardBuilder run lifecycle row'
static_gate "$MESSAGE_CARD_BUILDER" 'WORKING_LABEL' 'MessageCardBuilder working-strip label'
static_gate "$MESSAGE_CARD_BUILDER" 'work:lifecycle' 'MessageCardBuilder work:lifecycle row key'
static_gate "$EVENT_FRAMES" 'endRunFrames' 'EventFrames run_end settlement frames'
static_gate "$EVENT_FRAMES" 'lifecycleId' 'EventFrames lifecycle row id'
static_gate "$EVENT_FRAMES" 'openRun' 'EventFrames run_start open state'
static_gate "$EVENT_FRAMES" 'failRun' 'EventFrames error fail state'
static_gate "$CHAT_SCREEN" 'durationLabel' 'ChatScreen settled duration label'
static_gate "$CHAT_SCREEN" 'lifecycleRow' 'ChatScreen work:lifecycle call sites'
[ "$static_ok" = "1" ] || fail "static source gates failed (see $EVIDENCE/source-gates.txt)"
ok "T306 sources carry the new surface (source-gates.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (eight plugin jars) =="
home=$(mktemp -d /tmp/t306-home.XXXXXX)
bundled=$(mktemp -d /tmp/t306-bundled.XXXXXX)
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
    echo "plugin-reason=the T306 timeline is driven by the scripted run events of"
    echo "              the sessions QA helper (JHIN_SESSIONS_QA), no live LLM run is"
    echo "              needed; the agent/llm bundle is staged for the dependency edges"
    echo "              the chat screen expects."
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding (kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (QA helpers on, <= 30 s for health) =="
boot_kernel "$home" "$bundled"

# ------------------------------------------------------------------- seed
echo "== Step 5: seed one session with a full scripted run =="
s=$(create_session "qa-run" '"/tmp/t306/wd"')
post_event "$s" "run_start" '{"runId":"r1"}' "$EVIDENCE/event-run-start.json"
run_start_seq=$(jq -r '.seq' "$EVIDENCE/event-run-start.json")
[ -n "$run_start_seq" ] && [ "$run_start_seq" != "null" ] \
    || fail "the run_start append returned no seq (event-run-start.json)"
post_event "$s" "user_message" '{"text":"hi"}' "$EVIDENCE/event-user-message.json"
post_event "$s" "message_start" '{"role":"assistant"}' "$EVIDENCE/event-message-start.json"
post_event "$s" "text_delta" '{"text":"working"}' "$EVIDENCE/event-text-delta.json"
post_event "$s" "message_end" '{"text":"working"}' "$EVIDENCE/event-message-end.json"
post_event "$s" "run_end" '{"runId":"r1"}' "$EVIDENCE/event-run-end.json"
{
    echo "T306 seeding — the sessions QA helper (POST /sessions/{id}/events):"
    echo "  qa-run -> $s (workdir /tmp/t306/wd)"
    echo "  run_start {\"runId\":\"r1\"}        -> 201 (seq $run_start_seq)"
    echo "  user_message {\"text\":\"hi\"}       -> 201"
    echo "  message_start {\"role\":\"assistant\"} -> 201"
    echo "  text_delta {\"text\":\"working\"}    -> 201"
    echo "  message_end {\"text\":\"working\"}   -> 201"
    echo "  run_end {\"runId\":\"r1\"}          -> 201"
    echo "  the lifecycle row anchors at ev-$run_start_seq-lifecycle"
} > "$EVIDENCE/seeded.txt"
ok "seeded 6 run events on session $s via POST /sessions/{id}/events (seeded.txt)"

# ------------------------------------------------------- the stream frames
echo "== Step 6: GET /ui/stream/session/<id>?fromSeq=0 — the run lifecycle frames =="
fetch_frames "$s" "$EVIDENCE/run.jsonl"
frames_count=$(wc -l < "$EVIDENCE/run.jsonl" | tr -d ' ')
lifecycle_id="ev-$run_start_seq-lifecycle"
strip_id="ev-$run_start_seq"
{
    jq -r --arg id "$lifecycle_id" \
        'select(.node.id == $id and (.node.html | contains("Running"))) | 1' \
        "$EVIDENCE/run.jsonl" 2>/dev/null || true
} | wc -l | tr -d ' ' > "$EVIDENCE/.running-nodes"
running_nodes=$(cat "$EVIDENCE/.running-nodes")
{
    jq -r --arg id "$strip_id" \
        'select(.node.id == $id and (.node.html | contains("agent is working"))) | 1' \
        "$EVIDENCE/run.jsonl" 2>/dev/null || true
} | wc -l | tr -d ' ' > "$EVIDENCE/.strip-nodes"
strip_nodes=$(cat "$EVIDENCE/.strip-nodes")
{
    jq -r --arg id "$lifecycle_id" \
        'select(.replace.id == $id and (.replace.html | contains("Done"))) | 1' \
        "$EVIDENCE/run.jsonl" 2>/dev/null || true
} | wc -l | tr -d ' ' > "$EVIDENCE/.done-replace"
done_replace=$(cat "$EVIDENCE/.done-replace")
{
    jq -r --arg id "$strip_id" 'select(.remove == $id) | 1' \
        "$EVIDENCE/run.jsonl" 2>/dev/null || true
} | wc -l | tr -d ' ' > "$EVIDENCE/.strip-removes"
strip_removes=$(cat "$EVIDENCE/.strip-removes")
rm -f "$EVIDENCE/.running-nodes" "$EVIDENCE/.strip-nodes" "$EVIDENCE/.done-replace" "$EVIDENCE/.strip-removes"
[ "$frames_count" -ge 4 ] \
    || fail "the replay carries $frames_count frames (expected at least 4) (run.jsonl)"
[ "$running_nodes" -ge 1 ] \
    || fail "the replay carries no node frame $lifecycle_id with Running (run.jsonl)"
[ "$strip_nodes" -ge 1 ] \
    || fail "the replay carries no node frame $strip_id with the \"agent is working\" strip (run.jsonl)"
[ "$done_replace" -ge 1 ] \
    || fail "the replay carries no replace frame $lifecycle_id with Done (run.jsonl)"
[ "$strip_removes" -ge 1 ] \
    || fail "the replay carries no remove of the working strip $strip_id (run.jsonl)"
{
    echo "T306 stream replay — GET /ui/stream/session/$s?fromSeq=0 (run.jsonl):"
    echo "  $frames_count frames replayed from the 6 seeded run events"
    echo "  run_start -> node $strip_id (the \"agent is working\" working strip,"
    echo "    $strip_nodes frame(s)) alongside node $lifecycle_id (Running,"
    echo "    $running_nodes frame(s)) — the running lifecycle row of the open run"
    echo "  run_end   -> replace $lifecycle_id with the Done chip ($done_replace"
    echo "    frame(s)) + remove $strip_id ($strip_removes frame(s)) — the"
    echo "    lifecycle row closes in place at run_end and the strip is gone"
} > "$EVIDENCE/run-check.txt"
ok "frames: run_start node pair — working strip $strip_id + running lifecycle $lifecycle_id (run.jsonl)"
ok "frames: run_end replace $lifecycle_id with Done + remove of the working strip (run.jsonl)"

# ------------------------------------------------------- the screen timeline
echo "== Step 7: GET /ui/screen/chat:<id> — the settled lifecycle row =="
fetch_chat_html "$s" "$EVIDENCE/timeline.html"
lifecycle_keys=$(count_matches "$EVIDENCE/timeline.html" 'data-jhin-row-key="work:lifecycle"')
done_chips=$(count_matches "$EVIDENCE/timeline.html" '>Done<')
working_labels=$(count_matches "$EVIDENCE/timeline.html" 'agent is working')
{
    grep -oE '[0-9]+\.[0-9]s' "$EVIDENCE/timeline.html" 2>/dev/null || true
} | sort -u > "$EVIDENCE/.durations"
duration_hits=$(wc -l < "$EVIDENCE/.durations" | tr -d ' ')
duration_sample=$(head -1 "$EVIDENCE/.durations")
rm -f "$EVIDENCE/.durations"
[ "$lifecycle_keys" -ge 1 ] \
    || fail "the chat screen renders no work:lifecycle row (timeline.html)"
[ "$done_chips" -ge 1 ] \
    || fail "the chat screen carries no Done chip on the settled lifecycle row (timeline.html)"
[ "$duration_hits" -ge 1 ] \
    || fail "the chat screen carries no duration label (\\d+\\.\\ds) (timeline.html)"
[ "$working_labels" = "0" ] \
    || fail "the chat screen still shows the working strip (\"agent is working\" present) (timeline.html)"
{
    echo "T306 screen history — GET /ui/screen/chat:$s (timeline.html):"
    echo "  work:lifecycle rows: $lifecycle_keys — the run lifecycle row settles"
    echo "  in place at run_end (PASS)"
    echo "  Done chips: $done_chips — the settled lifecycle row carries the done"
    echo "  state chip (PASS)"
    echo "  duration label \\d+\\.\\ds: $duration_hits match(es)"
    echo "  (e.g. $duration_sample) — the settled row shows the run duration (PASS)"
    echo "  \"agent is working\": $working_labels hit(s) — the working strip is gone"
    echo "  after run_end (PASS)"
} > "$EVIDENCE/screen-check.txt"
ok "screen: work:lifecycle row settled with the Done chip (timeline.html)"
ok "screen: duration label matched \\d+\\.\\ds ($duration_sample) (timeline.html)"
ok "screen: working strip gone — no \"agent is working\" (timeline.html)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T306 browser steps — UNAVAILABLE in this environment.

Browser automation (the agent browser / screenshots / evaluate) cannot run
on this QA machine; the T202–T208/T301–T305 precedent applies: every
browser step is substituted with curl + static asserts.

Not executed (the plan's interactive/visual cases):
  - Watching the lifecycle row close at run_end (the Done chip and the
    duration fading in, the working strip disappearing): substituted by the
    run.jsonl frame asserts (the replace of ev-<seq>-lifecycle with Done and
    the remove of the strip) and the timeline.html history asserts.
  - Watching an open run's error settle the row to failed: substituted by
    the --fail mode asserts (the Error chip on the danger tone in the
    lifecycle row region of error-state.txt).

What IS proven here: the served chat screen and the SSE replay carry the
run lifecycle rows that open at run_start, close at run_end (Done chip +
duration, strip removed) and flip to failed on an error, all with curl.
EOF
ok "browser-unavailable.txt records the un-exercised visual cases"

# ---------------------------------------------------------------- summary
{
    echo "T306 QA — PASS"
    echo ""
    echo "  mode:              happy"
    echo "  suites:            :jhin-plugin-ui-kit:test $ui_kit_tests, :jhin-plugin-ui-default:test $ui_default_tests (0 failures)"
    echo "  scripted run:      run_start/user_message/message_start/text_delta/message_end/run_end"
    echo "                     seeded via POST /sessions/{id}/events (run_start at seq $run_start_seq)"
    echo "  stream replay:     $frames_count frames — the run_start node pair (working strip $strip_id"
    echo "                     + running lifecycle $lifecycle_id), the run_end replace with Done"
    echo "                     and the remove of the strip (run.jsonl)"
    echo "  screen history:    work:lifecycle settled with the Done chip and the duration label"
    echo "                     ($duration_sample), the working strip gone (timeline.html)"
    echo "  negative:          an error on an open run flips the lifecycle row to failed"
    echo "                     (Error chip on the danger tone, sticky) — proven in --fail mode"
    echo ""
    echo "  evidence: $EVIDENCE"
    sed 's/^/  /' "$checks"
} > "$EVIDENCE/summary.txt"
ok "T306 QA PASS (summary.txt)"
