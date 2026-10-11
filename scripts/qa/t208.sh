#!/usr/bin/env bash
# T208 QA — PWA manifest, service worker and offline shell (chunks 1+2).
#
# Proves, with a booted kernel, curl and static greps only (browser tools are
# UNAVAILABLE in this environment — the agent evaluate/SW-state capture and the
# offline.png screenshot cannot run here, so browser-unavailable.txt records
# the gap and nothing is fabricated in their place, the T202–T207 precedent):
#   1. build + test gates: the kernel boot jar and the three plugin jars
#      build and the four suites stay green with the T208 manifest/icon/
#      service-worker routes on the classpath — :jhin-plugin-ui-default:test
#      457 (ManifestRouteTest, ServiceWorkerRouteTest and the T207
#      WebShellRouteTest secure-context-guard cases among them),
#      :jhin-plugin-ui-kit:test 310, :sdk:test 64, :kernel:test 117
#      (KernelPurityTest must stay green); counts are summed from the JUnit
#      XML reports and asserted exactly;
#   2. static gates on the shipped assets: app.js == 59970 bytes (<= 60000,
#      unchanged since chunk 1), app.css == 35229 bytes (<= 40000, unchanged),
#      no '<' in app.css, 0 eval / new Function occurrences in app.js;
#   3. boot the kernel (plain HTTP port 18443, the 3-plugin bundle
#      jhin.sessions + jhin.ui-kit + jhin.ui — no mock LLM needed; the t207
#      pattern) and curl the PWA surface WITHOUT any X-Jhin-Client header (a
#      fresh browser sends none on the manifest, icon, worker and shell
#      fetches);
#   4. manifest asserts: GET /manifest.json -> 200 +
#      application/manifest+json (the RFC 2557 media type), parsed with jq
#      (the t205 precedent): name/short_name "Jhin", display "standalone",
#      theme_color/background_color match #rrggbb, icons[] references
#      /ui/icons/icon-192.png (192x192) and /ui/icons/icon-512.png
#      (512x512) as image/png; the fixed identity fields id/start_url/scope
#      "/" are recorded and asserted too (route javadoc); headers + field
#      results in manifest-checks.txt, the body copy in manifest.json;
#   5. icons.txt — GET /ui/icons/icon-192.png and /ui/icons/icon-512.png:
#      200 + image/png + strong ETag "sha256-<hex>", the PNG magic bytes
#      \x89PNG\x0d\x0a\x1a\x0a of the SERVED body and the IHDR pixel size
#      (bytes 17..24 big-endian width/height — the od one-liner byte check,
#      honest evidence of the real 192x192 / 512x512 payloads) plus file(1)
#      and the AssetRoute ETag discipline on an extra If-None-Match probe
#      (304, empty body, tag echoed); unknown icon /ui/icons/icon-384.png ->
#      404 with the not_found envelope and traversal /ui/icons/../app.js
#      (curl --path-as-is) -> non-200;
#   6. sw.js.txt + sw-checks.txt — GET /sw.js -> 200 +
#      application/javascript; charset=utf-8 + Cache-Control: no-cache and
#      NO Content-Security-Policy (worker fetch is outside page CSP —
#      documented in ServiceWorkerRoute); the served body carries the
#      jhin-shell-v1 cache name, install precache (/ + /ui/assets/app.js +
#      /ui/assets/app.css), activate stale-cache cleanup + self.skipWaiting()
#      + self.clients.claim(), the cache-first marker for /ui/assets/, the
#      network-first marker for / (cached-shell fallback), all four
#      never-cache prefixes (/_jhin/bootstrap, /ui/screen/, /ui/action/,
#      /ui/stream — passthrough fetch, no cache.put), GET+same-origin gating
#      and zero eval(/new Function( constructs;
#   7. insecure-skip.txt — from GET /: the SW registration snippet extracted
#      verbatim, asserting navigator.serviceWorker.register("/sw.js") +
#      window.isSecureContext and that the snippet nonce equals the CSP
#      header nonce of that same response (the T207 csp-clean reuse); the
#      file explains the silent-skip contract on insecure origins and the
#      loopback nuance of the Secure Contexts spec;
#   8. sw-registration-state.txt and offline.png are NOT produced (no
#      browser) — browser-unavailable.txt names the uncovered visual/runtime
#      cases and the substitutes (offline-strategy.txt carries the served
#      fetch-handler excerpts as the printable strategy contract);
#   9. beforeinstallprompt.txt — availability not observable here (no
#      browser), the client intentionally adds no listener (deliberate T208
#      decision); both facts stated, plan acceptance recorded as
#      "affordance unavailable, manifest valid";
#  10. summary.txt with every PASS line and the key numbers.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with three plugin jars: jhin.sessions, jhin.ui-kit and jhin.ui (the
# non-optional requires of jhin.ui — the t202–t207 bundle). jhin.security is
# deliberately absent: no bearer token is needed, no TlsProvider is
# registered and the listener speaks plain HTTP on http://localhost:18443
# (the kernel default 8443 is occupied by another service on the QA machine;
# the frozen kernel CLI has no --no-tls flag — plan section 9 allows the
# QA-only plain-HTTP mode in scripts).
#
# On any failure one line is appended to evidence/T208/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EVIDENCE="$ROOT/.sisyphus/evidence/T208"
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
# (the T207 compare, kept for the manifest and worker media types).
norm_ct() {
    printf '%s' "$1" | tr -d ' '
}

command -v jq >/dev/null 2>&1 \
    || fail "jq is required to parse the manifest (the t205 precedent) and is not on PATH"

tmp=$(mktemp -d /tmp/t208-tmp.XXXXXX)

# probe <path> <if-none-match|->  -> sets probe_code / probe_hdr / probe_body
probe() {
    local path=$1 inm=$2
    probe_hdr="$tmp/hdr"
    probe_body="$tmp/body"
    # curl -o creates the body file only when bytes are written; a 304 has
    # none, so pre-create both files (an empty body file then correctly
    # reads as 0 bytes).
    : > "$probe_hdr"
    : > "$probe_body"
    # --path-as-is: dot segments must reach the connector verbatim, not be
    # squashed client-side by curl.
    if [ "$inm" = "-" ]; then
        probe_code=$(curl -s --path-as-is --max-time 10 -D "$probe_hdr" -o "$probe_body" \
            -w '%{http_code}' "$BASE$path") || fail "GET $path: curl failed"
    else
        probe_code=$(curl -s --path-as-is --max-time 10 -D "$probe_hdr" -o "$probe_body" \
            -w '%{http_code}' -H "If-None-Match: $inm" "$BASE$path") \
            || fail "GET $path (If-None-Match): curl failed"
    fi
}

echo "== T208 QA: PWA manifest, service worker and offline shell =="
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
    echo "T208 test gates — the four suites green with the T208 manifest/icon/worker routes:"
    grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
    echo ""
    echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (expected 457; ManifestRouteTest, ServiceWorkerRouteTest, WebShellRouteTest)"
    echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests (expected 310)"
    echo "  :sdk:test                     $sdk_tests tests (expected 64)"
    echo "  :kernel:test                  $kernel_tests tests (expected 117; KernelPurityTest)"
    echo "  failures=$total_failures errors=$total_errors (expected 0/0)"
} > "$EVIDENCE/test-gates.txt"
for suite in ':jhin-plugin-ui-default:test' ':jhin-plugin-ui-kit:test' ':sdk:test' ':kernel:test'; do
    grep -qF "> Task $suite" "$EVIDENCE/build.log" \
        || fail "test suite $suite did not run (see $EVIDENCE/build.log)"
done
[ "$ui_default_tests" = "457" ] || fail "ui-default ran $ui_default_tests tests (expected 457)"
[ "$ui_kit_tests" = "310" ] || fail "ui-kit ran $ui_kit_tests tests (expected 310)"
[ "$sdk_tests" = "64" ] || fail "sdk ran $sdk_tests tests (expected 64)"
[ "$kernel_tests" = "117" ] || fail "kernel ran $kernel_tests tests (expected 117)"
[ "$total_failures" = "0" ] || fail "test failures=$total_failures (expected 0)"
[ "$total_errors" = "0" ] || fail "test errors=$total_errors (expected 0)"
ok "build + four test gates green (457/310/64/117; $EVIDENCE/test-gates.txt)"

# ----------------------------------------------------------- static gates
echo "== Step 2: static gates =="
js_bytes=$(wc -c < "$APP_JS" | tr -d ' ')
css_bytes=$(wc -c < "$APP_CSS" | tr -d ' ')
{
    echo "T208 static gates — the hard rules on the shipped web assets (unchanged by T208)."
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

# 2b: app.js size budget (60 kB decimal; actual 59970, unchanged since chunk 1).
{
    echo "gate 2b — app.js size (<= 60000 bytes, unchanged 59970):"
    echo "  wc -c $APP_JS -> $js_bytes bytes (must be 59970 and <= 60000)"
} >> "$EVIDENCE/static-gates.txt"
[ "$js_bytes" = "59970" ] \
    || fail "app.js is $js_bytes bytes (expected unchanged 59970)"
[ "$js_bytes" -le 60000 ] \
    || fail "app.js is $js_bytes bytes (must be <= 60000)"

# 2c: app.css size budget (40 kB decimal; actual 35229, unchanged since chunk 1).
{
    echo "gate 2c — app.css size (<= 40000 bytes, unchanged 35229):"
    echo "  wc -c $APP_CSS -> $css_bytes bytes (must be 35229 and <= 40000)"
} >> "$EVIDENCE/static-gates.txt"
[ "$css_bytes" = "35229" ] \
    || fail "app.css is $css_bytes bytes (expected unchanged 35229)"
[ "$css_bytes" -le 40000 ] \
    || fail "app.css is $css_bytes bytes (must be <= 40000)"

# 2d: no eval / new Function in app.js (same gate as T207, kept green).
eval_hits=$(grep -c 'eval\|new Function' "$APP_JS" || true)
{
    echo "gate 2d — no eval / new Function in app.js:"
    echo "  grep -c 'eval\\|new Function' $APP_JS -> $eval_hits (must be 0)"
} >> "$EVIDENCE/static-gates.txt"
[ "$eval_hits" = "0" ] \
    || fail "app.js carries $eval_hits eval/new Function occurrences (expected 0)"
ok "static gates green (0 '<' in app.css, app.js $js_bytes B == 59970 <= 60000, app.css $css_bytes B == 35229 <= 40000, 0 eval)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (jhin.sessions + jhin.ui-kit + jhin.ui) =="
home=$(mktemp -d /tmp/t208-home.XXXXXX)
bundled=$(mktemp -d /tmp/t208-bundled.XXXXXX)
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
    echo "              of jhin.ui (the t202–t207 QA bundle). T208 serves the manifest, its"
    echo "              two icons, the service worker and the shell and drives no LLM run,"
    echo "              so the t205 streaming additions (jhin.llm, jhin.agent,"
    echo "              jhin.qa-mock-llm) are deliberately absent and no bearer token is"
    echo "              used anywhere."
    echo "client-header=none sent: a fresh browser sends no X-Jhin-Client on the manifest,"
    echo "               icon, worker and shell fetches (only /_jhin/bootstrap and"
    echo "               /ui/screen|action negotiate; those routes are not probed here)"
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

# ---------------------------------------------------------------- manifest
echo "== Step 5: manifest.json + manifest-checks.txt =="
manifest_dump=$(curl -s --max-time 10 -D- -o "$EVIDENCE/manifest.json" "$BASE/manifest.json") \
    || fail "GET /manifest.json: curl failed"
manifest_status=$(status_of "$manifest_dump")
manifest_type=$(hdr "$manifest_dump" content-type)
manifest_cc=$(hdr "$manifest_dump" cache-control)
manifest_etag=$(hdr "$manifest_dump" etag)
manifest_bytes=$(wc -c < "$EVIDENCE/manifest.json" | tr -d ' ')

m_name=$(jq -r '.name' "$EVIDENCE/manifest.json")
m_short=$(jq -r '.short_name' "$EVIDENCE/manifest.json")
m_display=$(jq -r '.display' "$EVIDENCE/manifest.json")
m_theme=$(jq -r '.theme_color' "$EVIDENCE/manifest.json")
m_background=$(jq -r '.background_color' "$EVIDENCE/manifest.json")
m_id=$(jq -r '.id' "$EVIDENCE/manifest.json")
m_start=$(jq -r '.start_url' "$EVIDENCE/manifest.json")
m_scope=$(jq -r '.scope' "$EVIDENCE/manifest.json")
m_icon_192_src=$(jq -r '.icons[] | select(.sizes == "192x192") | .src' "$EVIDENCE/manifest.json")
m_icon_192_type=$(jq -r '.icons[] | select(.sizes == "192x192") | .type' "$EVIDENCE/manifest.json")
m_icon_512_src=$(jq -r '.icons[] | select(.sizes == "512x512") | .src' "$EVIDENCE/manifest.json")
m_icon_512_type=$(jq -r '.icons[] | select(.sizes == "512x512") | .type' "$EVIDENCE/manifest.json")
m_icon_count=$(jq -r '.icons | length' "$EVIDENCE/manifest.json")
{
    echo "T208 manifest — GET /manifest.json through the live kernel (no X-Jhin-Client)."
    echo ""
    echo "=== headers (curl -sD- -o manifest.json) ==="
    printf '%s\n' "$manifest_dump" | sed 's/\r$//'
    echo ""
    echo "body: manifest.json ($manifest_bytes bytes, jq-parsed below)"
    echo ""
    echo "asserts:"
    echo "  status            $manifest_status (expected 200)"
    echo "  content-type      '$manifest_type' (raw wire; expected application/manifest+json; charset=utf-8)"
    echo "  cache-control     '$manifest_cc' (expected no-cache; the manifest is settings-derived"
    echo "                    per request, so it carries no ETag — recorded etag: '${manifest_etag:-<absent>}')"
    echo "  name              '$m_name' (expected Jhin)"
    echo "  short_name        '$m_short' (expected Jhin)"
    echo "  display           '$m_display' (expected standalone)"
    echo "  theme_color       '$m_theme' (expected #[0-9a-f]{6})"
    echo "  background_color  '$m_background' (expected #[0-9a-f]{6})"
    echo "  icons             $m_icon_count entries"
    echo "    192x192  src '$m_icon_192_src' type '$m_icon_192_type'"
    echo "    512x512  src '$m_icon_512_src' type '$m_icon_512_type'"
    echo "  identity fields (route javadoc: fixed '/'):"
    echo "    id '$m_id'  start_url '$m_start'  scope '$m_scope'"
    echo ""
    echo "colors come from the BootstrapRoute theme pipeline per request"
    echo "(colors.accent -> theme_color, colors.background -> background_color,"
    echo "normalized to lowercase #rrggbb)."
} > "$EVIDENCE/manifest-checks.txt"
[ "$manifest_status" = "200" ] || fail "GET /manifest.json answered $manifest_status (expected 200)"
[ "$(norm_ct "$manifest_type")" = "application/manifest+json;charset=utf-8" ] \
    || fail "manifest Content-Type is '$manifest_type' (expected application/manifest+json; charset=utf-8)"
[ "$manifest_cc" = "no-cache" ] \
    || fail "manifest Cache-Control is '$manifest_cc' (expected no-cache)"
[ "$m_name" = "Jhin" ] || fail "manifest name is '$m_name' (expected Jhin)"
[ "$m_short" = "Jhin" ] || fail "manifest short_name is '$m_short' (expected Jhin)"
[ "$m_display" = "standalone" ] || fail "manifest display is '$m_display' (expected standalone)"
printf '%s' "$m_theme" | grep -qE '^#[0-9a-f]{6}$' \
    || fail "manifest theme_color is '$m_theme' (expected #rrggbb)"
printf '%s' "$m_background" | grep -qE '^#[0-9a-f]{6}$' \
    || fail "manifest background_color is '$m_background' (expected #rrggbb)"
[ "$m_icon_count" = "2" ] || fail "manifest carries $m_icon_count icons (expected 2)"
[ "$m_icon_192_src" = "/ui/icons/icon-192.png" ] \
    || fail "manifest 192x192 icon src is '$m_icon_192_src' (expected /ui/icons/icon-192.png)"
[ "$m_icon_192_type" = "image/png" ] \
    || fail "manifest 192x192 icon type is '$m_icon_192_type' (expected image/png)"
[ "$m_icon_512_src" = "/ui/icons/icon-512.png" ] \
    || fail "manifest 512x512 icon src is '$m_icon_512_src' (expected /ui/icons/icon-512.png)"
[ "$m_icon_512_type" = "image/png" ] \
    || fail "manifest 512x512 icon type is '$m_icon_512_type' (expected image/png)"
[ "$m_id" = "/" ] || fail "manifest id is '$m_id' (expected /)"
[ "$m_start" = "/" ] || fail "manifest start_url is '$m_start' (expected /)"
[ "$m_scope" = "/" ] || fail "manifest scope is '$m_scope' (expected /)"
ok "manifest green (application/manifest+json, Jhin/standalone, theme $m_theme, background $m_background, 2 icons at /ui/icons/{icon-192,icon-512}.png)"

# ------------------------------------------------------------------- icons
echo "== Step 6: icons.txt — served PNG bytes, IHDR sizes, ETag discipline =="
{
    echo "T208 icons — GET /ui/icons/{name} through the live kernel (curl, no client header)."
    echo ""
    echo "PNG magic: \x89PNG\r\n\x1a\n -> hex 89504e470d0a1a0a (checked on the SERVED body)."
    echo "IHDR pixel size: bytes 17..24 (1-indexed) of the file = width||height, each a"
    echo "big-endian u32 right after the 8-byte PNG signature and the IHDR length+type;"
    echo "the od one-liner reads those 8 bytes and bash converts the hex pairs (honest"
    echo "byte-level evidence, not a test-suite claim)."
    echo ""
} > "$EVIDENCE/icons.txt"

icon_ok=0
for icon_spec in "icon-192.png 192 192" "icon-512.png 512 512"; do
    set -- $icon_spec
    icon_name=$1 want_w=$2 want_h=$3
    probe "/ui/icons/$icon_name" "-"
    icon_code=$probe_code
    icon_hdr=$(cat "$probe_hdr")
    icon_type=$(hdr "$icon_hdr" content-type)
    icon_etag=$(hdr "$icon_hdr" etag)
    icon_cc=$(hdr "$icon_hdr" cache-control)
    icon_bytes=$(wc -c < "$probe_body" | tr -d ' ')
    icon_file=$(file -b "$probe_body" 2>/dev/null || echo "file(1) unavailable")
    icon_magic=$(od -An -tx1 -N8 "$probe_body" | tr -d ' \n')
    icon_ihdr=$(od -An -tx1 -j16 -N8 "$probe_body" | tr -d ' \n')
    icon_w=$((16#${icon_ihdr:0:8}))
    icon_h=$((16#${icon_ihdr:8:8}))
    {
        echo "=== GET /ui/icons/$icon_name ==="
        printf '%s\n' "$icon_hdr" | sed 's/\r$//;s/^/  | /'
        echo "  status:       $icon_code (expected 200)"
        echo "  content-type: '$icon_type' (raw wire; expected image/png)"
        echo "  etag:         $icon_etag (expected \"sha256-[0-9a-f]{64}\")"
        echo "  cache-control:'$icon_cc' (expected no-cache)"
        echo "  body:         $icon_bytes bytes"
        echo "  file(1):      $icon_file"
        echo "  png magic:    $icon_magic (expected 89504e470d0a1a0a)"
        echo "  ihdr bytes:   $icon_ihdr (bytes 17..24 hex)"
        echo "  ihdr size:    ${icon_w}x${icon_h} (expected ${want_w}x${want_h})"
        echo ""
    } >> "$EVIDENCE/icons.txt"
    [ "$icon_code" = "200" ] || fail "GET /ui/icons/$icon_name answered $icon_code (expected 200)"
    [ "$(norm_ct "$icon_type")" = "image/png" ] \
        || fail "$icon_name Content-Type is '$icon_type' (expected image/png)"
    printf '%s' "$icon_etag" | grep -qE '^"sha256-[0-9a-f]{64}"$' \
        || fail "$icon_name ETag is $icon_etag (expected \"sha256-[0-9a-f]{64}\")"
    [ "$icon_cc" = "no-cache" ] \
        || fail "$icon_name Cache-Control is '$icon_cc' (expected no-cache)"
    [ "$icon_magic" = "89504e470d0a1a0a" ] \
        || fail "$icon_name served bytes start with $icon_magic (expected PNG magic 89504e470d0a1a0a)"
    [ "$icon_w" = "$want_w" ] && [ "$icon_h" = "$want_h" ] \
        || fail "$icon_name IHDR size is ${icon_w}x${icon_h} (expected ${want_w}x${want_h})"
    icon_ok=$((icon_ok + 1))
done

# The AssetRoute ETag discipline on one extra icon revalidation (beyond the
# plan's header/magic/size asserts — the same extra-case habit as T207 6d/6e).
etag_dump=$(curl -s --max-time 10 -D- -o /dev/null "$BASE/ui/icons/icon-192.png") \
    || fail "GET /ui/icons/icon-192.png (etag capture): curl failed"
icon_etag=$(hdr "$etag_dump" etag)
probe "/ui/icons/icon-192.png" "$icon_etag"
icon_304_code=$probe_code
icon_304_hdr=$(cat "$probe_hdr")
icon_304_bytes=$(wc -c < "$probe_body" | tr -d ' ')
icon_304_etag=$(hdr "$icon_304_hdr" etag)
{
    echo "extra case — If-None-Match revalidation of the 192 icon (the AssetRoute discipline):"
    echo "  If-None-Match: $icon_etag"
    echo "  status: $icon_304_code (expected 304)  body: $icon_304_bytes bytes (expected 0)"
    echo "  etag echoed: $icon_304_etag"
    echo ""
} >> "$EVIDENCE/icons.txt"
[ "$icon_304_code" = "304" ] || fail "icon If-None-Match answered $icon_304_code (expected 304)"
[ "$icon_304_bytes" = "0" ] || fail "icon 304 body is $icon_304_bytes bytes (expected 0)"
[ "$icon_304_etag" = "$icon_etag" ] || fail "icon 304 echoed $icon_304_etag (expected $icon_etag)"

# Negative: an unknown allowlist name -> 404 not_found envelope.
probe "/ui/icons/icon-384.png" "-"
unk_code=$probe_code
unk_bytes=$(wc -c < "$probe_body" | tr -d ' ')
unk_snippet=$(head -c 200 "$probe_body" | tr -d '\r' | tr '\n' ' ')
{
    echo "negative 1 — GET /ui/icons/icon-384.png (outside the two-name allowlist):"
    echo "  status: $unk_code (expected 404)  body: $unk_bytes bytes"
    echo "  body:   $unk_snippet"
    echo ""
} >> "$EVIDENCE/icons.txt"
[ "$unk_code" = "404" ] || fail "unknown icon answered $unk_code (expected 404)"
grep -q '"error":"not_found"' "$probe_body" \
    || fail "unknown icon 404 carries no not_found envelope: $unk_snippet"

# Negative: traversal through the icon branch (raw dot segments reach the
# connector verbatim) -> non-200.
probe "/ui/icons/../app.js" "-"
trav_code=$probe_code
trav_bytes=$(wc -c < "$probe_body" | tr -d ' ')
trav_snippet=$(head -c 200 "$probe_body" | tr -d '\r' | tr '\n' ' ')
{
    echo "negative 2 — GET /ui/icons/../app.js (curl --path-as-is, raw dot segments):"
    echo "  status: $trav_code (must be non-200)  body: $trav_bytes bytes"
    echo "  body:   $trav_snippet"
    echo "  (the strict literal path check of handleIcon plus the kernel route match"
    echo "  refuse every traversal shape; same discipline as the AssetRoute matrix)"
    echo ""
} >> "$EVIDENCE/icons.txt"
[ "$trav_code" != "200" ] \
    || fail "icon traversal /ui/icons/../app.js answered 200 ($trav_bytes bytes)"
ok "icons green ($icon_ok PNGs served with magic + IHDR sizes + sha256 ETag, If-None-Match -> 304, unknown -> 404 not_found, traversal -> $trav_code)"

# ------------------------------------------------------- service worker
echo "== Step 7: sw.js.txt + sw-checks.txt =="
sw_dump=$(curl -s --max-time 10 -D- -o "$EVIDENCE/sw.js.txt" "$BASE/sw.js") \
    || fail "GET /sw.js: curl failed"
cp "$EVIDENCE/sw.js.txt" "$tmp/sw-body"
sw_status=$(status_of "$sw_dump")
sw_type=$(hdr "$sw_dump" content-type)
sw_cc=$(hdr "$sw_dump" cache-control)
sw_csp=$(hdr "$sw_dump" content-security-policy)
sw_bytes=$(wc -c < "$EVIDENCE/sw.js.txt" | tr -d ' ')

sw_has_cache_name=$(grep -c '"jhin-shell-v1"' "$EVIDENCE/sw.js.txt" || true)
sw_has_prefix=$(grep -c '"jhin-shell-"' "$EVIDENCE/sw.js.txt" || true)
sw_has_install=$(grep -c 'self.addEventListener("install"' "$EVIDENCE/sw.js.txt" || true)
sw_has_precache=$(grep -c 'cache.addAll(PRECACHE)' "$EVIDENCE/sw.js.txt" || true)
sw_has_activate=$(grep -c 'self.addEventListener("activate"' "$EVIDENCE/sw.js.txt" || true)
sw_has_cleanup=$(grep -c 'key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE' "$EVIDENCE/sw.js.txt" || true)
sw_has_delete=$(grep -c 'caches.delete(key)' "$EVIDENCE/sw.js.txt" || true)
sw_has_skip=$(grep -c 'self.skipWaiting()' "$EVIDENCE/sw.js.txt" || true)
sw_has_claim=$(grep -c 'self.clients.claim()' "$EVIDENCE/sw.js.txt" || true)
sw_has_cache_first=$(grep -c 'event.respondWith(cacheFirst(request))' "$EVIDENCE/sw.js.txt" || true)
sw_has_assets_marker=$(grep -c 'url.pathname.indexOf("/ui/assets/") === 0' "$EVIDENCE/sw.js.txt" || true)
sw_has_network_first=$(grep -c 'event.respondWith(networkFirst(request))' "$EVIDENCE/sw.js.txt" || true)
sw_has_root_marker=$(grep -c 'url.pathname === "/"' "$EVIDENCE/sw.js.txt" || true)
sw_has_offline_fallback=$(grep -c 'return caches.match(request);' "$EVIDENCE/sw.js.txt" || true)
sw_has_never_fn=$(grep -c 'function neverCache(path)' "$EVIDENCE/sw.js.txt" || true)
sw_has_never_dispatch=$(grep -c 'if (neverCache(url.pathname))' "$EVIDENCE/sw.js.txt" || true)
sw_has_never_passthrough=$(grep -c 'event.respondWith(fetch(request))' "$EVIDENCE/sw.js.txt" || true)
sw_never_list_ok=$(grep -c 'var NEVER_CACHE = \["/_jhin/bootstrap", "/ui/screen/", "/ui/action/", "/ui/stream"\];' "$EVIDENCE/sw.js.txt" || true)
sw_precache_list_ok=$(grep -c 'var PRECACHE = \["/", "/ui/assets/app.js", "/ui/assets/app.css"\];' "$EVIDENCE/sw.js.txt" || true)
sw_get_only=$(grep -c 'request.method !== "GET"' "$EVIDENCE/sw.js.txt" || true)
sw_same_origin=$(grep -c 'url.origin !== self.location.origin' "$EVIDENCE/sw.js.txt" || true)
sw_eval=$(grep -c 'eval(\|new Function(' "$EVIDENCE/sw.js.txt" || true)
{
    echo "T208 service worker — GET /sw.js through the live kernel (no X-Jhin-Client)."
    echo ""
    echo "=== headers (curl -sD- -o sw.js.txt) ==="
    printf '%s\n' "$sw_dump" | sed 's/\r$//'
    echo ""
    echo "body: sw.js.txt ($sw_bytes bytes — the verbatim served worker script)"
    echo ""
    echo "asserts on the served bytes:"
    echo "  status                 $sw_status (expected 200)"
    echo "  content-type           '$sw_type' (raw wire; expected application/javascript; charset=utf-8)"
    echo "  cache-control          '$sw_cc' (expected no-cache)"
    echo "  content-security-policy '$sw_csp' (must be ABSENT — the worker fetch is outside"
    echo "                          the page CSP context; documented in ServiceWorkerRoute)"
    echo "  cache name jhin-shell-v1        hits $sw_has_cache_name (>= 1)"
    echo "  stale prefix jhin-shell-        hits $sw_has_prefix (>= 1)"
    echo "  install listener                hits $sw_has_install (>= 1)"
    echo "  install precache addAll         hits $sw_has_precache (>= 1)"
    echo "  PRECACHE = / + app.js + app.css hits $sw_precache_list_ok (1)"
    echo "  activate listener               hits $sw_has_activate (>= 1)"
    echo "  stale-cache cleanup filter      hits $sw_has_cleanup (>= 1)"
    echo "  caches.delete(key)              hits $sw_has_delete (>= 1)"
    echo "  self.skipWaiting()              hits $sw_has_skip (>= 1)"
    echo "  self.clients.claim()            hits $sw_has_claim (>= 1)"
    echo "  cache-first marker /ui/assets/  hits $sw_has_assets_marker (>= 1)"
    echo "  cacheFirst dispatch             hits $sw_has_cache_first (>= 1)"
    echo "  network-first marker /          hits $sw_has_root_marker (>= 1)"
    echo "  networkFirst dispatch           hits $sw_has_network_first (>= 1)"
    echo "  offline fallback caches.match   hits $sw_has_offline_fallback (>= 1)"
    echo "  neverCache helper               hits $sw_has_never_fn (>= 1)"
    echo "  never-cache dispatch            hits $sw_has_never_dispatch (>= 1)"
    echo "  never-cache passthrough fetch   hits $sw_has_never_passthrough (>= 1)"
    echo "  NEVER_CACHE 4-prefix list       hits $sw_never_list_ok (1)"
    echo "  GET-only gate                   hits $sw_get_only (>= 1)"
    echo "  same-origin gate                hits $sw_same_origin (>= 1)"
    echo "  eval( / new Function(           hits $sw_eval (must be 0)"
} > "$EVIDENCE/sw-checks.txt"
[ "$sw_status" = "200" ] || fail "GET /sw.js answered $sw_status (expected 200)"
[ "$(norm_ct "$sw_type")" = "application/javascript;charset=utf-8" ] \
    || fail "sw.js Content-Type is '$sw_type' (expected application/javascript; charset=utf-8)"
[ "$sw_cc" = "no-cache" ] || fail "sw.js Cache-Control is '$sw_cc' (expected no-cache)"
[ -z "$sw_csp" ] || fail "sw.js carries a Content-Security-Policy ('$sw_csp') — worker fetch must stay outside page CSP"
[ "$sw_has_cache_name" -ge 1 ] || fail "sw.js carries no jhin-shell-v1 cache name"
[ "$sw_has_prefix" -ge 1 ] || fail "sw.js carries no jhin-shell- cleanup prefix"
[ "$sw_has_install" -ge 1 ] || fail "sw.js has no install listener"
[ "$sw_has_precache" -ge 1 ] || fail "sw.js install precaches nothing (no cache.addAll(PRECACHE))"
[ "$sw_precache_list_ok" = "1" ] \
    || fail "sw.js PRECACHE is not exactly / + /ui/assets/app.js + /ui/assets/app.css"
[ "$sw_has_activate" -ge 1 ] || fail "sw.js has no activate listener"
[ "$sw_has_cleanup" -ge 1 ] || fail "sw.js activate has no stale-cache filter"
[ "$sw_has_delete" -ge 1 ] || fail "sw.js activate deletes no caches"
[ "$sw_has_skip" -ge 1 ] || fail "sw.js activate calls no self.skipWaiting()"
[ "$sw_has_claim" -ge 1 ] || fail "sw.js activate calls no self.clients.claim()"
[ "$sw_has_assets_marker" -ge 1 ] || fail "sw.js has no cache-first marker for /ui/assets/"
[ "$sw_has_cache_first" -ge 1 ] || fail "sw.js never dispatches cacheFirst"
[ "$sw_has_root_marker" -ge 1 ] || fail "sw.js has no network-first marker for /"
[ "$sw_has_network_first" -ge 1 ] || fail "sw.js never dispatches networkFirst"
[ "$sw_has_offline_fallback" -ge 1 ] || fail "sw.js networkFirst has no cached-shell fallback"
[ "$sw_has_never_fn" -ge 1 ] || fail "sw.js has no neverCache helper"
[ "$sw_has_never_dispatch" -ge 1 ] || fail "sw.js fetch handler never consults neverCache"
[ "$sw_has_never_passthrough" -ge 1 ] || fail "sw.js never-cache path is not a fetch passthrough"
[ "$sw_never_list_ok" = "1" ] \
    || fail "sw.js NEVER_CACHE is not exactly /_jhin/bootstrap + /ui/screen/ + /ui/action/ + /ui/stream"
[ "$sw_get_only" -ge 1 ] || fail "sw.js fetch handler has no GET-only gate"
[ "$sw_same_origin" -ge 1 ] || fail "sw.js fetch handler has no same-origin gate"
[ "$sw_eval" = "0" ] || fail "sw.js carries $sw_eval eval(/new Function( occurrences (expected 0)"
ok "sw.js green ($sw_bytes B, application/javascript, no-cache, NO CSP; jhin-shell-v1 + precache + cleanup + skipWaiting/claim; cache-first assets / network-first / + 4 never-cache prefixes; 0 eval)"

# ------------------------------------------------- registration snippet
echo "== Step 8: insecure-skip.txt — the SW registration snippet =="
shell_dump=$(curl -s --max-time 10 -D- -o "$EVIDENCE/shell.html" "$BASE/") \
    || fail "GET /: curl failed"
shell_status=$(status_of "$shell_dump")
shell_csp=$(hdr "$shell_dump" content-security-policy)
shell_nonce=$(printf '%s' "$shell_csp" | sed -n "s/.*'nonce-\([^']*\)'.*/\1/p")
snippet=$(grep -o '<script nonce="[^"]*">if (window\.isSecureContext[^<]*</script>' "$EVIDENCE/shell.html" | head -n 1 || true)
snippet_count=$(grep -o '<script nonce="[^"]*">if (window\.isSecureContext[^<]*</script>' "$EVIDENCE/shell.html" | wc -l | tr -d ' ')
snippet_line=$(grep 'window\.isSecureContext' "$EVIDENCE/shell.html" | head -n 1 | sed 's/^[[:space:]]*//' || true)
snippet_nonce=$(printf '%s' "$snippet" | sed -n 's/.*<script nonce="\([^"]*\)".*/\1/p')
root_hits=$(grep -c 'id="jhin-root"' "$EVIDENCE/shell.html" || true)
{
    echo "T208 SW registration snippet — extracted verbatim from GET / (served shell)."
    echo ""
    echo "=== the app payload tag + the registration snippet, as served ==="
    echo "  $snippet_line"
    echo ""
    echo "=== registration snippet alone ==="
    echo "  $snippet"
    echo ""
    echo "asserts:"
    echo "  snippet occurrences in the document:        $snippet_count (expected 1 in the"
    echo "    served linked branch; the inline fallback branch carries the same"
    echo "    swSnippet(nonce) — covered by WebShellRouteTest."
    echo "    registersTheServiceWorkerWithASecureContextGuard /"
    echo "    theServiceWorkerSnippetCarriesTheResponseNonce, unit scope)"
    echo "  contains navigator.serviceWorker.register(\"/sw.js\"): $([ "$(printf '%s' "$snippet" | grep -cF 'navigator.serviceWorker.register("/sw.js")')" = "1" ] && echo yes || echo no)"
    echo "  contains window.isSecureContext:                          $([ "$(printf '%s' "$snippet" | grep -cF 'window.isSecureContext')" = "1" ] && echo yes || echo no)"
    echo "  snippet nonce:  '$snippet_nonce'"
    echo "  CSP header:     '$shell_csp'"
    echo "  CSP nonce:      '$shell_nonce'"
    echo "  snippet nonce == CSP nonce of the same response: $([ -n "$snippet_nonce" ] && [ "$snippet_nonce" = "$shell_nonce" ] && echo yes || echo no)"
    echo "  served shell carries id=\"jhin-root\": $root_hits hit(s) (the renderOffline paint target)"
    echo ""
    echo "=== why this file is named insecure-skip ==="
    echo "The guard is the first condition of the snippet: outside a secure context the"
    echo "register call is unreachable — the browser registers NOTHING and, by design,"
    echo "logs nothing (silent skip; the .catch(function () {}) keeps even a failed"
    echo "registration silent). That is the documented T208 trade-off: on an insecure"
    echo "origin (a plain-HTTP LAN address, or TLS with an untrusted self-signed cert —"
    echo "the deployment scenario of plan section 8) window.isSecureContext is false, the"
    echo "PWA affordances are skipped and the app keeps working as a normal web page."
    echo "Full PWA on a LAN needs a trusted cert (ACME or a Tailscale cert) — an ops"
    echo "decision, not code."
    echo ""
    echo "Plan clause mapping: 'an insecure origin must log the skip reason and register"
    echo "nothing'. Register-nothing is proven above statically (the register call is"
    echo "behind window.isSecureContext). The client deliberately does not log to the"
    echo "console (silent skip, per the T208 decision); this file IS the recorded skip"
    echo "reason."
    echo ""
    echo "Precision note on THIS QA origin: the kernel answers here as"
    echo "http://localhost:$PORT (plain HTTP, no jhin.security -> no TlsProvider). There"
    echo "is no browser in this environment, so the snippet is never executed here at"
    echo "all (browser-unavailable.txt) — the skip is proven on the served bytes. A"
    echo "browser pointed at a plain-HTTP non-loopback origin (the plan's LAN case)"
    echo "would evaluate window.isSecureContext === false and skip exactly as designed;"
    echo "note that modern browsers treat http://localhost (loopback) itself as a"
    echo "secure context (Secure Contexts spec, potentially-trustworthy origin), so on"
    echo "this exact QA URL a real browser would attempt the registration — silent"
    echo "either way thanks to the guard plus the empty catch. On a real https origin"
    echo "with a trusted cert the same snippet registers /sw.js."
} > "$EVIDENCE/insecure-skip.txt"
[ "$shell_status" = "200" ] || fail "GET / answered $shell_status (expected 200)"
[ -n "$snippet" ] || fail "the served shell carries no service-worker registration snippet"
[ "$(printf '%s' "$snippet" | grep -cF 'navigator.serviceWorker.register("/sw.js")')" = "1" ] \
    || fail "the registration snippet does not register /sw.js: $snippet"
[ "$(printf '%s' "$snippet" | grep -cF 'window.isSecureContext')" = "1" ] \
    || fail "the registration snippet is missing the window.isSecureContext guard: $snippet"
[ -n "$shell_nonce" ] || fail "the shell CSP carries no nonce: '$shell_csp'"
[ -n "$snippet_nonce" ] || fail "the registration snippet is not nonce'd: $snippet"
[ "$snippet_nonce" = "$shell_nonce" ] \
    || fail "registration snippet nonce '$snippet_nonce' != CSP nonce '$shell_nonce'"
ok "registration snippet green (guarded by window.isSecureContext, nonce $snippet_nonce == CSP nonce, silent-skip contract recorded in insecure-skip.txt)"

# -------------------------------------------- offline strategy + browser gap
echo "== Step 9: offline-strategy.txt + browser-unavailable.txt =="
{
    echo "T208 offline strategy — the served fetch-handler excerpts (printable substitute"
    echo "for the unavailable offline.png; nothing visual is fabricated)."
    echo ""
    echo "The strategy contract of /sw.js (verbatim from the served body — sw.js.txt"
    echo "holds the full script): cache name + precache set, then the fetch strategies."
    echo ""
} > "$EVIDENCE/offline-strategy.txt"
grep -E '^var CACHE =|^var CACHE_PREFIX =|^var PRECACHE =|^var NEVER_CACHE =' "$tmp/sw-body" \
    >> "$EVIDENCE/offline-strategy.txt" || true
{
    echo ""
} >> "$EVIDENCE/offline-strategy.txt"
sed -n '/^function neverCache/,$p' "$tmp/sw-body" >> "$EVIDENCE/offline-strategy.txt"
{
    echo ""
    echo "=== the offline render path, cross-referenced ==="
    echo "On an offline navigation the networkFirst branch falls back to"
    echo "caches.match(request) — the cached shell document (precache entry \"/\"). The"
    echo "shell carries the paint target and the runtime does the rest:"
    echo "  served shell: $(grep -o '<div id="jhin-root"></div>' "$EVIDENCE/shell.html" | head -n 1)"
    echo "  client runtime: app.js renderOffline() (module 5 of the T204 client runtime)"
    echo "    paints bootData.fallbacks.offline into #jhin-root when the bootstrap fetch"
    echo "    fails — the art is server-authored in the bootstrap payload, contract-tested"
    echo "    in unit scope (HtmlBootstrapRouteTest.fallbacksAreHtmlStrings,"
    echo "    BootstrapContractTest.screensAndFallbacksAreHtmlFragments: fallbacks.offline"
    echo "    is an HTML fragment carrying data-jhin-type=), and its paint target is"
    echo "    asserted by WebShellRouteTest.carriesTheClientRootInTheProductionBranch"
    echo "    (\"the offline art of module 5 (renderOffline) paints into this root\")."
    echo "What stays unproven here is only the visual result in a live engine"
    echo "(browser-unavailable.txt)."
} >> "$EVIDENCE/offline-strategy.txt"
ok "offline-strategy.txt written (fetch-handler excerpts + the renderOffline cross-references)"

cat > "$EVIDENCE/browser-unavailable.txt" <<EOF
T208 browser steps — UNAVAILABLE in this environment.

Browser tooling (the agent evaluate / SW registration state capture / offline
screenshot) cannot run on this QA machine; the T202–T207 precedent applies:
every browser step is recorded here and substituted with curl + static
asserts. Two planned artifacts were therefore NOT produced and nothing was
fabricated in their place:
  - sw-registration-state.txt — NOT produced. It would require a real
    engine's navigator.serviceWorker.getRegistration()/ready state after
    loading the shell (registered / installing / waiting / activated /
    controlling). No browser exists here, so no such state exists to record.
  - offline.png — NOT produced. It would require a real browser with the
    network cut, reloading the origin and painting the cached shell plus the
    fallbacks.offline art. Screenshotting anything else would be fake
    evidence.

Uncovered without a browser (accepted for this environment):
  - the actual service-worker lifecycle in a browser: install -> waiting ->
    activate -> controlling, and skipWaiting()/clients.claim() taking effect
    on live clients;
  - the offline cached-shell experience as a user hits it: cold start with
    the network down -> the cached "/" shell paints -> the bootstrap fetch
    fails -> renderOffline() replaces #jhin-root content with the
    fallbacks.offline art;
  - the fallbacks.offline art as seen by a user (layout, theme tokens, the
    refresh affordance);
  - the beforeinstallprompt affordance and any install flow
    (beforeinstallprompt.txt);
  - the registration snippet's console behaviour (silent skip on insecure
    origins, silent catch on failure) — only its source is provable here
    (insecure-skip.txt).

Substitutes of this run (evidence):
  - the worker behaviour contract is proven on the SERVED bytes
    (sw.js.txt / sw-checks.txt / offline-strategy.txt): jhin-shell-v1 cache
    name, install precaches "/" + /ui/assets/app.js + /ui/assets/app.css,
    activate deletes stale jhin-shell-* caches then self.skipWaiting() +
    self.clients.claim(), fetch is GET+same-origin only — cache-first for
    /ui/assets/*, network-first for "/" with caches.match as the offline
    fallback, and a fetch passthrough (no cache.put) for the never-cache
    prefixes /_jhin/bootstrap, /ui/screen/, /ui/action/ and /ui/stream;
  - the offline art path is unit-bracketed: renderOffline (app.js module 5,
    T204 client runtime scope) paints the server-authored fallbacks.offline
    fragment — asserted as HTML art by HtmlBootstrapRouteTest.
    fallbacksAreHtmlStrings and BootstrapContractTest.
    screensAndFallbacksAreHtmlFragments — into the root element asserted by
    WebShellRouteTest.carriesTheClientRootInTheProductionBranch; this run's
    served shell does carry id="jhin-root" (offline-strategy.txt);
  - the registration guard is proven statically on the served document:
    the snippet is present, nonce'd with the response CSP nonce and refuses
    to register outside a secure context (insecure-skip.txt).
EOF
ok "browser-unavailable.txt written (sw-registration-state.txt + offline.png honestly absent, substitutes listed)"

echo "== Step 10: beforeinstallprompt.txt =="
cat > "$EVIDENCE/beforeinstallprompt.txt" <<EOF
T208 beforeinstallprompt — availability report.

Fact 1 — availability in this environment: NOT OBSERVABLE. There are no
browser tools on this QA machine (the T202–T207 browser-unavailable
precedent), so no event can be observed, fired or not fired. The plan's
acceptance wording ("beforeinstallprompt fires on a secure origin") is a
browser-side observation and is therefore recorded here as the plan's own
escape clause: "affordance unavailable, manifest valid" — the manifest side
is proven (manifest-checks.txt: application/manifest+json, Jhin/standalone,
#rrggbb theme + background colors from the token pipeline, real 192x192 and
512x512 PNG icons on the /ui/icons/{name} allowlist).

Fact 2 — client behaviour: the web client intentionally adds NO
beforeinstallprompt listener. This is a deliberate T208 decision (documented
in the WebShellRoute class comment), not an omission: there is no browser
here to observe the event and no install UI exists in the client yet, so a
listener would only accumulate an event nobody consumes. A future install
affordance can add the listener then.

Observation (recorded, not a QA assert of the T208.4 plan): the served shell
document carries no <link rel="manifest" href="/manifest.json"> tag — the
manifest is served and validated at its URL (GET /manifest.json), but the
browser-side manifest association for the install flow is unobservable here
and was outside the chunk-1 scope; on a real browser the install affordance
would additionally need that link (or an equivalent association).

Plan reference (.sisyphus/plans/jhin-web-client-plan.md, T208 acceptance):
"T208 may record 'affordance unavailable, manifest valid' as the acceptance
instead of a fired event — report which." — Reported: affordance unavailable
(no browser tools in this environment), manifest valid (see above).
EOF
ok "beforeinstallprompt.txt written (availability: not observable; no listener by design; plan acceptance = affordance unavailable, manifest valid)"

# ------------------------------------------------------------- summary
echo "== Step 11: summary.txt =="
cat > "$EVIDENCE/summary.txt" <<EOF
T208 QA: PASS — PWA manifest, service worker and offline shell

PASS lines:
$(sed 's/^/  /' "$EVIDENCE/pass-lines.txt")

gates:
  build (bootJar + 3 plugin jars)                        green (build.log)
  :jhin-plugin-ui-default:test  $ui_default_tests tests                  green (ManifestRouteTest, ServiceWorkerRouteTest)
  :jhin-plugin-ui-kit:test      $ui_kit_tests tests                  green
  :sdk:test                     $sdk_tests tests                   green
  :kernel:test                  $kernel_tests tests                  green (KernelPurityTest)
  failures / errors                                          $total_failures / $total_errors
  '<' in app.css                                          $lt_count (0)
  app.js bytes                                            $js_bytes (== 59970 unchanged, <= 60000)
  app.css bytes                                           $css_bytes (== 35229 unchanged, <= 40000)
  eval/new Function in app.js                             $eval_hits (0)

kernel:
  mode   plain HTTP on $BASE (no jhin.security -> no TlsProvider -> plain HTTP;
         port 18443 because 8443 is occupied on this machine)
  plugins jhin.sessions, jhin.ui-kit, jhin.ui (no mock LLM — T208 drives no run)
  client  no X-Jhin-Client sent (fresh-browser first-load path)

manifest (manifest.json + manifest-checks.txt):
  GET /manifest.json   200  application/manifest+json; charset=utf-8, cache-control no-cache
  name/short_name      '$m_name' / '$m_short' (Jhin)
  display              $m_display
  theme_color          $m_theme  (#[0-9a-f]{6}, colors.accent via the BootstrapRoute theme pipeline)
  background_color     $m_background  (#[0-9a-f]{6}, colors.background, same pipeline)
  id/start_url/scope   '$m_id' / '$m_start' / '$m_scope' (fixed identity fields)
  icons                $m_icon_count entries: /ui/icons/icon-192.png 192x192 image/png,
                       /ui/icons/icon-512.png 512x512 image/png

icons (icons.txt):
  icon-192.png  200 image/png, etag "sha256-…", PNG magic 89504e470d0a1a0a, IHDR 192x192
  icon-512.png  200 image/png, etag "sha256-…", PNG magic 89504e470d0a1a0a, IHDR 512x512
  If-None-Match: $icon_etag -> $icon_304_code (empty body, tag echoed)
  /ui/icons/icon-384.png            -> $unk_code (not_found envelope)
  /ui/icons/../app.js (path-as-is)  -> $trav_code (non-200)

service worker (sw.js.txt + sw-checks.txt):
  GET /sw.js  200  application/javascript; charset=utf-8, cache-control no-cache
  no Content-Security-Policy on /sw.js                 $([ -z "$sw_csp" ] && echo yes || echo "NO — FAIL")
  cache name jhin-shell-v1 + stale jhin-shell- cleanup  yes
  install precache: / + /ui/assets/app.js + /ui/assets/app.css  yes
  activate: caches.delete(stale) + self.skipWaiting() + self.clients.claim()  yes
  cache-first  /ui/assets/*        (cacheFirst dispatch)  yes
  network-first /                  (networkFirst + caches.match fallback)  yes
  never-cache  /_jhin/bootstrap /ui/screen/ /ui/action/ /ui/stream (fetch passthrough)  yes
  GET-only + same-origin gates                        yes
  eval( / new Function( in sw.js                     $sw_eval (0)

registration snippet (insecure-skip.txt):
  snippet occurrences in the served shell             $snippet_count
  navigator.serviceWorker.register("/sw.js")          present
  window.isSecureContext guard                        present
  snippet nonce == CSP nonce of the same response     $([ -n "$snippet_nonce" ] && [ "$snippet_nonce" = "$shell_nonce" ] && echo yes || echo no) (nonce $snippet_nonce)
  insecure-origin behaviour                           silent skip by design (guard +
                                                      empty catch; plan clause recorded
                                                      in insecure-skip.txt, incl. the
                                                      http://localhost secure-context nuance)

browser runtime gap (browser-unavailable.txt):
  sw-registration-state.txt   NOT produced (needs a real engine) — substitutes:
                              sw.js.txt/sw-checks.txt strategy contract
  offline.png                 NOT produced (needs a real browser offline) — substitutes:
                              offline-strategy.txt fetch-handler excerpts + the
                              renderOffline/#jhin-root unit cites (T204 scope)
  beforeinstallprompt         not observable here; client adds no listener by design;
                              plan acceptance = "affordance unavailable, manifest valid"
                              (beforeinstallprompt.txt; manifest link observation noted there)

extra asserts beyond the brief's list (recorded, no plan asserts changed):
  manifest id/start_url/scope == "/" (route javadoc identity fields)
  manifest cache-control == no-cache
  icon If-None-Match -> 304 revalidation probe (the AssetRoute discipline)
  sw.js carries NO Content-Security-Policy header (the documented deviation)
  static gates also assert the exact unchanged sizes 59970/35229 (the brief's
  "unchanged since chunk 1" claim) in addition to the <= ceilings

evidence: $EVIDENCE
EOF
echo
echo "== T208 QA PASSED =="
echo "evidence: $EVIDENCE"
ls -1 "$EVIDENCE"
