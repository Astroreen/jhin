#!/usr/bin/env bash
# T308 QA — the real model picker and the branch picker shell.
#
# Proves, with a booted kernel, curl and jq only (browser tools are
# UNAVAILABLE in this environment — every browser step becomes
# evidence/T308/browser-unavailable.txt plus strengthened curl asserts, the
# T202–T208/T301–T307 precedent):
#   1. build + test gates: the kernel boot jar and the six plugin jars
#      build and the two suites stay green (:jhin-plugin-ui-kit:test,
#      :jhin-plugin-ui-default:test — ChatScreenTest, ActionsTest,
#      ComposerRowsTest, SettingsActionsTest among them); counts are summed
#      from the JUnit XML reports, failures/errors asserted 0;
#   2. static gates: the T308 sources carry the new surface — ChatScreen
#      (select-model, toggle-favorite-model, the "No providers configured"
#      empty state and the "Git plugin not installed — branches
#      unavailable" branch copy), ModelPickerActions (selectModel) and
#      UiSettings (composer.favoriteModels);
#   3. wire gates: the kernel is booted with jhin.sessions + jhin.ui-kit +
#      jhin.ui + jhin.security + jhin.llm + jhin.llm-builtin into a temp
#      JHIN_HOME with JHIN_SESSIONS_QA=true and JHIN_UI_QAPROBE=true.
#      jhin.security is staged per the milestone plan, so its TlsProvider
#      switches the listener to HTTPS (curl -k) and its bearer filter
#      guards every path: one account/device is seeded through the admin
#      CLI (create-account/create-enrollment) and POST /enroll, and every
#      wire call carries Authorization: Bearer <token>. One provider is
#      created from a real llm-builtin factory format of
#      GET /providers/formats (openai/anthropic/gemini, dummy key) so the
#      picker has data. GET /ui/screen/chat:<sessionId> saves the screen to
#      picker.html and proves the model dialog lists the created
#      provider/model (the provider group, the row action select-model and
#      the star action toggle-favorite-model) plus the branch dialog copy
#      "Git plugin not installed". POST /ui/action/select-model writes the
#      choice onto the session: the answer carries the patch/setState/
#      dismissDialog directives, GET /sessions/<id> (session.json) carries
#      the chosen model and providerId, and the re-fetched screen
#      (picker-selected.html) shows the model line on the context chip
#      -> checks.txt;
#   4. browser-unavailable.txt: browser automation is unavailable; the
#      assertions are curl + static;
#   5. summary.txt with every PASS line and the key numbers.
#
# --fail mode (the negative proof — must PASS, exit 0, into checks-fail.txt):
#   a. with NO provider configured the model picker dialog renders the
#      honest empty state instead of option rows: one fresh session, the
#      chat screen carries the "No providers configured" copy and no
#      select-model row action at all -> no-providers.txt.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp
# JHIN_HOME seeded with the six plugin jars (plugin projects expose the
# plain `jar` task — the kernel is the only bootJar). The listener speaks
# HTTPS on https://localhost:18443 (the kernel default 8443 is occupied on
# the QA machine; plan section 9 allows the QA-only port override) with the
# self-signed keystore of jhin.security (curl -k). The happy mode runs the
# two suites with --rerun; --fail keeps the build gate (the suites must be
# green) but skips the forced rerun to stay small.
#
# On any failure one line is appended to evidence/T308/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T308_INNER:-}" ]; then
    exec env T308_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."
ROOT="$(pwd)"

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
    fail_mode=1
    shift
fi

EVIDENCE="${1:-$ROOT/.sisyphus/evidence/T308}"
PORT=18443
BASE="https://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage'
CHAT_SCREEN="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/ChatScreen.java"
MODEL_PICKER_ACTIONS="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/ModelPickerActions.java"
UI_SETTINGS="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/UiSettings.java"
PLUGINS="sessions ui-kit ui-default security llm llm-builtin"

mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/failures.txt"
if [ "$fail_mode" = "1" ]; then
    checks="$EVIDENCE/checks-fail.txt"
else
    checks="$EVIDENCE/checks.txt"
fi
: > "$checks"

token=""
auth_hdr=""

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

# stage_jars <dir>: copies the six plugin jars into <dir>, retrying briefly
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
        -d "{\"code\":\"$enroll_code\",\"deviceName\":\"t308\"}" 2>/dev/null) || code=000
    [ "$code" = "200" ] || fail "POST /enroll answered $code (expected 200): $(cat "$EVIDENCE/enroll.body")"
    token=$(jq -r '.token' "$EVIDENCE/enroll.body")
    [ -n "$token" ] && [ "$token" != "null" ] \
        || fail "POST /enroll returned no token: $(cat "$EVIDENCE/enroll.body")"
    auth_hdr="Authorization: Bearer $token"
    ok "device enrolled (cli create-account/create-enrollment qa + POST /enroll -> 200, bearer token captured)"
}

# create_session <title> <workdir-json> -> prints the session id. The workdir
# is a JSON string fragment ("\"/tmp/t308/wd\"").
create_session() {
    local title=$1 workdir=$2 code id
    code=$(api POST /sessions "{\"title\":\"$title\",\"workdir\":$workdir}" \
        "$EVIDENCE/session-$title.json") \
        || fail "POST /sessions ($title): curl failed"
    [ "$code" = "201" ] || fail "POST /sessions ($title) answered $code (expected 201): $(cat "$EVIDENCE/session-$title.json")"
    id=$(jq -r '.id' "$EVIDENCE/session-$title.json")
    [ -n "$id" ] && [ "$id" != "null" ] || fail "POST /sessions ($title) returned no id"
    printf '%s\n' "$id"
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

# first_region <file> <marker> <len>: the first <len>-char window of the
# one-line screen HTML starting at <marker> (the model chip region).
first_region() {
    awk -v m="$2" -v n="$3" '
        {
            i = index($0, m)
            if (i == 0) next
            print substr($0, i, n)
            exit
        }' "$1"
}

build_and_test() {
    echo "== Step 1: build the jars + run the two test gates =="
    set +e
    ./gradlew --console=plain :kernel:bootJar \
        :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar \
        :jhin-plugin-security:jar :jhin-plugin-llm:jar :jhin-plugin-llm-builtin:jar \
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
        echo "T308 test gates — the two suites green on the model/branch picker surface:"
        grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
        echo ""
        echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests"
        echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (ChatScreenTest, ActionsTest, ComposerRowsTest, SettingsActionsTest among them)"
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
    echo "== T308 QA --fail: the negative proof must PASS =="

    build_and_test

    home=$(mktemp -d /tmp/t308-home.XXXXXX)
    bundled=$(mktemp -d /tmp/t308-bundled.XXXXXX)
    stage_jars "$bundled" || fail "could not stage the six plugin jars into $bundled"
    kernel_jar=$(ls kernel/build/libs/kernel-*.jar 2>/dev/null \
        | grep -vE -- '-(plain|sources|javadoc)' | head -1 || true)
    [ -n "$kernel_jar" ] || fail "no kernel boot jar under kernel/build/libs"
    boot_kernel "$home" "$bundled"
    enroll_device

    # ---- negative proof a: with no providers the picker shows the empty state
    log "-- negative proof: with no provider configured the model dialog is the empty state"
    f=$(create_session "fail-picker" '"/tmp/t308/fail"')
    fetch_chat_html "$f" "$EVIDENCE/no-providers.html" "$EVIDENCE/fail-screen.json"
    empty_hits=$(count_matches "$EVIDENCE/no-providers.html" 'No providers configured')
    select_hits=$(count_matches "$EVIDENCE/no-providers.html" 'select-model')
    dialog_hits=$(count_matches "$EVIDENCE/no-providers.html" 'composer-model-dialog')
    [ "$empty_hits" -ge 1 ] \
        || fail "the chat screen carries no \"No providers configured\" empty state (no-providers.html)"
    [ "$dialog_hits" -ge 1 ] \
        || fail "the chat screen carries no composer-model-dialog (no-providers.html)"
    [ "$select_hits" = "0" ] \
        || fail "the empty model dialog still carries $select_hits select-model row action(s) (no-providers.html)"
    no_providers="$EVIDENCE/no-providers.txt"
    {
        echo "T308 --fail: with no provider configured the model picker dialog renders"
        echo "the honest empty state."
        echo "One fresh session is opened (POST /sessions -> $f) and no provider is"
        echo "created — GET /providers/formats may list the llm-builtin factories but"
        echo "the account's provider registry is empty, so ChatScreen.modelDialog"
        echo "renders MODEL_EMPTY_TEXT (\"No providers configured — add one on the"
        echo "Providers screen.\") inside the composer-model-dialog card instead of"
        echo "any option rows: no model rows, no select-model row actions, no"
        echo "toggle-favorite-model stars."
        echo ""
        echo "  seed: POST /sessions -> $f (fail-picker)"
        echo "  GET /ui/screen/chat:$f -> 200 (no-providers.html)"
        echo ""
        echo "  composer-model-dialog present:     $dialog_hits hit(s)"
        echo "  \"No providers configured\" copy:    $empty_hits hit(s)"
        echo "  select-model row actions:          $select_hits hit(s) (expected 0)"
        echo ""
        echo "  The model picker degrades to the empty state without providers —"
        echo "  the negative proof that the dialog is fed by the real jhin.llm"
        echo "  provider registry (screens/ChatScreen.java modelDialog)."
    } > "$no_providers"
    ok "no providers configured -> the model dialog is the \"No providers configured\" empty state (no-providers.txt)"
    ok "the empty model dialog carries no select-model row action (no-providers.txt)"

    ok "T308 QA --fail: the negative proof PASS"
    {
        echo ""
        echo "T308 QA --fail — PASS"
        echo ""
        echo "  mode:              fail"
        echo "  empty picker:      no provider created — the model dialog empty state carries"
        echo "                     \"No providers configured\" ($empty_hits hit(s)) and no select-model"
        echo "                     row action ($select_hits hit(s)) (no-providers.txt)"
        echo ""
        echo "  evidence: $EVIDENCE"
        sed 's/^/  /' "$checks"
    } >> "$EVIDENCE/summary.txt"
    exit 0
fi

# ------------------------------------------------------------------ happy
echo "== T308 QA: the real model picker and the branch picker shell =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

build_and_test

# ------------------------------------------------------- static source gates
echo "== Step 2: the T308 surface in the sources =="
{
    echo "T308 static source gates — the new surface must exist in the sources"
    echo "the wire proofs exercise."
    echo ""
} > "$EVIDENCE/source-gates.txt"
[ -f "$MODEL_PICKER_ACTIONS" ] \
    || fail "ModelPickerActions.java is missing ($MODEL_PICKER_ACTIONS)"
static_ok=1
static_gate() {
    local file=$1 pattern=$2 label=$3 hits
    hits=$(grep -cF -- "$pattern" "$file" || true)
    printf '  %-52s %s hit(s)  %s\n' "$label" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" \
        | tee -a "$EVIDENCE/source-gates.txt" >> "$checks"
    [ "$hits" -ge 1 ] || static_ok=0
}
static_gate "$CHAT_SCREEN" 'select-model' 'ChatScreen select-model row action'
static_gate "$CHAT_SCREEN" 'toggle-favorite-model' 'ChatScreen favourite star action'
static_gate "$CHAT_SCREEN" 'No providers configured' 'ChatScreen no-providers empty state'
static_gate "$CHAT_SCREEN" 'Git plugin not installed \u2014 branches unavailable' 'ChatScreen branch empty-state copy'
static_gate "$MODEL_PICKER_ACTIONS" 'selectModel' 'ModelPickerActions selectModel handler'
static_gate "$UI_SETTINGS" 'composer.favoriteModels' 'UiSettings favourites key'
[ "$static_ok" = "1" ] || fail "static source gates failed (see $EVIDENCE/source-gates.txt)"
ok "T308 sources carry the new surface (source-gates.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (six plugin jars) =="
home=$(mktemp -d /tmp/t308-home.XXXXXX)
bundled=$(mktemp -d /tmp/t308-bundled.XXXXXX)
stage_jars "$bundled" || fail "could not stage the six plugin jars into $bundled"
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
    echo "mode-reason=jhin.security is staged (the milestone plan's T308 staging) -> its"
    echo "            TlsProvider switches the listener to HTTPS and its bearer filter"
    echo "            guards every path. One device is enrolled through the admin CLI"
    echo "            (create-account/create-enrollment qa) and POST /enroll; every wire"
    echo "            call carries Authorization: Bearer <token> and curl -k."
    echo "port-reason=the kernel default 8443 is occupied by another service on this machine"
    echo "plugins=jhin.sessions, jhin.ui-kit, jhin.ui, jhin.security, jhin.llm,"
    echo "        jhin.llm-builtin"
    echo "plugin-reason=the T308 model picker is fed by the jhin.llm provider registry"
    echo "              (the jhin.llm-builtin factories), jhin.ui renders it and"
    echo "              jhin.security is the staged authenticator; the agent/tools"
    echo "              plugins are not needed for the picker/branch shell."
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding (kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (QA helpers on, <= 30 s for health) =="
boot_kernel "$home" "$bundled"
enroll_device

# ------------------------------------------------------------- the provider
echo "== Step 5: create one provider from a real llm-builtin format =="
code=$(api GET /providers/formats "" "$EVIDENCE/formats.json") \
    || fail "GET /providers/formats: curl failed"
[ "$code" = "200" ] || fail "GET /providers/formats answered $code (expected 200): $(cat "$EVIDENCE/formats.json")"
fmt=""
model=""
if jq -e 'index("openai")' "$EVIDENCE/formats.json" > /dev/null 2>&1; then
    fmt="openai"; model="gpt-4o"
elif jq -e 'index("anthropic")' "$EVIDENCE/formats.json" > /dev/null 2>&1; then
    fmt="anthropic"; model="claude-sonnet-4-5"
elif jq -e 'index("gemini")' "$EVIDENCE/formats.json" > /dev/null 2>&1; then
    fmt="gemini"; model="gemini-2.0-flash"
elif jq -e 'index("mock")' "$EVIDENCE/formats.json" > /dev/null 2>&1; then
    fmt="mock"; model="mock-1"
else
    fail "GET /providers/formats lists no known factory format (formats.json): $(cat "$EVIDENCE/formats.json")"
fi
code=$(api POST /providers "{\"format\":\"$fmt\",\"model\":\"$model\",\"apiKey\":\"qa\"}" \
    "$EVIDENCE/provider.json") \
    || fail "POST /providers: curl failed"
[ "$code" = "201" ] \
    || fail "POST /providers ($fmt) answered $code (expected 201): $(cat "$EVIDENCE/provider.json")"
provider_id=$(jq -r '.id' "$EVIDENCE/provider.json")
[ -n "$provider_id" ] && [ "$provider_id" != "null" ] \
    || fail "POST /providers returned no id: $(cat "$EVIDENCE/provider.json")"
{
    echo "T308 provider seed — GET /providers/formats then POST /providers:"
    echo "  GET /providers/formats -> $(jq -c . "$EVIDENCE/formats.json")"
    echo "  POST /providers {\"format\":\"$fmt\",\"model\":\"$model\",\"apiKey\":\"qa\"} -> 201"
    echo "  provider id: $provider_id (format $fmt, model $model)"
} > "$EVIDENCE/seeded.txt"
ok "provider $provider_id created (format $fmt, model $model) from the real llm-builtin registry (seeded.txt)"

# ------------------------------------------------------------- the session
echo "== Step 6: create one session and fetch the chat screen =="
s=$(create_session "picker" '"/tmp/t308/wd"')
fetch_chat_html "$s" "$EVIDENCE/picker.html"
model_rows=$(count_matches "$EVIDENCE/picker.html" "$model")
provider_labels=$(count_matches "$EVIDENCE/picker.html" "$fmt")
provider_payloads=$(count_matches "$EVIDENCE/picker.html" "$provider_id")
select_actions=$(count_matches "$EVIDENCE/picker.html" 'select-model')
star_actions=$(count_matches "$EVIDENCE/picker.html" 'toggle-favorite-model')
branch_copy=$(count_matches "$EVIDENCE/picker.html" 'Git plugin not installed')
branch_dialog=$(count_matches "$EVIDENCE/picker.html" 'composer-branch-dialog')
{
    echo "T308 picker screen — GET /ui/screen/chat:$s (picker.html):"
    echo "  model rows carrying \"$model\": $model_rows hit(s)"
    echo "  provider group label \"$fmt\": $provider_labels hit(s)"
    echo "  provider id $provider_id in the row payloads: $provider_payloads hit(s)"
    echo "  select-model row action: $select_actions hit(s)"
    echo "  toggle-favorite-model star action: $star_actions hit(s)"
    echo "  branch dialog composer-branch-dialog: $branch_dialog hit(s)"
    echo "  \"Git plugin not installed\" empty-state copy: $branch_copy hit(s)"
} > "$EVIDENCE/picker-check.txt"
[ "$model_rows" -ge 1 ] \
    || fail "the model dialog lists no \"$model\" row (picker.html)"
[ "$provider_payloads" -ge 1 ] \
    || fail "the model dialog carries no row of provider $provider_id (picker.html)"
[ "$provider_labels" -ge 1 ] \
    || fail "the model dialog carries no \"$fmt\" provider group label (picker.html)"
[ "$select_actions" -ge 1 ] \
    || fail "the model dialog carries no select-model row action (picker.html)"
[ "$star_actions" -ge 1 ] \
    || fail "the model dialog carries no toggle-favorite-model star action (picker.html)"
[ "$branch_dialog" -ge 1 ] \
    || fail "the chat screen carries no composer-branch-dialog (picker.html)"
[ "$branch_copy" -ge 1 ] \
    || fail "the branch dialog carries no \"Git plugin not installed\" copy (picker.html)"
ok "picker dialog lists the created provider/model ($model under $fmt, $model_rows row(s); picker-check.txt)"
ok "picker rows carry select-model + toggle-favorite-model ($select_actions/$star_actions hit(s); picker.html)"
ok "branch dialog carries \"Git plugin not installed\" ($branch_copy hit(s); picker.html)"

# ------------------------------------------------------------- select-model
echo "== Step 7: POST /ui/action/select-model — the choice lands on the session =="
jq -n --arg sid "$s" --arg pid "$provider_id" --arg model "$model" \
    '{action:"select-model",payload:{sessionId:$sid,providerId:$pid,model:$model}}' \
    > "$EVIDENCE/select-model-body.json"
code=$(api POST /ui/action/select-model "$(cat "$EVIDENCE/select-model-body.json")" \
    "$EVIDENCE/select-model.json") \
    || fail "POST /ui/action/select-model: curl failed"
[ "$code" = "200" ] \
    || fail "POST /ui/action/select-model answered $code (expected 200): $(cat "$EVIDENCE/select-model.json")"
action_ops=$(jq -r '[.client[]?.op] | join(" ")' "$EVIDENCE/select-model.json")
for op_name in patch setState dismissDialog; do
    printf '%s\n' "$action_ops" | grep -qw "$op_name" \
        || fail "the select-model answer carries no $op_name directive (select-model.json): $action_ops"
done
code=$(api GET "/sessions/$s" "" "$EVIDENCE/session.json") \
    || fail "GET /sessions/$s: curl failed"
[ "$code" = "200" ] \
    || fail "GET /sessions/$s answered $code (expected 200): $(cat "$EVIDENCE/session.json")"
got_model=$(jq -r '.model' "$EVIDENCE/session.json")
got_provider=$(jq -r '.providerId' "$EVIDENCE/session.json")
[ "$got_model" = "$model" ] \
    || fail "the session document carries model=$got_model (expected $model) (session.json)"
[ "$got_provider" = "$provider_id" ] \
    || fail "the session document carries providerId=$got_provider (expected $provider_id) (session.json)"
{
    echo "T308 selection — POST /ui/action/select-model then GET /sessions/$s:"
    echo "  request body: $(jq -c . "$EVIDENCE/select-model-body.json")"
    echo "  answer directives: $action_ops (patch of the context chip, setState,"
    echo "    dismissDialog)"
    echo "  session.json: model=$got_model providerId=$got_provider"
} > "$EVIDENCE/selection-check.txt"
ok "select-model answers patch/setState/dismissDialog ($action_ops)"
ok "the session document carries model=$model providerId=$provider_id (session.json)"

# --------------------------------------------------- the refreshed screen
echo "== Step 8: re-fetch the chat screen — the model line reflects the choice =="
fetch_chat_html "$s" "$EVIDENCE/picker-selected.html" "$EVIDENCE/selected-screen.json"
selected_model_hits=$(count_matches "$EVIDENCE/picker-selected.html" "$model")
chip_region=$(first_region "$EVIDENCE/picker-selected.html" 'data-jhin-id="context-chip"' 600)
chip_model_hits=$(count_matches /dev/stdin "$model" <<< "$chip_region")
chip_provider_hits=$(count_matches /dev/stdin "$provider_id" <<< "$chip_region")
printf '%s' "$chip_region" > "$EVIDENCE/context-chip-region.html"
[ -n "$chip_region" ] \
    || fail "the refreshed chat screen carries no context-chip region (picker-selected.html)"
[ "$selected_model_hits" -ge 1 ] \
    || fail "the refreshed chat screen carries no \"$model\" (picker-selected.html)"
[ "$chip_model_hits" -ge 1 ] \
    || fail "the context chip carries no \"$model\" model line (picker-selected.html)"
[ "$chip_provider_hits" -ge 1 ] \
    || fail "the context chip carries no providerId $provider_id (picker-selected.html)"
{
    echo "T308 refreshed screen — GET /ui/screen/chat:$s (picker-selected.html):"
    echo "  \"$model\" on the whole screen: $selected_model_hits hit(s)"
    echo "  context-chip region (context-chip-region.html): model \"$model\":"
    echo "    $chip_model_hits hit(s), providerId $provider_id: $chip_provider_hits hit(s)"
} > "$EVIDENCE/selected-check.txt"
ok "the refreshed screen shows the chosen model line on the context chip (picker-selected.html)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T308 browser steps — UNAVAILABLE in this environment.

Browser automation (the agent browser / screenshots / evaluate) cannot run
on this QA machine; the T202–T208/T301–T307 precedent applies: every
browser step is substituted with curl + static asserts.

Not executed (the plan's interactive/visual cases):
  - Opening the model picker and tapping a row (the dialog opening, the
    type-ahead filter, the mod+1..9 jump labels, the star flip): substituted
    by the picker.html dialog markup asserts (the provider/model rows, the
    select-model and toggle-favorite-model action payloads) and the
    POST /ui/action/select-model directive asserts.
  - Watching the composer model line/chip change after the selection:
    substituted by the picker-selected.html context-chip region assert and
    the session.json model/providerId assert.
  - Opening the branch picker and reading the empty state: substituted by
    the picker.html "Git plugin not installed" assert.
  - The no-providers empty state on a fresh account: substituted by the
    --fail mode asserts (no-providers.txt).

What IS proven here: the served chat screen carries the real provider/model
picker wired to POST /ui/action/select-model (the choice is written onto the
session and re-rendered as the model line on the context chip) and the
honest branch-picker shell, all with curl.
EOF
ok "browser-unavailable.txt records the un-exercised visual cases"

# ---------------------------------------------------------------- summary
{
    echo "T308 QA — PASS"
    echo ""
    echo "  mode:              happy"
    echo "  suites:            :jhin-plugin-ui-kit:test $ui_kit_tests, :jhin-plugin-ui-default:test $ui_default_tests (0 failures)"
    echo "  provider:          POST /providers {\"format\":\"$fmt\",\"model\":\"$model\"} -> $provider_id"
    echo "                     (GET /providers/formats lists the llm-builtin factories)"
    echo "  picker screen:     GET /ui/screen/chat:$s -> picker.html — the model dialog lists"
    echo "                     $model under $fmt with select-model + toggle-favorite-model,"
    echo "                     the branch dialog carries \"Git plugin not installed\""
    echo "  select-model:      POST /ui/action/select-model -> $action_ops"
    echo "  session.json:      GET /sessions/$s carries model=$model providerId=$provider_id"
    echo "  selection chip:    picker-selected.html — the context chip carries the model line"
    echo "  negative:          with no providers the picker is the \"No providers configured\""
    echo "                     empty state — proven in --fail mode"
    echo ""
    echo "  evidence: $EVIDENCE"
    sed 's/^/  /' "$checks"
} > "$EVIDENCE/summary.txt"
ok "T308 QA PASS (summary.txt)"
