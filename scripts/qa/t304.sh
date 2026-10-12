#!/usr/bin/env bash
# T304 QA — real snooze/settle/done session actions with hover card and undo.
#
# Proves, with a booted kernel, curl and jq only (browser tools are
# UNAVAILABLE in this environment — every browser step becomes
# evidence/T304/browser-unavailable.txt plus strengthened curl asserts, the
# T202–T208/T301–T303 precedent):
#   1. build + test gates: the kernel boot jar and the three plugin jars
#      build and the two suites stay green (:jhin-plugin-ui-kit:test,
#      :jhin-plugin-ui-default:test — SessionActionsTest, SidebarBuilderTest,
#      SessionsScreenTest, ActionsTest among them); counts are summed from
#      the JUnit XML reports, failures/errors asserted 0;
#   2. static gates: the T304 sources carry the new surface — the snooze
#      preset submenu of SidebarBuilder (snoozeChildren/snoozePresets/
#      customSnoozeDialog), the hover card, the undo-notice seam of
#      SessionActions (UNDO_WINDOW_MS, SNOOZE_DEADLINE_HINT), the status
#      indicator glyphs of components.css and the datetime keyboard type of
#      the custom-snooze dialog (docs/sdui.md, UiEnums, ControlRenderers);
#   3. wire gates: the kernel is booted with jhin.sessions + jhin.ui-kit +
#      jhin.ui into a temp JHIN_HOME and seeded with two sessions via the
#      sessions API. POST /ui/action/pin|snooze|settle|undo and every
#      response body carries the undo toast directive (the T98 undo notice:
#      toast + the undo action + the 5000 ms window; the undo answer is its
#      own "Undone" toast + refresh) — the bodies are recorded to
#      actions.jsonl; GET /sessions/{id} shows the state changes (snooze
#      sets snoozed_until; settle clears pin + snooze and writes
#      settledReason=manual; undo restores the pre-settle state); the
#      served sessions screen moves the row to the Settled shelf on settle
#      and to the Snoozed shelf on snooze, and its menu HTML carries the
#      Snooze submenu with exactly 5 entries (15 min, 1 h, 4 h, Until
#      tomorrow 09:00, Custom…) -> menu.html;
#   4. browser-unavailable.txt: the hover card, the submenu flyout, the
#      toast-stack undo card and the status glyphs cannot be exercised
#      here; the file lists exactly which cases are uncovered and which
#      asserts substitute them;
#   5. summary.txt with every PASS line and the key numbers.
#
# --fail mode (the negative proofs — each must PASS, exit 0, into
# checks-fail.txt):
#   a. settle a settled session is refused per the service contract:
#      POST /sessions/{id}/settle on an already-settled session answers
#      409 with the invalid_transition error code -> invalid-transition.txt;
#   b. undo after the 5-second window is a no-op: the answer is the
#      "Nothing to undo" error toast -> undo-expired.txt.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with three plugin jars: jhin.sessions, jhin.ui-kit and jhin.ui (the
# non-optional requires of jhin.ui). jhin.security is deliberately absent: no
# bearer token is needed and the listener speaks plain HTTP on
# http://localhost:18443 (the kernel default 8443 is occupied on the QA
# machine; plan section 9 allows the QA-only plain-HTTP mode in scripts).
#
# On any failure one line is appended to evidence/T304/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T304_INNER:-}" ]; then
    exec env T304_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."
ROOT="$(pwd)"

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
    fail_mode=1
    shift
fi

EVIDENCE="${1:-$ROOT/.sisyphus/evidence/T304}"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage'
SIDEBAR_BUILDER="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/SidebarBuilder.java"
SESSION_ACTIONS="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/SessionActions.java"
ACTIONS_JAVA="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/Actions.java"
CHAT_SCREEN="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/ChatScreen.java"
COMPONENTS_CSS="plugins/ui-default/src/main/resources/web/css/components.css"
UI_ENUMS="plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/UiEnums.java"
CONTROL_RENDERERS="plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/html/renderers/ControlRenderers.java"
SDUI_DOC="docs/sdui.md"

mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/failures.txt"
if [ "$fail_mode" = "1" ]; then
    checks="$EVIDENCE/checks-fail.txt"
else
    checks="$EVIDENCE/checks.txt"
fi
: > "$checks"
if [ "$fail_mode" = "0" ]; then
    : > "$EVIDENCE/actions.jsonl"
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

# stage_jars <dir>: copies the three plugin jars into <dir>, retrying briefly —
# a background IDE gradle build can be rewriting build/libs while we copy.
stage_jars() {
    local dest=$1 attempt
    for attempt in 1 2 3 4 5; do
        if cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$dest/" 2>/dev/null \
                && cp plugins/ui-kit/build/libs/jhin-plugin-ui-kit-*.jar "$dest/" 2>/dev/null \
                && cp plugins/ui-default/build/libs/jhin-plugin-ui-default-*.jar "$dest/" 2>/dev/null; then
            return 0
        fi
        rm -f "$dest"/*.jar 2>/dev/null || true
        sleep 1
    done
    return 1
}

# boot_kernel <home> <bundled>: starts run-kernel.sh (qaProbe screens on) and
# waits <= 30 s for health.
boot_kernel() {
    local home=$1 bundled=$2 start code
    JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" JHIN_UI_QAPROBE=true \
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
# is a JSON string fragment ("\"/tmp/t304/one\"").
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

# get_session <id> <out>: GET /sessions/{id} into <out>.
get_session() {
    local id=$1 out=$2 code
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$out" -w '%{http_code}' \
        "$BASE/sessions/$id") || fail "GET /sessions/$id: curl failed"
    [ "$code" = "200" ] || fail "GET /sessions/$id answered $code (expected 200): $(cat "$out")"
}

# fetch_sessions_html <out>: the sessions screen HTML — the sidebar bytes and
# the row overflow menus the web client receives.
fetch_sessions_html() {
    local out=$1 code
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/screen.json" \
        -w '%{http_code}' "$BASE/ui/screen/sessions") || fail "GET /ui/screen/sessions: curl failed"
    [ "$code" = "200" ] || fail "GET /ui/screen/sessions answered $code (expected 200)"
    jq -r '.html' "$EVIDENCE/screen.json" > "$out"
    [ -s "$out" ] || fail "the sessions screen carries no HTML ($out)"
}

# post_action <name> <payload-json> <out>: POST /ui/action/<name> with the
# payload merged into the action body; the response body lands in <out>.
post_action() {
    local name=$1 payload=$2 out=$3 code
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
        -o "$out" -w '%{http_code}' \
        -d "{\"action\":\"$name\",\"payload\":$payload}" "$BASE/ui/action/$name") \
        || fail "POST /ui/action/$name: curl failed"
    [ "$code" = "200" ] || fail "POST /ui/action/$name answered $code (expected 200): $(cat "$out")"
}

# record_action <name> <payload-json> <body-file>: appends one JSONL line to
# actions.jsonl — the dispatched action, its payload and the full response.
record_action() {
    jq -c -n --arg action "$1" --argjson payload "$2" --argjson response "$(cat "$3")" \
        '{action: $action, payload: $payload, response: $response}' \
        >> "$EVIDENCE/actions.jsonl" || fail "could not record the $1 body in actions.jsonl"
}

# assert_undo_notice <body-file> <verb-text>: the undo-notice answer of one
# lifecycle mutation — exactly [toast <verb> <n> thread(s), + undo action +
# 5000 ms window, refresh].
assert_undo_notice() {
    jq -e --arg text "$2" '
        .client as $c
        | (($c | length) == 2)
          and ($c[0].op == "toast")
          and ($c[0].text == $text)
          and ($c[0].action.name == "undo")
          and ($c[0].action.path == "/ui/action/undo")
          and ($c[0].duration == 5000)
          and ($c[1].op == "refresh")' "$1" > /dev/null \
        || fail "$1 does not carry the undo toast directive for \"$2\": $(cat "$1")"
}

# section_rows <html> <section-id>: the comma-joined session-row ids rendered
# inside one sidebar section (section-pinned / section-active /
# section-working / section-snoozed / section-settled).
section_rows() {
    tr -d '\n' < "$1" | sed 's/data-jhin-id="section-/\n&/g' | tail -n +2 \
        | grep -F "data-jhin-id=\"$2\"" | head -1 \
        | grep -o 'data-jhin-id="session-row:[^"]*"' \
        | sed 's/.*session-row://;s/"$//' | paste -sd, - || true
}

# snooze_submenu <html>: the Snooze submenu block of the first row menu —
# the Snooze button plus its nested jhin-menu-submenu items.
snooze_submenu() {
    tr -d '\n' < "$1" | sed 's/Snooze<\/button>/\n&/g' | tail -n +2 | head -1 \
        | sed 's#</div>#</div>\n#g' | head -1
}

count_attr() {
    grep -h -o "$2=\"[0-9]*\"" "$1"/TEST-*.xml 2>/dev/null | awk -F'"' '{s += $2} END {print s+0}'
}

build_and_test() {
    echo "== Step 1: build the jars + run the two test gates =="
    set +e
    ./gradlew --console=plain :kernel:bootJar \
        :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar \
        2>&1 | tee "$EVIDENCE/build.log"
    local build_status="${PIPESTATUS[0]}"
    set -e
    [ "$build_status" -eq 0 ] || fail "gradle build exited $build_status (see $EVIDENCE/build.log)"

    set +e
    ./gradlew --console=plain \
        :jhin-plugin-ui-kit:test --rerun \
        :jhin-plugin-ui-default:test --rerun \
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
        echo "T304 test gates — the two suites green on the snooze/settle/undo surface:"
        grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
        echo ""
        echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests"
        echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (SessionActionsTest, SidebarBuilderTest, SessionsScreenTest, ActionsTest among them)"
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
    echo "== T304 QA --fail: the negative proofs must PASS =="

    build_and_test

    home=$(mktemp -d /tmp/t304-home.XXXXXX)
    bundled=$(mktemp -d /tmp/t304-bundled.XXXXXX)
    stage_jars "$bundled" || fail "could not stage the three plugin jars into $bundled"
    boot_kernel "$home" "$bundled"

    # ---- negative proof a: settle on a settled session -> 409 invalid_transition
    log "-- negative proof: settle on a settled session must 409 invalid_transition"
    invalid="$EVIDENCE/invalid-transition.txt"
    {
        echo "T304 --fail: the service contract refuses to settle an"
        echo "already-settled session. POST /sessions/{id}/settle answers"
        echo "409 with the invalid_transition error code."
        echo ""
    } > "$invalid"

    settled_id=$(create_session "fail-settled" '"/tmp/t304/fail"')
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
        -o "$EVIDENCE/settle-first.body" -w '%{http_code}' \
        -d '{"reason":"manual"}' "$BASE/sessions/$settled_id/settle") \
        || fail "POST /sessions/$settled_id/settle: curl failed"
    [ "$code" = "200" ] || fail "the first settle answered $code (expected 200): $(cat "$EVIDENCE/settle-first.body")"
    jq -e '.settledReason == "manual" and .settledAt != null' "$EVIDENCE/settle-first.body" > /dev/null \
        || fail "the first settle did not settle the session: $(cat "$EVIDENCE/settle-first.body")"
    {
        echo "  seed: POST /sessions -> $settled_id (fail-settled)"
        echo "  first settle (PASS):"
        echo "    POST /sessions/$settled_id/settle {\"reason\":\"manual\"} -> 200"
        echo "    body: $(cat "$EVIDENCE/settle-first.body")"
        echo ""
    } >> "$invalid"

    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
        -o "$EVIDENCE/settle-second.body" -w '%{http_code}' \
        -d '{"reason":"manual"}' "$BASE/sessions/$settled_id/settle") \
        || fail "POST /sessions/$settled_id/settle (second): curl failed"
    [ "$code" = "409" ] || fail "the second settle answered $code (expected 409): $(cat "$EVIDENCE/settle-second.body")"
    jq -e '.error == "invalid_transition"' "$EVIDENCE/settle-second.body" > /dev/null \
        || fail "the 409 body does not carry the invalid_transition code: $(cat "$EVIDENCE/settle-second.body")"
    grep -qi 'settled' "$EVIDENCE/settle-second.body" \
        || fail "the 409 body does not name the already-settled state: $(cat "$EVIDENCE/settle-second.body")"
    {
        echo "  second settle (PASS):"
        echo "    POST /sessions/$settled_id/settle {\"reason\":\"manual\"} -> 409"
        echo "    body: $(cat "$EVIDENCE/settle-second.body")"
        echo "    .error == \"invalid_transition\" (PASS)"
        echo ""
    } >> "$invalid"
    ok "settle on a settled session -> 409 invalid_transition (invalid-transition.txt)"

    # ---- negative proof b: undo after the 5 s window -> Nothing to undo
    log "-- negative proof: undo after the 5 s window must answer Nothing to undo"
    expired="$EVIDENCE/undo-expired.txt"
    {
        echo "T304 --fail: the undo window is 5 s (SessionActions.UNDO_WINDOW_MS,"
        echo "the UndoJournal window). A mutation's undo notice expires with it,"
        echo "so POST /ui/action/undo after the window answers the"
        echo "\"Nothing to undo\" error toast — nothing is mutated."
        echo ""
    } > "$expired"

    undo_id=$(create_session "fail-undo" '"/tmp/t304/fail"')
    post_action "pin" "{\"id\":\"$undo_id\"}" "$EVIDENCE/undo-pin.body"
    assert_undo_notice "$EVIDENCE/undo-pin.body" "Pinned 1 thread,"
    {
        echo "  seed: POST /sessions -> $undo_id (fail-undo)"
        echo "  POST /ui/action/pin {\"id\":\"$undo_id\"} -> 200 (PASS)"
        echo "  body: $(cat "$EVIDENCE/undo-pin.body")"
        echo "  the response carries the undo toast directive (undo action, 5000 ms)"
        echo ""
    } >> "$expired"

    log "waiting 6 s past the 5 s undo window"
    sleep 6

    post_action "undo" "{}" "$EVIDENCE/undo-after.body"
    jq -e '
        .client as $c
        | (($c | length) == 1)
          and ($c[0].op == "toast")
          and ($c[0].text == "Nothing to undo")
          and ($c[0].style == "error")' "$EVIDENCE/undo-after.body" > /dev/null \
        || fail "undo after 6 s did not answer the Nothing to undo toast: $(cat "$EVIDENCE/undo-after.body")"
    {
        echo "  waited 6 s past the mutation, then (PASS):"
        echo "    POST /ui/action/undo {} -> 200"
        echo "    body: $(cat "$EVIDENCE/undo-after.body")"
        echo "    one directive: toast \"Nothing to undo\" style=error (PASS)"
        echo ""
        echo "  the expired window leaves nothing to undo — the undo action is a"
        echo "  documented no-op toast, never a failed request."
    } >> "$expired"
    ok "undo after the 5 s window -> \"Nothing to undo\" toast (undo-expired.txt)"

    ok "T304 QA --fail: the negative proofs PASS"
    exit 0
fi

# ------------------------------------------------------------------ happy
echo "== T304 QA: real snooze/settle/done session actions with hover card and undo =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

build_and_test

# ------------------------------------------------------- static source gates
echo "== Step 2: the T304 surface in the sources =="
{
    echo "T304 static source gates — the new surface must exist in the sources"
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
static_gate "$SIDEBAR_BUILDER" 'snoozeChildren(' 'SidebarBuilder Snooze submenu children'
static_gate "$SIDEBAR_BUILDER" 'snoozePresets(' 'SidebarBuilder snooze presets'
static_gate "$SIDEBAR_BUILDER" 'customSnoozeDialog(' 'SidebarBuilder custom snooze dialog'
static_gate "$SIDEBAR_BUILDER" 'Until tomorrow 09:00' 'SidebarBuilder Until tomorrow 09:00 preset'
static_gate "$SIDEBAR_BUILDER" 'hoverCard(' 'SidebarBuilder hover card'
static_gate "$SESSION_ACTIONS" 'UNDO_WINDOW_MS' 'SessionActions undo window'
static_gate "$SESSION_ACTIONS" 'SNOOZE_DEADLINE_HINT' 'SessionActions snooze deadline hint'
static_gate "$SESSION_ACTIONS" 'ActionDescriptors.of("undo")' 'SessionActions undo notice action'
static_gate "$SESSION_ACTIONS" '"Snoozed"' 'SessionActions Snoozed verb'
static_gate "$SESSION_ACTIONS" '"Settled"' 'SessionActions Settled verb'
static_gate "$ACTIONS_JAVA" 'handlers.put("undo"' 'Actions undo handler registration'
static_gate "$CHAT_SCREEN" 'snoozeChildren(' 'ChatScreen shares the Snooze submenu'
static_gate "$COMPONENTS_CSS" 'data-jhin-status="pinned"' 'components.css pinned glyph'
static_gate "$COMPONENTS_CSS" 'data-jhin-status="snoozed"' 'components.css snoozed glyph'
static_gate "$COMPONENTS_CSS" 'data-jhin-status="settled"' 'components.css settled glyph'
static_gate "$SDUI_DOC" 'multiline/datetime' 'sdui.md datetime keyboard type'
static_gate "$UI_ENUMS" '"datetime"' 'UiEnums datetime keyboard type'
static_gate "$CONTROL_RENDERERS" 'datetime-local' 'ControlRenderers datetime-local input'
[ "$static_ok" = "1" ] || fail "static source gates failed (see $EVIDENCE/source-gates.txt)"
ok "T304 sources carry the new surface (source-gates.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (jhin.sessions + jhin.ui-kit + jhin.ui) =="
home=$(mktemp -d /tmp/t304-home.XXXXXX)
bundled=$(mktemp -d /tmp/t304-bundled.XXXXXX)
stage_jars "$bundled" || fail "could not stage the three plugin jars into $bundled"
jar_count=$(ls "$bundled"/*.jar 2>/dev/null | wc -l | tr -d ' ')
[ "$jar_count" = "3" ] || fail "expected 3 plugin jars in $bundled, got $jar_count"
{
    echo "JHIN_HOME=$home"
    echo "JHIN_BUNDLED_PLUGINS=$bundled"
    echo "JHIN_UI_QAPROBE=true"
    echo "port=$PORT"
    echo "base=$BASE"
    echo "mode=plain HTTP loopback"
    echo "mode-reason=jhin.security is not loaded -> no TlsProvider registered -> the kernel"
    echo "            listener speaks plain HTTP. Plan section 9 allows the QA-only"
    echo "            plain-HTTP mode in scripts."
    echo "port-reason=the kernel default 8443 is occupied by another service on this machine"
    echo "plugins=jhin.sessions, jhin.ui-kit, jhin.ui"
    echo "plugin-reason=the non-optional requires of jhin.ui; T304 drives the session"
    echo "              lifecycle actions over the served sessions screen, no LLM run"
    echo "              is needed."
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding (kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (qaProbe on, <= 30 s for health) =="
boot_kernel "$home" "$bundled"

# ------------------------------------------------------------- seed two
echo "== Step 5: seed two sessions via the API =="
s1=$(create_session "qa-one" '"/tmp/t304/one"')
sleep 1
s2=$(create_session "qa-two" '"/tmp/t304/two"')
{
    echo "T304 seeding — the sessions API (POST /sessions):"
    echo "  qa-one -> $s1 (workdir /tmp/t304/one)"
    echo "  qa-two -> $s2 (workdir /tmp/t304/two)"
} > "$EVIDENCE/seeded.txt"
ok "seeded 2 sessions ($s1, $s2) via POST /sessions (seeded.txt)"

# ------------------------------------------------------------- menu HTML
echo "== Step 6: the served menu HTML — the Snooze submenu with 5 entries =="
fetch_sessions_html "$EVIDENCE/menu.html"
snooze_submenu "$EVIDENCE/menu.html" > "$EVIDENCE/snooze-submenu.html"
[ -s "$EVIDENCE/snooze-submenu.html" ] || fail "the served menu carries no Snooze submenu (menu.html)"
grep -qF '<div class="jhin-menu-submenu" role="menu">' "$EVIDENCE/snooze-submenu.html" \
    || fail "the Snooze children are not rendered as a submenu (snooze-submenu.html)"
items=$(grep -o 'role="menuitem"' "$EVIDENCE/snooze-submenu.html" | wc -l | tr -d ' ')
[ "$items" = "5" ] || fail "the Snooze submenu carries $items entries (expected 5): $(cat "$EVIDENCE/snooze-submenu.html")"
for label in '>15 min</button>' '>1 h</button>' '>4 h</button>' \
        '>Until tomorrow 09:00</button>' '>Custom…</button>'; do
    grep -qF "$label" "$EVIDENCE/snooze-submenu.html" \
        || fail "the Snooze submenu is missing the $label entry (snooze-submenu.html)"
done
grep -qF 'data-jhin-action' "$EVIDENCE/snooze-submenu.html" \
    || fail "the Snooze submenu entries dispatch no actions (snooze-submenu.html)"
{
    echo "T304 menu acceptance — GET /ui/screen/sessions .html (menu.html):"
    echo "  the row overflow menu carries the Snooze submenu with exactly 5"
    echo "  entries — 15 min / 1 h / 4 h / Until tomorrow 09:00 / Custom… — each"
    echo "  a menuitem carrying a data-jhin-action dispatch (snooze-submenu.html)."
    echo ""
    sed 's/^/  /' "$EVIDENCE/snooze-submenu.html"
} > "$EVIDENCE/menu-check.txt"
ok "the Snooze submenu carries 5 entries (15 min, 1 h, 4 h, Until tomorrow 09:00, Custom…) (menu.html)"

# ----------------------------------------------------- pin / snooze / settle
echo "== Step 7: POST /ui/action/pin|snooze|settle|undo — the undo toast directive =="
post_action "pin" "{\"id\":\"$s1\"}" "$EVIDENCE/action-pin.body"
assert_undo_notice "$EVIDENCE/action-pin.body" "Pinned 1 thread,"
record_action "pin" "{\"id\":\"$s1\"}" "$EVIDENCE/action-pin.body"
ok "POST /ui/action/pin -> undo toast directive \"Pinned 1 thread,\" + undo + 5000 ms (actions.jsonl)"

post_action "snooze" "{\"id\":\"$s1\",\"durationMs\":3600000}" "$EVIDENCE/action-snooze.body"
assert_undo_notice "$EVIDENCE/action-snooze.body" "Snoozed 1 thread,"
record_action "snooze" "{\"id\":\"$s1\",\"durationMs\":3600000}" "$EVIDENCE/action-snooze.body"
ok "POST /ui/action/snooze -> undo toast directive \"Snoozed 1 thread,\" + undo + 5000 ms (actions.jsonl)"

get_session "$s1" "$EVIDENCE/state-snoozed.json"
jq -e '.snoozedUntil != null and .snoozedUntil > (now * 1000 | floor)' \
    "$EVIDENCE/state-snoozed.json" > /dev/null \
    || fail "GET /sessions/$s1 does not show a future snoozed_until: $(cat "$EVIDENCE/state-snoozed.json")"
ok "GET /sessions/{id}: snooze sets snoozed_until to a future deadline (state-snoozed.json)"

post_action "settle" "{\"id\":\"$s1\",\"reason\":\"manual\"}" "$EVIDENCE/action-settle.body"
assert_undo_notice "$EVIDENCE/action-settle.body" "Settled 1 thread,"
record_action "settle" "{\"id\":\"$s1\",\"reason\":\"manual\"}" "$EVIDENCE/action-settle.body"
ok "POST /ui/action/settle -> undo toast directive \"Settled 1 thread,\" + undo + 5000 ms (actions.jsonl)"

get_session "$s1" "$EVIDENCE/state-settled.json"
jq -e '.pinned == false and .snoozedUntil == null and .settledReason == "manual" and .settledAt != null' \
    "$EVIDENCE/state-settled.json" > /dev/null \
    || fail "GET /sessions/$s1 does not show the settle state: $(cat "$EVIDENCE/state-settled.json")"
ok "GET /sessions/{id}: settle clears pin + snoozed_until and writes settledReason=manual (state-settled.json)"

fetch_sessions_html "$EVIDENCE/screen-settled.html"
settled_rows=$(section_rows "$EVIDENCE/screen-settled.html" "section-settled")
printf '%s' "$settled_rows" | grep -qF "$s1" \
    || fail "the settled session $s1 is not rendered in the Settled shelf (rows: $settled_rows)"
ok "settle moves the row to the Settled shelf (section-settled of screen-settled.html)"

# -------------------------------------------------------------------- undo
echo "== Step 8: POST /ui/action/undo reverts the last lifecycle action =="
post_action "undo" "{}" "$EVIDENCE/action-undo.body"
jq -e '
    .client as $c
    | (($c | length) == 2)
      and ($c[0].op == "toast")
      and ($c[0].text == "Undone")
      and ($c[1].op == "refresh")' "$EVIDENCE/action-undo.body" > /dev/null \
    || fail "POST /ui/action/undo did not answer the Undone toast + refresh: $(cat "$EVIDENCE/action-undo.body")"
record_action "undo" "{}" "$EVIDENCE/action-undo.body"
ok "POST /ui/action/undo -> undo toast \"Undone\" + refresh (actions.jsonl)"

get_session "$s1" "$EVIDENCE/state-undone.json"
jq -e '.settledAt == null and .settledReason == null and .pinned == true and .snoozedUntil != null' \
    "$EVIDENCE/state-undone.json" > /dev/null \
    || fail "undo did not restore the pre-settle state of $s1: $(cat "$EVIDENCE/state-undone.json")"
ok "GET /sessions/{id}: undo restores the pre-settle state (pin + snooze back, settle cleared) (state-undone.json)"

# --------------------------------------------------- snoozed shelf (qa-two)
echo "== Step 9: snooze moves the row to the Snoozed shelf =="
post_action "snooze" "{\"id\":\"$s2\",\"durationMs\":3600000}" "$EVIDENCE/action-snooze-qa-two.body"
assert_undo_notice "$EVIDENCE/action-snooze-qa-two.body" "Snoozed 1 thread,"
record_action "snooze" "{\"id\":\"$s2\",\"durationMs\":3600000}" "$EVIDENCE/action-snooze-qa-two.body"
get_session "$s2" "$EVIDENCE/state-qa-two-snoozed.json"
jq -e '.snoozedUntil != null and .snoozedUntil > (now * 1000 | floor)' \
    "$EVIDENCE/state-qa-two-snoozed.json" > /dev/null \
    || fail "GET /sessions/$s2 does not show a future snoozed_until: $(cat "$EVIDENCE/state-qa-two-snoozed.json")"
fetch_sessions_html "$EVIDENCE/screen-snoozed.html"
snoozed_rows=$(section_rows "$EVIDENCE/screen-snoozed.html" "section-snoozed")
printf '%s' "$snoozed_rows" | grep -qF "$s2" \
    || fail "the snoozed session $s2 is not rendered in the Snoozed shelf (rows: $snoozed_rows)"
ok "snooze moves the row to the Snoozed shelf (section-snoozed of screen-snoozed.html)"

action_count=$(wc -l < "$EVIDENCE/actions.jsonl" | tr -d ' ')
[ "$action_count" = "5" ] || fail "actions.jsonl carries $action_count bodies (expected 5)"
ok "every response body carries the undo toast directive — 5 action bodies recorded (actions.jsonl)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T304 browser steps — UNAVAILABLE in this environment.

Browser tooling (the agent browser / screenshots / evaluate) cannot run on
this QA machine; the T202–T208/T301–T303 precedent applies: every browser
step is recorded here and substituted with curl + static asserts.

Not executed (the plan's interactive/visual cases):
  - Opening the row overflow menu and flying out the Snooze submenu on
    hover/click: substituted by the served menu bytes in menu.html — the
    Snooze submenu block (snooze-submenu.html) with exactly 5 menuitems
    (15 min, 1 h, 4 h, Until tomorrow 09:00, Custom…), each carrying its
    data-jhin-action dispatch — plus the SidebarBuilderTest
    snoozeCarriesTheUpstreamPresetSubmenuPlusCustom unit assert.
  - The 500 ms hover-card preview reveal (title, project, workdir chip,
    model, created/updated, status, last event): substituted by the
    static gate on SidebarBuilder.hoverCard and the SidebarBuilderTest
    hover-card anatomy asserts.
  - The undo toast card (label + Undo button + close) living out its 5 s
    window in the toast stack, and tapping Undo inside it: substituted by
    the actions.jsonl directive greps (toast + action.name=undo +
    duration=5000 + refresh) and the undo round trip proven over the wire
    (POST /ui/action/undo restores the pre-settle state), plus the --fail
    proof that the toast window is real (undo after 6 s answers
    "Nothing to undo", undo-expired.txt).
  - The status indicator glyphs (pinned diamond, snoozed clock, settled
    check, working pulse): substituted by the components.css static gates
    (data-jhin-status="pinned"|"snoozed"|"settled", --animate-status-pulse)
    and the SidebarBuilderTest statusKinds asserts.
  - The custom-snooze dialog's native datetime picker: substituted by the
    docs/sdui.md + UiEnums + ControlRenderers static gates (keyboardType
    datetime -> input type="datetime-local") and the SessionsScreenTest
    dialog asserts.

What IS proven here: the served row menus carry the Snooze submenu with its
5 entries, every lifecycle action answer carries the undo toast directive
(5000 ms window), the undo action really reverts the last mutation over the
wire, GET /sessions/{id} shows every state change (snoozed_until set, settle
clearing pin + snooze and writing settledReason, undo restoring), the served
screen moves rows between the Settled and Snoozed shelves, and the --fail
mode proves the negative paths (409 invalid_transition, "Nothing to undo").
EOF
ok "browser-unavailable.txt records the un-exercised visual cases"

# ---------------------------------------------------------------- summary
{
    echo "T304 QA — PASS"
    echo ""
    echo "  suites:            :jhin-plugin-ui-kit:test $ui_kit_tests, :jhin-plugin-ui-default:test $ui_default_tests (0 failures)"
    echo "  actions:           pin/snooze/settle/undo — every response body carries the undo toast"
    echo "                     directive (toast + undo action + 5000 ms; undo answers \"Undone\")"
    echo "                     $action_count bodies in actions.jsonl"
    echo "  state:             snooze sets snoozed_until; settle clears pin + snooze and writes"
    echo "                     settledReason=manual; undo restores the pre-settle state"
    echo "                     (GET /sessions/{id}: state-snoozed/state-settled/state-undone.json)"
    echo "  shelves:           settle -> Settled shelf, snooze -> Snoozed shelf (screen-*.html)"
    echo "  menu:              GET /ui/screen/sessions — the Snooze submenu with 5 entries"
    echo "                     (15 min, 1 h, 4 h, Until tomorrow 09:00, Custom…) (menu.html)"
    echo "  negative:          settle on a settled session -> 409 invalid_transition; undo after"
    echo "                     5 s -> \"Nothing to undo\" (proven in --fail mode)"
    echo ""
    echo "  evidence: $EVIDENCE"
    sed 's/^/  /' "$checks"
} > "$EVIDENCE/summary.txt"
ok "T304 QA PASS (summary.txt)"
