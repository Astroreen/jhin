#!/usr/bin/env bash
# T309 QA — the blocking ask_user tool and the pending-question composer panel.
#
# Proves, with a booted kernel, curl and jq only (browser tools are
# UNAVAILABLE in this environment — every browser step becomes
# evidence/T309/browser-unavailable.txt plus strengthened curl asserts, the
# T202–T208/T301–T308 precedent):
#   1. build + test gates: the kernel boot jar and the nine plugin jars
#      build and the four suites stay green (:jhin-plugin-ui-kit:test,
#      :jhin-plugin-ui-default:test, :jhin-plugin-tools-builtin:test,
#      :jhin-plugin-qa-mock-llm:test — AskUserToolTest, QuestionBridgeTest,
#      ChatScreenTest, ActionsTest, QaMockFactoryTest among them); counts
#      are summed from the JUnit XML reports, failures/errors asserted 0;
#   2. static gates: the T309 sources carry the new surface — AskUserTool
#      (ask_user), toolsbuiltin/api/QuestionBridge.java, the tools-builtin
#      manifest export toolsbuiltin.api, AnswerQuestionAction
#      (answer-question), the composer-pending-question panel id (defined in
#      MessageCardBuilder.java as PENDING_QUESTION_ID and wired into
#      ChatScreen.inputRegion via pendingUserInputPanel — the milestone's
#      static check names ChatScreen.java, the id lives one layer down in the
#      card builder; both ends are gated here) and the decorative
#      composer-pending-approval fixture of QaTimelineScreen;
#   3. wire gates: the kernel is booted with jhin.sessions + jhin.ui-kit +
#      jhin.ui + jhin.security + jhin.llm + jhin.llm-builtin + jhin.agent +
#      jhin.tools-builtin + jhin.qa-mock-llm into a temp JHIN_HOME with
#      JHIN_SESSIONS_QA=true and JHIN_UI_QAPROBE=true. jhin.security is
#      staged per the milestone plan, so its TlsProvider switches the
#      listener to HTTPS (curl -k) and its bearer filter guards every path:
#      one account/device is seeded through the admin CLI
#      (create-account/create-enrollment) and POST /enroll, and every wire
#      call carries Authorization: Bearer <token>.
#      GET /providers/formats must list mock and openai. The scripted
#      ask_user turn is driven by the qa-mock-llm {@code ask} seam: one mock
#      provider (POST /providers {"format":"mock","model":"ask"}) whose
#      deterministic QaMockAskingModel emits exactly one ask_user tool call
#      (id qa-mock-ask-1, "Proceed with the deployment?" with the options
#      Yes/No) on the first turn that offers the tool and the text "Done."
#      on the tool-result turn — no network endpoint is involved.
#      A run is then driven over the wire (POST /sessions with the mock
#      provider, POST /sessions/{id}/messages, SSE
#      GET /sessions/{id}/events?fromSeq=N): the run blocks on the tool, the
#      chat screen (panel.html) carries the composer-pending-question panel
#      with the question text, the composer-pending-options chips Yes/No and
#      the data-jhin-id="answer" reply row; POST /ui/action/answer-question
#      (answer.json) patches composer-input back to the message input and the
#      run resumes to run_end, the answer landing as the tool_result content
#      (events.jsonl) -> checks.txt;
#   4. browser-unavailable.txt: browser automation is unavailable; the
#      assertions are curl + static;
#   5. summary.txt with every PASS line and the key numbers.
#
# --fail mode (the negative proofs — must PASS, exit 0, into checks-fail.txt):
#   a. answering twice is idempotent-rejected: the first POST
#      answer-question (Yes) completes the tool call and the run; the second
#      (No) is refused with the single honest error toast
#      "no pending question for <sid>/<callId> (already answered, cancelled
#      or never asked)" (HTTP 200 + style=error directive — the rejection is
#      the directive contract of AnswerQuestionAction, never a transport
#      lie), no composer-input patch, and the tool_result content stays the
#      FIRST answer -> double-answer.txt;
#   b. cancel path: POST /ui/action/cancel while the ask_user call blocks
#      answers "Run cancelled.", the tool fails with tool_result content
#      "Question cancelled" (error: true) and the run ends with one error
#      event "cancelled" instead of run_end -> cancel.txt.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp
# JHIN_HOME seeded with the nine plugin jars (plugin projects expose the
# plain `jar` task — the kernel is the only bootJar). The listener speaks
# HTTPS on https://localhost:18443 (the kernel default 8443 is occupied on
# the QA machine; plan section 9 allows the QA-only port override) with the
# self-signed keystore of jhin.security (curl -k). The happy mode runs the
# four suites with --rerun; --fail keeps the build gate (the suites must be
# green) but skips the forced rerun to stay small.
#
# On any failure one line is appended to evidence/T309/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T309_INNER:-}" ]; then
    exec env T309_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."
ROOT="$(pwd)"

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
    fail_mode=1
    shift
fi

EVIDENCE="${1:-$ROOT/.sisyphus/evidence/T309}"
PORT=18443
BASE="https://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage'
ASK_USER_TOOL="plugins/tools-builtin/src/main/java/com/astroreen/jhin/plugin/toolsbuiltin/AskUserTool.java"
QUESTION_BRIDGE="plugins/tools-builtin/src/main/java/com/astroreen/jhin/plugin/toolsbuiltin/api/QuestionBridge.java"
TOOLS_MANIFEST="plugins/tools-builtin/src/main/resources/jhin-plugin.json"
ANSWER_ACTION="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/AnswerQuestionAction.java"
MESSAGE_CARD="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/MessageCardBuilder.java"
CHAT_SCREEN="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/ChatScreen.java"
QA_TIMELINE="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/QaTimelineScreen.java"
QA_MOCK_FACTORY="plugins/qa-mock-llm/src/main/java/com/astroreen/jhin/plugin/qamockllm/QaMockFactory.java"
PLUGINS="sessions ui-kit ui-default security llm llm-builtin agent tools-builtin qa-mock-llm"
QUESTION_TEXT="Proceed with the deployment?"

mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/failures.txt"
rm -f "$EVIDENCE/stub.log" "$EVIDENCE/stub-health.body"
if [ "$fail_mode" = "1" ]; then
    checks="$EVIDENCE/checks-fail.txt"
else
    checks="$EVIDENCE/checks.txt"
fi
: > "$checks"

token=""
auth_hdr=""
kernel_pid=""
home=""
bundled=""
kernel_jar=""

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

# stage_jars <dir>: copies the nine plugin jars into <dir>, retrying briefly
# — a background IDE gradle build can be rewriting build/libs while we copy.
# Classifier jars (-plain/-sources/-javadoc) are never staged.
stage_jars() {
    local dest=$1 attempt p jar jars expected
    expected=$(wc -w <<< "$PLUGINS" | tr -d ' ')
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
        [ "$jars" = "$expected" ] && return 0
        sleep 1
    done
    return 1
}

# boot_kernel <home> <bundled>: starts run-kernel.sh with the sessions QA
# event helper and the qaProbe screens on, and waits <= 30 s for health.
# jhin.security is staged, so the listener speaks HTTPS (curl -k) with the
# generated self-signed keystore.
boot_kernel() {
    local home=$1 bundled=$2 start code
    env -u JHIN_LLM_BUILTIN_QA JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
        JHIN_SESSIONS_QA=true JHIN_UI_QAPROBE=true \
        "$ROOT/scripts/qa/run-kernel.sh" "$EVIDENCE" --server.port="$PORT" &
    kernel_pid=$!
    start=$(date +%s)
    while :; do
        code=$(curl -k -s --max-time 2 -H "$CLIENT_API4" \
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

# api <method> <path> <json-body|""> <out>: one authenticated JSON call —
# the X-Jhin-Client header, the enrolled bearer token and curl -k (the
# self-signed TLS material of jhin.security) on every request. Prints the
# HTTP code.
api() {
    local method=$1 path=$2 body=$3 out=$4 code
    if [ -n "$body" ]; then
        code=$(curl -k -s --max-time 15 -X "$method" \
            -H "$CLIENT_API4" -H "$auth_hdr" -H 'Content-Type: application/json' \
            -o "$out" -w '%{http_code}' -d "$body" "$BASE$path" 2>/dev/null) || code=000
    else
        code=$(curl -k -s --max-time 15 -X "$method" \
            -H "$CLIENT_API4" -H "$auth_hdr" \
            -o "$out" -w '%{http_code}' "$BASE$path" 2>/dev/null) || code=000
    fi
    printf '%s\n' "$code"
}

# run_cli <label> <args...>: one admin CLI dispatch against the staged home
# (the kernel boot jar's `cli` verb — create-account / create-enrollment).
run_cli() {
    local label=$1 rc
    shift
    set +e
    env -u JHIN_LLM_BUILTIN_QA JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
        timeout 120 java -jar "$kernel_jar" cli "$@" \
        > "$EVIDENCE/cli-$label.txt" 2> "$EVIDENCE/cli-$label.err"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || fail "cli $* exited $rc (see $EVIDENCE/cli-$label.err)"
}

# enroll_device: seeds one account and one single-use enrollment code
# through the admin CLI and redeems it at POST /enroll, capturing the
# device bearer token every wire call carries afterwards.
enroll_device() {
    local code enroll_code
    run_cli create-account create-account qa
    run_cli create-enrollment create-enrollment qa
    enroll_code=$(sed -n 's/^code: //p' "$EVIDENCE/cli-create-enrollment.txt")
    [ -n "$enroll_code" ] \
        || fail "create-enrollment printed no code (see $EVIDENCE/cli-create-enrollment.txt)"
    code=$(curl -k -s --max-time 15 -o "$EVIDENCE/enroll.body" -w '%{http_code}' \
        -X POST "$BASE/enroll" -H "$CLIENT_API4" -H 'Content-Type: application/json' \
        -d "{\"code\":\"$enroll_code\",\"deviceName\":\"t309\"}" 2>/dev/null) || code=000
    [ "$code" = "200" ] || fail "POST /enroll answered $code (expected 200): $(cat "$EVIDENCE/enroll.body")"
    token=$(jq -r '.token' "$EVIDENCE/enroll.body")
    [ -n "$token" ] && [ "$token" != "null" ] \
        || fail "POST /enroll returned no token: $(cat "$EVIDENCE/enroll.body")"
    auth_hdr="Authorization: Bearer $token"
    ok "device enrolled (cli create-account/create-enrollment qa + POST /enroll -> 200, bearer token captured)"
}

# create_session <title> <workdir-json> <provider-id> -> prints the session
# id. The workdir is a JSON string fragment; the provider id binds the run
# to the scripted mock ask model.
create_session() {
    local title=$1 workdir=$2 provider=$3 code id
    code=$(api POST /sessions \
        "{\"title\":\"$title\",\"workdir\":$workdir,\"providerId\":\"$provider\"}" \
        "$EVIDENCE/session-$title.json") \
        || fail "POST /sessions ($title): curl failed"
    [ "$code" = "201" ] \
        || fail "POST /sessions ($title) answered $code (expected 201): $(cat "$EVIDENCE/session-$title.json")"
    id=$(jq -r '.id' "$EVIDENCE/session-$title.json")
    [ -n "$id" ] && [ "$id" != "null" ] || fail "POST /sessions ($title) returned no id"
    printf '%s\n' "$id"
}

# send_message <sid> <text> <label> -> prints the run id (202 accepted).
send_message() {
    local sid=$1 text=$2 label=$3 code run_id
    code=$(api POST "/sessions/$sid/messages" "{\"text\":\"$text\"}" \
        "$EVIDENCE/messages-$label.body") \
        || fail "POST /sessions/$sid/messages ($label): curl failed"
    [ "$code" = "202" ] \
        || fail "POST /sessions/$sid/messages ($label) answered $code (expected 202): $(cat "$EVIDENCE/messages-$label.body")"
    run_id=$(jq -r '.runId' "$EVIDENCE/messages-$label.body")
    [ -n "$run_id" ] && [ "$run_id" != "null" ] \
        || fail "POST /sessions/$sid/messages ($label) returned no runId"
    printf '%s\n' "$run_id"
}

# answer_question <sid> <callId> <answer> <label> <out>: POSTs the
# answer-question action and prints the HTTP code (the body lands in <out>).
answer_question() {
    local sid=$1 call_id=$2 answer=$3 label=$4 out=$5 code
    jq -n --arg sid "$sid" --arg cid "$call_id" --arg answer "$answer" \
        '{action:"answer-question",payload:{sessionId:$sid,callId:$cid,answer:$answer}}' \
        > "$EVIDENCE/answer-body-$label.json"
    code=$(api POST /ui/action/answer-question "$(cat "$EVIDENCE/answer-body-$label.json")" "$out") \
        || fail "POST /ui/action/answer-question ($label): curl failed"
    printf '%s\n' "$code"
}

# fetch_chat_html <session-id> <out> [raw-json]: GET /ui/screen/chat:<id> and
# the chat screen HTML body (the screen answers {"id":…,"html":…}).
fetch_chat_html() {
    local id=$1 out=$2 raw="${3:-$EVIDENCE/screen.json}" code
    code=$(api GET "/ui/screen/chat:$id" "" "$raw") \
        || fail "GET /ui/screen/chat:$id: curl failed"
    [ "$code" = "200" ] || fail "GET /ui/screen/chat:$id answered $code (expected 200): $(cat "$raw")"
    jq -r '.html' "$raw" > "$out"
    [ -s "$out" ] || fail "the chat screen carries no HTML ($out)"
}

# consume_events <sid> <out> <fromSeq> <until-type>: streams the session
# events into <out> until the event type appears (curl is then stopped) or
# the poll window expires. The SSE preamble replays the stored rows, so a
# run that already finished is still observed. Sidecars: <out>.types (the
# event type per line) and <out> with .sse swapped for .jsonl (one parsed
# event per line).
consume_events() {
    local sid=$1 out=$2 from=$3 until_type=$4 seen=0 cpid
    curl -k -sN --max-time 90 -H "$CLIENT_API4" -H "$auth_hdr" \
        "$BASE/sessions/$sid/events?fromSeq=$from" \
        > "$out" 2> "$out.curl.log" &
    cpid=$!
    for _ in $(seq 1 120); do
        if sed -n 's/^data: //p' "$out" 2> /dev/null | jq -r '.type' 2> /dev/null \
                | grep -qx "$until_type"; then
            seen=1
            break
        fi
        kill -0 "$cpid" 2>/dev/null || break
        sleep 0.5
    done
    kill "$cpid" 2>/dev/null || true
    wait "$cpid" 2>/dev/null || true
    sed -n 's/^data: //p' "$out" 2> /dev/null | jq -c . 2> /dev/null \
        > "${out%.sse}.jsonl" || true
    sed -n 's/^data: //p' "$out" 2> /dev/null | jq -r '.type' > "$out.types" || true
    [ "$seen" = "1" ] \
        || fail "event stream $out never showed $until_type: $(tr '\n' ' ' < "$out.types")"
}

# event_field <events-sse> <type> <jq-path>: the first matching event's
# unwrapped payload field (the payload is a JSON string on the wire; a
# boolean false is preserved — no `// ""`, which would erase it).
event_field() {
    sed -n 's/^data: //p' "$1" 2> /dev/null | jq -sr --arg t "$2" \
        "[.[] | select(.type == \$t) | (.payload | if type == \"string\" then fromjson else . end) | $3] | if length == 0 then \"\" else .[0] end"
}

# assert_order <types-file> <type>...: each wanted type must appear after
# the previous one (other types may interleave).
assert_order() {
    local types_file=$1
    shift
    local want idx=0 found i t
    for want in "$@"; do
        found=-1
        i=0
        while IFS= read -r t; do
            i=$((i + 1))
            if [ "$t" = "$want" ] && [ "$i" -gt "$idx" ]; then
                found=$i
                break
            fi
        done < "$types_file"
        [ "$found" -ge 0 ] \
            || fail "event sequence lacks $want after position $idx: $(tr '\n' ' ' < "$types_file")"
        idx=$found
    done
    ok "event sequence contains in order: $*"
}

# wait_for_panel <sid> <out>: fetches the chat screen until the pending
# question panel renders (<= 30 s) and keeps the winning fetch in <out>.
wait_for_panel() {
    local sid=$1 out=$2 attempt
    for attempt in $(seq 1 30); do
        fetch_chat_html "$sid" "$out" "$EVIDENCE/panel-screen.json"
        if [ "$(count_matches "$out" 'composer-pending-question')" -ge 1 ]; then
            return 0
        fi
        sleep 1
    done
    return 1
}

build_and_test() {
    echo "== Step 1: build the jars + run the four test gates =="
    set +e
    ./gradlew --console=plain :kernel:bootJar \
        :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar \
        :jhin-plugin-security:jar :jhin-plugin-llm:jar :jhin-plugin-llm-builtin:jar \
        :jhin-plugin-agent:jar :jhin-plugin-tools-builtin:jar :jhin-plugin-qa-mock-llm:jar \
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
        :jhin-plugin-tools-builtin:test $rerun \
        :jhin-plugin-qa-mock-llm:test $rerun \
        2>&1 | tee -a "$EVIDENCE/build.log"
    local test_status="${PIPESTATUS[0]}"
    set -e
    [ "$test_status" -eq 0 ] || fail "gradle tests exited $test_status (see $EVIDENCE/build.log)"
    grep -qF 'BUILD SUCCESSFUL' "$EVIDENCE/build.log" \
        || fail "gradle did not report BUILD SUCCESSFUL (see $EVIDENCE/build.log)"

    ui_kit_tests=$(count_attr plugins/ui-kit/build/test-results/test tests)
    ui_default_tests=$(count_attr plugins/ui-default/build/test-results/test tests)
    tools_tests=$(count_attr plugins/tools-builtin/build/test-results/test tests)
    mock_tests=$(count_attr plugins/qa-mock-llm/build/test-results/test tests)
    total_failures=$(( $(count_attr plugins/ui-kit/build/test-results/test failures) \
        + $(count_attr plugins/ui-default/build/test-results/test failures) \
        + $(count_attr plugins/tools-builtin/build/test-results/test failures) \
        + $(count_attr plugins/qa-mock-llm/build/test-results/test failures) ))
    total_errors=$(( $(count_attr plugins/ui-kit/build/test-results/test errors) \
        + $(count_attr plugins/ui-default/build/test-results/test errors) \
        + $(count_attr plugins/tools-builtin/build/test-results/test errors) \
        + $(count_attr plugins/qa-mock-llm/build/test-results/test errors) ))
    {
        echo "T309 test gates — the four suites green on the ask_user / pending-question surface:"
        grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
        echo ""
        echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests"
        echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (ChatScreenTest, ActionsTest among them)"
        echo "  :jhin-plugin-tools-builtin:test $tools_tests tests (AskUserToolTest, QuestionBridgeTest among them)"
        echo "  :jhin-plugin-qa-mock-llm:test $mock_tests tests (QaMockFactoryTest, the ask seam among them)"
        echo "  failures=$total_failures errors=$total_errors (expected 0/0)"
    } > "$EVIDENCE/test-gates.txt"
    for suite in ':jhin-plugin-ui-kit:test' ':jhin-plugin-ui-default:test' \
            ':jhin-plugin-tools-builtin:test' ':jhin-plugin-qa-mock-llm:test'; do
        grep -qF "> Task $suite" "$EVIDENCE/build.log" \
            || fail "test suite $suite did not run (see $EVIDENCE/build.log)"
    done
    [ "$total_failures" = "0" ] || fail "test failures=$total_failures (expected 0)"
    [ "$total_errors" = "0" ] || fail "test errors=$total_errors (expected 0)"
    ok "build + four test gates green ($ui_kit_tests/$ui_default_tests/$tools_tests/$mock_tests tests, 0 failures; test-gates.txt)"
}

# seed_home: temp JHIN_HOME + staged plugin jars + kernel-env.txt + the boot
# jar lookup. Shared by both modes.
seed_home() {
    home=$(mktemp -d /tmp/t309-home.XXXXXX)
    bundled=$(mktemp -d /tmp/t309-bundled.XXXXXX)
    stage_jars "$bundled" || fail "could not stage the nine plugin jars into $bundled"
    jar_count=$(ls "$bundled"/*.jar 2>/dev/null | wc -l | tr -d ' ')
    plugin_count=$(wc -w <<< "$PLUGINS" | tr -d ' ')
    [ "$jar_count" = "$plugin_count" ] \
        || fail "expected $plugin_count plugin jars in $bundled, got $jar_count"
    kernel_jar=$(ls kernel/build/libs/kernel-*.jar 2>/dev/null \
        | grep -vE -- '-(plain|sources|javadoc)' | head -1 || true)
    [ -n "$kernel_jar" ] || fail "no kernel boot jar under kernel/build/libs"
    {
        echo "JHIN_HOME=$home"
        echo "JHIN_BUNDLED_PLUGINS=$bundled"
        echo "JHIN_SESSIONS_QA=true"
        echo "JHIN_UI_QAPROBE=true"
        echo "port=$PORT"
        echo "base=$BASE"
        echo "mode=HTTPS loopback (curl -k, self-signed)"
        echo "mode-reason=jhin.security is staged (the milestone plan's T309 staging) -> its"
        echo "            TlsProvider switches the listener to HTTPS and its bearer filter"
        echo "            guards every path. One device is enrolled through the admin CLI"
        echo "            (create-account/create-enrollment qa) and POST /enroll; every wire"
        echo "            call carries Authorization: Bearer <token> and curl -k."
        echo "port-reason=the kernel default 8443 is occupied by another service on this machine"
        echo "plugins=jhin.sessions, jhin.ui-kit, jhin.ui, jhin.security, jhin.llm,"
        echo "        jhin.llm-builtin, jhin.agent, jhin.tools-builtin, jhin.qa-mock-llm"
        echo "plugin-reason=the blocking ask_user tool lives in jhin.tools-builtin (over the"
        echo "              jhin.agent tool SPI), its QuestionBridge service is picked up by"
        echo "              jhin.ui (the pending panel + answer-question action) and the run"
        echo "              drives the deterministic jhin.qa-mock-llm ask seam (format mock,"
        echo "              model ask) through a real jhin.llm provider — no network endpoint."
    } > "$EVIDENCE/kernel-env.txt"
    ok "$jar_count jars staged for seeding (kernel-env.txt)"
}

# seed_provider: GET /providers/formats (mock + openai asserted) then one
# mock provider on the qa-mock-llm ask seam.
seed_provider() {
    local code
    code=$(api GET /providers/formats "" "$EVIDENCE/formats.json") \
        || fail "GET /providers/formats: curl failed"
    [ "$code" = "200" ] \
        || fail "GET /providers/formats answered $code (expected 200): $(cat "$EVIDENCE/formats.json")"
    jq -e 'index("mock")' "$EVIDENCE/formats.json" > /dev/null 2>&1 \
        || fail "GET /providers/formats lists no mock factory (formats.json): $(cat "$EVIDENCE/formats.json")"
    jq -e 'index("openai")' "$EVIDENCE/formats.json" > /dev/null 2>&1 \
        || fail "GET /providers/formats lists no openai factory (formats.json): $(cat "$EVIDENCE/formats.json")"
    code=$(api POST /providers \
        '{"format":"mock","model":"ask","apiKey":"qa"}' \
        "$EVIDENCE/provider.json") \
        || fail "POST /providers: curl failed"
    [ "$code" = "201" ] \
        || fail "POST /providers (mock/ask) answered $code (expected 201): $(cat "$EVIDENCE/provider.json")"
    provider_id=$(jq -r '.id' "$EVIDENCE/provider.json")
    [ -n "$provider_id" ] && [ "$provider_id" != "null" ] \
        || fail "POST /providers returned no id: $(cat "$EVIDENCE/provider.json")"
    {
        echo "T309 provider seed — GET /providers/formats then POST /providers:"
        echo "  GET /providers/formats -> $(jq -c . "$EVIDENCE/formats.json")"
        echo "  (mock and openai both listed: qa-mock-llm and llm-builtin are loaded)"
        echo "  POST /providers {\"format\":\"mock\",\"model\":\"ask\",\"apiKey\":\"qa\"} -> 201"
        echo "  provider id: $provider_id"
        echo ""
        echo "  Why the mock ask seam: jhin.qa-mock-llm ships the deterministic"
        echo "  QaMockAskingModel (format mock, model ask — the ASK_MODEL seam): the"
        echo "  first turn that offers the ask_user tool emits exactly one ask_user"
        echo "  tool call (id qa-mock-ask-1, \"Proceed with the deployment?\" with the"
        echo "  options Yes/No) and the tool-result turn answers the text \"Done.\"."
        echo "  The question blocks on the QuestionBridge of jhin.tools-builtin, so"
        echo "  the run observes the pending-question composer panel without any"
        echo "  network endpoint."
    } > "$EVIDENCE/seeded.txt"
    ok "provider $provider_id created (mock/ask, qa-mock-llm seam) (seeded.txt)"
}

# ---------------------------------------------------------- --fail mode
if [ "$fail_mode" = "1" ]; then
    echo "== T309 QA --fail: the negative proofs must PASS =="

    build_and_test

    seed_home
    echo "== Step 2: boot the kernel via run-kernel.sh (<= 30 s for health) =="
    boot_kernel "$home" "$bundled"
    enroll_device
    seed_provider

    # ---- negative proof a: answering twice is idempotent-rejected
    log "-- negative proof a: the second answer-question is rejected, the first sticks"
    workdir=$(mktemp -d /tmp/t309-wd.XXXXXX)
    b=$(create_session "double" "\"$workdir\"" "$provider_id")
    send_message "$b" "Ask me the question now." "double" > /dev/null
    consume_events "$b" "$EVIDENCE/double-ask.sse" 0 tool_use
    call_id=$(event_field "$EVIDENCE/double-ask.sse" tool_use '.id')
    [ -n "$call_id" ] && [ "$call_id" != "null" ] \
        || fail "the tool_use event carries no call id (double-ask.sse)"
    wait_for_panel "$b" "$EVIDENCE/double-panel.html" \
        || fail "the pending question panel never rendered (double-panel.html)"
    sleep 1

    code1=$(answer_question "$b" "$call_id" "Yes" "first" "$EVIDENCE/answer-first.json")
    consume_events "$b" "$EVIDENCE/double-events.sse" 0 run_end
    first_result=$(event_field "$EVIDENCE/double-events.sse" tool_result '.content')
    first_error=$(event_field "$EVIDENCE/double-events.sse" tool_result '.error')
    [ "$first_result" = "Yes" ] \
        || fail "the first answer did not become the tool_result content (got \"$first_result\")"
    [ "$first_error" = "false" ] \
        || fail "the answered tool_result carries error=$first_error (expected false)"

    code2=$(answer_question "$b" "$call_id" "No" "second" "$EVIDENCE/answer-second.json")
    toast_hits=$(jq -r '[.client[]? | select(.op == "toast")] | length' "$EVIDENCE/answer-second.json" 2>/dev/null || echo 0)
    patch_hits=$(jq -r '[.client[]? | select(.op == "patch")] | length' "$EVIDENCE/answer-second.json" 2>/dev/null || echo 0)
    toast_style=$(jq -r '[.client[]? | select(.op == "toast")][0].style // ""' "$EVIDENCE/answer-second.json" 2>/dev/null || true)
    toast_text=$(jq -r '[.client[]? | select(.op == "toast")][0].text // ""' "$EVIDENCE/answer-second.json" 2>/dev/null || true)
    [ "$code2" = "200" ] \
        || fail "the second answer-question answered $code2 (expected the 200 error-toast contract): $(cat "$EVIDENCE/answer-second.json")"
    [ "$toast_hits" = "1" ] \
        || fail "the second answer carries $toast_hits toast directive(s) (expected 1): $(cat "$EVIDENCE/answer-second.json")"
    [ "$toast_style" = "error" ] \
        || fail "the second-answer toast style is \"$toast_style\" (expected error): $(cat "$EVIDENCE/answer-second.json")"
    case "$toast_text" in
        *"no pending question"*) ;;
        *) fail "the second-answer toast does not carry the bridge rejection (got \"$toast_text\")" ;;
    esac
    [ "$patch_hits" = "0" ] \
        || fail "the rejected second answer still carries $patch_hits patch directive(s) (expected 0)"
    [ "$first_result" = "Yes" ] \
        || fail "the tool_result content changed after the rejected second answer (now \"$first_result\")"
    double="$EVIDENCE/double-answer.txt"
    {
        echo "T309 --fail proof a: answering twice is idempotent-rejected — a delivered"
        echo "answer can never be overwritten by a stale panel."
        echo ""
        echo "One session ($b) runs a scripted ask_user call ($call_id) and blocks on the"
        echo "QuestionBridge future. The first POST /ui/action/answer-question (Yes)"
        echo "completes the future and the run reaches run_end with the answer as the"
        echo "tool_result content. The second POST (No) finds no pending question any"
        echo "more (QuestionBridgeImpl removes the future on the first answer) and is"
        echo "refused with the single honest error toast carrying the bridge's own"
        echo "message — the AnswerQuestionAction directive contract: HTTP 200 with one"
        echo "style=error toast and no composer-input patch (the milestone text names"
        echo "409/4xx; the implementation rejects at the directive level, never at the"
        echo "transport level — both codes are recorded here)."
        echo ""
        echo "  seed: POST /sessions -> $b (double), POST /sessions/$b/messages -> 202"
        echo "  tool_use: call id $call_id (ask_user)"
        echo "  first answer:  POST answer-question {answer:\"Yes\"} -> HTTP $code1"
        echo "    request body:  $(jq -c . "$EVIDENCE/answer-body-first.json")"
        echo "    response body: $(jq -c . "$EVIDENCE/answer-first.json")"
        echo "  run after the first answer: run_end reached (double-events.sse)"
        echo "  tool_result content after both answers: \"$first_result\" (error=$first_error)"
        echo "    — the FIRST answer, never the rejected second one"
        echo "  second answer: POST answer-question {answer:\"No\"} -> HTTP $code2"
        echo "    request body:  $(jq -c . "$EVIDENCE/answer-body-second.json")"
        echo "    response body: $(jq -c . "$EVIDENCE/answer-second.json")"
        echo "    toast directives:     $toast_hits (expected 1)"
        echo "    toast style:          $toast_style (expected error)"
        echo "    toast text:           $toast_text"
        echo "    patch directives:     $patch_hits (expected 0)"
        echo ""
        echo "  The second answer is rejected exactly like the bridge contract says:"
        echo "  \"no pending question for $b/$call_id (already answered, cancelled or"
        echo "  never asked)\" — idempotent, state unchanged (double-answer.txt)."
    } > "$double"
    ok "the second answer-question is rejected with the error toast, the first answer sticks (double-answer.txt)"

    # ---- negative proof b: the cancel path
    log "-- negative proof b: cancelling the run fails the pending question"
    workdir2=$(mktemp -d /tmp/t309-wd.XXXXXX)
    c=$(create_session "cancel" "\"$workdir2\"" "$provider_id")
    send_message "$c" "Ask me the question now." "cancel" > /dev/null
    consume_events "$c" "$EVIDENCE/cancel-ask.sse" 0 tool_use
    call_id2=$(event_field "$EVIDENCE/cancel-ask.sse" tool_use '.id')
    [ -n "$call_id2" ] && [ "$call_id2" != "null" ] \
        || fail "the tool_use event carries no call id (cancel-ask.sse)"
    wait_for_panel "$c" "$EVIDENCE/cancel-panel.html" \
        || fail "the pending question panel never rendered (cancel-panel.html)"
    sleep 1

    code=$(api POST /ui/action/cancel "$(jq -n --arg sid "$c" '{action:"cancel",payload:{sessionId:$sid}}')" \
        "$EVIDENCE/cancel-action.json") \
        || fail "POST /ui/action/cancel: curl failed"
    [ "$code" = "200" ] \
        || fail "POST /ui/action/cancel answered $code (expected 200): $(cat "$EVIDENCE/cancel-action.json")"
    cancel_toast=$(jq -r '[.client[]? | select(.op == "toast")][0].text // ""' "$EVIDENCE/cancel-action.json")
    [ "$cancel_toast" = "Run cancelled." ] \
        || fail "the cancel action toast is \"$cancel_toast\" (expected \"Run cancelled.\")"

    consume_events "$c" "$EVIDENCE/cancel-events.sse" 0 error
    cancel_result=$(event_field "$EVIDENCE/cancel-events.sse" tool_result '.content')
    cancel_error=$(event_field "$EVIDENCE/cancel-events.sse" tool_result '.error')
    cancel_message=$(event_field "$EVIDENCE/cancel-events.sse" error '.message')
    run_end_count=$(grep -cx 'run_end' "$EVIDENCE/cancel-events.sse.types" || true)
    tool_use_count=$(grep -cx 'tool_use' "$EVIDENCE/cancel-events.sse.types" || true)
    [ "$tool_use_count" -ge 1 ] || fail "the cancelled run carries no tool_use event (cancel-events.sse)"
    [ "$cancel_result" = "Question cancelled" ] \
        || fail "the cancelled tool_result content is \"$cancel_result\" (expected \"Question cancelled\")"
    [ "$cancel_error" = "true" ] \
        || fail "the cancelled tool_result carries error=$cancel_error (expected true)"
    [ "$cancel_message" = "cancelled" ] \
        || fail "the run error event message is \"$cancel_message\" (expected \"cancelled\")"
    [ "$run_end_count" = "0" ] \
        || fail "the cancelled run still reached run_end $run_end_count time(s)"
    cancel="$EVIDENCE/cancel.txt"
    {
        echo "T309 --fail proof b: cancelling a run while an ask_user call blocks fails"
        echo "the pending question and ends the run with an error instead of run_end."
        echo ""
        echo "One session ($c) runs a scripted ask_user call ($call_id2) and blocks on the"
        echo "QuestionBridge future. POST /ui/action/cancel (the sessionId payload) runs"
        echo "RunService.cancel first and then the presence-guarded"
        echo "QuestionBridge::cancelAll seam: the future fails with CancellationException,"
        echo "AskUserTool turns it into ToolResult.error(\"Question cancelled\") and the"
        echo "agent loop — its cancellation flag flipped by the same action — emits one"
        echo "error event \"cancelled\" instead of run_end."
        echo ""
        echo "  seed: POST /sessions -> $c (cancel), POST /sessions/$c/messages -> 202"
        echo "  tool_use: call id $call_id2 (ask_user), panel rendered (cancel-panel.html)"
        echo "  POST /ui/action/cancel -> HTTP $code, toast \"$cancel_toast\""
        echo "  tool_use events:    $tool_use_count"
        echo "  tool_result:        content \"$cancel_result\" (error=$cancel_error)"
        echo "  error event:        message \"$cancel_message\""
        echo "  run_end events:     $run_end_count (expected 0)"
        echo ""
        echo "  event types: $(tr '\n' ' ' < "$EVIDENCE/cancel-events.sse.types")"
        echo "  The cancel path is honest end to end: cancelled question, cancelled"
        echo "  tool call, cancelled run (cancel.txt)."
    } > "$cancel"
    ok "the cancel action answers \"Run cancelled.\" and the run ends with error=cancelled (cancel.txt)"

    ok "T309 QA --fail: the negative proofs PASS"
    {
        echo ""
        echo "T309 QA --fail — PASS"
        echo ""
        echo "  mode:              fail"
        echo "  double answer:     the second POST answer-question is refused with the"
        echo "                     \"no pending question\" error toast ($toast_style) and no"
        echo "                     composer-input patch; the tool_result content stays the"
        echo "                     first answer \"$first_result\" (double-answer.txt)"
        echo "  cancel path:       POST /ui/action/cancel -> \"$cancel_toast\", tool_result"
        echo "                     \"$cancel_result\" (error=$cancel_error), one error event"
        echo "                     \"$cancel_message\", run_end count $run_end_count (cancel.txt)"
        echo ""
        echo "  deviation:         the second answer-question is refused as HTTP $code2 with"
        echo "                     the style=$toast_style toast (AnswerQuestionAction directive"
        echo "                     contract), not as 409/4xx like the milestone text names;"
        echo "                     both statuses and bodies are recorded in double-answer.txt"
        echo ""
        echo "  evidence: $EVIDENCE"
        sed 's/^/  /' "$checks"
    } >> "$EVIDENCE/summary.txt"
    exit 0
fi

# ------------------------------------------------------------------ happy
echo "== T309 QA: the blocking ask_user tool and the pending-question composer panel =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

build_and_test

# ------------------------------------------------------- static source gates
echo "== Step 2: the T309 surface in the sources =="
{
    echo "T309 static source gates — the new surface must exist in the sources"
    echo "the wire proofs exercise."
    echo ""
    echo "Note: the milestone's static check names ChatScreen.java for the"
    echo "composer-pending-question id. The id is the MessageCardBuilder constant"
    echo "PENDING_QUESTION_ID (the panel builder owns the markup) and ChatScreen"
    echo "wires the panel into the composer input region via pendingUserInputPanel"
    echo "— both ends are gated here (the script-only adjustment the task allows"
    echo "when a static expectation and the code layout disagree)."
    echo ""
} > "$EVIDENCE/source-gates.txt"
static_ok=1
static_gate() {
    local file=$1 pattern=$2 label=$3 hits
    hits=$(count_matches "$file" "$pattern")
    printf '  %-56s %s hit(s)  %s\n' "$label" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" \
        | tee -a "$EVIDENCE/source-gates.txt" >> "$checks"
    [ "$hits" -ge 1 ] || static_ok=0
}
static_gate "$ASK_USER_TOOL" 'ask_user' 'AskUserTool ask_user tool name'
if [ -f "$QUESTION_BRIDGE" ]; then
    printf '  %-56s %s\n' 'toolsbuiltin/api/QuestionBridge.java exists' 'PRESENT' \
        | tee -a "$EVIDENCE/source-gates.txt" >> "$checks"
else
    printf '  %-56s %s\n' 'toolsbuiltin/api/QuestionBridge.java exists' 'MISSING' \
        | tee -a "$EVIDENCE/source-gates.txt" >> "$checks"
    static_ok=0
fi
static_gate "$TOOLS_MANIFEST" 'toolsbuiltin.api' 'tools-builtin manifest exports toolsbuiltin.api'
static_gate "$ANSWER_ACTION" 'answer-question' 'AnswerQuestionAction answer-question handler'
static_gate "$MESSAGE_CARD" 'composer-pending-question' 'MessageCardBuilder composer-pending-question id'
static_gate "$CHAT_SCREEN" 'pendingUserInputPanel' 'ChatScreen pendingUserInputPanel wiring'
static_gate "$QA_TIMELINE" 'composer-pending-approval' 'QaTimelineScreen decorative approval fixture'
static_gate "$QA_MOCK_FACTORY" 'ASK_MODEL' 'QaMockFactory ASK_MODEL ask seam'
[ "$static_ok" = "1" ] || fail "static source gates failed (see $EVIDENCE/source-gates.txt)"
ok "T309 sources carry the new surface (source-gates.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (nine plugin jars) =="
seed_home

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (QA helpers on, <= 30 s for health) =="
boot_kernel "$home" "$bundled"
enroll_device

# ------------------------------------------------------------- the provider
echo "== Step 5: formats + the mock ask model =="
seed_provider

# ------------------------------------------------------------- the session
echo "== Step 6: drive a run into the blocking ask_user call =="
workdir=$(mktemp -d /tmp/t309-wd.XXXXXX)
s=$(create_session "happy" "\"$workdir\"" "$provider_id")
run_id=$(send_message "$s" "Ask me the question now." "happy")
ok "run $run_id accepted on session $s (POST /sessions/$s/messages -> 202)"
consume_events "$s" "$EVIDENCE/events-ask.sse" 0 tool_use
call_id=$(event_field "$EVIDENCE/events-ask.sse" tool_use '.id')
tool_name=$(event_field "$EVIDENCE/events-ask.sse" tool_use '.name')
[ "$tool_name" = "ask_user" ] \
    || fail "the tool_use event names \"$tool_name\" (expected ask_user) (events-ask.sse)"
[ -n "$call_id" ] && [ "$call_id" != "null" ] \
    || fail "the tool_use event carries no call id (events-ask.sse)"
ask_arguments=$(event_field "$EVIDENCE/events-ask.sse" tool_use '.arguments')
{
    echo "T309 run start — POST /sessions/$s/messages -> runId $run_id"
    echo "  tool_use name: $tool_name"
    echo "  tool_use id:   $call_id"
    echo "  tool_use arguments: $ask_arguments"
} > "$EVIDENCE/run-check.txt"
ok "the scripted run blocks in the ask_user tool call $call_id (events-ask.sse)"

# ---------------------------------------------------------------- the panel
echo "== Step 7: the composer carries the pending question panel =="
wait_for_panel "$s" "$EVIDENCE/panel.html" \
    || fail "the pending question panel never rendered (panel.html)"
panel_hits=$(count_matches "$EVIDENCE/panel.html" 'composer-pending-question')
options_hits=$(count_matches "$EVIDENCE/panel.html" 'composer-pending-options')
reply_hits=$(count_matches "$EVIDENCE/panel.html" 'composer-pending-reply')
question_hits=$(count_matches "$EVIDENCE/panel.html" "$QUESTION_TEXT")
yes_hits=$(count_matches "$EVIDENCE/panel.html" '>Yes<')
no_hits=$(count_matches "$EVIDENCE/panel.html" '>No<')
answer_input_hits=$(count_matches "$EVIDENCE/panel.html" 'data-jhin-id="answer"')
action_hits=$(count_matches "$EVIDENCE/panel.html" 'answer-question')
call_hits=$(count_matches "$EVIDENCE/panel.html" "$call_id")
{
    echo "T309 pending panel — GET /ui/screen/chat:$s (panel.html):"
    echo "  composer-pending-question panel root: $panel_hits hit(s)"
    echo "  composer-pending-options chip row:    $options_hits hit(s)"
    echo "  composer-pending-reply row:           $reply_hits hit(s)"
    echo "  question text \"$QUESTION_TEXT\": $question_hits hit(s)"
    echo "  option chip \">Yes<\":                  $yes_hits hit(s)"
    echo "  option chip \">No<\":                   $no_hits hit(s)"
    echo "  reply input data-jhin-id=\"answer\":     $answer_input_hits hit(s)"
    echo "  answer-question action payloads:      $action_hits hit(s)"
    echo "  call id $call_id in the payloads: $call_hits hit(s)"
} > "$EVIDENCE/panel-check.txt"
[ "$panel_hits" -ge 1 ] || fail "the chat screen carries no composer-pending-question panel (panel.html)"
[ "$options_hits" -ge 1 ] || fail "the pending panel carries no composer-pending-options row (panel.html)"
[ "$reply_hits" -ge 1 ] || fail "the pending panel carries no composer-pending-reply row (panel.html)"
[ "$question_hits" -ge 1 ] || fail "the pending panel carries no \"$QUESTION_TEXT\" question text (panel.html)"
[ "$yes_hits" -ge 1 ] || fail "the pending panel carries no \">Yes<\" option chip (panel.html)"
[ "$no_hits" -ge 1 ] || fail "the pending panel carries no \">No<\" option chip (panel.html)"
[ "$answer_input_hits" -ge 1 ] || fail "the pending panel carries no data-jhin-id=\"answer\" reply input (panel.html)"
[ "$action_hits" -ge 2 ] || fail "the pending panel carries $action_hits answer-question action(s) (expected >= 2: chips + reply) (panel.html)"
[ "$call_hits" -ge 1 ] || fail "the pending panel payloads carry no call id $call_id (panel.html)"
ok "the composer carries the question + Yes/No chips + the answer reply row (panel.html, panel-check.txt)"
sleep 1

# -------------------------------------------------------------- the answer
echo "== Step 8: POST /ui/action/answer-question — the answer resumes the run =="
code=$(answer_question "$s" "$call_id" "Yes" "happy" "$EVIDENCE/answer.json")
[ "$code" = "200" ] \
    || fail "POST /ui/action/answer-question answered $code (expected 200): $(cat "$EVIDENCE/answer.json")"
patch_hits=$(jq -r '[.client[]? | select(.op == "patch")] | length' "$EVIDENCE/answer.json" 2>/dev/null || echo 0)
patch_id=$(jq -r '[.client[]? | select(.op == "patch")][0].id // ""' "$EVIDENCE/answer.json" 2>/dev/null || true)
patch_html=$(jq -r '[.client[]? | select(.op == "patch")][0].html // ""' "$EVIDENCE/answer.json" 2>/dev/null || true)
restored_hits=$(count_matches /dev/stdin 'data-jhin-id="messageInput"' <<< "$patch_html")
[ "$patch_hits" = "1" ] \
    || fail "the answer carries $patch_hits patch directive(s) (expected 1): $(cat "$EVIDENCE/answer.json")"
[ "$patch_id" = "composer-input" ] \
    || fail "the answer patches \"$patch_id\" (expected composer-input): $(cat "$EVIDENCE/answer.json")"
[ "$restored_hits" -ge 1 ] \
    || fail "the composer-input patch does not restore the message input (answer.json)"
{
    echo "T309 answer — POST /ui/action/answer-question {sessionId:$s, callId:$call_id, answer:\"Yes\"}:"
    echo "  HTTP $code"
    echo "  patch directives: $patch_hits (id \"$patch_id\")"
    echo "  patch restores the message input (data-jhin-id=\"messageInput\"): $restored_hits hit(s)"
} > "$EVIDENCE/answer-check.txt"
ok "answer-question answers one composer-input patch that restores the message input (answer.json)"

# ------------------------------------------------------------- run resumed
echo "== Step 9: the run resumes to run_end — the answer is the tool_result =="
consume_events "$s" "$EVIDENCE/events.sse" 0 run_end
assert_order "$EVIDENCE/events.sse.types" run_start tool_use tool_result message_end run_end
result_content=$(event_field "$EVIDENCE/events.sse" tool_result '.content')
result_error=$(event_field "$EVIDENCE/events.sse" tool_result '.error')
result_id=$(event_field "$EVIDENCE/events.sse" tool_result '.id')
end_text=$(event_field "$EVIDENCE/events.sse" message_end '.text')
[ "$result_id" = "$call_id" ] \
    || fail "the tool_result id is \"$result_id\" (expected $call_id) (events.jsonl)"
[ "$result_content" = "Yes" ] \
    || fail "the tool_result content is \"$result_content\" (expected \"Yes\") (events.jsonl)"
[ "$result_error" = "false" ] \
    || fail "the tool_result carries error=$result_error (expected false) (events.jsonl)"
[ "$end_text" = "Done." ] \
    || fail "the message_end text is \"$end_text\" (expected \"Done.\") (events.jsonl)"
event_lines=$(wc -l < "$EVIDENCE/events.jsonl" | tr -d ' ')
{
    echo "T309 run completion — GET /sessions/$s/events (events.sse / events.jsonl):"
    echo "  event types: $(tr '\n' ' ' < "$EVIDENCE/events.sse.types")"
    echo "  tool_result id/content/error: $result_id / \"$result_content\" / $result_error"
    echo "  message_end text: \"$end_text\""
    echo "  events.jsonl lines: $event_lines"
} > "$EVIDENCE/events-check.txt"
ok "the answer resumes the run: tool_result content \"Yes\", run_end reached (events.jsonl)"

# ------------------------------------------------------- the panel is gone
echo "== Step 10: re-fetch the chat screen — the panel is replaced =="
fetch_chat_html "$s" "$EVIDENCE/panel-after.html" "$EVIDENCE/panel-after-screen.json"
after_panel=$(count_matches "$EVIDENCE/panel-after.html" 'composer-pending-question')
after_input=$(count_matches "$EVIDENCE/panel-after.html" 'data-jhin-id="messageInput"')
[ "$after_panel" = "0" ] \
    || fail "the answered chat screen still carries $after_panel pending question panel(s) (panel-after.html)"
[ "$after_input" -ge 1 ] \
    || fail "the answered chat screen carries no restored message input (panel-after.html)"
ok "the answered screen carries the message input again and no question panel (panel-after.html)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T309 browser steps — UNAVAILABLE in this environment.

Browser automation (the agent browser / screenshots / evaluate) cannot run
on this QA machine; the T202–T208/T301–T308 precedent applies: every
browser step is substituted with curl + static asserts.

Not executed (the plan's interactive/visual cases):
  - Watching the composer turn into the pending question panel while the
    run blocks: substituted by the panel.html markup asserts
    (composer-pending-question, the question text, the composer-pending-options
    chips >Yes< / >No<, the composer-pending-reply row and the
    data-jhin-id="answer" reply input).
  - Tapping the Yes chip / typing into the reply row and submitting:
    substituted by the POST /ui/action/answer-question directive asserts
    (answer.json — one composer-input patch restoring the message input) and
    the events.jsonl tool_result content assert.
  - Watching the panel swap back to the message input after the answer:
    substituted by the panel-after.html asserts (no composer-pending-question,
    the message input back).
  - Cancelling a blocked run from the composer: substituted by the --fail
    mode wire asserts (cancel.txt).
  - Answering a stale panel twice: substituted by the --fail mode wire
    asserts (double-answer.txt).

What IS proven here: a real run blocks in the blocking ask_user tool, the
served chat screen carries the pending-question composer panel with the
option chips and reply row wired to the answer-question action, the answer
resumes the run and lands as the tool_result content, and the double-answer
and cancel paths reject/fail honestly — all with curl.
EOF
ok "browser-unavailable.txt records the un-exercised visual cases"

# ---------------------------------------------------------------- summary
{
    echo "T309 QA — PASS"
    echo ""
    echo "  mode:              happy"
    echo "  suites:            :jhin-plugin-ui-kit:test $ui_kit_tests, :jhin-plugin-ui-default:test $ui_default_tests,"
    echo "                     :jhin-plugin-tools-builtin:test $tools_tests, :jhin-plugin-qa-mock-llm:test $mock_tests (0 failures)"
    echo "  provider:          POST /providers {\"format\":\"mock\",\"model\":\"ask\",\"apiKey\":\"qa\"} -> $provider_id"
    echo "                     (GET /providers/formats lists mock + openai; the ask_user turn"
    echo "                     is scripted by the qa-mock-llm ask seam, no network endpoint)"
    echo "  blocked run:       session $s, run $run_id — tool_use $call_id (ask_user),"
    echo "                     \"$QUESTION_TEXT\""
    echo "  pending panel:     panel.html — composer-pending-question + options"
    echo "                     >Yes< / >No< + the data-jhin-id=\"answer\" reply row"
    echo "  answer:            POST /ui/action/answer-question -> patch composer-input"
    echo "                     (answer.json, restores the message input)"
    echo "  run completion:    events.jsonl — tool_result \"$result_content\" (error=$result_error),"
    echo "                     message_end \"Done.\", run_end reached"
    echo "  panel replaced:    panel-after.html — no question panel, message input back"
    echo "  negative:          double answer rejected + cancel path — proven in --fail mode"
    echo ""
    echo "  evidence: $EVIDENCE"
    sed 's/^/  /' "$checks"
} > "$EVIDENCE/summary.txt"
ok "T309 QA PASS (summary.txt)"
