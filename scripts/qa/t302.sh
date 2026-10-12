#!/usr/bin/env bash
# T302 QA — GFM markdown parity, code-block headers and path chips.
#
# Proves, with a booted kernel, curl, jq and static greps only (browser tools
# are UNAVAILABLE in this environment — every browser step becomes
# evidence/T302/browser-unavailable.txt plus strengthened curl/static asserts,
# the T202–T208/T301 precedent):
#   1. build + test gates: the kernel boot jar and the three plugin jars
#      build and the two suites stay green (:jhin-plugin-ui-kit:test,
#      :jhin-plugin-ui-default:test); counts are summed from the JUnit XML
#      reports, failures/errors asserted 0;
#   2. static gates: the T302 sources carry the new surface — PathDisplay,
#      the copyable code-block header, the GFM extensions, the path-chip and
#      callout CSS, the client copy handler;
#   3. wire gates: the kernel is booted with the qaProbe screens
#      (JHIN_UI_QAPROBE=true) and GET /_jhin/bootstrap serves the
#      qa-markdown screen HTML; the acceptance greps run against those
#      served bytes — <del>, <input type="checkbox" disabled>, the autolink
#      <a href="https://…">, the data-jhin-type="code_block" header with the
#      language label and the copy affordance, and the path chips
#      (paths.txt: every chip label <= 48 chars, the file.java basename
#      preserved, the full path in the tooltip);
#   4. browser-unavailable.txt: interactive clipboard clicks / hover-tooltip
#      rendering cannot be exercised here; the file lists exactly which
#      cases are uncovered and which asserts substitute them;
#   5. summary.txt with every PASS line and the key numbers.
#
# --fail mode (the negative proofs — each must PASS, exit 0, into
# checks-fail.txt):
#   a. degraded.txt: the qa-degraded screen (unclosed fence) is proven to
#      fail closed — the served bytes contain NO code_block node and NO
#      <pre>, and the same acceptance probe the happy path applies reports
#      every GFM marker as MISSING against it (a vacuously passing gate
#      could not produce this file).
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with three plugin jars: jhin.sessions, jhin.ui-kit and jhin.ui (the
# non-optional requires of jhin.ui). jhin.security is deliberately absent: no
# bearer token is needed and the listener speaks plain HTTP on
# http://localhost:18443 (the kernel default 8443 is occupied on the QA
# machine; plan section 9 allows the QA-only plain-HTTP mode in scripts).
#
# On any failure one line is appended to evidence/T302/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T302_INNER:-}" ]; then
    exec env T302_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."
ROOT="$(pwd)"

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
    fail_mode=1
    shift
fi

EVIDENCE="${1:-$ROOT/.sisyphus/evidence/T302}"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage'
MARKDOWN_RENDERER="plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/html/renderers/MarkdownRenderer.java"
PATH_DISPLAY="plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/text/PathDisplay.java"
TEXT_RENDERERS="plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/html/renderers/TextRenderers.java"

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

# fetch_screen_html <screen-id> <out>: extracts the served screen HTML
# fragment from the bootstrap payload (the screens carry {id, html}).
fetch_screen_html() {
    local id=$1 out=$2 code
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/bootstrap.json" \
        -w '%{http_code}' "$BASE/_jhin/bootstrap") || fail "GET /_jhin/bootstrap: curl failed"
    [ "$code" = "200" ] || fail "GET /_jhin/bootstrap answered $code (expected 200)"
    jq -r --arg id "$id" '.screens[] | select(.id == $id) | .html' \
        "$EVIDENCE/bootstrap.json" > "$out"
    [ -s "$out" ] || fail "bootstrap payload carries no '$id' screen HTML ($out)"
}

# probe_absent <haystack> <pattern> <out> <name>: appends "  MISSING <name>"
# to <out> when the pattern is absent from the haystack; appends
# "  PRESENT <name>" when it is there. Returns 0 always.
probe_absent() {
    local haystack=$1 pattern=$2 out=$3 name=$4
    if grep -qF -- "$pattern" "$haystack"; then
        printf '  PRESENT %s\n' "$name" >> "$out"
    else
        printf '  MISSING %s\n' "$name" >> "$out"
    fi
    return 0
}

# count_attr <dir> <attr>: sums one XML attribute across the JUnit reports.
count_attr() {
    grep -h -o "$2=\"[0-9]*\"" "$1"/TEST-*.xml 2>/dev/null | awk -F'"' '{s += $2} END {print s+0}'
}

# The happy-path acceptance patterns, one per line (pattern<TAB>label).
acceptance_patterns() {
    printf '%s\n' \
        '<del>	strikethrough renders <del>' \
        '<input type="checkbox" disabled>	task-list checkbox (bare disabled)' \
        'jhin-code-block-header	code-block header' \
        'jhin-code-block-lang">java	header language label (java)' \
        'jhin-code-block-copy	copy affordance' \
        'aria-label="Copy code"	copy aria-label' \
        'data-jhin-type="code_block"	code_block wire marker' \
        'href="https://example.invalid/docs"	autolink href' \
        '<a href="https://example.invalid/docs"	autolink <a href=' \
        'jhin-callout jhin-callout-warning	alert callout (warning)' \
        'jhin-path-chip	path chip class'
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
        echo "T302 test gates — the two suites green on the GFM/path-chip surface:"
        grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
        echo ""
        echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests (MarkdownRenderTest, PathDisplayTest among them)"
        echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (SidebarBuilderTest, HtmlConformanceTest among them)"
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
    echo "== T302 QA --fail: the negative proofs must PASS =="

    build_and_test

    log "-- negative proof a: the unclosed-fence degradation fails closed"
    home=$(mktemp -d /tmp/t302-home.XXXXXX)
    bundled=$(mktemp -d /tmp/t302-bundled.XXXXXX)
    stage_jars "$bundled" || fail "could not stage the three plugin jars into $bundled"
    boot_kernel "$home" "$bundled"

    degraded="$EVIDENCE/degraded.html"
    fetch_screen_html "qa-degraded" "$degraded"

    {
        echo "T302 --fail: the unclosed-fence fixture must degrade to plain text."
        echo ""
        echo "  fixture: the qa-degraded screen — 'before' then an unclosed"
        echo "  \`\`\`java fence. The markdown node must degrade to one escaped"
        echo "  plain-text run: no code_block node, no <pre>, the fence markers"
        echo "  surviving as visible characters only."
        echo ""
    } > "$EVIDENCE/degraded.txt"

    # 1. the degradation itself.
    if grep -qF 'data-jhin-type="code_block"' "$degraded"; then
        fail "degraded fixture still renders a code_block node (degraded.txt)"
    fi
    printf '  no data-jhin-type="code_block" in the served bytes (PASS)\n' >> "$EVIDENCE/degraded.txt"
    if grep -qF '<pre' "$degraded"; then
        fail "degraded fixture still renders <pre (degraded.txt)"
    fi
    printf '  no <pre> in the served bytes (PASS)\n' >> "$EVIDENCE/degraded.txt"
    grep -qF '```java' "$degraded" \
        || fail "degraded fixture lost the fence markers (degraded.txt)"
    printf '  fence markers survive as plain characters (PASS)\n' >> "$EVIDENCE/degraded.txt"

    # 2. the happy acceptance probe against the degraded bytes must report
    #    every GFM marker MISSING — the probe cannot pass vacuously.
    {
        echo ""
        echo "  the happy-path acceptance probe run against the degraded bytes"
        echo "  (every pattern must come back MISSING):"
        echo ""
    } >> "$EVIDENCE/degraded.txt"
    while IFS=$'\t' read -r pattern label; do
        probe_absent "$degraded" "$pattern" "$EVIDENCE/degraded.txt" "$label"
    done < <(acceptance_patterns)
    present_count=$(grep -c '^  PRESENT ' "$EVIDENCE/degraded.txt" || true)
    printf '\n  PRESENT lines reported against the degraded fixture: %s (expected 0)\n' \
        "$present_count" >> "$EVIDENCE/degraded.txt"
    [ "$present_count" = "0" ] \
        || fail "acceptance probe reported $present_count patterns present in the degraded fixture (degraded.txt)"
    ok "unclosed fence degrades to plain text and the acceptance probe fails closed against it (degraded.txt)"

    ok "T302 QA --fail: the negative proof PASSes"
    exit 0
fi

# ------------------------------------------------------------------ happy
echo "== T302 QA: GFM markdown parity, code-block headers and path chips =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

build_and_test

# ------------------------------------------------------- static source gates
echo "== Step 2: the T302 surface in the sources =="
{
    echo "T302 static source gates — the new surface must exist in the sources"
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
static_gate "$PATH_DISPLAY" 'middleTruncate' 'PathDisplay.middleTruncate'
static_gate "$PATH_DISPLAY" 'DEFAULT_MAX = 48' 'PathDisplay budget = 48'
static_gate "$PATH_DISPLAY" 'looksLikePath' 'PathDisplay.looksLikePath'
static_gate "$TEXT_RENDERERS" 'jhin-code-block-header' 'code-block header renderer'
static_gate "$TEXT_RENDERERS" 'jhin-code-block-copy' 'copy affordance renderer'
static_gate "$MARKDOWN_RENDERER" 'StrikethroughExtension' 'GFM strikethrough extension'
static_gate "$MARKDOWN_RENDERER" 'TaskListItemsExtension' 'GFM task-list extension'
static_gate "$MARKDOWN_RENDERER" 'AutolinkExtension' 'autolink extension'
static_gate "$MARKDOWN_RENDERER" 'hasUnclosedFence' 'unclosed-fence degrade'
static_gate plugins/ui-default/src/main/resources/web/js/actions.js \
    'jhin-code-block-copy' 'client copy handler'
static_gate plugins/ui-default/src/main/resources/web/css/components.css \
    '.jhin-path-chip' 'path-chip CSS'
static_gate plugins/ui-default/src/main/resources/web/css/components.css \
    '.jhin-callout-warning' 'callout CSS'
[ "$static_ok" = "1" ] || fail "static source gates failed (see $EVIDENCE/source-gates.txt)"
ok "T302 sources carry the new surface (source-gates.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (jhin.sessions + jhin.ui-kit + jhin.ui) =="
home=$(mktemp -d /tmp/t302-home.XXXXXX)
bundled=$(mktemp -d /tmp/t302-bundled.XXXXXX)
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
    echo "plugin-reason=the non-optional requires of jhin.ui; T302 renders the qaProbe"
    echo "              screens and the static payloads only, no LLM run is needed."
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding (kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (qaProbe on, <= 30 s for health) =="
boot_kernel "$home" "$bundled"

# ------------------------------------------------------- wire acceptance
echo "== Step 5: qa-markdown screen HTML over the wire =="
markdown="$EVIDENCE/markdown.html"
fetch_screen_html "qa-markdown" "$markdown"

{
    echo "T302 acceptance greps — the served qa-markdown screen HTML"
    echo "(GET /_jhin/bootstrap, .screens[id=qa-markdown].html), the exact"
    echo "bytes the web client receives."
    echo ""
} > "$EVIDENCE/acceptance.txt"
acc_ok=1
while IFS=$'\t' read -r pattern label; do
    hits=$(grep -cF -- "$pattern" "$markdown" || true)
    printf '  %-52s %s hit(s)  %s\n' "$label" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" >> "$EVIDENCE/acceptance.txt"
    [ "$hits" -ge 1 ] || acc_ok=0
done < <(acceptance_patterns)
grep -qF '<input type="checkbox" disabled>' "$markdown" \
    || acc_ok=0
printf '\n  autolink element:\n    %s\n' \
    "$(grep -o '<a[^>]*href="https://example.invalid/docs"[^>]*>' "$markdown" | head -1)" \
    >> "$EVIDENCE/acceptance.txt"
[ "$acc_ok" = "1" ] || fail "acceptance greps failed (see $EVIDENCE/acceptance.txt)"
ok "GFM parity + code_block header + callout + path chips served (acceptance.txt)"

# ------------------------------------------------------------- path chips
echo "== Step 6: path chips — <= 48 chars, file.java preserved, full tooltip =="
{
    echo "T302 path chips — every jhin-path-chip label of the served screen:"
    echo "middle-truncated to <= 48 characters, the basename kept whole and the"
    echo "full path in the tooltip (title)."
    echo ""
} > "$EVIDENCE/paths.txt"
grep -o 'data-jhin-type="chip"[^>]*>[^<]*' "$markdown" \
    | sed 's/^.*>//' > "$EVIDENCE/path-labels.txt" || true
label_count=$(wc -l < "$EVIDENCE/path-labels.txt" | tr -d ' ')
[ "$label_count" -ge 3 ] || fail "expected >= 3 path-chip labels, got $label_count (paths.txt)"
paths_ok=1
while IFS= read -r label; do
    [ -n "$label" ] || continue
    len=${#label}
    state=ok
    [ "$len" -le 48 ] || state="TOO-LONG"
    printf '  %3d chars  %-12s  %s\n' "$len" "$state" "$label" >> "$EVIDENCE/paths.txt"
    [ "$len" -le 48 ] || paths_ok=0
done < "$EVIDENCE/path-labels.txt"
grep -qF 'file.java' "$EVIDENCE/path-labels.txt" \
    || fail "no chip label preserves the file.java basename (paths.txt)"
grep -qF 'src/auth.java' "$EVIDENCE/path-labels.txt" \
    || fail "the short path chip label changed (paths.txt)"
grep -qF 'MessageCardBuilder.java' "$EVIDENCE/path-labels.txt" \
    || fail "the long path chip lost its basename (paths.txt)"
printf '  file.java basename preserved; short path unchanged; long basename kept\n' \
    >> "$EVIDENCE/paths.txt"
grep -qF 'title="/home/astroreen/Documents/jhin/plugins/ui-default/src/test/resources/gallery/deep/structure/file.java"' \
    "$markdown" || fail "the file.java chip tooltip does not carry the full path (paths.txt)"
printf '  the file.java chip tooltip carries the full path (title=...)\n' >> "$EVIDENCE/paths.txt"
[ "$paths_ok" = "1" ] || fail "path-chip budget gates failed (see $EVIDENCE/paths.txt)"
ok "path-chip labels <= 48 chars with full-path tooltips (paths.txt)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T302 browser steps — UNAVAILABLE in this environment.

Browser tooling (the agent browser / screenshots / evaluate) cannot run on
this QA machine; the T202–T208/T301 precedent applies: every browser step
is recorded here and substituted with curl + static asserts.

Not executed (the plan's interactive/visual cases):
  - Clicking the .jhin-code-block-copy affordance and pasting the clipboard:
    substituted by the served-byte greps in acceptance.txt (the button, the
    aria-label and the client copy handler bytes) plus the unit asserts —
    the handler is proven present in web/js/actions.js and the exact button
    markup in the served HTML.
  - Hovering a path chip to see the full-path tooltip rendering: substituted
    by the title= greps in paths.txt — the tooltip payload is proven in the
    exact bytes the client receives.
  - Visual GFM rendering (strikethrough line-through, checkbox states,
    callout borders): substituted by the element greps in acceptance.txt
    (del/input/blockquote markup) plus the callout CSS gates in
    source-gates.txt.

What IS proven here: the served qa-markdown screen carries the GFM
elements (<del>, task checkboxes, autolink, alert callout), the code_block
header with the language label and the copy affordance, and the path chips
with <= 48-char labels and full-path tooltips.
EOF
ok "browser-unavailable.txt records the un-exercised visual cases"

# ---------------------------------------------------------------- summary
{
    echo "T302 QA — PASS"
    echo ""
    echo "  suites:            :jhin-plugin-ui-kit:test $ui_kit_tests, :jhin-plugin-ui-default:test $ui_default_tests (0 failures)"
    echo "  GFM parity:        <del>, task checkboxes (bare disabled), autolink <a href=, alert callout served"
    echo "  code_block header: language label (java) + copy affordance + aria-label on data-jhin-type=\"code_block\""
    echo "  path chips:        $label_count labels, all <= 48 chars, file.java preserved, full-path tooltips"
    echo "  degrade:           unclosed fence -> plain text (proven in --fail mode, degraded.txt)"
    echo ""
    echo "  evidence: $EVIDENCE"
    sed 's/^/  /' "$checks"
} > "$EVIDENCE/summary.txt"
ok "T302 QA PASS (summary.txt)"
