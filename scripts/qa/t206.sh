#!/usr/bin/env bash
# T206 QA — full HTML catalog gallery and the responsive shell (chunk C).
#
# Proves, with a booted kernel, curl and static greps only (browser tools are
# UNAVAILABLE in this environment — every agent-browser step becomes
# evidence/T206/browser-unavailable.txt plus strengthened curl/static asserts,
# the T202/T203/T204/T205 precedent):
#   1. build + test gates: the kernel boot jar and the three plugin jars build
#      and the four suites stay green with the T206 catalog on the classpath —
#      :jhin-plugin-ui-kit:test 310, :jhin-plugin-ui-default:test 411
#      (HtmlConformanceTest among them), :sdk:test 64, :kernel:test 117
#      (KernelPurityTest must stay green); counts are summed from the JUnit
#      XML reports and asserted exactly;
#   2. static gates on the runtime assets and the gallery: no `<` in app.css;
#      app.js <= 60000 bytes (frozen at its recorded size); app.css <= 40000
#      bytes (the T206 responsive-shell budget); the gallery holds 68 fixtures
#      (>= 64 — the plan's gallery-coverage gate; 68 = the docs/sdui.md
#      section 2.5 count) and 0 `jhin-unsupported` placeholders across it;
#   3. gallery coverage dump: the 68 fixture names into gallery-coverage.txt
#      and the data-jhin-type= occurrence count across every fixture into
#      node-count.txt (asserted >= 30, the T203 node-count precedent);
#   4. prop-probe artifact: HtmlConformanceTest's section 2.6 probe writes
#      plugins/ui-default/build/unknown-props.txt unconditionally before it
#      asserts the list empty in-JVM (the existing test-only side channel —
#      no test change was needed for this QA run); the script deletes the
#      artifact before the suites run, asserts the probe rewrote it, copies it
#      to evidence/unknown-props.txt and asserts 0 bytes / 0 occurrences;
#   5. boot the kernel (plain HTTP port 18443, the 3-plugin bundle
#      jhin.sessions + jhin.ui-kit + jhin.ui — no mock LLM needed here), then
#      curl: GET /_jhin/health -> 200, GET / -> 200 text/html (the served
#      shell), api=4 bootstrap -> 200 with screens[].html, and the responsive
#      hooks of chunk 2 are asserted inside the served shell's inlined CSS
#      (responsive-hooks.txt): max-width: 768px (the overlay-drawer
#      breakpoint), safe-area-inset (the notch insets), data-jhin-collapsed
#      (the 56px rail), plus the drawer-open hook, the topbar-compact id
#      convention, the data-jhin-safe-area node opt-in and the closed-drawer
#      zero-tab-stop focus-trap half;
#   6. browser-unavailable.txt: the dual-viewport screenshots (390x844 and
#      1440x900 — drawer open/closed, rail collapsed, compact topbar,
#      safe-area on a notched viewport) cannot be captured here; the file
#      lists exactly which visual cases are uncovered and which asserts
#      substitute them (responsive-hooks.txt greps + the fixture gallery);
#   7. summary.txt with every PASS line and the key numbers.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with three plugin jars: jhin.sessions, jhin.ui-kit and jhin.ui (the
# non-optional requires of jhin.ui — the t202/t203/t204 bundle). Unlike t205
# no jhin.llm / jhin.agent / jhin.qa-mock-llm is staged: T206 renders the
# catalog and the shell, it drives no LLM run. jhin.security is deliberately
# absent: no bearer token is needed, no TlsProvider is registered and the
# listener speaks plain HTTP on http://localhost:18443 (the kernel default
# 8443 is occupied by another service on the QA machine; the frozen kernel
# CLI has no --no-tls flag — plan section 9 allows the QA-only plain-HTTP
# mode in scripts).
#
# On any failure one line is appended to evidence/T206/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EVIDENCE="$ROOT/.sisyphus/evidence/T206"
APP_JS="plugins/ui-default/src/main/resources/web/app.js"
APP_CSS="plugins/ui-default/src/main/resources/web/app.css"
GALLERY="plugins/ui-default/src/test/resources/gallery"
UNKNOWN_SRC="plugins/ui-default/build/unknown-props.txt"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.0.0-web; schema=5; caps=sse,open_url,secure_storage'

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

echo "== T206 QA: full HTML catalog gallery and the responsive shell =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

# ------------------------------------------------------------------- build
echo "== Step 1: build the jars + run the four test gates =="
# The prop probe must leave a fresh artifact: drop any stale one so the
# copy in step 4 can only come from this run's suites.
rm -f "$UNKNOWN_SRC"
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
    echo "T206 test gates — the four suites green with the T206 catalog:"
    grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
    echo ""
    echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests (expected 310)"
    echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (expected 411; HtmlConformanceTest among them)"
    echo "  :sdk:test                     $sdk_tests tests (expected 64)"
    echo "  :kernel:test                  $kernel_tests tests (expected 117; KernelPurityTest)"
    echo "  failures=$total_failures errors=$total_errors (expected 0/0)"
} > "$EVIDENCE/test-gates.txt"
for suite in ':jhin-plugin-ui-default:test' ':jhin-plugin-ui-kit:test' ':sdk:test' ':kernel:test'; do
    grep -qF "> Task $suite" "$EVIDENCE/build.log" \
        || fail "test suite $suite did not run (see $EVIDENCE/build.log)"
done
[ "$ui_kit_tests" = "310" ] || fail "ui-kit ran $ui_kit_tests tests (expected 310)"
[ "$ui_default_tests" = "411" ] || fail "ui-default ran $ui_default_tests tests (expected 411)"
[ "$sdk_tests" = "64" ] || fail "sdk ran $sdk_tests tests (expected 64)"
[ "$kernel_tests" = "117" ] || fail "kernel ran $kernel_tests tests (expected 117)"
[ "$total_failures" = "0" ] || fail "test failures=$total_failures (expected 0)"
[ "$total_errors" = "0" ] || fail "test errors=$total_errors (expected 0)"
ok "build + four test gates green (310/411/64/117; $EVIDENCE/test-gates.txt)"

# ----------------------------------------------------------- static gates
echo "== Step 2: static gates on app.css / app.js / the gallery =="
js_bytes=$(wc -c < "$APP_JS" | tr -d ' ')
css_bytes=$(wc -c < "$APP_CSS" | tr -d ' ')
fixture_count=$(ls "$GALLERY"/*.html | wc -l | tr -d ' ')
{
    echo "T206 static gates — the plan's hard rules on the runtime assets and the gallery."
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

# 2b: app.js size budget (frozen at $js_bytes; the T207 budget is 60000).
{
    echo "gate 2b — app.js size (frozen; <= 60000 bytes for the T207 budget):"
    echo "  wc -c $APP_JS -> $js_bytes bytes (must be <= 60000)"
} >> "$EVIDENCE/static-gates.txt"
[ "$js_bytes" -le 60000 ] \
    || fail "app.js is $js_bytes bytes (must be <= 60000)"

# 2c: app.css responsive-shell budget.
{
    echo "gate 2c — app.css size budget (T206 responsive shell, <= 40000 bytes):"
    echo "  wc -c $APP_CSS -> $css_bytes bytes (must be <= 40000)"
} >> "$EVIDENCE/static-gates.txt"
[ "$css_bytes" -le 40000 ] \
    || fail "app.css is $css_bytes bytes (must be <= 40000)"

# 2d: gallery fixture count (68 = the docs/sdui.md section 2.5 count;
# the plan's T206.4 gate is >= 64).
{
    echo "gate 2d — gallery fixture count:"
    echo "  ls $GALLERY/*.html | wc -l -> $fixture_count (must be 68; plan gate >= 64)"
} >> "$EVIDENCE/static-gates.txt"
[ "$fixture_count" -ge 64 ] \
    || fail "gallery holds $fixture_count fixtures (plan gate >= 64)"
[ "$fixture_count" = "68" ] \
    || fail "gallery holds $fixture_count fixtures (expected 68 — the section 2.5 count)"

# 2e: zero jhin-unsupported placeholders across the gallery.
unsupported=$(grep -rl 'jhin-unsupported' "$GALLERY" 2>/dev/null || true)
{
    echo "gate 2e — no jhin-unsupported placeholder in the gallery:"
    echo "  grep -rl jhin-unsupported $GALLERY -> $(printf '%s' "$unsupported" | grep -c . || true) file(s) (must be 0)"
} >> "$EVIDENCE/static-gates.txt"
[ -z "$unsupported" ] \
    || fail "gallery fixtures land in the jhin-unsupported placeholder: $unsupported"
ok "static gates green ($lt_count '<' in app.css, app.js $js_bytes B, app.css $css_bytes B, $fixture_count fixtures, 0 unsupported)"

# --------------------------------------------------- gallery coverage dump
echo "== Step 3: gallery-coverage.txt + node-count.txt =="
ls -1 "$GALLERY"/*.html | sed "s|$GALLERY/||" | sort > "$EVIDENCE/gallery-coverage.txt"
names_dumped=$(wc -l < "$EVIDENCE/gallery-coverage.txt" | tr -d ' ')
node_count=$(grep -o 'data-jhin-type=' "$GALLERY"/*.html | wc -l | tr -d ' ')
{
    echo "T206 gallery coverage — one committed fixture per docs/sdui.md section 2.5 name."
    echo ""
    echo "  fixture files: $names_dumped (byte-pinned; regen:"
    echo "    ./gradlew :jhin-plugin-ui-default:test --tests '*HtmlConformanceTest*' -Djhin.gallery.regen=true)"
    echo "  data-jhin-type= occurrences across all fixtures: $node_count (asserted >= 30)"
    echo ""
    echo "  fixture names:"
    sed 's/^/    /' "$EVIDENCE/gallery-coverage.txt"
} > "$EVIDENCE/node-count.txt"
[ "$names_dumped" = "$fixture_count" ] \
    || fail "gallery-coverage.txt lists $names_dumped names (fixture count $fixture_count)"
[ "$node_count" -ge 30 ] \
    || fail "gallery fixtures carry only $node_count data-jhin-type= occurrences (expected >= 30)"
ok "gallery coverage $names_dumped fixtures, $node_count data-jhin-type= occurrences (>= 30)"

# ------------------------------------------------------- prop-probe report
echo "== Step 4: unknown-props.txt — the section 2.6 prop probe artifact =="
[ -f "$UNKNOWN_SRC" ] \
    || fail "the prop probe left no $UNKNOWN_SRC (did HtmlConformanceTest run?)"
cp "$UNKNOWN_SRC" "$EVIDENCE/unknown-props.txt"
unknown_bytes=$(wc -c < "$EVIDENCE/unknown-props.txt" | tr -d ' ')
unknown_lines=$(grep -c . "$EVIDENCE/unknown-props.txt" || true)
{
    echo "T206 prop-probe artifact — section 2.6 (primitive, prop) pairs with no HTML channel."
    echo ""
    echo "  source: $UNKNOWN_SRC (written unconditionally by HtmlConformanceTest's"
    echo "          everyDocumentedPropIsReflectedInTheHtml before its in-JVM assert;"
    echo "          the file was deleted before this run's suites, so what is copied"
    echo "          here is this run's report — the QA side channel is the existing"
    echo "          test artifact, no test change was needed)"
    echo "  bytes:  $unknown_bytes (asserted 0)"
    echo "  lines:  $unknown_lines (asserted 0)"
    echo ""
    echo "  the probe parses docs/sdui.md section 2.6 at test time and renders every"
    echo "  (primitive, prop) pair with and without the prop (554 pairs in the current"
    echo "  tables); a pair whose outputs do not differ lands here unless allowlisted"
    echo "  (allowlist is empty). Props may reflect through any channel: semantic"
    echo "  attribute, style, class, text content, child structure or the"
    echo "  data-jhin-<kebab> PropReflection backstop."
} > "$EVIDENCE/unknown-props-report.txt"
[ "$unknown_bytes" = "0" ] \
    || fail "unknown-props.txt is $unknown_bytes bytes (expected 0): $(head -n 3 "$EVIDENCE/unknown-props.txt")"
[ "$unknown_lines" = "0" ] \
    || fail "unknown-props.txt carries $unknown_lines lines (expected 0)"
ok "prop probe artifact 0 bytes / 0 occurrences (unknown-props.txt + unknown-props-report.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 5: seed a temp JHIN_HOME (jhin.sessions + jhin.ui-kit + jhin.ui) =="
home=$(mktemp -d /tmp/t206-home.XXXXXX)
bundled=$(mktemp -d /tmp/t206-bundled.XXXXXX)
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
    echo "              of jhin.ui (the t202/t203/t204 QA bundle). T206 renders the catalog"
    echo "              and the responsive shell and drives no LLM run, so the t205"
    echo "              streaming additions (jhin.llm, jhin.agent, jhin.qa-mock-llm) are"
    echo "              deliberately absent and no bearer token is used anywhere."
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding ($EVIDENCE/kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 6: boot the kernel via run-kernel.sh (wait <= 30 s for health) =="
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

# ------------------------------------------------------------- web shell
echo "== Step 7: GET / serves the web shell (200 text/html) =="
shell_code=$(curl -s --max-time 10 -D "$EVIDENCE/shell.headers" -o "$EVIDENCE/shell.html" \
    -w '%{http_code}' "$BASE/") || fail "GET /: curl failed"
printf '%s\n' "$shell_code" > "$EVIDENCE/shell.status"
[ "$shell_code" = "200" ] || fail "GET / answered $shell_code (expected 200)"
grep -qiF 'content-type: text/html' "$EVIDENCE/shell.headers" \
    || fail "GET / Content-Type is not text/html: $(grep -i 'content-type' "$EVIDENCE/shell.headers" || true)"
grep -qF 'id="jhin-root"' "$EVIDENCE/shell.html" || fail "shell.html has no #jhin-root element"
ok "GET / -> 200 text/html; #jhin-root present (shell.html)"

# ------------------------------------------------------- the api=4 bootstrap
echo "== Step 8: GET /_jhin/bootstrap at api=4 — screens[].html =="
boot_code=$(curl -s --max-time 20 -H "$CLIENT_API4" -o "$EVIDENCE/bootstrap-api4.json" \
    -w '%{http_code}' "$BASE/_jhin/bootstrap") || fail "GET /_jhin/bootstrap (api=4): curl failed"
printf '%s\n' "$boot_code" > "$EVIDENCE/bootstrap-api4.status"
[ "$boot_code" = "200" ] || fail "api=4 bootstrap answered $boot_code (expected 200)"
grep -qF '"screens"' "$EVIDENCE/bootstrap-api4.json" \
    || fail "api=4 payload has no screens key: $(head -c 300 "$EVIDENCE/bootstrap-api4.json")"
first_html=$(grep -o '"html":"[^"]*' "$EVIDENCE/bootstrap-api4.json" | head -n 1 || true)
printf '%s\n' "$first_html" > "$EVIDENCE/screens0-html-prefix.txt"
printf '%s' "$first_html" | grep -qF '"html":"<div data-jhin-type=' \
    || fail "screens[0].html does not start with <div data-jhin-type=: [${first_html:-<none>}]"
ok "api=4 bootstrap -> 200; screens[].html starts with <div data-jhin-type= (bootstrap-api4.json)"

# ------------------------------------------------------ responsive hooks
echo "== Step 9: responsive-hooks.txt — chunk 2 hooks in the served shell =="
hook_ok=1
hook_report() {
    local label=$1 pattern=$2
    local hits
    hits=$(grep -cF "$pattern" "$EVIDENCE/shell.html" || true)
    printf '  %-46s %s hit(s)  %s\n' "$label" "$hits" "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)"
    [ "$hits" -ge 1 ] || hook_ok=0
}
{
    echo "T206 responsive hooks — asserted in the SERVED shell body (GET / inlines app.css)."
    echo "These greps substitute the dual-viewport screenshots (browser-unavailable.txt):"
    echo "the hooks are the CSS-half of the responsive shell, so their presence in the"
    echo "served bytes is the browser-less proof that the shell carries them."
    echo ""
    echo "hard asserts (plan T206.4 step 5):"
    hook_report 'max-width: 768px (overlay-drawer breakpoint)' 'max-width: 768px'
    hook_report 'safe-area-inset (notch insets)' 'safe-area-inset'
    hook_report 'data-jhin-collapsed (56px rail rule)' 'data-jhin-collapsed'
    echo ""
    echo "strengthened substitutes for the un-captured viewports:"
    hook_report 'jhin-drawer-open (the documented drawer hook)' 'jhin-drawer-open'
    hook_report 'topbar-compact id-convention swap' 'topbar-compact'
    hook_report 'data-jhin-safe-area node opt-in' 'data-jhin-safe-area'
    hook_report 'closed-drawer tab-stop drop (visibility: hidden)' 'visibility: hidden'
    echo ""
    echo "note: #jhin-root.jhin-drawer-open is a CSS-only hook — nothing in app.js drives"
    echo "it; the drawer opens on sidebar hover / focus-within alone. Flagged as a T206"
    echo "deviation (see the commit body and browser-unavailable.txt)."
} > "$EVIDENCE/responsive-hooks.txt"
[ "$hook_ok" = 1 ] || fail "responsive hooks missing from the served shell (see $EVIDENCE/responsive-hooks.txt)"
ok "responsive hooks present in the served shell (responsive-hooks.txt)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T206 browser steps — UNAVAILABLE in this environment.

Browser tooling (the agent browser / screenshots / evaluate) cannot run on
this QA machine; the T202/T203/T204/T205 precedent applies: every browser
step is recorded here and substituted with curl + static asserts.

Not executed (the plan's dual-viewport screenshot set):
  - 390x844, drawer closed: the 8px peek strip at the left edge painting
    nothing, zero tab stops in the closed state (CSS-half focus-trap).
  - 390x844, drawer open: the overlay drawer (sidebar hover / focus-within,
    and the #jhin-root.jhin-drawer-open hook) with its dimmed backdrop.
  - 390x844, compact topbar: the [id$="-topbar-compact"] variant stepping in
    for the wide top bar below 768px (the id-suffix convention swap).
  - 390x844, safe-area on a notched viewport: chrome top/bottom padding and
    the [data-jhin-safe-area] node spacers tracking the emulated insets.
  - 1440x900, rail collapsed: data-jhin-collapsed="true" shrinking the
    sidebar to the documented 56px icon rail (labels/sections hidden).
  - 1440x900, rail wide: the full sidebar for contrast.

Substituted (evidence of this run):
  - responsive CSS presence -> responsive-hooks.txt greps the SERVED shell
    body (GET / inlines app.css) for max-width: 768px, safe-area-inset and
    the data-jhin-collapsed rule (the plan's three hard asserts), plus the
    jhin-drawer-open hook, the topbar-compact id convention, the
    data-jhin-safe-area node opt-in and the closed-drawer visibility:hidden
    tab-stop drop;
  - catalog rendering -> the 68 byte-pinned gallery fixtures
    (gallery-coverage.txt, 107 data-jhin-type= occurrences — node-count.txt),
    one rendered node per docs/sdui.md section 2.5 name, plus the four
    universal-prop hosts (glass, demo, statusPulse, safeArea);
  - prop reflection -> the section 2.6 probe artifact (unknown-props.txt,
    0 occurrences across 554 pairs).

Uncovered without a browser (accepted for this environment):
  - the visual result of the drawer / rail / topbar / safe-area states at the
    two viewports (layout, overlap, animation);
  - real hover / focus-driven drawer opening and the backdrop hit target;
  - real device notch insets (env() resolves against the platform; a headless
    curl sees only the rule text, not the resolved px);
  - the CSS-half focus-trap behaviour in a live tab order (static: the closed
    drawer sets visibility: hidden on every sidebar child, which removes the
    subtree from sequential focus navigation — proven as a rule, not as a
    keystroke walk).

Known deviation (flagged, not a QA failure):
  - #jhin-root.jhin-drawer-open is documented in app.css but nothing in
    app.js drives it: the drawer opens CSS-only (sidebar hover /
    focus-within). A drawer-open screenshot would need that hook wired or a
    synthetic class toggle; neither exists in this chunk.
EOF
ok "browser-unavailable.txt written (dual-viewport screenshots substituted)"

# ------------------------------------------------------------- summary
echo "== Step 10: summary.txt =="
cat > "$EVIDENCE/summary.txt" <<EOF
T206 QA: PASS — full HTML catalog gallery and the responsive shell

PASS lines:
$(sed 's/^/  /' "$EVIDENCE/pass-lines.txt")

gates:
  build (bootJar + 3 plugin jars)                        green (build.log)
  :jhin-plugin-ui-kit:test      $ui_kit_tests tests                  green (test-gates.txt)
  :jhin-plugin-ui-default:test  $ui_default_tests tests                  green (HtmlConformanceTest)
  :sdk:test                     $sdk_tests tests                   green
  :kernel:test                  $kernel_tests tests                  green (KernelPurityTest)
  failures / errors                                          $total_failures / $total_errors
  '<' in app.css                                          $lt_count (0)
  app.js bytes                                            $js_bytes (<= 60000)
  app.css bytes                                           $css_bytes (<= 40000)
  gallery fixtures                                        $fixture_count (68; plan gate >= 64)
  jhin-unsupported across the gallery                     0 files

gallery (gallery-coverage.txt / node-count.txt):
  fixture names listed                                    $names_dumped
  data-jhin-type= occurrences across all fixtures         $node_count (>= 30)
  byte-pinned; regen -Djhin.gallery.regen=true (documented path)

prop probe (unknown-props.txt):
  section 2.6 pairs with no HTML channel                  $unknown_lines lines / $unknown_bytes bytes (0 / 0)
  source: plugins/ui-default/build/unknown-props.txt (the probe's existing
  test-only side channel, rewritten by this run's suites)

kernel:
  mode   plain HTTP on $BASE (no jhin.security -> no TlsProvider -> plain HTTP;
         port 18443 because 8443 is occupied on this machine)
  plugins jhin.sessions, jhin.ui-kit, jhin.ui (no mock LLM — T206 drives no run)

served shell + bootstrap:
  GET /_jhin/health                     200
  GET /                                 200 text/html, #jhin-root (shell.html)
  GET /_jhin/bootstrap (api=4)          200, screens[].html -> <div data-jhin-type=

responsive hooks (responsive-hooks.txt, in the served shell's inlined CSS):
  max-width: 768px / safe-area-inset / data-jhin-collapsed   PRESENT (plan asserts)
  jhin-drawer-open / topbar-compact / data-jhin-safe-area /
    closed-drawer visibility:hidden                         PRESENT (substitutes)

browser: unavailable — browser-unavailable.txt lists the dual-viewport cases
         (390x844 drawer open/closed, compact topbar, notched safe-area;
         1440x900 rail collapsed/wide) and their curl/static substitutes.
evidence: $EVIDENCE
EOF
echo
echo "== T206 QA PASSED =="
echo "evidence: $EVIDENCE"
ls -1 "$EVIDENCE"
