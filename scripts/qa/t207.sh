#!/usr/bin/env bash
# T207 QA — ETag asset routes and a nonce CSP for the web shell (chunks 1+2).
#
# Proves, with a booted kernel, curl and static greps only (browser tools are
# UNAVAILABLE in this environment — the agent console-messages capture
# becomes evidence/T207/browser-unavailable.txt plus the static
# nonce-matching and eval-gate substitutes, the T202–T206 precedent):
#   1. build + test gates: the kernel boot jar and the three plugin jars
#      build and the four suites stay green with the T207 asset route on the
#      classpath — :jhin-plugin-ui-default:test 430 (AssetRouteTest,
#      WebAssetBudgetTest and the linked-shell WebShellRouteTest among them),
#      :jhin-plugin-ui-kit:test 310, :sdk:test 64, :kernel:test 117
#      (KernelPurityTest must stay green); counts are summed from the JUnit
#      XML reports and asserted exactly;
#   2. static gates on the shipped assets: no `<` in app.css; app.js <= 60000
#      bytes; app.css <= 40000 bytes — actuals recorded in budget.txt
#      together with this run's WebAssetBudgetTest result lines (the JUnit
#      XML of :jhin-plugin-ui-default:test — the suite asserts the same
#      class-path bytes the routes serve);
#   3. boot the kernel (plain HTTP port 18443, the 3-plugin bundle
#      jhin.sessions + jhin.ui-kit + jhin.ui — no mock LLM needed; the t206
#      pattern) and curl the web surface WITHOUT any X-Jhin-Client header:
#      a fresh browser sends none on the shell and asset fetches (only
#      /_jhin/bootstrap and the /ui/screen|action routes negotiate the
#      contract header), so this probes the real first-load path;
#   4. headers.txt — GET /ui/assets/app.js, GET /ui/assets/app.css and
#      GET / via `curl -sD- -o /dev/null`: status + Content-Type + ETag +
#      Cache-Control + Content-Security-Policy recorded and asserted
#      (application/javascript; charset=utf-8 / text/css; charset=utf-8,
#      Cache-Control: no-cache, ETag "sha256-[0-9a-f]{64}"; the Content-Type
#      compare is OWS-tolerant — the embedded Tomcat re-serializes the
#      header and drops the space after ';' on the wire, an RFC 9110-equal
#      media type);
#   5. etag-304.txt — the ETag captured from the 200 revalidates through
#      If-None-Match: the exact tag -> 304 with an empty body and the tag
#      echoed, `*` -> 304, a mismatching tag -> 200 with the full body; the
#      RFC 9110 weak-compare forms (W/ prefix, comma lists) are probed too;
#   6. csp-clean.txt — from GET /: the CSP header string (directive set
#      exactly `default-src 'self'; script-src 'self' 'nonce-…';
#      style-src 'unsafe-inline' 'self'; object-src 'none'; base-uri
#      'none'`), the header nonce reused by the linked <script …> and the
#      inline <style id="jhin-token-css" …>, two requests with DIFFERENT
#      nonces, the linked <link>/<script src> tags, no inlined jhinFetch
#      payload and no leftover __JHIN_ placeholders (production linked
#      mode); static substitute for the console capture: 0 eval /
#      new Function occurrences in app.js;
#   7. path-traversal.txt — the full traversal matrix through the live
#      kernel (raw .., encoded ..%2f and %2e%2e%2f, %00, app.js.map,
#      index.html, APP.JS, nested segment, doubled slash, trailing slash):
#      none may answer 200 with asset bytes — each is 400/404, and every
#      404 body carries the not_found envelope;
#   8. browser-unavailable.txt — the console-messages capture cannot run
#      here; the file lists the uncovered browser cases and the static
#      nonce-matching + eval-gate substitutes;
#   9. summary.txt with every PASS line and the key numbers.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with three plugin jars: jhin.sessions, jhin.ui-kit and jhin.ui (the
# non-optional requires of jhin.ui — the t202–t206 bundle). jhin.security is
# deliberately absent: no bearer token is needed, no TlsProvider is
# registered and the listener speaks plain HTTP on http://localhost:18443
# (the kernel default 8443 is occupied by another service on the QA machine;
# the frozen kernel CLI has no --no-tls flag — plan section 9 allows the
# QA-only plain-HTTP mode in scripts).
#
# On any failure one line is appended to evidence/T207/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EVIDENCE="$ROOT/.sisyphus/evidence/T207"
APP_JS="plugins/ui-default/src/main/resources/web/app.js"
APP_CSS="plugins/ui-default/src/main/resources/web/app.css"
PORT=18443
BASE="http://localhost:$PORT"

mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/failures.txt" "$EVIDENCE/pass-lines.txt"

fail() {
    echo "FAIL: $*" | tee -a "$EVIDENCE/failures.txt" >&2
    exit 1
}

ok() {
    echo "-- OK: $*"
    echo "-- OK: $*" >> "$EVIDENCE/pass-lines.txt"
}

kernel_pid=""
cleanup() {
    if [ -n "$kernel_pid" ] && kill -0 "$kernel_pid" 2>/dev/null; then
        kill "$kernel_pid" 2>/dev/null || true
        wait "$kernel_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# First response-header field of a curl -D- dump (status line is line 1).
status_of() {
    printf '%s\n' "$1" | head -n 1 | awk '{print $2}' || true
}

# Header value of a curl -D- dump, case-insensitive name, \r stripped.
hdr() {
    printf '%s\n' "$1" | tr -d '\r' | grep -i "^$2:" | head -n 1 \
        | sed 's/^[^:]*: *//' || true
}

# Media-type compare without optional whitespace: the embedded Tomcat
# re-serializes Content-Type through its MIME parser and drops the OWS
# after ';' on the wire ('application/javascript;charset=utf-8'), while the
# SDK-level header value and its unit tests use '...; charset=utf-8' —
# RFC 9110 makes the two byte-different strings the same media type
# (media-type = type "/" subtype *( OWS ";" OWS parameter )), so the QA
# compares the semantic value and records the raw wire string.
norm_ct() {
    printf '%s' "$1" | tr -d ' '
}

echo "== T207 QA: ETag asset routes and a nonce CSP for the web shell =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

# ------------------------------------------------------------------- build
echo "== Step 1: build the jars + run the four test gates =="
set +e
./gradlew --console=plain :kernel:bootJar \
    :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar \
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
    echo "T207 test gates — the four suites green with the T207 asset route:"
    grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
    echo ""
    echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (expected 430; AssetRouteTest, WebAssetBudgetTest, WebShellRouteTest)"
    echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests (expected 310)"
    echo "  :sdk:test                     $sdk_tests tests (expected 64)"
    echo "  :kernel:test                  $kernel_tests tests (expected 117; KernelPurityTest)"
    echo "  failures=$total_failures errors=$total_errors (expected 0/0)"
} > "$EVIDENCE/test-gates.txt"
for suite in ':jhin-plugin-ui-default:test' ':jhin-plugin-ui-kit:test' ':sdk:test' ':kernel:test'; do
    grep -qF "> Task $suite" "$EVIDENCE/build.log" \
        || fail "test suite $suite did not run (see $EVIDENCE/build.log)"
done
[ "$ui_default_tests" = "430" ] || fail "ui-default ran $ui_default_tests tests (expected 430)"
[ "$ui_kit_tests" = "310" ] || fail "ui-kit ran $ui_kit_tests tests (expected 310)"
[ "$sdk_tests" = "64" ] || fail "sdk ran $sdk_tests tests (expected 64)"
[ "$kernel_tests" = "117" ] || fail "kernel ran $kernel_tests tests (expected 117)"
[ "$total_failures" = "0" ] || fail "test failures=$total_failures (expected 0)"
[ "$total_errors" = "0" ] || fail "test errors=$total_errors (expected 0)"
ok "build + four test gates green (430/310/64/117; $EVIDENCE/test-gates.txt)"

# ----------------------------------------------------------- static gates
echo "== Step 2: static gates + budget.txt =="
js_bytes=$(wc -c < "$APP_JS" | tr -d ' ')
css_bytes=$(wc -c < "$APP_CSS" | tr -d ' ')
{
    echo "T207 static gates — the plan's hard rules on the shipped web assets."
    echo ""
} > "$EVIDENCE/static-gates.txt"

# 2a: no '<' in app.css (CSS must not smuggle markup).
lt_count=$(grep -c '<' "$APP_CSS" || true)
{
    echo "gate 2a — no '<' in app.css:"
    echo "  grep -c '<' $APP_CSS -> $lt_count (must be 0)"
} >> "$EVIDENCE/static-gates.txt"
[ "$lt_count" = "0" ] \
    || fail "app.css carries $lt_count '<' occurrences (must be 0)"

# 2b: app.js size budget (60 kB decimal; actual 59970).
{
    echo "gate 2b — app.js size (<= 60000 bytes):"
    echo "  wc -c $APP_JS -> $js_bytes bytes (must be <= 60000)"
} >> "$EVIDENCE/static-gates.txt"
[ "$js_bytes" -le 60000 ] \
    || fail "app.js is $js_bytes bytes (must be <= 60000)"

# 2c: app.css size budget (40 kB decimal; actual 35229).
{
    echo "gate 2c — app.css size (<= 40000 bytes):"
    echo "  wc -c $APP_CSS -> $css_bytes bytes (must be <= 40000)"
} >> "$EVIDENCE/static-gates.txt"
[ "$css_bytes" -le 40000 ] \
    || fail "app.css is $css_bytes bytes (must be <= 40000)"
ok "static gates green (0 '<' in app.css, app.js $js_bytes B <= 60000, app.css $css_bytes B <= 40000)"

# --------------------------------------------------------- budget evidence
echo "== Step 2b: budget.txt — actuals + the WebAssetBudgetTest result lines =="
budget_xml="plugins/ui-default/build/test-results/test/TEST-com.astroreen.jhin.plugin.ui.WebAssetBudgetTest.xml"
[ -f "$budget_xml" ] \
    || fail "no $budget_xml (did :jhin-plugin-ui-default:test run WebAssetBudgetTest?)"
suite_line=$(grep -o '<testsuite[^>]*>' "$budget_xml" | head -n 1)
case_lines=$(grep -o '<testcase[^>]*>' "$budget_xml" || true)
case_count=$(printf '%s\n' "$case_lines" | grep -c '<testcase' || true)
{
    echo "T207 payload budgets — the shipped web assets stay under their ceilings."
    echo ""
    echo "  app.js   $js_bytes bytes   ceiling 60000   ($js_bytes <= 60000)   PASS"
    echo "  app.css  $css_bytes bytes   ceiling 40000   ($css_bytes <= 40000)   PASS"
    echo ""
    echo "WebAssetBudgetTest result lines — this run's JUnit XML of"
    echo ":jhin-plugin-ui-default:test ($budget_xml):"
    echo "  $suite_line"
    printf '%s\n' "$case_lines" | sed 's/^/  /'
    echo ""
    echo "  test cases recorded: $case_count (expected 2)"
    echo ""
    echo "the suite asserts the class-path bytes of this plugin — the same"
    echo "resources AssetRoute serves — not a copy (WebAssetBudgetTest)."
} > "$EVIDENCE/budget.txt"
[ "$case_count" = "2" ] \
    || fail "WebAssetBudgetTest recorded $case_count test cases (expected 2)"
grep -q 'failures="0"' "$budget_xml" \
    || fail "WebAssetBudgetTest XML does not report failures=\"0\""
ok "budget.txt written (app.js $js_bytes / 60000, app.css $css_bytes / 40000; WebAssetBudgetTest $case_count cases, failures=0)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (jhin.sessions + jhin.ui-kit + jhin.ui) =="
home=$(mktemp -d /tmp/t207-home.XXXXXX)
bundled=$(mktemp -d /tmp/t207-bundled.XXXXXX)
cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$bundled/"
cp plugins/ui-kit/build/libs/jhin-plugin-ui-kit-*.jar "$bundled/"
cp plugins/ui-default/build/libs/jhin-plugin-ui-default-*.jar "$bundled/"
jar_count=$(ls "$bundled"/*.jar 2>/dev/null | wc -l | tr -d ' ')
[ "$jar_count" = "3" ] || fail "expected 3 plugin jars in $bundled, got $jar_count"
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
    echo "plugins=jhin.sessions, jhin.ui-kit, jhin.ui"
    echo "plugin-reason=jhin.sessions + jhin.ui-kit + jhin.ui are the non-optional requires"
    echo "              of jhin.ui (the t202–t206 QA bundle). T207 serves the shell and its"
    echo "              two static payloads and drives no LLM run, so the t205 streaming"
    echo "              additions (jhin.llm, jhin.agent, jhin.qa-mock-llm) are deliberately"
    echo "              absent and no bearer token is used anywhere."
    echo "client-header=none sent: a fresh browser sends no X-Jhin-Client on GET / and the"
    echo "               asset fetches (only /_jhin/bootstrap and /ui/screen|action"
    echo "               negotiate; those routes are not probed here)"
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding ($EVIDENCE/kernel-env.txt)"

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
ok "kernel up on $BASE (pid $kernel_pid), GET /_jhin/health -> 200 in $(( $(date +%s) - start )) s"

# ---------------------------------------------------------------- headers
echo "== Step 5: headers.txt — GET /ui/assets/app.js, app.css and / =="
js_dump=$(curl -s --max-time 10 -D- -o /dev/null "$BASE/ui/assets/app.js") \
    || fail "GET /ui/assets/app.js: curl failed"
css_dump=$(curl -s --max-time 10 -D- -o /dev/null "$BASE/ui/assets/app.css") \
    || fail "GET /ui/assets/app.css: curl failed"
shell_dump=$(curl -s --max-time 10 -D- -o /dev/null "$BASE/") \
    || fail "GET /: curl failed"

js_status=$(status_of "$js_dump")
css_status=$(status_of "$css_dump")
shell_status=$(status_of "$shell_dump")
js_type=$(hdr "$js_dump" content-type)
css_type=$(hdr "$css_dump" content-type)
shell_type=$(hdr "$shell_dump" content-type)
js_etag=$(hdr "$js_dump" etag)
css_etag=$(hdr "$css_dump" etag)
js_cc=$(hdr "$js_dump" cache-control)
css_cc=$(hdr "$css_dump" cache-control)
js_csp=$(hdr "$js_dump" content-security-policy)
css_csp=$(hdr "$css_dump" content-security-policy)
shell_csp=$(hdr "$shell_dump" content-security-policy)
{
    echo "T207 web headers — GET /ui/assets/app.js, GET /ui/assets/app.css, GET /"
    echo "(curl -sD- -o /dev/null, no X-Jhin-Client — the browser first-load path)."
    echo ""
    echo "=== GET /ui/assets/app.js ==="
    printf '%s\n' "$js_dump"
    echo ""
    echo "=== GET /ui/assets/app.css ==="
    printf '%s\n' "$css_dump"
    echo ""
    echo "=== GET / ==="
    printf '%s\n' "$shell_dump"
    echo ""
    echo "asserts:"
    echo "  app.js  status $js_status (200)  content-type '$js_type' (raw wire)"
    echo "          etag $js_etag  cache-control '$js_cc'  csp present: $([ -n "$js_csp" ] && echo yes || echo no)"
    echo "  app.css status $css_status (200)  content-type '$css_type' (raw wire)"
    echo "          etag $css_etag  cache-control '$css_cc'  csp present: $([ -n "$css_csp" ] && echo yes || echo no)"
    echo "  /       status $shell_status (200)  content-type '$shell_type' (raw wire)"
    echo "          etag '$(hdr "$shell_dump" etag)' (absent on the per-response document)"
    echo "          cache-control '$(hdr "$shell_dump" cache-control)' (absent)"
    echo "          csp present: $([ -n "$shell_csp" ] && echo yes || echo no)"
    echo ""
    echo "content-type comparison is OWS-tolerant (norm_ct strips the optional"
    echo "whitespace): the embedded Tomcat re-serializes Content-Type through its"
    echo "MIME parser and drops the space after ';' on the wire, so the raw value"
    echo "above reads '...;charset=utf-8' while the SDK-level header (and its unit"
    echo "tests) is '...; charset=utf-8' — RFC 9110 equal media types."
} > "$EVIDENCE/headers.txt"
[ "$js_status" = "200" ] || fail "GET /ui/assets/app.js answered $js_status (expected 200)"
[ "$(norm_ct "$js_type")" = "application/javascript;charset=utf-8" ] \
    || fail "app.js Content-Type is '$js_type' (expected application/javascript; charset=utf-8)"
[ "$js_cc" = "no-cache" ] \
    || fail "app.js Cache-Control is '$js_cc' (expected no-cache)"
printf '%s' "$js_etag" | grep -qE '^"sha256-[0-9a-f]{64}"$' \
    || fail "app.js ETag is $js_etag (expected \"sha256-[0-9a-f]{64}\")"
[ -n "$js_csp" ] || fail "app.js response carries no Content-Security-Policy"
[ "$css_status" = "200" ] || fail "GET /ui/assets/app.css answered $css_status (expected 200)"
[ "$(norm_ct "$css_type")" = "text/css;charset=utf-8" ] \
    || fail "app.css Content-Type is '$css_type' (expected text/css; charset=utf-8)"
[ "$css_cc" = "no-cache" ] \
    || fail "app.css Cache-Control is '$css_cc' (expected no-cache)"
printf '%s' "$css_etag" | grep -qE '^"sha256-[0-9a-f]{64}"$' \
    || fail "app.css ETag is $css_etag (expected \"sha256-[0-9a-f]{64}\")"
[ -n "$css_csp" ] || fail "app.css response carries no Content-Security-Policy"
[ "$shell_status" = "200" ] || fail "GET / answered $shell_status (expected 200)"
[ "$(norm_ct "$shell_type")" = "text/html;charset=utf-8" ] \
    || fail "GET / Content-Type is '$shell_type' (expected text/html; charset=utf-8)"
[ -n "$shell_csp" ] || fail "GET / carries no Content-Security-Policy"
ok "headers green (app.js $js_type + $js_etag + no-cache; app.css $css_type + $css_etag + no-cache; / text/html + CSP)"

# --------------------------------------------------------------- etag-304
echo "== Step 6: etag-304.txt — If-None-Match revalidation =="
tmp=$(mktemp -d /tmp/t207-tmp.XXXXXX)
probe() {
    # probe <path> <if-none-match|->  -> sets probe_code / probe_hdr / probe_body
    local path=$1 inm=$2
    probe_hdr="$tmp/hdr"
    probe_body="$tmp/body"
    # curl -o creates the body file only when bytes are written; a 304 has
    # none, so pre-create both files (an empty body file then correctly
    # reads as 0 bytes).
    : > "$probe_hdr"
    : > "$probe_body"
    # --path-as-is: dot segments and doubled slashes must reach the
    # connector verbatim, not be squashed client-side by curl.
    if [ "$inm" = "-" ]; then
        probe_code=$(curl -s --path-as-is --max-time 10 -D "$probe_hdr" -o "$probe_body" \
            -w '%{http_code}' "$BASE$path") || fail "GET $path: curl failed"
    else
        probe_code=$(curl -s --path-as-is --max-time 10 -D "$probe_hdr" -o "$probe_body" \
            -w '%{http_code}' -H "If-None-Match: $inm" "$BASE$path") \
            || fail "GET $path (If-None-Match): curl failed"
    fi
}

etag_dump=$(curl -s --max-time 10 -D- -o /dev/null "$BASE/ui/assets/app.js") \
    || fail "GET /ui/assets/app.js (etag capture): curl failed"
etag=$(hdr "$etag_dump" etag)
[ -n "$etag" ] || fail "the 200 carried no ETag"
{
    echo "T207 ETag revalidation — GET /ui/assets/app.js through If-None-Match."
    echo ""
    echo "etag captured from the 200: $etag"
    echo ""
} > "$EVIDENCE/etag-304.txt"

# 6a: the exact tag -> 304, empty body, tag echoed.
probe /ui/assets/app.js "$etag"
exact_code=$probe_code
exact_hdr=$(cat "$probe_hdr")
exact_body_bytes=$(wc -c < "$probe_body" | tr -d ' ')
exact_etag=$(hdr "$exact_hdr" etag)
{
    echo "case 6a — If-None-Match: $etag (exact tag)"
    echo "  status: $exact_code (expected 304)"
    echo "  body:   $exact_body_bytes bytes (expected 0)"
    echo "  etag echoed: $exact_etag (expected $etag)"
    printf '%s\n' "$exact_hdr" | sed 's/\r$//;s/^/  | /'
    echo ""
} >> "$EVIDENCE/etag-304.txt"
[ "$exact_code" = "304" ] || fail "exact If-None-Match answered $exact_code (expected 304)"
[ "$exact_body_bytes" = "0" ] || fail "304 body is $exact_body_bytes bytes (expected 0)"
[ "$exact_etag" = "$etag" ] || fail "304 echoed etag $exact_etag (expected $etag)"

# 6b: the wildcard -> 304.
probe /ui/assets/app.js '*'
wild_code=$probe_code
wild_hdr=$(cat "$probe_hdr")
wild_body_bytes=$(wc -c < "$probe_body" | tr -d ' ')
{
    echo "case 6b — If-None-Match: * (wildcard)"
    echo "  status: $wild_code (expected 304)"
    echo "  body:   $wild_body_bytes bytes (expected 0)"
    printf '%s\n' "$wild_hdr" | sed 's/\r$//;s/^/  | /'
    echo ""
} >> "$EVIDENCE/etag-304.txt"
[ "$wild_code" = "304" ] || fail "If-None-Match: * answered $wild_code (expected 304)"
[ "$wild_body_bytes" = "0" ] || fail "wildcard 304 body is $wild_body_bytes bytes (expected 0)"

# 6c: a mismatching tag -> 200 full body.
zeros=$(printf '%064d' 0)
mismatch="\"sha256-$zeros\""
probe /ui/assets/app.js "$mismatch"
miss_code=$probe_code
miss_body_bytes=$(wc -c < "$probe_body" | tr -d ' ')
{
    echo "case 6c — If-None-Match: $mismatch (mismatch)"
    echo "  status: $miss_code (expected 200)"
    echo "  body:   $miss_body_bytes bytes (expected $js_bytes — the full payload)"
    echo ""
} >> "$EVIDENCE/etag-304.txt"
[ "$miss_code" = "200" ] || fail "mismatching If-None-Match answered $miss_code (expected 200)"
[ "$miss_body_bytes" = "$js_bytes" ] \
    || fail "mismatching tag body is $miss_body_bytes bytes (expected $js_bytes)"

# 6d/6e: the RFC 9110 weak-compare forms (beyond the plan's three cases —
# the stated If-None-Match behaviour: W/ prefix ignored, comma lists).
probe /ui/assets/app.js "W/$etag"
weak_code=$probe_code
probe /ui/assets/app.js "\"deadbeef\", $etag"
list_code=$probe_code
{
    echo "case 6d — If-None-Match: W/$etag (weak prefix, weak comparison)"
    echo "  status: $weak_code (expected 304)"
    echo ""
    echo "case 6e — If-None-Match: \"deadbeef\", $etag (comma list, second entry matches)"
    echo "  status: $list_code (expected 304)"
    echo ""
    echo "note: 6d/6e probe the RFC 9110 weak-compare forms the route documents;"
    echo "the plan's hard cases are 6a-6c."
} >> "$EVIDENCE/etag-304.txt"
[ "$weak_code" = "304" ] || fail "weak-prefix If-None-Match answered $weak_code (expected 304)"
[ "$list_code" = "304" ] || fail "comma-list If-None-Match answered $list_code (expected 304)"
ok "If-None-Match green (exact -> 304 empty + etag echoed, * -> 304, mismatch -> 200 $js_bytes B; W/ and list -> 304)"

# -------------------------------------------------------------- csp-clean
echo "== Step 7: csp-clean.txt — the shell CSP + nonce matching =="
shell1_dump=$(curl -s --max-time 10 -D- -o "$EVIDENCE/shell1.html" "$BASE/") \
    || fail "GET / (1st): curl failed"
shell2_dump=$(curl -s --max-time 10 -D- -o "$EVIDENCE/shell2.html" "$BASE/") \
    || fail "GET / (2nd): curl failed"
csp1=$(hdr "$shell1_dump" content-security-policy)
csp2=$(hdr "$shell2_dump" content-security-policy)
csp1_count=$(printf '%s\n' "$shell1_dump" | grep -ic '^content-security-policy:' || true)
nonce1=$(printf '%s' "$csp1" | sed -n "s/.*'nonce-\([^']*\)'.*/\1/p")
nonce2=$(printf '%s' "$csp2" | sed -n "s/.*'nonce-\([^']*\)'.*/\1/p")
expected_csp="default-src 'self'; script-src 'self' 'nonce-$nonce1'; style-src 'unsafe-inline' 'self'; object-src 'none'; base-uri 'none'"

style_tag=$(grep -o '<style id="jhin-token-css"[^>]*>' "$EVIDENCE/shell1.html" | head -n 1 || true)
script_tag=$(grep -o '<script src="/ui/assets/app.js"[^>]*>' "$EVIDENCE/shell1.html" | head -n 1 || true)
style_nonce=$(printf '%s' "$style_tag" | sed -n 's/.*nonce="\([^"]*\)".*/\1/p')
script_nonce=$(printf '%s' "$script_tag" | sed -n 's/.*nonce="\([^"]*\)".*/\1/p')
link_hits=$(grep -cF '<link rel="stylesheet" href="/ui/assets/app.css">' "$EVIDENCE/shell1.html" || true)
script_src_hits=$(grep -cF '<script src="/ui/assets/app.js"' "$EVIDENCE/shell1.html" || true)
fetch_hits=$(grep -c 'jhinFetch' "$EVIDENCE/shell1.html" || true)
placeholder_hits=$(grep -c '__JHIN_' "$EVIDENCE/shell1.html" || true)
eval_hits=$(grep -c 'eval\|new Function' "$APP_JS" || true)

# Every <style>/<script> element of the served shell must carry the CSP nonce.
tag_lines=$(grep -o '<style[^>]*>\|<script[^>]*>' "$EVIDENCE/shell1.html" || true)
tag_count=$(printf '%s\n' "$tag_lines" | grep -c '<' || true)
tag_bad=0
tag_bad_list=""
while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    case "$tag" in
        *"nonce=\"$nonce1\""*) ;;
        *)
            tag_bad=$((tag_bad + 1))
            tag_bad_list="$tag_bad_list
    $tag"
            ;;
    esac
done <<< "$tag_lines"

{
    echo "T207 CSP + nonce — the served shell document (GET /, production linked mode)."
    echo ""
    echo "csp header (1st response, $csp1_count header line(s), expected 1):"
    echo "  $csp1"
    echo "csp header (2nd response):"
    echo "  $csp2"
    echo ""
    echo "exact directive set (reconstructed from the extracted nonce and compared"
    echo "byte-for-byte with the header — proves no extra/missing directive):"
    echo "  expected: $expected_csp"
    echo "  match:    $([ "$csp1" = "$expected_csp" ] && echo yes || echo no)"
    echo ""
    echo "nonce matching (X = $nonce1):"
    echo "  <style id=\"jhin-token-css\" …> element:   '$style_tag'"
    echo "    its nonce: '$style_nonce'  == X: $([ "$style_nonce" = "$nonce1" ] && echo yes || echo no)"
    echo "  <script src=\"/ui/assets/app.js\" …> tag: '$script_tag'"
    echo "    its nonce: '$script_nonce'  == X: $([ "$script_nonce" = "$nonce1" ] && echo yes || echo no)"
    echo "  every <style>/<script> element carries nonce=\"X\":"
    echo "    elements: $tag_count, missing/wrong nonce: $tag_bad$tag_bad_list"
    echo ""
    echo "per-response freshness:"
    echo "  2nd response nonce: $nonce2"
    echo "  1st != 2nd:         $([ -n "$nonce1" ] && [ "$nonce1" != "$nonce2" ] && echo yes || echo no)"
    echo ""
    echo "production linked mode (no inlined payloads):"
    echo "  <link rel=\"stylesheet\" href=\"/ui/assets/app.css\"> occurrences: $link_hits (expected 1)"
    echo "  <script src=\"/ui/assets/app.js\" occurrences:                 $script_src_hits (expected 1)"
    echo "  jhinFetch occurrences in the body (inlined app.js):            $fetch_hits (expected 0)"
    echo "  __JHIN_ placeholder leftovers:                                 $placeholder_hits (expected 0)"
    echo ""
    echo "static substitute for the browser console capture (browser-unavailable.txt):"
    echo "  grep -c 'eval\\|new Function' $APP_JS -> $eval_hits (must be 0)"
    echo "  (a CSP-violating console would complain about nonce-less inline elements"
    echo "  and eval-based sources; the nonce match above and this gate prove both"
    echo "  classes away statically on the served bytes)"
} > "$EVIDENCE/csp-clean.txt"
[ "$csp1_count" = "1" ] || fail "GET / carries $csp1_count Content-Security-Policy headers (expected 1)"
[ -n "$nonce1" ] || fail "no 'nonce-…' source in the CSP: $csp1"
[ "$csp1" = "$expected_csp" ] \
    || fail "CSP directive set mismatch: got [$csp1] expected [$expected_csp]"
[ -n "$style_nonce" ] || fail "no <style id=\"jhin-token-css\" nonce=…> in the served shell"
[ "$style_nonce" = "$nonce1" ] \
    || fail "token style nonce '$style_nonce' != CSP nonce '$nonce1'"
[ -n "$script_nonce" ] || fail "no <script src=\"/ui/assets/app.js\" …nonce=…> in the served shell"
[ "$script_nonce" = "$nonce1" ] \
    || fail "app script nonce '$script_nonce' != CSP nonce '$nonce1'"
[ "$tag_bad" = "0" ] \
    || fail "$tag_bad <style>/<script> element(s) without the CSP nonce:$tag_bad_list"
[ -n "$nonce2" ] || fail "no nonce in the 2nd response's CSP: $csp2"
[ "$nonce1" != "$nonce2" ] || fail "per-response nonce was reused across two responses"
[ "$link_hits" = "1" ] \
    || fail "served shell carries $link_hits <link …app.css> (expected 1)"
[ "$script_src_hits" = "1" ] \
    || fail "served shell carries $script_src_hits <script src=…app.js> (expected 1)"
[ "$fetch_hits" = "0" ] \
    || fail "served shell inlines the jhinFetch payload ($fetch_hits hits — production links app.js)"
[ "$placeholder_hits" = "0" ] \
    || fail "served shell carries $placeholder_hits leftover __JHIN_ placeholders"
[ "$eval_hits" = "0" ] \
    || fail "app.js carries $eval_hits eval/new Function occurrences (expected 0)"
ok "CSP clean (exact directive set; nonce $nonce1 shared by script+style, 2nd response $nonce2 differs; linked mode; 0 eval)"

# ---------------------------------------------------------- path traversal
echo "== Step 8: path-traversal.txt — the full traversal matrix =="
{
    echo "T207 traversal matrix — GET through the live kernel (curl --path-as-is,"
    echo "so dot segments and doubled slashes reach the connector verbatim)."
    echo ""
    echo "hard rule: none of these may answer 200 with asset bytes (each is"
    echo "400/404/other non-200); 404 bodies must carry the not_found envelope."
    echo ""
} > "$EVIDENCE/path-traversal.txt"
trav_fail=0
trav() {
    local path=$1 note=$2
    local code body_bytes snippet
    probe "$path" "-"
    code=$probe_code
    body_bytes=$(wc -c < "$probe_body" | tr -d ' ')
    snippet=$(head -c 200 "$probe_body" | tr -d '\r' | tr '\n' ' ')
    {
        echo "GET $path"
        echo "  $note"
        echo "  status: $code  body: $body_bytes bytes"
        [ -n "$snippet" ] && echo "  body:   $snippet"
        echo ""
    } >> "$EVIDENCE/path-traversal.txt"
    if [ "$code" = "200" ]; then
        echo "FAIL: $path answered 200 (body $body_bytes bytes) — asset refused matrix broken" \
            | tee -a "$EVIDENCE/failures.txt" >&2
        trav_fail=1
        return 0
    fi
    if [ "$code" = "404" ]; then
        if ! grep -q '"error":"not_found"' "$probe_body"; then
            echo "FAIL: $path answered 404 without the not_found envelope: $snippet" \
                | tee -a "$EVIDENCE/failures.txt" >&2
            trav_fail=1
        fi
    fi
}
trav "/ui/assets/../app.js" "raw dot-segments: RouteMatcher sees 4 segments -> kernel 404 (Tomcat normalizes only its internal mapping, requestURI stays raw)"
trav "/ui/assets/..%2fapp.js" "encoded slash: Tomcat 400 pre-dispatch (T203 precedent)"
trav "/ui/assets/%2e%2e%2fapp.js" "fully encoded traversal: Tomcat 400 pre-dispatch"
trav "/ui/assets/app.js%00" "null byte: Tomcat 400 (suspicious URI) or handler 404"
trav "/ui/assets/app.js.map" "source-map probe -> handler 404"
trav "/ui/assets/index.html" "template name -> handler 404"
trav "/ui/assets/APP.JS" "case variant -> handler 404 (exact lowercase allowlist)"
trav "/ui/assets/x/app.js" "nested segment -> kernel 404 (4 segments)"
trav "/ui/assets//app.js" "doubled slash -> strict path check 404 (name matched, path mismatch)"
trav "/ui/assets/app.js/" "trailing slash -> strict path check 404 (name matched, path mismatch)"

# Positive control: the matrix is proven against a route that does serve.
probe /ui/assets/app.js "-"
ctrl_code=$probe_code
ctrl_bytes=$(wc -c < "$probe_body" | tr -d ' ')
{
    echo "control — GET /ui/assets/app.js (the allowlisted name)"
    echo "  status: $ctrl_code (expected 200)  body: $ctrl_bytes bytes (expected $js_bytes)"
    echo "  (positive control: the matrix above is not vacuously green)"
} >> "$EVIDENCE/path-traversal.txt"
[ "$trav_fail" = "0" ] || fail "traversal matrix violations (see $EVIDENCE/path-traversal.txt)"
[ "$ctrl_code" = "200" ] || fail "control GET /ui/assets/app.js answered $ctrl_code (expected 200)"
[ "$ctrl_bytes" = "$js_bytes" ] \
    || fail "control body is $ctrl_bytes bytes (expected $js_bytes)"
ok "traversal matrix green (10 probes, none 200; 404s carry not_found; control 200 $js_bytes B)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T207 browser steps — UNAVAILABLE in this environment.

Browser tooling (the agent browser / console-messages capture / evaluate)
cannot run on this QA machine; the T202–T206 precedent applies: every
browser step is recorded here and substituted with curl + static asserts.

Not executed (the plan's agent console-messages capture):
  - open GET / in a real engine and read the console for CSP violation
    reports: that a nonce-less inline script/style would be blocked AND
    reported, and that the served document produces zero such reports;
  - DevTools network evidence of the ETag revalidation (304 round-trips
    from the browser cache on reload);
  - visual rendering of the shell with the linked assets (FOUC-free load,
    token CSS applied, app.js booting the SDUI runtime).

Substituted (evidence of this run):
  - the CSP-violation class is proven away statically (csp-clean.txt):
    every <style>/<script> element of the served shell carries nonce="X"
    where X is the nonce of that response's own script-src directive — the
    exact condition a violating (nonce-less or wrong-nonce) inline element
    would fail, checked on the served bytes instead of in a console;
  - eval/new Function gate: 0 occurrences in app.js (csp-clean.txt) —
    no eval-based CSP violation source exists in the payload;
  - ETag/304 behaviour proven at the HTTP layer instead of in a browser
    cache (etag-304.txt: exact tag -> 304 empty + tag echoed, wildcard ->
    304, mismatch -> 200, plus the RFC 9110 weak-compare W/ and list
    forms).

Uncovered without a browser (accepted for this environment):
  - real engine CSP enforcement and the console reports themselves;
  - live nonce acceptance for the inline token style under the policy;
  - browser cache revalidation timing/UX (no-cache -> revalidate on
    reload) observed only as HTTP behaviour here;
  - the visual result of the linked-asset shell (layout, theme tokens).
EOF
ok "browser-unavailable.txt written (console capture substituted by nonce-match + eval gate)"

# ------------------------------------------------------------- summary
echo "== Step 9: summary.txt =="
cat > "$EVIDENCE/summary.txt" <<EOF
T207 QA: PASS — ETag asset routes and a nonce CSP for the web shell

PASS lines:
$(sed 's/^/  /' "$EVIDENCE/pass-lines.txt")

gates:
  build (bootJar + 3 plugin jars)                        green (build.log)
  :jhin-plugin-ui-default:test  $ui_default_tests tests                  green (AssetRouteTest, WebAssetBudgetTest)
  :jhin-plugin-ui-kit:test      $ui_kit_tests tests                  green
  :sdk:test                     $sdk_tests tests                   green
  :kernel:test                  $kernel_tests tests                  green (KernelPurityTest)
  failures / errors                                          $total_failures / $total_errors
  '<' in app.css                                          $lt_count (0)
  app.js bytes                                            $js_bytes (<= 60000)
  app.css bytes                                           $css_bytes (<= 40000)
  WebAssetBudgetTest                                      $case_count cases, failures=0 (budget.txt)

kernel:
  mode   plain HTTP on $BASE (no jhin.security -> no TlsProvider -> plain HTTP;
         port 18443 because 8443 is occupied on this machine)
  plugins jhin.sessions, jhin.ui-kit, jhin.ui (no mock LLM — T207 drives no run)
  client  no X-Jhin-Client sent (browser first-load path)

headers (headers.txt):
  GET /ui/assets/app.js   200  application/javascript; charset=utf-8
                            etag $js_etag, cache-control no-cache, CSP present
  GET /ui/assets/app.css  200  text/css; charset=utf-8
                            etag $css_etag, cache-control no-cache, CSP present
  GET /                   200  text/html; charset=utf-8, CSP present

etag (etag-304.txt):
  If-None-Match: $etag -> $exact_code, body $exact_body_bytes B, etag echoed
  If-None-Match: *  -> $wild_code
  If-None-Match: $mismatch -> $miss_code, body $miss_body_bytes B
  W/ prefix -> $weak_code;  comma list -> $list_code

csp (csp-clean.txt):
  directive set exact (5 directives, byte-for-byte)   yes
  nonce X=$nonce1 shared by <script src> + <style id="jhin-token-css">
  per-response freshness (1st != 2nd)                 $([ -n "$nonce1" ] && [ "$nonce1" != "$nonce2" ] && echo yes || echo no) (2nd: $nonce2)
  linked mode: 1 <link …app.css>, 1 <script src=…app.js>, 0 jhinFetch, 0 __JHIN_
  eval/new Function in app.js                         $eval_hits (0)

traversal (path-traversal.txt):
  10 matrix probes (raw .., ..%2f, %2e%2e%2f, %00, app.js.map, index.html,
  APP.JS, nested, doubled slash, trailing slash)       none 200
  404 bodies carry not_found                           yes
  control GET /ui/assets/app.js                        200, $ctrl_bytes B

browser: unavailable — browser-unavailable.txt lists the console-messages
         capture gap and the static substitutes (nonce-match of every
         style/script element against the CSP header, 0 eval in app.js).
evidence: $EVIDENCE
EOF
echo
echo "== T207 QA PASSED =="
echo "evidence: $EVIDENCE"
ls -1 "$EVIDENCE"
