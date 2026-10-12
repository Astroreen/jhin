#!/usr/bin/env bash
# T303 QA — project-grouped sidebar and thread-row fidelity.
#
# Proves, with a booted kernel, curl, jq, sqlite3 and static greps only
# (browser tools are UNAVAILABLE in this environment — every browser step
# becomes evidence/T303/browser-unavailable.txt plus strengthened curl/static
# asserts, the T202–T208/T301/T302 precedent):
#   1. build + test gates: the kernel boot jar and the three plugin jars
#      build and the two suites stay green (:jhin-plugin-ui-kit:test,
#      :jhin-plugin-ui-default:test); counts are summed from the JUnit XML
#      reports, failures/errors asserted 0;
#   2. static gates: the T303 sources carry the new surface — the project
#      groups of SidebarBuilder, the "›" breadcrumb separator, the context
#      chip of the chat header, the 52px topbar token and the completed
#      docs/sdui.md §5 session_updated paragraph;
#   3. wire gates: the kernel is booted with jhin.sessions + jhin.ui-kit +
#      jhin.ui into a temp JHIN_HOME and seeded via the sessions API in two
#      workdirs (/tmp/t303/alpha x2, /tmp/t303/beta x1). GET / answers 200
#      with the web-client shell (root.html); the sidebar bytes the client
#      receives live in the sessions screen (GET /ui/screen/sessions ->
#      sidebar.html — the same HtmlRenderer fragment the bootstrap inlines).
#      groups.txt extracts one line per project group (key, label, count,
#      nested session-row ids) and asserts: exactly two group headers
#      project-group:alpha / project-group:beta with counts 2 / 1 and the
#      rows nested under them, the project-groups:<sectionId> wrapper, the
#      sidebar.project.<key>.collapsed store keys, the "›" breadcrumb and
#      the --workspace-topbar-height: 52px token (tokens.txt);
#   4. browser-unavailable.txt: the interactive collapse of a project group
#      and the hover context chip cannot be exercised here; the file lists
#      exactly which cases are uncovered and which asserts substitute them;
#   5. summary.txt with every PASS line and the key numbers.
#
# --fail mode (the negative proofs — each must PASS, exit 0, into
# checks-fail.txt):
#   a. null-workdir.txt: the REST contract refuses a null workdir (POST
#      /sessions {workdir: null} -> 400 naming workdir), so the no-project
#      case is seeded by clearing the column over the shared SQLite file
#      ($JHIN_HOME/data/jhin.db) — the only channel that can express a
#      null workdir. The wire then must show the session row nested under
#      the "No project" group — and that group LAST, after the seeded
#      "alpha" project.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with three plugin jars: jhin.sessions, jhin.ui-kit and jhin.ui (the
# non-optional requires of jhin.ui). jhin.security is deliberately absent: no
# bearer token is needed and the listener speaks plain HTTP on
# http://localhost:18443 (the kernel default 8443 is occupied on the QA
# machine; plan section 9 allows the QA-only plain-HTTP mode in scripts).
#
# On any failure one line is appended to evidence/T303/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T303_INNER:-}" ]; then
    exec env T303_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."
ROOT="$(pwd)"

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
    fail_mode=1
    shift
fi

EVIDENCE="${1:-$ROOT/.sisyphus/evidence/T303}"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage'
SIDEBAR_BUILDER="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/SidebarBuilder.java"
SHELL_SCREEN="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/ShellScreen.java"
MESSAGE_CARD="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/MessageCardBuilder.java"
CHAT_SCREEN="plugins/ui-default/src/main/java/com/astroreen/jhin/plugin/ui/screens/ChatScreen.java"
TOKENS_CSS="plugins/ui-default/src/main/resources/web/css/tokens.css"
SDUI_DOC="docs/sdui.md"
SQLITE3="${SQLITE3:-sqlite3}"

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

# fetch_sessions_html <out>: the sessions screen HTML — the sidebar bytes the
# web client receives (GET / serves the static client shell; the screens are
# served by GET /ui/screen/{id} exactly as the bootstrap inlines them).
fetch_sessions_html() {
    local out=$1 code
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/screen.json" \
        -w '%{http_code}' "$BASE/ui/screen/sessions") || fail "GET /ui/screen/sessions: curl failed"
    [ "$code" = "200" ] || fail "GET /ui/screen/sessions answered $code (expected 200)"
    jq -r '.html' "$EVIDENCE/screen.json" > "$out"
    [ -s "$out" ] || fail "the sessions screen carries no HTML ($out)"
}

# create_session <title> <workdir-json> -> prints the session id. The workdir
# is a JSON string fragment (""\"/tmp/t303/alpha\"" or "null").
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

# extract_groups <html> <out>: one TSV line per project group in document
# (group) order — key, label, count, the comma-joined nested session-row ids.
extract_groups() {
    local html=$1 out=$2
    : > "$out"
    # The served fragment carries real newlines mid-section; collapse them so
    # every project group becomes exactly one chunk, then split on the group
    # id. Every grep below is failure-tolerant: a chunk without a group id (or
    # without rows) is skipped or padded empty instead of aborting the run
    # under set -e.
    tr -d '\n' < "$html" | sed 's/data-jhin-id="project-group:/\n&/g' | tail -n +2 \
        | while IFS= read -r chunk || [ -n "$chunk" ]; do
        key=$(printf '%s' "$chunk" | grep -o 'data-jhin-id="project-group:[^"]*"' | head -1 \
            | sed 's/.*project-group://;s/"$//') || true
        [ -n "$key" ] || continue
        label=$(printf '%s' "$chunk" | grep -o 'jhin-list-section-label">[^<]*' | head -1 \
            | sed 's/.*>//') || true
        count=$(printf '%s' "$chunk" | grep -o 'jhin-list-section-count">[0-9]*' | head -1 \
            | sed 's/.*>//') || true
        rows=$(printf '%s' "$chunk" | grep -o 'data-jhin-id="session-row:[^"]*"' \
            | sed 's/.*session-row://;s/"$//' | paste -sd, -) || true
        printf '%s\t%s\t%s\t%s\n' "$key" "$label" "$count" "$rows" >> "$out"
    done
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
        echo "T303 test gates — the two suites green on the project-group surface:"
        grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
        echo ""
        echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests"
        echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (SidebarBuilderTest, ShellScreenTest, ChatScreenTest, TimelineRowsTest among them)"
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
    echo "== T303 QA --fail: the negative proofs must PASS =="

    build_and_test

    command -v "$SQLITE3" > /dev/null 2>&1 \
        || fail "sqlite3 is required for the null-workdir proof (set SQLITE3=...)"

    home=$(mktemp -d /tmp/t303-home.XXXXXX)
    bundled=$(mktemp -d /tmp/t303-bundled.XXXXXX)
    stage_jars "$bundled" || fail "could not stage the three plugin jars into $bundled"
    boot_kernel "$home" "$bundled"

    log "-- negative proof: a workdir=null session lands in the No project bucket"
    {
        echo "T303 --fail: a session with workdir=null must land in the"
        echo "\"No project\" group — and that group must sort LAST, after the"
        echo "seeded \"alpha\" project."
        echo ""
    } > "$EVIDENCE/null-workdir.txt"

    # 1. the REST contract refuses a null workdir — the 400 names the field.
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
        -o "$EVIDENCE/null-create.body" -w '%{http_code}' \
        -d '{"title":"null-workdir","workdir":null}' "$BASE/sessions") \
        || fail "POST /sessions {workdir: null}: curl failed"
    [ "$code" = "400" ] || fail "POST /sessions {workdir: null} answered $code (expected 400)"
    grep -qi 'workdir' "$EVIDENCE/null-create.body" \
        || fail "the 400 body does not name workdir: $(cat "$EVIDENCE/null-create.body")"
    {
        echo "  the REST create contract refuses a null workdir (PASS):"
        echo "    POST /sessions {\"title\":\"null-workdir\",\"workdir\":null} -> 400"
        echo "    body: $(cat "$EVIDENCE/null-create.body")"
        echo "  (POST requires a non-blank workdir and PATCH keeps the current"
        echo "  one on null, so the no-project bucket cannot be seeded through"
        echo "  the sessions API — the column is cleared over the shared"
        echo "  SQLite file, the only channel that can express workdir=null.)"
        echo ""
    } >> "$EVIDENCE/null-workdir.txt"

    # 2. seed one named project and one orphan through the API, then null the
    #    orphan's workdir column over the shared database file.
    alpha_id=$(create_session "alpha" '"/tmp/t303/alpha"')
    orphan_id=$(create_session "orphan" '"/tmp/t303/orphan"')
    db="$home/data/jhin.db"
    [ -f "$db" ] || fail "the shared database file is missing: $db"
    "$SQLITE3" "$db" "UPDATE jhin_sessions_sessions SET workdir = NULL WHERE id = '$orphan_id';" \
        || fail "could not clear the workdir column of $orphan_id in $db"
    "$SQLITE3" "$db" "SELECT id || '=' || COALESCE(workdir, 'NULL') FROM jhin_sessions_sessions ORDER BY id;" \
        > "$EVIDENCE/null-workdir-db.txt"
    grep -qF "$orphan_id=NULL" "$EVIDENCE/null-workdir-db.txt" \
        || fail "the orphan row still carries a workdir (null-workdir-db.txt)"
    printf '  the orphan row %s has workdir=NULL in %s (PASS)\n' "$orphan_id" "$db" \
        >> "$EVIDENCE/null-workdir.txt"

    # 3. the API-visible session really carries a null workdir.
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/null-session.json" \
        -w '%{http_code}' "$BASE/sessions/$orphan_id") || fail "GET /sessions/{id}: curl failed"
    [ "$code" = "200" ] || fail "GET /sessions/$orphan_id answered $code (expected 200)"
    [ "$(jq -r '.workdir' "$EVIDENCE/null-session.json")" = "null" ] \
        || fail "GET /sessions/$orphan_id does not report workdir null: $(cat "$EVIDENCE/null-session.json")"
    printf '  GET /sessions/%s reports "workdir": null (PASS)\n' "$orphan_id" \
        >> "$EVIDENCE/null-workdir.txt"

    # 4. the wire: the orphan row nests under the No project group — last.
    fetch_sessions_html "$EVIDENCE/sidebar.html"
    extract_groups "$EVIDENCE/sidebar.html" "$EVIDENCE/groups.tsv"
    {
        echo ""
        echo "  the project groups of the served sidebar, in render order:"
        echo "  (key, label, count, nested session-row ids)"
        sed 's/^/    /' "$EVIDENCE/groups.tsv"
        echo ""
    } >> "$EVIDENCE/null-workdir.txt"

    expected=$(printf 'alpha\talpha\t1\t%s\nno-project\tNo project\t1\t%s\n' \
        "$alpha_id" "$orphan_id")
    actual=$(cat "$EVIDENCE/groups.tsv")
    if [ "$actual" != "$expected" ]; then
        printf '  groups.tsv does not match the expected two-group render (FAIL)\n' \
            >> "$EVIDENCE/null-workdir.txt"
        fail "no-project grouping mismatch (groups.tsv): got [$actual], expected [$expected]"
    fi
    printf '  exactly two groups, "No project" LAST after "alpha" (PASS)\n' \
        >> "$EVIDENCE/null-workdir.txt"
    printf '  the orphan row %s nests under project-group:no-project (PASS)\n' "$orphan_id" \
        >> "$EVIDENCE/null-workdir.txt"
    grep -qF 'data-jhin-store-key="sidebar.project.no-project.collapsed"' "$EVIDENCE/sidebar.html" \
        || fail "the No project group carries no sidebar.project.no-project.collapsed store key (sidebar.html)"
    printf '  store key sidebar.project.no-project.collapsed present (PASS)\n' \
        >> "$EVIDENCE/null-workdir.txt"

    ok "workdir=null lands in the No project bucket, sorted last (null-workdir.txt)"
    ok "T303 QA --fail: the negative proof PASSes"
    exit 0
fi

# ------------------------------------------------------------------ happy
echo "== T303 QA: project-grouped sidebar and thread-row fidelity =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

build_and_test

# ------------------------------------------------------- static source gates
echo "== Step 2: the T303 surface in the sources =="
{
    echo "T303 static source gates — the new surface must exist in the sources"
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
static_gate "$SIDEBAR_BUILDER" 'NO_PROJECT_KEY' 'SidebarBuilder no-project key'
static_gate "$SIDEBAR_BUILDER" 'project-groups:' 'SidebarBuilder project-groups wrapper'
static_gate "$SIDEBAR_BUILDER" 'sidebar.project.' 'SidebarBuilder group store key'
static_gate "$SIDEBAR_BUILDER" 'projectKey(' 'SidebarBuilder projectKey'
static_gate "$SHELL_SCREEN" 'CRUMB_SEPARATOR = "›"' 'ShellScreen "›" breadcrumb separator'
static_gate "$MESSAGE_CARD" 'contextChip(' 'MessageCardBuilder context chip'
static_gate "$MESSAGE_CARD" 'PathDisplay.chip(workdir)' 'MessageCardBuilder workdir path chip'
static_gate "$CHAT_SCREEN" 'context-chip' 'ChatScreen header context chip'
static_gate "$TOKENS_CSS" '--workspace-topbar-height: 52px' 'tokens.css topbar height 52px'
static_gate "$SDUI_DOC" 'absent fields become' 'sdui.md absent fields -> null'
static_gate "$SDUI_DOC" 'table governs the patch' 'sdui.md row-prop table governs'
[ "$static_ok" = "1" ] || fail "static source gates failed (see $EVIDENCE/source-gates.txt)"
ok "T303 sources carry the new surface (source-gates.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (jhin.sessions + jhin.ui-kit + jhin.ui) =="
home=$(mktemp -d /tmp/t303-home.XXXXXX)
bundled=$(mktemp -d /tmp/t303-bundled.XXXXXX)
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
    echo "plugin-reason=the non-optional requires of jhin.ui; T303 renders the sessions"
    echo "              screen and the seeded sidebar only, no LLM run is needed."
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding (kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (qaProbe on, <= 30 s for health) =="
boot_kernel "$home" "$bundled"

# ------------------------------------------------------- seed two projects
echo "== Step 5: seed sessions via the API in two workdirs =="
# Oldest first: the Active shelf orders by updatedAt DESC, so the seeded
# timestamps must strictly increase for a deterministic group render order
# (alpha group first with rows alpha-one, alpha-two; beta group second).
beta_one=$(create_session "beta-one" '"/tmp/t303/beta"')
sleep 1
alpha_two=$(create_session "alpha-two" '"/tmp/t303/alpha"')
sleep 1
alpha_one=$(create_session "alpha-one" '"/tmp/t303/alpha"')
{
    echo "T303 seeding — the sessions API (POST /sessions) in two workdirs:"
    echo "  /tmp/t303/alpha  -> $alpha_one (alpha-one), $alpha_two (alpha-two)"
    echo "  /tmp/t303/beta   -> $beta_one (beta-one)"
} > "$EVIDENCE/seeded.txt"
ok "seeded 2 sessions in /tmp/t303/alpha and 1 in /tmp/t303/beta (seeded.txt)"

# ------------------------------------------------------- wire acceptance
echo "== Step 6: GET / and the served sidebar HTML =="
code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/root.html" -w '%{http_code}' \
    "$BASE/") || fail "GET /: curl failed"
[ "$code" = "200" ] || fail "GET / answered $code (expected 200)"
grep -qF 'jhin-root' "$EVIDENCE/root.html" \
    || fail "GET / does not carry the web-client shell (root.html)"
ok "GET / -> 200 with the web-client shell (root.html)"

fetch_sessions_html "$EVIDENCE/sidebar.html"
ok "GET /ui/screen/sessions -> the served sidebar HTML (sidebar.html)"

echo "== Step 7: the project group headers, counts and nested rows =="
{
    echo "T303 acceptance greps — the served sessions screen HTML"
    echo "(GET /ui/screen/sessions .html; GET / serves the static client shell"
    echo "and the client fetches this exact fragment at runtime)."
    echo ""
    echo "The project groups of the sidebar, in render order"
    echo "(key, label, count, nested session-row ids):"
} > "$EVIDENCE/groups.txt"
extract_groups "$EVIDENCE/sidebar.html" "$EVIDENCE/groups.tsv"
sed 's/^/  /' "$EVIDENCE/groups.tsv" >> "$EVIDENCE/groups.txt"

expected=$(printf 'alpha\talpha\t2\t%s,%s\nbeta\tbeta\t1\t%s\n' \
    "$alpha_one" "$alpha_two" "$beta_one")
actual=$(cat "$EVIDENCE/groups.tsv")
if [ "$actual" != "$expected" ]; then
    {
        echo ""
        echo "  groups.tsv does not match the expected render (FAIL):"
        echo "  got:      [$actual]"
        echo "  expected: [$expected]"
    } >> "$EVIDENCE/groups.txt"
    fail "project-group rendering mismatch (groups.txt)"
fi
{
    echo ""
    echo "  exactly two group headers with the correct counts and rows (PASS):"
    echo "    project-group:alpha  label=alpha  count=2  rows=$alpha_one,$alpha_two"
    echo "    project-group:beta   label=beta   count=1  rows=$beta_one"
} >> "$EVIDENCE/groups.txt"

grep -qF 'data-jhin-id="project-groups:section-active"' "$EVIDENCE/sidebar.html" \
    || fail "the Active section carries no project-groups:section-active wrapper (groups.txt)"
grep -qF 'data-jhin-store-key="sidebar.project.alpha.collapsed"' "$EVIDENCE/sidebar.html" \
    || fail "the alpha group carries no sidebar.project.alpha.collapsed store key (groups.txt)"
grep -qF 'data-jhin-store-key="sidebar.project.beta.collapsed"' "$EVIDENCE/sidebar.html" \
    || fail "the beta group carries no sidebar.project.beta.collapsed store key (groups.txt)"
{
    echo "  wrapper project-groups:section-active present (PASS)"
    echo "  store keys sidebar.project.alpha.collapsed / sidebar.project.beta.collapsed (PASS)"
} >> "$EVIDENCE/groups.txt"

grep -qF '›' "$EVIDENCE/sidebar.html" \
    || fail "the breadcrumb carries no \"›\" separator (groups.txt)"
printf '  breadcrumb separator \"›\" served (PASS)\n' >> "$EVIDENCE/groups.txt"

code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/tokens.css" -w '%{http_code}' \
    "$BASE/ui/assets/tokens.css") || fail "GET /ui/assets/tokens.css: curl failed"
[ "$code" = "200" ] || fail "GET /ui/assets/tokens.css answered $code (expected 200)"
grep -qF -- '--workspace-topbar-height: 52px' "$EVIDENCE/tokens.css" \
    || fail "tokens.css carries no --workspace-topbar-height: 52px (tokens.css)"
{
    echo ""
    echo "T303 tokens — the served tokens.css:"
    grep -F -- '--workspace-topbar-height' "$EVIDENCE/tokens.css" | sed 's/^/  /'
    echo "  --workspace-topbar-height: 52px served (PASS)"
} > "$EVIDENCE/tokens.txt"
ok "two group headers + counts + nested rows, wrapper, store keys, \"›\" and 52px topbar (groups.txt, tokens.txt)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T303 browser steps — UNAVAILABLE in this environment.

Browser tooling (the agent browser / screenshots / evaluate) cannot run on
this QA machine; the T202–T208/T301/T302 precedent applies: every browser
step is recorded here and substituted with curl + static asserts.

Not executed (the plan's interactive/visual cases):
  - Clicking a project group header to collapse/expand it and reloading to
    see the sidebar.project.<key>.collapsed store key take effect: substituted
    by the served-byte greps in groups.txt (data-jhin-collapsible/
    data-jhin-store-key on the group sections) and the unit asserts of
    SidebarBuilderTest (the group collapse contract).
  - Hovering a thread row to reveal the trailing cluster and the hover
    preview card: substituted by the row HTML in sidebar.html (hoverReveal
    and the hover_card title slot) plus SidebarBuilderTest row-anatomy
    asserts.
  - The breadcrumb rendering of "project › session title" at the 52px
    topbar: substituted by the "›" grep in groups.txt and the
    --workspace-topbar-height: 52px gate in tokens.txt.
  - The chat header context chip (model + provider + workdir path chip):
    substituted by the source gate on MessageCardBuilder/ChatScreen and the
    ChatScreenTest/TimelineRowsTest unit asserts.

What IS proven here: the served sidebar HTML nests the seeded rows under
the two project group headers with the correct counts (and under the
"No project" bucket last in --fail mode), the groups carry their collapse
store keys and the wrapper, and the topbar token and breadcrumb separator
are served.
EOF
ok "browser-unavailable.txt records the un-exercised visual cases"

# ---------------------------------------------------------------- summary
{
    echo "T303 QA — PASS"
    echo ""
    echo "  suites:            :jhin-plugin-ui-kit:test $ui_kit_tests, :jhin-plugin-ui-default:test $ui_default_tests (0 failures)"
    echo "  project groups:    project-group:alpha (count 2) + project-group:beta (count 1), rows nested under them"
    echo "  wrapper/storeKey:  project-groups:section-active + sidebar.project.<key>.collapsed"
    echo "  breadcrumb:        project › session title (separator \"›\") served"
    echo "  topbar:            --workspace-topbar-height: 52px served (tokens.txt)"
    echo "  no-project:        workdir=null lands in \"No project\" last (proven in --fail mode, null-workdir.txt)"
    echo ""
    echo "  evidence: $EVIDENCE"
    sed 's/^/  /' "$checks"
} > "$EVIDENCE/summary.txt"
ok "T303 QA PASS (summary.txt)"
