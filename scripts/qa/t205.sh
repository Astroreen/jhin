#!/usr/bin/env bash
# T205 QA — SSE streaming frames, delta batching, replay dedupe (chunk C).
#
# Proves, with a booted kernel, curl and static greps only (browser tools are
# UNAVAILABLE in this environment — every agent-browser step becomes
# evidence/T205/browser-unavailable.txt plus strengthened curl/static asserts,
# the T202/T203/T204 precedent):
#   1. build + test gates: the seven jars build and the four suites stay green
#      with the T205 frames on the classpath —
#      :jhin-plugin-ui-default:test 408 (EventFramesTest 12 of them),
#      :jhin-plugin-ui-kit:test 291, :sdk:test 64, :kernel:test 117
#      (KernelPurityTest must stay green); counts are summed from the JUnit
#      XML reports and asserted exactly;
#   2. static gates on the runtime assets: no `eval` / `new Function` in
#      app.js; no `<` in app.css; app.js <= 60000 bytes (recorded actual);
#      the `node --check` syntax gate is recorded in evidence node-check.txt
#      (the QA rules keep node out of scripts/qa/*.sh — "pure curl+gradle"
#      there — so the check runs manually and its SYNTAX_OK verdict is
#      asserted here); the T205 runtime markers are present (module-8 SSE
#      applyFrame / fetch-stream + EventSource fallback / Last-Event-ID /
#      tombstones / reconnect backoff / syncStreams / openOverview,
#      withFocusRestore, turnRunning, ANCHOR_PX, the restored
#      localStorage jhin.keybindings overrides) and the T100 end-inset;
#   3. boot the kernel, GET /_jhin/health -> 200, GET / -> 200 text/html;
#   4. configure the deterministic mock LLM through the established
#      mechanism (POST /providers {"format":"mock","model":"title"} — the
#      qa-mock-llm factory publishes format `mock` and the provider `model`
#      name selects the script: `title` = QaMockTitleModel's fixed over-long
#      answer, `fail` = failing model, anything else = the plain scripted
#      run model; no config keys, env vars or files are involved) and drive
#      two runs with it while one SSE capture (curl -N) is open on
#      GET /ui/stream/session/{id}?fromSeq=0; the raw capture is reduced to
#      frames.jsonl (one JSON frame per line) and asserted:
#        - >= 3 distinct `patch` frames on the wire (plan T205.4);
#        - every frame is exactly one of the 5 shapes of docs/sdui.md
#          section 5 ({node|patch|replace:{id,html}}, {remove:"id"},
#          {client:[...]}), node/patch/replace carry `html`, and there is no
#          `props` / node-tree key anywhere (grep '"props"' == 0; the naive
#          '"node":{' grep is NOT used as a negative because "node": is the
#          shape discriminator itself — the envelope is asserted by jq to
#          carry exactly {id, html});
#        - the capture is live: a mid-run snapshot (frames-live-mid.txt)
#          already carries run 1's frames before run 2 is sent;
#   5. delta batching evidence (patch-count.txt): per msg-<seq> the number
#      of patch frames is <= the number of text_delta events it absorbed in
#      the 60 ms window (the mock answers one text_delta per message), and
#      message_end produced exactly ONE final cumulative patch carrying the
#      full scripted text once at the end;
#   6. replay/dedupe (replay-dedupe.txt): the stream is re-requested with
#      Last-Event-ID set to a mid-stream id (the msg-<seq> of run 1's open
#      assistant message) plus the ?fromSeq= resume parameter — the client
#      sends both (app.js streamUrl + fetch-loop headers) and the server
#      resume parameter is fromSeq (StreamRoute.parseFromSeq; no
#      Last-Event-ID handler exists in kernel/sdk/plugins). The replay must
#      not duplicate logical rows (same id+content node/replace pair at most
#      once), must not re-emit the earlier history as node frames (the
#      seen-dedup/absorb design: replay starts near where it was asked and
#      patches the absorbed open message instead of re-opening it), and the
#      FINAL text of each message id must be identical between the live
#      capture and the replay capture;
#   7. unknown-id.txt: a stream request naming an unknown session answers a
#      JSON 404 unknown_session (never SSE) and a malformed fromSeq answers
#      a JSON 400 naming fromSeq; an unknown frame target id is dropped by
#      the client with a console.warn (static, app.js); the kernel answers
#      health 200 after both probes — nothing crashes;
#   8. browser-unavailable.txt: the stream-01..03.png screenshots (live
#      streaming, visual scroll anchoring, focus restore) cannot run here;
#      the file lists which curl/static asserts substitute which case.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with six plugin jars: jhin.sessions, jhin.ui-kit and jhin.ui (the
# non-optional requires of jhin.ui), plus the streaming wiring — jhin.llm and
# jhin.agent (the mock factory is jhin.qa-mock-llm's non-optional require and
# POST /sessions/{id}/messages lives in jhin.agent) and jhin.qa-mock-llm
# itself. jhin.security is deliberately absent: the qa-mock-llm plugin
# requires no security, no bearer token is needed, no TlsProvider is
# registered and the listener speaks plain HTTP on
# http://localhost:18443 (the kernel default 8443 is occupied by another
# service on the QA machine; the frozen kernel CLI has no --no-tls flag —
# plan section 9 allows the QA-only plain-HTTP mode in scripts).
#
# On any failure one line is appended to evidence/T205/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EVIDENCE="$ROOT/.sisyphus/evidence/T205"
APP_JS="plugins/ui-default/src/main/resources/web/app.js"
APP_CSS="plugins/ui-default/src/main/resources/web/app.css"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.0.0-web; schema=5; caps=sse,open_url,secure_storage'
# The scripted answer of the mock script selected by model "title"
# (QaMockTitleModel.TITLE — deliberately longer than 60 chars so the title
# flow must truncate it; the run's message_end carries it whole).
SCRIPT_TEXT='Fix the authentication flow across the gateway, the proxy and every dependent microservice'

mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/failures.txt"

fail() {
    echo "FAIL: $*" | tee -a "$EVIDENCE/failures.txt" >&2
    exit 1
}

kernel_pid=""
capture_pid=""
cleanup() {
    if [ -n "$capture_pid" ] && kill -0 "$capture_pid" 2>/dev/null; then
        kill "$capture_pid" 2>/dev/null || true
        wait "$capture_pid" 2>/dev/null || true
    fi
    if [ -n "$kernel_pid" ] && kill -0 "$kernel_pid" 2>/dev/null; then
        kill "$kernel_pid" 2>/dev/null || true
        wait "$kernel_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT

echo "== T205 QA: SSE streaming frames, delta batching, replay dedupe =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

# ------------------------------------------------------------------- build
echo "== Step 1: build the jars + run the four test gates =="
set +e
./gradlew --console=plain :kernel:bootJar \
    :jhin-plugin-sessions:jar :jhin-plugin-llm:jar :jhin-plugin-agent:jar \
    :jhin-plugin-qa-mock-llm:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar \
    2>&1 | tee "$EVIDENCE/build.log"
BUILD_STATUS="${PIPESTATUS[0]}"
set -e
[ "$BUILD_STATUS" -eq 0 ] || fail "gradle build exited $BUILD_STATUS (see $EVIDENCE/build.log)"

set +e
./gradlew --console=plain \
    :jhin-plugin-ui-default:test --rerun \
    :jhin-plugin-ui-kit:test --rerun \
    :sdk:test --rerun \
    :kernel:test --rerun \
    2>&1 | tee -a "$EVIDENCE/build.log"
TEST_STATUS="${PIPESTATUS[0]}"
set -e
[ "$TEST_STATUS" -eq 0 ] || fail "gradle tests exited $TEST_STATUS (see $EVIDENCE/build.log)"
grep -qF 'BUILD SUCCESSFUL' "$EVIDENCE/build.log" \
    || fail "gradle did not report BUILD SUCCESSFUL (see $EVIDENCE/build.log)"

# Test-count gates: sum the JUnit XML counters of each suite.
count_attr() {
    grep -h -o "$2=\"[0-9]*\"" "$1"/TEST-*.xml 2>/dev/null | awk -F'"' '{s += $2} END {print s+0}'
}
ui_default_tests=$(count_attr plugins/ui-default/build/test-results/test tests)
ui_kit_tests=$(count_attr plugins/ui-kit/build/test-results/test tests)
sdk_tests=$(count_attr sdk/build/test-results/test tests)
kernel_tests=$(count_attr kernel/build/test-results/test tests)
total_failures=$(( $(count_attr plugins/ui-default/build/test-results/test failures) \
    + $(count_attr plugins/ui-kit/build/test-results/test failures) \
    + $(count_attr sdk/build/test-results/test failures) \
    + $(count_attr kernel/build/test-results/test failures) ))
total_errors=$(( $(count_attr plugins/ui-default/build/test-results/test errors) \
    + $(count_attr plugins/ui-kit/build/test-results/test errors) \
    + $(count_attr sdk/build/test-results/test errors) \
    + $(count_attr kernel/build/test-results/test errors) ))
{
    echo "T205 test gates — the four suites green with the T205 frames:"
    grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
    echo ""
    echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (expected 408; EventFramesTest among them)"
    echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests (expected 291)"
    echo "  :sdk:test                     $sdk_tests tests (expected 64)"
    echo "  :kernel:test                  $kernel_tests tests (expected 117; KernelPurityTest)"
    echo "  failures=$total_failures errors=$total_errors (expected 0/0)"
} > "$EVIDENCE/test-gates.txt"
for suite in ':jhin-plugin-ui-default:test' ':jhin-plugin-ui-kit:test' ':sdk:test' ':kernel:test'; do
    grep -qF "> Task $suite" "$EVIDENCE/build.log" \
        || fail "test suite $suite did not run (see $EVIDENCE/build.log)"
done
[ "$ui_default_tests" = "408" ] || fail "ui-default ran $ui_default_tests tests (expected 408)"
[ "$ui_kit_tests" = "291" ] || fail "ui-kit ran $ui_kit_tests tests (expected 291)"
[ "$sdk_tests" = "64" ] || fail "sdk ran $sdk_tests tests (expected 64)"
[ "$kernel_tests" = "117" ] || fail "kernel ran $kernel_tests tests (expected 117)"
[ "$total_failures" = "0" ] || fail "test failures=$total_failures (expected 0)"
[ "$total_errors" = "0" ] || fail "test errors=$total_errors (expected 0)"
echo "-- OK: build + four test gates green (408/291/64/117; $EVIDENCE/test-gates.txt)"

# ----------------------------------------------------------- static gates
echo "== Step 2: static gates on app.js / app.css =="
{
    echo "T205 static gates — the plan's hard rules on the runtime assets."
    echo ""
} > "$EVIDENCE/static-gates.txt"

# 2a: no eval / new Function in app.js.
eval_count=$(grep -c "eval\|new Function" "$APP_JS" || true)
{
    echo "gate 2a — no eval / new Function in app.js:"
    echo "  grep -c \"eval\\|new Function\" $APP_JS -> $eval_count (must be 0)"
} >> "$EVIDENCE/static-gates.txt"
[ "$eval_count" = "0" ] \
    || fail "app.js carries $eval_count eval/new Function occurrences (must be 0)"

# 2b: no '<' in app.css (CSS must not smuggle markup).
lt_count=$(grep -c '<' "$APP_CSS" || true)
{
    echo "gate 2b — no '<' in app.css:"
    echo "  grep -c '<' $APP_CSS -> $lt_count (must be 0)"
} >> "$EVIDENCE/static-gates.txt"
[ "$lt_count" = "0" ] \
    || fail "app.css carries $lt_count '<' occurrences (must be 0)"

# 2c: app.js size budget (T207: <= 60000 bytes; asserted now so T207 cannot
# regress silently).
js_bytes=$(wc -c < "$APP_JS" | tr -d ' ')
css_bytes=$(wc -c < "$APP_CSS" | tr -d ' ')
{
    echo "gate 2c — app.js size budget (T207 <= 60000 bytes):"
    echo "  wc -c $APP_JS -> $js_bytes bytes (must be <= 60000)"
    echo "  wc -c $APP_CSS -> $css_bytes bytes (recorded, no budget)"
} >> "$EVIDENCE/static-gates.txt"
[ "$js_bytes" -le 60000 ] \
    || fail "app.js is $js_bytes bytes (must be <= 60000 for the T207 budget)"

# 2d: the node --check syntax gate. The QA rules forbid invoking node from
# scripts/qa/*.sh, so the check runs manually and its verdict is recorded in
# node-check.txt (written before this script) and asserted here.
if [ -f "$EVIDENCE/node-check.txt" ] && grep -qF 'SYNTAX_OK' "$EVIDENCE/node-check.txt"; then
    node_check="PASS"
else
    node_check="FAIL"
fi
{
    echo "gate 2d — node --check $APP_JS (manual gate; node is never invoked from scripts/qa/*.sh):"
    echo "  recorded verdict in node-check.txt -> $node_check (must be PASS / SYNTAX_OK)"
} >> "$EVIDENCE/static-gates.txt"
[ "$node_check" = "PASS" ] \
    || fail "node-check.txt is missing or lacks SYNTAX_OK — run: node --check $APP_JS (see $EVIDENCE/node-check.txt)"

# 2e: the T205 runtime markers of chunk B (module 8 SSE, focus restore,
# anchoring, turnRunning, restored keybindings overrides).
marker_ok=1
for marker in 'function applyFrame' 'EventSource' 'Last-Event-ID' 'st.dead' \
    'function scheduleReconnect' 'function syncStreams' 'function openOverview' \
    'function withFocusRestore' 'turnRunning' 'ANCHOR_PX' \
    'function readKeyOverrides' 'jhin.keybindings' 'function effectiveKeymap'; do
    if ! grep -qF "$marker" "$APP_JS"; then
        marker_ok=0
        echo "gate 2e — runtime marker MISSING in app.js: $marker" >> "$EVIDENCE/static-gates.txt"
    fi
done
if ! grep -qF 'padding-bottom: 24px' "$APP_CSS"; then
    marker_ok=0
    echo "gate 2e — T100 end-inset MISSING in app.css (padding-bottom: 24px)" >> "$EVIDENCE/static-gates.txt"
fi
{
    echo "gate 2e — T205 runtime markers (SSE module 8, focus restore, anchoring,"
    echo "  turnRunning, jhin.keybindings overrides, T100 end-inset): $([ "$marker_ok" = 1 ] && echo PRESENT || echo MISSING)"
    grep -n 'function applyFrame\|function withFocusRestore\|turnRunning =\|const ANCHOR_PX\|function readKeyOverrides\|padding-bottom: 24px' \
        "$APP_JS" "$APP_CSS" | sed 's/^/  /'
} >> "$EVIDENCE/static-gates.txt"
[ "$marker_ok" = 1 ] || fail "T205 runtime markers missing (see $EVIDENCE/static-gates.txt)"
echo "-- OK: static gates green ($EVIDENCE/static-gates.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (sessions, ui-kit, ui + llm, agent, qa-mock-llm) =="
home=$(mktemp -d /tmp/t205-home.XXXXXX)
bundled=$(mktemp -d /tmp/t205-bundled.XXXXXX)
cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$bundled/"
cp plugins/ui-kit/build/libs/jhin-plugin-ui-kit-*.jar "$bundled/"
cp plugins/ui-default/build/libs/jhin-plugin-ui-default-*.jar "$bundled/"
cp plugins/llm/build/libs/jhin-plugin-llm-*.jar "$bundled/"
cp plugins/agent/build/libs/jhin-plugin-agent-*.jar "$bundled/"
cp plugins/qa-mock-llm/build/libs/jhin-plugin-qa-mock-llm-*.jar "$bundled/"
jar_count=$(ls "$bundled"/*.jar 2>/dev/null | wc -l | tr -d ' ')
[ "$jar_count" = "6" ] || fail "expected 6 plugin jars in $bundled, got $jar_count"
{
    echo "JHIN_HOME=$home"
    echo "JHIN_BUNDLED_PLUGINS=$bundled"
    echo "port=$PORT"
    echo "base=$BASE"
    echo "mode=plain HTTP loopback"
    echo "mode-reason=jhin.security is not loaded -> no TlsProvider registered -> the kernel"
    echo "            listener speaks plain HTTP (kernel.log: 'no TLS material registered;"
    echo "            the listener speaks plain HTTP'). The frozen kernel CLI has no --no-tls"
    echo "            flag (KernelBoot parses only --server.address and --server.port);"
    echo "            plan section 9 allows the QA-only plain-HTTP mode in scripts."
    echo "port-reason=the kernel default 8443 is occupied by another service on this machine"
    echo "plugins=jhin.sessions, jhin.ui-kit, jhin.ui, jhin.llm, jhin.agent, jhin.qa-mock-llm"
    echo "plugin-reason=jhin.sessions + jhin.ui-kit + jhin.ui are the non-optional requires"
    echo "              of jhin.ui (the t202/t203/t204 QA bundle). The streaming part adds"
    echo "              jhin.qa-mock-llm (the deterministic mock LLM, id jhin.qa-mock-llm,"
    echo "              format 'mock') whose non-optional require is jhin.llm, and jhin.agent"
    echo "              which owns POST /sessions/{id}/messages and the run that emits the"
    echo "              session events. jhin.qa-mock-llm does NOT require jhin.security; no"
    echo "              bearer token is used anywhere in this run."
} > "$EVIDENCE/kernel-env.txt"
echo "-- OK: $jar_count jars staged for seeding ($EVIDENCE/kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (wait <= 30 s for health) =="
JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
    "$ROOT/scripts/qa/run-kernel.sh" "$EVIDENCE" --server.port="$PORT" &
kernel_pid=$!

start=$(date +%s)
code=000
while :; do
    code=$(curl -s --max-time 2 -o "$EVIDENCE/health.body" -w '%{http_code}' \
        "$BASE/_jhin/health" 2>/dev/null) || code=000
    [ "$code" = "200" ] && break
    kill -0 "$kernel_pid" 2>/dev/null \
        || fail "kernel (pid $kernel_pid) exited before health answered (see $EVIDENCE/kernel.log)"
    now=$(date +%s)
    [ $((now - start)) -lt 30 ] \
        || fail "health endpoint did not answer 200 within 30 s (last code $code)"
    sleep 0.5
done
echo "-- OK: kernel up on $BASE (pid $kernel_pid), health answered 200 in $(( $(date +%s) - start )) s"

# ------------------------------------------------------------- web shell
echo "== Step 5: GET / serves the web shell =="
shell_code=$(curl -s --max-time 10 -D "$EVIDENCE/shell.headers" -o "$EVIDENCE/shell.html" \
    -w '%{http_code}' "$BASE/") || fail "GET /: curl failed"
printf '%s\n' "$shell_code" > "$EVIDENCE/shell.status"
[ "$shell_code" = "200" ] || fail "GET / answered $shell_code (expected 200)"
grep -qiF 'content-type: text/html' "$EVIDENCE/shell.headers" \
    || fail "GET / Content-Type is not text/html: $(grep -i 'content-type' "$EVIDENCE/shell.headers" || true)"
grep -qF 'id="jhin-root"' "$EVIDENCE/shell.html" || fail "shell.html has no #jhin-root element"
echo "-- OK: GET / -> 200 text/html"

# ------------------------------------------------- mock LLM + one session
echo "== Step 6: mock LLM provider (format mock, model title) + session =="
mock_note="$EVIDENCE/mock-llm.txt"
{
    echo "T205 mock LLM wiring — the established qa-mock-llm configuration mechanism."
    echo ""
    echo "The jhin.qa-mock-llm plugin (plugins/qa-mock-llm/, id jhin.qa-mock-llm,"
    echo "\"scripted replies, title and failure scripts\") publishes ONE service:"
    echo "LlmProviderFactory under the qualifier 'mock' (QaMockLlmPlugin.start ->"
    echo "services().publish(LlmProviderFactory.class, \"mock\", ...)). Configuration is"
    echo "the provider record itself — POST /providers with a JSON body; the 'model'"
    echo "name selects the script (QaMockFactory.create):"
    echo "  model=fail   -> QaMockFailingModel (every call fails)"
    echo "  model=title  -> QaMockTitleModel (the fixed over-long answer used below)"
    echo "  anything else-> QaMockChatModel (one 'write' tool call when that tool is"
    echo "                 offered, else the short text 'Done.')"
    echo "There are no config keys, no env vars and no files under the Jhin home —"
    echo "the same POST /providers mechanism scripts/qa/t75.sh and e2e-bundle.sh use."
    echo "Keep JHIN_LLM_BUILTIN_QA unset (it is): jhin.llm-builtin is not in this bundle,"
    echo "so nothing collides on the 'mock' qualifier."
    echo ""
} > "$mock_note"
prov_code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
    -o "$EVIDENCE/providers.body" -w '%{http_code}' \
    -d '{"format":"mock","model":"title","apiKey":"qa"}' "$BASE/providers") \
    || fail "POST /providers: curl failed"
printf '%s\n' "$prov_code" > "$EVIDENCE/providers.status"
[ "$prov_code" = "201" ] || fail "POST /providers answered $prov_code (expected 201): $(cat "$EVIDENCE/providers.body")"
pid=$(jq -r '.id' "$EVIDENCE/providers.body")
[ -n "$pid" ] && [ "$pid" != "null" ] || fail "POST /providers returned no id: $(cat "$EVIDENCE/providers.body")"
echo "POST /providers {format:mock, model:title} -> 201, provider id $pid" >> "$mock_note"

sess_code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
    -o "$EVIDENCE/session.body" -w '%{http_code}' \
    -d "{\"title\":\"t205 streaming\",\"workdir\":\"/tmp/t205-work\",\"providerId\":\"$pid\"}" \
    "$BASE/sessions") || fail "POST /sessions: curl failed"
printf '%s\n' "$sess_code" > "$EVIDENCE/session.status"
[ "$sess_code" = "201" ] || fail "POST /sessions answered $sess_code (expected 201): $(cat "$EVIDENCE/session.body")"
sid=$(jq -r '.id' "$EVIDENCE/session.body")
[ -n "$sid" ] && [ "$sid" != "null" ] || fail "POST /sessions returned no id: $(cat "$EVIDENCE/session.body")"
echo "POST /sessions {title,workdir,providerId} -> 201, session $sid" >> "$mock_note"
echo "-- OK: provider $pid, session $sid ($EVIDENCE/mock-llm.txt)"

# -------------------------------------------- live SSE capture + two runs
echo "== Step 7: open the session stream (curl -N) and drive run 1 =="
curl -sN --max-time 60 -H "$CLIENT_API4" \
    "$BASE/ui/stream/session/$sid?fromSeq=0" > "$EVIDENCE/frames-raw.sse" &
capture_pid=$!
sleep 1.5
kill -0 "$capture_pid" 2>/dev/null || fail "the SSE capture process died at open (see $EVIDENCE/frames-raw.sse)"

run1_code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
    -o "$EVIDENCE/messages-1.body" -w '%{http_code}' \
    -d '{"text":"Fix the login bug in the auth module"}' "$BASE/sessions/$sid/messages") \
    || fail "POST /sessions/{id}/messages (run 1): curl failed"
printf '%s\n' "$run1_code" > "$EVIDENCE/messages-1.status"
[ "$run1_code" = "202" ] || fail "run 1 POST answered $run1_code (expected 202): $(cat "$EVIDENCE/messages-1.body")"
run1=$(jq -r '.runId' "$EVIDENCE/messages-1.body")
[ -n "$run1" ] && [ "$run1" != "null" ] || fail "run 1 returned no runId: $(cat "$EVIDENCE/messages-1.body")"

# Wait for run 1 to finish: poll the raw events endpoint until one run_end.
wait_run_end() {
    local want=$1 out=$2 i n
    for i in $(seq 1 30); do
        timeout 2 curl -sN -H "$CLIENT_API4" "$BASE/sessions/$sid/events?fromSeq=0" > "$out" || true
        n=$(grep -c '"type":"run_end"' "$out" || true)
        [ "$n" -ge "$want" ] && return 0
        sleep 0.5
    done
    return 1
}
wait_run_end 1 "$EVIDENCE/run1-events.txt" \
    || fail "run 1 did not finish within 15 s (see $EVIDENCE/run1-events.txt)"
echo "-- OK: run 1 ($run1) finished (run_end in run1-events.txt)"

# Mid-run snapshot of the capture: run 1's frames already on the wire while
# the connection is still open (the live-streaming proof, browser-less).
sleep 0.5
cp "$EVIDENCE/frames-raw.sse" "$EVIDENCE/frames-live-mid.sse"
awk '/^event: frame$/ { if (getline > 0) { sub(/^data: /, ""); print } }' \
    "$EVIDENCE/frames-live-mid.sse" > "$EVIDENCE/frames-live-mid.txt"
mid_frames=$(wc -l < "$EVIDENCE/frames-live-mid.txt" | tr -d ' ')
{
    echo "T205 live-capture snapshot — taken after run 1 finished and BEFORE run 2 was sent."
    echo "The SSE connection (curl -N on /ui/stream/session/$sid?fromSeq=0) was open the"
    echo "whole time, so these frames arrived live on the wire during run 1:"
    echo "  frame count at snapshot: $mid_frames"
    echo ""
    jq -r 'keys[0] as $k | $k + " " + (if $k == "node" or $k == "patch" or $k == "replace"
            then (.[$k].id // "?") elif $k == "remove" then .remove else "<directives>" end)' \
        "$EVIDENCE/frames-live-mid.txt" | sed 's/^/  /'
} > "$EVIDENCE/frames-live-mid-report.txt"
[ "$mid_frames" -ge 3 ] \
    || fail "the live capture held only $mid_frames frames after run 1 (expected >= 3; see $EVIDENCE/frames-live-mid.sse)"
grep -q '"patch"' "$EVIDENCE/frames-live-mid.txt" \
    || fail "run 1's live frames carry no patch frame (see $EVIDENCE/frames-live-mid.txt)"
echo "-- OK: live mid-run snapshot carries $mid_frames frames (frames-live-mid-report.txt)"

echo "== Step 8: drive run 2, then two session_updated patches (title + settle) =="
run2_code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
    -o "$EVIDENCE/messages-2.body" -w '%{http_code}' \
    -d '{"text":"Now update the tests for the auth module"}' "$BASE/sessions/$sid/messages") \
    || fail "POST /sessions/{id}/messages (run 2): curl failed"
printf '%s\n' "$run2_code" > "$EVIDENCE/messages-2.status"
[ "$run2_code" = "202" ] || fail "run 2 POST answered $run2_code (expected 202): $(cat "$EVIDENCE/messages-2.body")"
run2=$(jq -r '.runId' "$EVIDENCE/messages-2.body")
[ -n "$run2" ] && [ "$run2" != "null" ] || fail "run 2 returned no runId: $(cat "$EVIDENCE/messages-2.body")"
wait_run_end 2 "$EVIDENCE/run2-events.txt" \
    || fail "run 2 did not finish within 15 s (see $EVIDENCE/run2-events.txt)"
echo "-- OK: run 2 ($run2) finished (two run_end events in run2-events.txt)"

title_code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
    -o "$EVIDENCE/title.body" -w '%{http_code}' -X POST -d '' "$BASE/sessions/$sid/title") \
    || fail "POST /sessions/{id}/title: curl failed"
printf '%s\n' "$title_code" > "$EVIDENCE/title.status"
[ "$title_code" = "200" ] || fail "POST /sessions/{id}/title answered $title_code: $(cat "$EVIDENCE/title.body")"
new_title=$(jq -r '.title' "$EVIDENCE/title.body")
[ "${#new_title}" -le 60 ] || fail "the regenerated title exceeds 60 chars: $new_title"
echo "-- OK: title regenerated (${#new_title} chars: $new_title) -> session_updated"

settle_code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
    -o "$EVIDENCE/settle.body" -w '%{http_code}' \
    -d '{"reason":"manual"}' "$BASE/sessions/$sid/settle") \
    || fail "POST /sessions/{id}/settle: curl failed"
printf '%s\n' "$settle_code" > "$EVIDENCE/settle.status"
[ "$settle_code" = "200" ] || fail "POST /sessions/{id}/settle answered $settle_code: $(cat "$EVIDENCE/settle.body")"
echo "-- OK: settle -> 200 -> second session_updated"

sleep 1
if kill -0 "$capture_pid" 2>/dev/null; then
    kill "$capture_pid" 2>/dev/null || true
fi
wait "$capture_pid" 2>/dev/null || true
capture_pid=""

# one full raw-events listing for the delta accounting
timeout 3 curl -sN -H "$CLIENT_API4" "$BASE/sessions/$sid/events?fromSeq=0" \
    > "$EVIDENCE/events-all.txt" || true

# ------------------------------------------------- frames.jsonl + shapes
echo "== Step 9: frames.jsonl — the 5 shapes, html envelopes, >= 3 patches =="
awk '/^event: frame$/ { if (getline > 0) { sub(/^data: /, ""); print } }' \
    "$EVIDENCE/frames-raw.sse" > "$EVIDENCE/frames.jsonl"
frame_count=$(wc -l < "$EVIDENCE/frames.jsonl" | tr -d ' ')
[ "$frame_count" -ge 5 ] || fail "frames.jsonl holds only $frame_count frames"

# Shape membership: every frame is exactly one of the 5 shapes of section 5.
jq -c 'select((keys | length) != 1
    or (keys[0] != "node" and keys[0] != "patch" and keys[0] != "replace"
        and keys[0] != "remove" and keys[0] != "client"))' \
    "$EVIDENCE/frames.jsonl" > "$EVIDENCE/frames-bad-shape.txt" || true
[ ! -s "$EVIDENCE/frames-bad-shape.txt" ] \
    || fail "frames outside the 5-shape vocabulary: $(head -n 3 "$EVIDENCE/frames-bad-shape.txt")"

# Envelope: node/patch/replace carry exactly {id, html} with html a string —
# no props, no node-tree keys. remove is a bare id string; client an array.
jq -c 'select(has("node") or has("patch") or has("replace"))
    | (.node // .patch // .replace)
    | select((keys | sort) != ["html", "id"] or (.html | type) != "string")' \
    "$EVIDENCE/frames.jsonl" > "$EVIDENCE/frames-bad-envelope.txt" || true
[ ! -s "$EVIDENCE/frames-bad-envelope.txt" ] \
    || fail "node/patch/replace envelopes are not exactly {id, html}: $(head -n 3 "$EVIDENCE/frames-bad-envelope.txt")"
jq -c 'select(has("remove")) | select((.remove | type) != "string")' \
    "$EVIDENCE/frames.jsonl" > "$EVIDENCE/frames-bad-remove.txt" || true
[ ! -s "$EVIDENCE/frames-bad-remove.txt" ] || fail "remove frames whose payload is not a bare id"
jq -c 'select(has("client")) | select((.client | type) != "array")' \
    "$EVIDENCE/frames.jsonl" > "$EVIDENCE/frames-bad-client.txt" || true
[ ! -s "$EVIDENCE/frames-bad-client.txt" ] || fail "client frames whose payload is not a directive array"

props_count=$(grep -c '"props"' "$EVIDENCE/frames.jsonl" || true)
children_count=$(grep -c '"children"' "$EVIDENCE/frames.jsonl" || true)
[ "$props_count" = "0" ] || fail "frames.jsonl carries $props_count \"props\" occurrences (must be 0)"
[ "$children_count" = "0" ] || fail "frames.jsonl carries $children_count \"children\" occurrences (must be 0)"

jq -r 'keys[0]' "$EVIDENCE/frames.jsonl" | sort | uniq -c > "$EVIDENCE/shape-counts.txt"
patch_count=$(jq -r 'select(has("patch")) | .patch.id' "$EVIDENCE/frames.jsonl" | wc -l | tr -d ' ')
jq -r 'select(has("patch")) | .patch.id' "$EVIDENCE/frames.jsonl" | sort -u > "$EVIDENCE/patch-ids.txt"
patch_ids=$(wc -l < "$EVIDENCE/patch-ids.txt" | tr -d ' ')
{
    echo "T205 frame-shape asserts — frames.jsonl ($frame_count frames from the live capture):"
    echo ""
    echo "  shape counts (one key per frame, the 5 shapes of docs/sdui.md section 5):"
    sed 's/^/    /' "$EVIDENCE/shape-counts.txt"
    echo ""
    echo "  patch frames on the wire: $patch_count (asserted >= 3)"
    echo "  distinct patch target ids: $patch_ids ($(tr '\n' ' ' < "$EVIDENCE/patch-ids.txt"))"
    echo "  node/patch/replace envelopes: exactly {id, html}, html is a string (jq)"
    echo "  \"props\" occurrences: $props_count (asserted 0)"
    echo "  \"children\" occurrences: $children_count (asserted 0)"
    echo ""
    echo "  NOTE: the naive grep for the node-tree key pattern '\"node\":{' is NOT used as"
    echo "  a negative here — '\"node\":' IS the frame discriminator of the {node:{id,html}}"
    echo "  shape, so that pattern counts legal frames. The tree regression is excluded by"
    echo "  the jq envelope assert above (keys == [html, id]) and the props/children greps."
} > "$EVIDENCE/frame-shapes.txt"
[ "$patch_count" -ge 3 ] \
    || fail "only $patch_count patch frames on the wire (asserted >= 3; see $EVIDENCE/frame-shapes.txt)"
echo "-- OK: $frame_count frames, 5-shape vocabulary, $patch_count patch frames (>= 3)"

# ----------------------------------------------- patch-count (batching)
echo "== Step 10: patch-count.txt — delta batching evidence =="
sed -n 's/^data: //p' "$EVIDENCE/events-all.txt" \
    | jq -r '[.seq, .type] | @tsv' > "$EVIDENCE/events-order.txt"
awk '
    $2 == "message_start" { start = $1; deltas = 0 }
    $2 == "text_delta" && start != "" { deltas++ }
    $2 == "message_end" && start != "" { print "msg-" start, deltas; start = "" }
' "$EVIDENCE/events-order.txt" > "$EVIDENCE/delta-counts.txt"
[ -s "$EVIDENCE/delta-counts.txt" ] \
    || fail "no completed message found in the event log (see $EVIDENCE/events-order.txt)"
{
    echo "T205 delta batching — per message id: patch frames vs absorbed text_delta events."
    echo "The mock script (model=title) answers each turn with ONE text_delta carrying the"
    echo "whole scripted text and one message_end; EventFrames.DeltaBatcher coalesces"
    echo "deltas inside one 60 ms window (DELTA_FLUSH_WINDOW_MILLIS) and message_end"
    echo "emits the one final cumulative patch. Asserted per msg-<seq>:"
    echo "  patch frames <= text_delta events absorbed (here 1 <= 1),"
    echo "  exactly ONE patch carrying the full scripted text, appearing last."
    echo ""
    echo "  full scripted text: $SCRIPT_TEXT"
    echo ""
    printf '  %-10s %8s %8s %10s %s\n' "msg id" "deltas" "patches" "full-text" "verdict"
} > "$EVIDENCE/patch-count.txt"
batch_ok=1
for id in $(awk '{print $1}' "$EVIDENCE/delta-counts.txt"); do
    deltas=$(awk -v id="$id" '$1 == id {print $2}' "$EVIDENCE/delta-counts.txt")
    patches=$(jq -r --arg id "$id" 'select(.patch.id == $id) | 1' "$EVIDENCE/frames.jsonl" | wc -l | tr -d ' ')
    last_html=$(jq -r --arg id "$id" 'select(.patch.id == $id) | .patch.html' "$EVIDENCE/frames.jsonl" | tail -1)
    full="no"
    case "$last_html" in
        *"$SCRIPT_TEXT"*) full="yes" ;;
    esac
    verdict="ok"
    if [ "$patches" -gt "$deltas" ]; then
        verdict="FAIL patches > deltas"
        batch_ok=0
    fi
    if [ "$patches" != "1" ] || [ "$full" != "yes" ]; then
        verdict="FAIL not exactly one full-text final patch"
        batch_ok=0
    fi
    printf '  %-10s %8s %8s %10s %s\n' "$id" "$deltas" "$patches" "$full" "$verdict" >> "$EVIDENCE/patch-count.txt"
done
{
    echo ""
    echo "  session-row patches (session_updated -> sidebar row, not message text):"
    jq -r 'select(has("patch")) | .patch.id | select(startswith("session-row:"))' \
        "$EVIDENCE/frames.jsonl" | sort | uniq -c | sed 's/^/    /'
    echo ""
    echo "  message_end final patches: one per message id, each the last patch of its id"
    echo "  and the only one carrying the full scripted text (the flush rules: window"
    echo "  expiry / before any non-delta frame / message_end / close — EventFramesTest"
    echo "  covers the multi-delta windows that this instant mock cannot produce)."
} >> "$EVIDENCE/patch-count.txt"
[ "$batch_ok" = "1" ] || fail "delta batching asserts failed (see $EVIDENCE/patch-count.txt)"
echo "-- OK: one full-text cumulative patch per message, patches <= deltas ($EVIDENCE/patch-count.txt)"

# ------------------------------------------------------ replay / dedupe
echo "== Step 11: Last-Event-ID replay — dedupe and absorb semantics =="
mid_seq=$(sed -n 's/^data: //p' "$EVIDENCE/events-all.txt" \
    | jq -r 'select(.type=="message_start") | .seq' | head -1)
[ -n "$mid_seq" ] && [ "$mid_seq" != "null" ] || fail "no message_start seq found (see $EVIDENCE/events-all.txt)"
mid_id="msg-$mid_seq"
# The SSE stream never closes, so curl's --max-time expires by design (exit
# 28 after the window); the status line comes from the saved headers.
curl -s --max-time 6 -H "$CLIENT_API4" -H "Last-Event-ID: $mid_id" \
    -D "$EVIDENCE/replay.headers" -o "$EVIDENCE/replay-raw.sse" \
    "$BASE/ui/stream/session/$sid?fromSeq=$mid_seq" || true
replay_code=$(head -1 "$EVIDENCE/replay.headers" | awk '{print $2}' | tr -d '\r')
printf '%s\n' "$replay_code" > "$EVIDENCE/replay.status"
[ "$replay_code" = "200" ] \
    || fail "the replay request answered ${replay_code:-<none>} (expected 200 SSE; see $EVIDENCE/replay.headers)"
awk '/^event: frame$/ { if (getline > 0) { sub(/^data: /, ""); print } }' \
    "$EVIDENCE/replay-raw.sse" > "$EVIDENCE/replay-frames.jsonl"
replay_count=$(wc -l < "$EVIDENCE/replay-frames.jsonl" | tr -d ' ')
[ "$replay_count" -ge 1 ] || fail "the replay captured no frames (see $EVIDENCE/replay-raw.sse)"

# (a) No pre-window rows re-emitted as node/replace frames.
jq -r 'select(has("node") or has("replace")) | (.node // .replace).id' \
    "$EVIDENCE/replay-frames.jsonl" | sort -u > "$EVIDENCE/replay-row-ids.txt"
bad_rows=""
for rid in $(grep -E '^(ev|msg)-' "$EVIDENCE/replay-row-ids.txt" || true); do
    rseq="${rid#*-}"
    if [ "$rseq" -le "$mid_seq" ] 2>/dev/null; then
        bad_rows="$bad_rows $rid"
    fi
done
# (b) No duplicated id+content node/replace pair in the replay.
jq -c 'select(has("node") or has("replace")) | (.node // .replace)' \
    "$EVIDENCE/replay-frames.jsonl" | sort | uniq -d > "$EVIDENCE/replay-dup-rows.txt"
# (c) FINAL text of each message id identical live vs replay.
text_ok=1
{
    echo "T205 replay / dedupe — Last-Event-ID resume of the session stream."
    echo ""
    echo "Request: GET /ui/stream/session/$sid?fromSeq=$mid_seq"
    echo "         Last-Event-ID: $mid_id   (the mid-stream id of run 1's open assistant"
    echo "         message — its message_start seq $mid_seq was absorbed, its text_delta"
    echo "         absorbed, so the replay patches the message instead of re-opening it)"
    echo "Status:  $replay_code (SSE; $replay_count frames)"
    echo ""
    echo "Wire note: the client sends BOTH the Last-Event-ID header and the ?fromSeq="
    echo "resume parameter (app.js streamUrl + fetch-loop headers). The server resume"
    echo "parameter is fromSeq — StreamRoute.parseFromSeq; grep over kernel/, sdk/ and"
    echo "plugins/ finds no Last-Event-ID handler, so the header is sent for wire parity"
    echo "and the resume semantics live in fromSeq + the seen-dedup/absorb design."
    echo ""
    echo "(a) rows before the resume point must NOT be re-emitted as node/replace:"
    echo "    resume seq: $mid_seq"
    echo "    replay node/replace ids: $(tr '\n' ' ' < "$EVIDENCE/replay-row-ids.txt")"
    if [ -n "$bad_rows" ]; then
        echo "    FAIL — re-emitted rows:$bad_rows"
    else
        echo "    PASS — no node/replace id <= seq $mid_seq (run 1's rows are not replayed)"
    fi
    echo ""
    echo "(b) the same id+content node/replace pair at most once in the replay:"
    if [ -s "$EVIDENCE/replay-dup-rows.txt" ]; then
        echo "    FAIL — duplicated pairs:"
        sed 's/^/      /' "$EVIDENCE/replay-dup-rows.txt"
    else
        echo "    PASS — 0 duplicated id+content node/replace pairs"
    fi
    echo ""
    echo "(c) FINAL text of each message id identical between the live capture and the"
    echo "    replay capture (cumulative patches are idempotent content):"
} > "$EVIDENCE/replay-dedupe.txt"
for id in $(jq -r 'select(has("patch")) | .patch.id' "$EVIDENCE/replay-frames.jsonl" | grep '^msg-' | sort -u); do
    live_final=$(jq -r --arg id "$id" 'select(.patch.id == $id) | .patch.html' "$EVIDENCE/frames.jsonl" | tail -1)
    replay_final=$(jq -r --arg id "$id" 'select(.patch.id == $id) | .patch.html' "$EVIDENCE/replay-frames.jsonl" | tail -1)
    if [ "$live_final" = "$replay_final" ] && [ -n "$live_final" ]; then
        echo "    PASS — $id final patch identical (${#live_final} bytes of html)" >> "$EVIDENCE/replay-dedupe.txt"
    else
        echo "    FAIL — $id final patch differs (live ${#live_final} bytes / replay ${#replay_final} bytes)" >> "$EVIDENCE/replay-dedupe.txt"
        text_ok=0
    fi
done
{
    echo ""
    echo "    message ids in the replay: $(jq -r 'select(has("patch")) | .patch.id' "$EVIDENCE/replay-frames.jsonl" | grep '^msg-' | sort -u | tr '\n' ' ')"
    echo "    (ids absorbed before the resume point leave no rows in the replay by design;"
    echo "    the replay starts near where it was asked.)"
    echo ""
    echo "(d) absorb semantics proven: the message node of $mid_id was NOT re-opened in"
    echo "    the replay — only its patch frames grow the absorbed text state to the"
    echo "    final content (EventFrames.Translator.absorb)."
} >> "$EVIDENCE/replay-dedupe.txt"
[ -z "$bad_rows" ] || fail "the replay re-emitted pre-window rows:$bad_rows (see $EVIDENCE/replay-dedupe.txt)"
[ ! -s "$EVIDENCE/replay-dup-rows.txt" ] \
    || fail "the replay duplicated node/replace pairs (see $EVIDENCE/replay-dup-rows.txt)"
[ "$text_ok" = "1" ] || fail "final message texts differ between live and replay (see $EVIDENCE/replay-dedupe.txt)"
echo "-- OK: replay resumes at seq $mid_seq, no row duplication, final texts identical ($EVIDENCE/replay-dedupe.txt)"

# ---------------------------------------------------------- unknown ids
echo "== Step 12: unknown-id.txt — unknown session / fromSeq / frame target =="
unknown_code=$(curl -s --max-time 10 -H "$CLIENT_API4" \
    -D "$EVIDENCE/unknown-id.headers" -o "$EVIDENCE/unknown-id.body" -w '%{http_code}' \
    "$BASE/ui/stream/session/does-not-exist?fromSeq=0") \
    || fail "GET /ui/stream/session/does-not-exist: curl failed"
badseq_code=$(curl -s --max-time 10 -H "$CLIENT_API4" \
    -o "$EVIDENCE/bad-fromseq.body" -w '%{http_code}' \
    "$BASE/ui/stream/session/$sid?fromSeq=abc") \
    || fail "GET /ui/stream/session/{id}?fromSeq=abc: curl failed"
health_after=$(curl -s --max-time 5 -o "$EVIDENCE/health-after-unknown.body" -w '%{http_code}' \
    "$BASE/_jhin/health") || health_after=000
{
    echo "T205 unknown-id probes — a bad stream reference must not crash the server."
    echo ""
    echo "probe 1 — GET /ui/stream/session/does-not-exist?fromSeq=0"
    echo "  status: $unknown_code (expect 404, JSON, never SSE)"
    echo "  content-type: $(grep -i '^content-type' "$EVIDENCE/unknown-id.headers" | tr -d '\r' || true)"
    echo "  body: $(cat "$EVIDENCE/unknown-id.body")"
    echo ""
    echo "probe 2 — GET /ui/stream/session/$sid?fromSeq=abc"
    echo "  status: $badseq_code (expect 400 invalid_request naming fromSeq)"
    echo "  body: $(cat "$EVIDENCE/bad-fromseq.body")"
    echo ""
    echo "probe 3 — frame target referencing an unknown id (client side): app.js"
    echo "  applyFrame drops a patch/replace whose target is absent with"
    echo "  'jhin: frame target not found:' and never throws; removed ids stay"
    echo "  tombstoned in st.dead so a replay cannot resurrect them"
    echo "  (grep: 'frame target not found' / 'st.dead' in app.js)."
    echo "  The runtime proof needs a browser — UNAVAILABLE here (browser-unavailable.txt)."
    echo ""
    echo "after the probes — GET /_jhin/health: $health_after (expect 200; kernel alive)"
} > "$EVIDENCE/unknown-id.txt"
[ "$unknown_code" = "404" ] || fail "unknown session answered $unknown_code (expected 404; see $EVIDENCE/unknown-id.txt)"
grep -qF 'unknown_session' "$EVIDENCE/unknown-id.body" \
    || fail "unknown session body lacks unknown_session: $(cat "$EVIDENCE/unknown-id.body")"
grep -qiF 'text/event-stream' "$EVIDENCE/unknown-id.headers" && \
    fail "unknown session answered an SSE response (must be a JSON 404)"
[ "$badseq_code" = "400" ] || fail "malformed fromSeq answered $badseq_code (expected 400)"
grep -qF 'fromSeq' "$EVIDENCE/bad-fromseq.body" \
    || fail "the 400 body does not name fromSeq: $(cat "$EVIDENCE/bad-fromseq.body")"
[ "$health_after" = "200" ] || fail "health answered $health_after after the unknown-id probes"
echo "-- OK: unknown session -> 404 JSON, bad fromSeq -> 400, kernel alive (unknown-id.txt)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T205 browser steps — UNAVAILABLE in this environment.

Browser tooling (the agent browser / screenshots / evaluate) cannot run on
this QA machine; the T202/T203/T204 precedent applies: every browser step is
recorded here and substituted with curl + static asserts.

Not executed (the plan's stream-01..02/03.png set):
  - stream-01.png: a live streaming screenshot — tokens appearing in the open
    chat incrementally while the scripted reply streams.
  - stream-02.png: visual scroll anchoring — auto-scroll follows the end and
    releases when the user scrolls up 40 px (T100 / CHAT_TIMELINE_ANCHOR).
  - stream-03.png: the focus restore rule — caret and selection survive the
    patch/replace swaps (sdui.md section 9.5 / section 4.4).

Substituted (evidence of this run):
  - live streaming  -> the SSE capture (frames-raw.sse) is opened BEFORE the
    runs and the mid-run snapshot (frames-live-mid.txt / -report.txt) proves
    run 1's frames arrived on the wire before run 2 was sent; frames.jsonl
    carries the full frame sequence of both runs;
  - >= 3 incremental patches -> asserted on the wire in frame-shapes.txt
    (plan T205.4's frame counter becomes the patch count of frames.jsonl);
  - scroll anchoring -> static: ANCHOR_PX = 24 and the follow check
    (view.scrollHeight - view.scrollTop - view.clientHeight <= ANCHOR_PX) in
    app.js, and the T100 end-inset (padding-bottom: 24px) in app.css
    (static-gates.txt gate 2e);
  - focus restore -> static: withFocusRestore shared by swapInner/swapOuter in
    app.js (static-gates.txt gate 2e); the DOM-level restore proof needs a
    browser;
  - the working spinner appearing/disappearing -> the wire frames: run_start
    emits the working row (node) and run_end removes it (remove) — recorded in
    frames.jsonl / shape-counts.txt (turnRunning's
    [data-jhin-id$="-working"] selector asserted in gate 2e).

Uncovered without a browser (accepted for this environment):
  - the visual result of the html fragments (rendering, layout, colours);
  - EventSource fallback behaviour in a real browser (the fetch-stream primary
    path is the one curl exercises; the fallback is static-only);
  - real keystroke focus/selection restoration.
EOF
echo "-- OK: browser-unavailable.txt written"

# ------------------------------------------------------------- summary
echo "== Step 13: summary.txt =="
node_bytes=$js_bytes
cat > "$EVIDENCE/summary.txt" <<EOF
T205 QA: PASS — SSE streaming frames, delta batching, replay dedupe

gates:
  build (bootJar + 6 plugin jars)                          green (build.log)
  :jhin-plugin-ui-default:test  408 tests                  green (test-gates.txt)
  :jhin-plugin-ui-kit:test      291 tests                  green
  :sdk:test                      64 tests                  green
  :kernel:test                  117 tests                  green (KernelPurityTest)
  node --check app.js                                     SYNTAX_OK (node-check.txt, manual gate)
  eval / new Function in app.js                           $eval_count (0)
  '<' in app.css                                          $lt_count (0)
  app.js bytes                                            $node_bytes (<= 60000)
  app.css bytes                                           $css_bytes (recorded)

wire (frames.jsonl, $frame_count frames from one live curl -N capture):
  shapes                                                  $(tr '\n' ' ' < "$EVIDENCE/shape-counts.txt" | tr -s ' ')
  patch frames                                            $patch_count (>= 3, plan T205.4)
  distinct patch ids                                      $patch_ids ($(tr '\n' ' ' < "$EVIDENCE/patch-ids.txt" | tr '\n' ' '))
  node/patch/replace envelopes                            exactly {id, html}
  "props" / "children" occurrences                        $props_count / $children_count (0 / 0)

delta batching (patch-count.txt):
  per msg-<seq>: 1 text_delta absorbed -> 1 final cumulative patch carrying
  the full scripted text once at the end; patches <= deltas for every message;
  sidebar patches (session_updated) recorded separately.

replay (replay-dedupe.txt):
  resume at Last-Event-ID $mid_id + ?fromSeq=$mid_seq -> $replay_count frames;
  pre-window rows re-emitted: 0; duplicated node/replace pairs: 0;
  final message texts identical live vs replay: yes.

negative (unknown-id.txt):
  GET /ui/stream/session/does-not-exist   -> $unknown_code unknown_session (JSON, not SSE)
  GET /ui/stream/session/{id}?fromSeq=abc -> $badseq_code names fromSeq
  GET /_jhin/health after the probes       -> $health_after (kernel alive)

kernel:
  mode   plain HTTP on $BASE (no jhin.security -> no TlsProvider -> the kernel
         logs 'no TLS material registered; the listener speaks plain HTTP';
         port 18443 because 8443 is occupied on this machine)
  plugins jhin.sessions, jhin.ui-kit, jhin.ui + jhin.llm, jhin.agent,
         jhin.qa-mock-llm (streaming wiring; no bearer token)
  mock   POST /providers {"format":"mock","model":"title"} (model name selects
         the qa-mock-llm script; QaMockTitleModel's fixed answer is the
         scripted reply)

browser: unavailable — browser-unavailable.txt lists the screenshot cases
         (stream-01..03.png) and their curl/static substitutes.
evidence: $EVIDENCE
EOF
echo
echo "== T205 QA PASSED =="
echo "evidence: $EVIDENCE"
ls -1 "$EVIDENCE"
