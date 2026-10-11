#!/usr/bin/env bash
# T209 QA — retire the Flutter client: the HTML web client is the only
# client (chunks 1+2+3).
#
# Proves, with a booted kernel, curl, gradle and static greps only (browser
# tools are UNAVAILABLE in this environment — the cold browser tour becomes
# evidence/T209/tour-substitute.txt (the curled served surface) plus
# browser-unavailable.txt, the T202–T208 precedent; nothing visual is
# fabricated):
#   1. build tee (build.log): `./gradlew build` plus an explicit
#      `:kernel:test --rerun` — BUILD SUCCESSFUL both, the four suite counts
#      asserted exactly (:jhin-plugin-ui-default:test 457 — the T209
#      ContextChipAccentsTest deletion lands here, :jhin-plugin-ui-kit:test
#      310, :sdk:test 64, :kernel:test 117) with 0 failures / 0 errors, and
#      KernelPurityTest green in its JUnit XML;
#   2. kernel-purity.txt — the zero-kernel-edit proof: `git diff HEAD --stat
#      kernel/` prints NOTHING (the tree holds the whole T209, chunks 1–3;
#      the kernel stayed untouched — the one stale Flutter comment in
#      JhinServlet.java is deliberately left, plan gate "zero kernel edits");
#   3. flutter-sweep.txt — `rg -n -i "flutter|\bdart\b" --glob '!.sisyphus/**'`
#      over the whole tree (minus this checker's own prose, which names the
#      retired stack by design): every hit must sit on the ALLOWED paths only
#      (the explicit allowlist below — the kernel's one stale comment, the
#      docs/web-client.md ADR rationale and the kept historical scripts'
#      prose). The full hit list is recorded either way; one hit outside the
#      allowlist fails the run;
#   4. stale-docs.txt — must be EMPTY: the prose docs (AGENTS.md README.md
#      docs/ deploy/) carry no stale surface term of the retired stack
#      (flutter|dart|frontend/|no-tree-shake|icon_registry|api=3|api: 3|
#      dist/frontend), EXCLUDING the docs/web-client.md ADR rationale (the
#      whole file is the ADR) and the docs/sdui.md Appendix A history block
#      (everything from the '## Appendix A' heading on — encoded explicitly
#      as file/line filters below);
#   5. e2e-bundle.txt — scripts/qa/e2e-bundle.sh runs end to end at the
#      level-4 contract and ends green (exit 0, 'T46 QA green');
#   6. static-gates.txt — the plan section 8 must-NOT-haves one more time:
#      0 eval / new Function in app.js, 0 '<' in app.css, app.js 59970
#      bytes <= 60000, app.css 35229 bytes <= 40000, the 68-primitive
#      gallery dump count == 68;
#   7. cold browser tour substitute — boot the kernel (plain HTTP port
#      18443, the 3-plugin bundle jhin.sessions + jhin.ui-kit + jhin.ui —
#      the t207/t208 pattern) and curl the full served surface:
#      GET /_jhin/health, GET / (the shell), GET /ui/assets/app.js,
#      GET /ui/assets/app.css, GET /manifest.json, GET /sw.js,
#      GET /ui/icons/icon-192.png, GET /ui/icons/icon-512.png, the api=4
#      GET /_jhin/bootstrap (200 with screens[].html and the level-4
#      contract) and GET /ui/screen/sessions (200 {id, html}) — status +
#      content-type per endpoint in tour-substitute.txt;
#   8. browser-unavailable.txt — the uncovered visual cases (a screenshot
#      tour of every screen, the PWA install UX, the offline experience);
#   9. summary.txt with every PASS line and the key numbers.
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with three plugin jars: jhin.sessions, jhin.ui-kit and jhin.ui (the
# non-optional requires of jhin.ui). jhin.security is deliberately absent: no
# bearer token is needed, no TlsProvider is registered and the listener
# speaks plain HTTP on http://localhost:18443 (the kernel default 8443 is
# occupied by another service on the QA machine; plan section 9 allows the
# QA-only plain-HTTP mode in scripts).
#
# On any failure one line is appended to evidence/T209/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EVIDENCE="$ROOT/.sisyphus/evidence/T209"
APP_JS="plugins/ui-default/src/main/resources/web/app.js"
APP_CSS="plugins/ui-default/src/main/resources/web/app.css"
GALLERY="plugins/ui-default/src/test/resources/gallery"
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

# First response-header field of a curl -D- dump (status line is line 1).
status_of() {
    printf '%s\n' "$1" | head -n 1 | awk '{print $2}' || true
}

# Header value of a curl -D- dump, case-insensitive name, \r stripped.
hdr() {
    printf '%s\n' "$1" | tr -d '\r' | grep -i "^$2:" | head -n 1 \
        | sed 's/^[^:]*: *//' || true
}

# Media-type compare without optional whitespace (the T207 norm_ct: the
# embedded Tomcat drops the OWS after ';' on the wire).
norm_ct() {
    printf '%s' "$1" | tr -d ' '
}

command -v jq >/dev/null 2>&1 \
    || fail "jq is required (bootstrap/screen JSON asserts) and is not on PATH"
command -v rg >/dev/null 2>&1 \
    || fail "rg is required (the flutter/stale-docs sweeps) and is not on PATH"

echo "== T209 QA: retire the Flutter client — the HTML web client is the only client =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

# ------------------------------------------------------------------- build
echo "== Step 1: build.log — ./gradlew build + :kernel:test =="
set +e
./gradlew --console=plain build 2>&1 | tee "$EVIDENCE/build.log"
BUILD_STATUS="${PIPESTATUS[0]}"
./gradlew --console=plain :kernel:test --rerun 2>&1 | tee -a "$EVIDENCE/build.log"
KERNEL_TEST_STATUS="${PIPESTATUS[0]}"
set -e
[ "$BUILD_STATUS" -eq 0 ] || fail "gradle build exited $BUILD_STATUS (see $EVIDENCE/build.log)"
[ "$KERNEL_TEST_STATUS" -eq 0 ] \
    || fail ":kernel:test exited $KERNEL_TEST_STATUS (see $EVIDENCE/build.log)"
grep -qF 'BUILD SUCCESSFUL' "$EVIDENCE/build.log" \
    || fail "gradle did not report BUILD SUCCESSFUL (see $EVIDENCE/build.log)"

# Test-count gates: sum the JUnit XML counters of each named suite.
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
purity_xml="kernel/build/test-results/test/TEST-com.astroreen.jhin.kernel.KernelPurityTest.xml"
[ -f "$purity_xml" ] || fail "KernelPurityTest result missing: $purity_xml"
grep -q 'failures="0" errors="0"' "$purity_xml" \
    || fail "KernelPurityTest reports failures (see $purity_xml)"
{
    echo "T209 build gates — the whole composite build green with the Flutter client gone:"
    grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
    echo ""
    echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests (expected 457 = 458 minus the deleted ContextChipAccentsTest)"
    echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests (expected 310)"
    echo "  :sdk:test                     $sdk_tests tests (expected 64)"
    echo "  :kernel:test                  $kernel_tests tests (expected 117; KernelPurityTest green in $purity_xml)"
    echo "  failures=$total_failures errors=$total_errors (expected 0/0)"
} > "$EVIDENCE/test-gates.txt"
[ "$ui_default_tests" = "457" ] || fail "ui-default ran $ui_default_tests tests (expected 457)"
[ "$ui_kit_tests" = "310" ] || fail "ui-kit ran $ui_kit_tests tests (expected 310)"
[ "$sdk_tests" = "64" ] || fail "sdk ran $sdk_tests tests (expected 64)"
[ "$kernel_tests" = "117" ] || fail "kernel ran $kernel_tests tests (expected 117)"
[ "$total_failures" = "0" ] || fail "test failures=$total_failures (expected 0)"
[ "$total_errors" = "0" ] || fail "test errors=$total_errors (expected 0)"
ok "build + :kernel:test green (457/310/64/117, KernelPurityTest green; $EVIDENCE/test-gates.txt)"

# --------------------------------------------------------- kernel purity
echo "== Step 2: kernel-purity.txt — zero kernel edits =="
{
    echo "T209 kernel purity — the task changed NOTHING under kernel/."
    echo ""
    echo "\$ git diff HEAD --stat kernel/"
    git diff HEAD --stat kernel/
    echo "\$ git status --porcelain kernel/"
    git status --porcelain kernel/
    echo ""
    echo "assert: both commands print nothing — the working tree holds the whole"
    echo "T209 (chunks 1–3) and the kernel sources are byte-identical to HEAD."
    echo "The one stale Flutter comment in"
    echo "kernel/src/main/java/com/astroreen/jhin/kernel/http/JhinServlet.java is"
    echo "deliberately LEFT (zero kernel edits is a plan gate; it is on the"
    echo "flutter-sweep allowlist instead)."
} > "$EVIDENCE/kernel-purity.txt"
if [ -n "$(git diff HEAD --stat kernel/)" ] || [ -n "$(git status --porcelain kernel/)" ]; then
    fail "kernel/ carries edits (see $EVIDENCE/kernel-purity.txt)"
fi
ok "kernel untouched: git diff HEAD --stat kernel/ is empty (kernel-purity.txt)"

# ---------------------------------------------------------- flutter sweep
echo "== Step 3: flutter-sweep.txt — flutter|dart hits must sit on the allowlist =="
# The allowlist (the chunk-2 report, encoded explicitly): the kernel's one
# stale comment (kernel is zero-edit), the docs/web-client.md ADR rationale
# (history by design) and the kept historical scripts' prose mentions.
ALLOWLIST=$(cat <<'EOF'
kernel/src/main/java/com/astroreen/jhin/kernel/http/JhinServlet.java
docs/web-client.md
scripts/qa/t50.sh
scripts/qa/t76.sh
scripts/qa/t77.sh
scripts/qa/t78.sh
scripts/qa/t80.sh
EOF
)
set +e
# The sweep excludes .sisyphus evidence (the plan's glob) and this checker
# itself: t209.sh's prose and its rg pattern strings name the retired stack
# by design — it documents the sweep, so it is meta, not product surface
# (the allowlist below stays exactly the plan's list).
rg -n -i "flutter|\bdart\b" --glob '!.sisyphus/**' --glob '!scripts/qa/t209.sh' \
    > "$EVIDENCE/flutter-sweep.txt" 2>&1
RG_STATUS=$?
set -e
[ "$RG_STATUS" -eq 0 ] || [ "$RG_STATUS" -eq 1 ] \
    || fail "rg flutter sweep exited $RG_STATUS (see $EVIDENCE/flutter-sweep.txt)"
hit_count=$(grep -c ':' "$EVIDENCE/flutter-sweep.txt" || true)
sweep_files=$(cut -d: -f1 "$EVIDENCE/flutter-sweep.txt" | sort -u || true)
{
    echo ""
    echo "=== allowlist (hits outside these paths fail the run) ==="
    printf '%s\n' "$ALLOWLIST" | sed 's/^/  /'
    echo ""
    echo "=== per-file verdict ==="
} >> "$EVIDENCE/flutter-sweep.txt"
outside=0
for f in $sweep_files; do
    if printf '%s\n' "$ALLOWLIST" | grep -qxF "$f"; then
        echo "  ALLOWED  $f" >> "$EVIDENCE/flutter-sweep.txt"
    else
        echo "  OUTSIDE  $f" >> "$EVIDENCE/flutter-sweep.txt"
        outside=$((outside + 1))
    fi
done
[ "$outside" -eq 0 ] \
    || fail "$outside flutter|dart hit file(s) outside the allowlist (see $EVIDENCE/flutter-sweep.txt)"
ok "flutter|dart sweep clean: every hit on the allowlist ($hit_count hit lines, $outside outside)"

# ----------------------------------------------------------- stale docs
echo "== Step 4: stale-docs.txt — the prose docs carry no retired-stack term =="
# Exclusions, encoded explicitly: docs/web-client.md is the ADR in full (its
# rationale names the retired client by design) and the docs/sdui.md
# Appendix A block is contract history ("History only") — everything from
# the '## Appendix A' heading to EOF.
appendix_line=$(grep -n '^## Appendix A' docs/sdui.md | head -n 1 | cut -d: -f1)
[ -n "$appendix_line" ] || fail "docs/sdui.md carries no '## Appendix A' heading (exclusion anchor missing)"
set +e
rg -n -i 'flutter|\bdart\b|frontend/|no-tree-shake|icon_registry|api=3\b|api: 3\b|dist/frontend' \
    AGENTS.md README.md docs/ deploy/ 2>/dev/null \
    | grep -v '^docs/web-client.md:' \
    | awk -F: -v cut="$appendix_line" '!( $1 == "docs/sdui.md" && ($2 + 0) >= cut )' \
    > "$EVIDENCE/stale-docs.txt"
set -e
{
    echo ""
    echo "=== exclusions applied ==="
    echo "  docs/web-client.md            whole file (the ADR rationale, history by design)"
    echo "  docs/sdui.md lines >= $appendix_line   the '## Appendix A' history block (to EOF)"
    echo ""
    echo "assert: the filtered hit list above is EMPTY."
} >> "$EVIDENCE/stale-docs.txt"
stale_hits=$(grep -cE '^[^ ]+:[0-9]+:' "$EVIDENCE/stale-docs.txt" || true)
[ "$stale_hits" -eq 0 ] \
    || fail "stale-docs.txt carries $stale_hits retired-stack mention(s) outside the exclusions"
ok "stale-docs sweep empty: 0 retired-stack terms in AGENTS.md/README.md/docs/ deploy/ outside the ADR + Appendix A (stale-docs.txt)"

# ------------------------------------------------------------- e2e bundle
echo "== Step 5: e2e-bundle.txt — the full release bundle at the level-4 contract =="
set +e
scripts/qa/e2e-bundle.sh 2>&1 | tee "$EVIDENCE/e2e-bundle.txt"
E2E_STATUS="${PIPESTATUS[0]}"
set -e
[ "$E2E_STATUS" -eq 0 ] || fail "e2e-bundle.sh exited $E2E_STATUS (see $EVIDENCE/e2e-bundle.txt)"
grep -q 'T46 QA green' "$EVIDENCE/e2e-bundle.txt" \
    || fail "e2e-bundle.sh did not report 'T46 QA green' (see $EVIDENCE/e2e-bundle.txt)"
ok "e2e-bundle.sh green at contract level 4 (T46 QA green; $EVIDENCE/e2e-bundle.txt)"

# ----------------------------------------------------------- static gates
echo "== Step 6: static-gates.txt — the plan section 8 must-NOT-haves =="
js_bytes=$(wc -c < "$APP_JS" | tr -d ' ')
css_bytes=$(wc -c < "$APP_CSS" | tr -d ' ')
eval_hits=$(grep -c 'eval\|new Function' "$APP_JS" || true)
lt_count=$(grep -c '<' "$APP_CSS" || true)
gallery_count=$(ls "$GALLERY"/*.html 2>/dev/null | wc -l | tr -d ' ')
{
    echo "T209 static gates — the hard rules on the shipped web client (plan section 8 must-NOT-haves)."
    echo ""
    echo "gate 1 — no eval / new Function in app.js:"
    echo "  grep -c 'eval\\|new Function' $APP_JS -> $eval_hits (must be 0)"
    echo "gate 2 — no '<' in app.css (CSS must not smuggle markup):"
    echo "  grep -c '<' $APP_CSS -> $lt_count (must be 0)"
    echo "gate 3 — app.js size budget:"
    echo "  wc -c $APP_JS -> $js_bytes bytes (must be 59970 and <= 60000)"
    echo "gate 4 — app.css size budget:"
    echo "  wc -c $APP_CSS -> $css_bytes bytes (must be 35229 and <= 40000)"
    echo "gate 5 — the 68-primitive gallery dump:"
    echo "  ls $GALLERY/*.html | wc -l -> $gallery_count (must be 68)"
} > "$EVIDENCE/static-gates.txt"
[ "$eval_hits" = "0" ] \
    || fail "app.js carries $eval_hits eval/new Function occurrences (expected 0)"
[ "$lt_count" = "0" ] \
    || fail "app.css carries $lt_count '<' occurrences (must be 0)"
[ "$js_bytes" = "59970" ] || fail "app.js is $js_bytes bytes (expected 59970)"
[ "$js_bytes" -le 60000 ] || fail "app.js is $js_bytes bytes (must be <= 60000)"
[ "$css_bytes" = "35229" ] || fail "app.css is $css_bytes bytes (expected 35229)"
[ "$css_bytes" -le 40000 ] || fail "app.css is $css_bytes bytes (must be <= 40000)"
[ "$gallery_count" = "68" ] || fail "gallery dump holds $gallery_count HTML files (expected 68)"
ok "static gates green (0 eval, 0 '<', app.js $js_bytes B, app.css $css_bytes B, gallery $gallery_count)"

# ------------------------------------------------------- seed a temp home
echo "== Step 7: seed a temp JHIN_HOME (jhin.sessions + jhin.ui-kit + jhin.ui) =="
home=$(mktemp -d /tmp/t209-home.XXXXXX)
bundled=$(mktemp -d /tmp/t209-bundled.XXXXXX)
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
    echo "            listener speaks plain HTTP (the t207/t208 QA pattern; plan section 9"
    echo "            allows the QA-only plain-HTTP mode in scripts)."
    echo "port-reason=the kernel default 8443 is occupied by another service on this machine"
    echo "plugins=jhin.sessions, jhin.ui-kit, jhin.ui"
    echo "plugin-reason=jhin.sessions + jhin.ui-kit + jhin.ui are the non-optional requires"
    echo "              of jhin.ui (the t202–t208 QA bundle). The tour curls the served"
    echo "              surface only and drives no LLM run, so the mock LLM harness is"
    echo "              deliberately absent and no bearer token is used anywhere."
    echo "client-header=none on the shell/asset/manifest/icon/worker/health fetches (a fresh"
    echo "               browser sends none); $CLIENT_API4 on /_jhin/bootstrap and"
    echo "               /ui/screen/* (those routes negotiate and refuse api<4 with 426)."
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding ($EVIDENCE/kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 8: boot the kernel via run-kernel.sh (wait <= 30 s for health) =="
JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
    "$ROOT/scripts/qa/run-kernel.sh" "$EVIDENCE" --server.port="$PORT" &
kernel_pid=$!

start=$(date +%s)
code=000
while :; do
    code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' \
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

# ------------------------------------------------- cold tour substitute
echo "== Step 9: tour-substitute.txt — the curled served surface =="
{
    echo "T209 cold browser tour substitute — the full served surface, curled."
    echo ""
    echo "Browser tools are UNAVAILABLE in this environment (browser-unavailable.txt),"
    echo "so the tour is the served surface itself: every endpoint the web client"
    echo "touches on a cold start, through the live kernel, with status + content-type"
    echo "recorded and asserted. Nothing visual is fabricated."
    echo ""
} > "$EVIDENCE/tour-substitute.txt"

# tour <label> <path> <expected-media-type> <client-header|-> <jq-assert|->
# Records status + content-type into tour-substitute.txt and asserts both,
# plus an optional jq assert over the JSON body.
tour() {
    local label=$1 path=$2 want_ct=$3 client=$4 jq_assert=$5
    local dump status ct bytes body
    body="$EVIDENCE/.tour-body"
    if [ "$client" = "-" ]; then
        dump=$(curl -s --max-time 10 -D- -o "$body" "$BASE$path") \
            || fail "GET $path: curl failed"
    else
        dump=$(curl -s --max-time 10 -D- -o "$body" -H "$client" "$BASE$path") \
            || fail "GET $path: curl failed"
    fi
    status=$(status_of "$dump")
    ct=$(hdr "$dump" content-type)
    bytes=$(wc -c < "$body" | tr -d ' ')
    {
        echo "=== $label ==="
        echo "GET $path"
        echo "  header:       $client"
        printf '%s\n' "$dump" | tr -d '\r' | grep -i '^HTTP/\|^content-type:\|^etag:\|^cache-control:' | sed 's/^/  | /'
        echo "  status:       $status (expected 200)"
        echo "  content-type: '$ct' (raw wire; expected $want_ct)"
        echo "  body:         $bytes bytes"
    } >> "$EVIDENCE/tour-substitute.txt"
    [ "$status" = "200" ] || fail "GET $path answered $status (expected 200)"
    case "$(norm_ct "$ct")" in
        "$(norm_ct "$want_ct")"*) : ;;
        *) fail "GET $path Content-Type is '$ct' (expected $want_ct)" ;;
    esac
    if [ "$jq_assert" != "-" ]; then
        if jq -e "$jq_assert" "$body" > /dev/null 2>&1; then
            echo "  jq assert:    ok — $jq_assert" >> "$EVIDENCE/tour-substitute.txt"
        else
            echo "  jq assert:    FAILED — $jq_assert" >> "$EVIDENCE/tour-substitute.txt"
            fail "GET $path: jq assertion '$jq_assert' failed (body: $(head -c 300 "$body"))"
        fi
    fi
    echo "" >> "$EVIDENCE/tour-substitute.txt"
}

tour "health" "/_jhin/health" "application/json" "-" "-"
tour "web shell" "/" "text/html" "-" "-"
tour "client runtime" "/ui/assets/app.js" "application/javascript" "-" "-"
tour "client styles" "/ui/assets/app.css" "text/css" "-" "-"
tour "PWA manifest" "/manifest.json" "application/manifest+json" "-" "-"
tour "service worker" "/sw.js" "application/javascript" "-" "-"
tour "PWA icon 192" "/ui/icons/icon-192.png" "image/png" "-" "-"
tour "PWA icon 512" "/ui/icons/icon-512.png" "image/png" "-" "-"
tour "bootstrap (api=4)" "/_jhin/bootstrap" "application/json" "$CLIENT_API4" \
    '(.screens | length) > 0 and all(.screens[]; (.id | length) > 0 and (.html | length) > 0)'
tour "sessions screen" "/ui/screen/sessions" "application/json" "$CLIENT_API4" \
    '.id == "sessions" and (.html | length) > 0'

# The level-4 contract block of the bootstrap payload (key numbers).
curl -s --max-time 10 -H "$CLIENT_API4" "$BASE/_jhin/bootstrap" \
    > "$EVIDENCE/.tour-body" || fail "GET /_jhin/bootstrap (contract capture): curl failed"
jq -e '.contract.api == 4 and .contract.minApi == 4 and .contract.schema == 5 and .contract.minSchema == 5' \
    "$EVIDENCE/.tour-body" > /dev/null \
    || fail "bootstrap contract is not api 4/minApi 4/schema 5/minSchema 5 (see tour-substitute.txt)"
screen_count=$(jq '.screens | length' "$EVIDENCE/.tour-body")
{
    echo "=== bootstrap contract + screens (key numbers) ==="
    echo "  contract: $(jq -c '.contract' "$EVIDENCE/.tour-body")"
    echo "  screens:  $screen_count inline {id, html} entries"
    echo "  assert:   contract api 4/minApi 4/schema 5/minSchema 5 — ok"
    echo ""
} >> "$EVIDENCE/tour-substitute.txt"
rm -f "$EVIDENCE/.tour-body"
ok "tour substitute green: 10 endpoints 200 with the expected media types (bootstrap screens[].html x$screen_count, /ui/screen/sessions {id,html}; tour-substitute.txt)"

# ------------------------------------------------------- browser gap
echo "== Step 10: browser-unavailable.txt =="
cat > "$EVIDENCE/browser-unavailable.txt" <<EOF
T209 cold browser tour — UNAVAILABLE in this environment.

Browser tooling (the screenshot tour of every screen, the PWA install UX and
the offline experience) cannot run on this QA machine; the T202–T208
precedent applies: every browser step is recorded here and substituted with
curl over the served surface (tour-substitute.txt). No screenshot, snapshot
or visual artifact was produced and nothing was fabricated in their place.

Uncovered without a browser (accepted for this environment):
  - a screenshot tour of every screen (sessions, chat, settings:*,
    settings:licenses, pair, the version-gate and the fallback art): the
    rendered pixels, layout, theme tokens and responsive behaviour of each
    screen as a user sees them;
  - the PWA install UX: the beforeinstallprompt affordance, the install
    prompt and the installed-app chrome (the manifest and its two icons are
    proven served — tour-substitute.txt — but no install flow runs here);
  - the offline experience: the service-worker install/activate lifecycle in
    a real engine, the cached-shell cold start with the network down and the
    fallbacks.offline art painted into #jhin-root (the worker script and the
    shell paint target are proven served; the T208 sw-checks/offline-strategy
    evidence covers the strategy contract).

Substitutes of this run (evidence):
  - tour-substitute.txt — the full served surface curled through the live
    kernel: health, shell, app.js, app.css, manifest, worker, both icons,
    the api=4 bootstrap (screens[].html, contract 4/4/5/5) and the sessions
    screen ({id, html}) — status + content-type per endpoint;
  - static-gates.txt — the client-side must-NOT-haves (0 eval, 0 '<',
    the byte budgets, the 68-primitive gallery);
  - stale-docs.txt / flutter-sweep.txt — the retired stack is gone from the
    product surface and survives only on the allowlisted history paths.
EOF
ok "browser-unavailable.txt written (screenshot tour / PWA install UX / offline experience honestly absent, substitutes listed)"

# ------------------------------------------------------------- summary
echo "== Step 11: summary.txt =="
cat > "$EVIDENCE/summary.txt" <<EOF
T209 QA: PASS — retire the Flutter client: the HTML web client is the only client

PASS lines:
$(sed 's/^/  /' "$EVIDENCE/pass-lines.txt")

gates:
  ./gradlew build + :kernel:test                          green (build.log)
  :jhin-plugin-ui-default:test  $ui_default_tests tests                  green (457 = 458 minus ContextChipAccentsTest)
  :jhin-plugin-ui-kit:test      $ui_kit_tests tests                  green
  :sdk:test                     $sdk_tests tests                   green
  :kernel:test                  $kernel_tests tests                  green (KernelPurityTest)
  failures / errors                                          $total_failures / $total_errors
  git diff HEAD --stat kernel/                            empty (zero kernel edits)
  flutter|dart sweep                                      $hit_count hit lines, $outside outside the allowlist
  stale-docs sweep                                        $stale_hits hits outside the ADR + Appendix A exclusions
  e2e-bundle.sh                                           T46 QA green (level-4 contract)
  eval/new Function in app.js                             $eval_hits (0)
  '<' in app.css                                          $lt_count (0)
  app.js bytes                                            $js_bytes (== 59970, <= 60000)
  app.css bytes                                           $css_bytes (== 35229, <= 40000)
  gallery HTML files                                      $gallery_count (== 68)

tour substitute (tour-substitute.txt):
  GET /_jhin/health            200  application/json
  GET /                        200  text/html (the web shell)
  GET /ui/assets/app.js        200  application/javascript; charset=utf-8
  GET /ui/assets/app.css       200  text/css; charset=utf-8
  GET /manifest.json           200  application/manifest+json; charset=utf-8
  GET /sw.js                   200  application/javascript; charset=utf-8
  GET /ui/icons/icon-192.png   200  image/png
  GET /ui/icons/icon-512.png   200  image/png
  GET /_jhin/bootstrap (api=4) 200  application/json — screens[].html x$screen_count, contract 4/4/5/5
  GET /ui/screen/sessions      200  application/json — {id, html}

kernel:
  mode   plain HTTP on $BASE (no jhin.security -> no TlsProvider -> plain HTTP;
         port 18443 because 8443 is occupied on this machine)
  plugins jhin.sessions, jhin.ui-kit, jhin.ui (no mock LLM — the tour drives no run)
  client  none on the shell/asset/manifest/icon/worker/health fetches;
          $CLIENT_API4 on /_jhin/bootstrap and /ui/screen/*

browser gap (browser-unavailable.txt):
  screenshot tour of every screen   NOT produced (needs a real browser) — substitute:
                                    tour-substitute.txt (the curled served surface)
  PWA install UX                    NOT produced (needs a real browser) — substitute:
                                    manifest + icons proven served
  offline experience                NOT produced (needs a real browser offline) —
                                    substitutes: served sw.js + shell paint target
                                    (the T208 strategy evidence)

leftovers handled (the chunk-2 handover):
  1. SettingsScreen LICENSE_NOTICE/LICENSE_ENTRIES no longer list Flutter/Dart
     (the license screen must not claim a client that is not bundled);
  2. t80.sh kept — its dead '--no-tree-shake-icons' README assert repointed at
     the surviving 'HTML web client' phrase;
  3. e2e-lifecycle.sh DELETED (with its t81.sh wrapper): its core asserts are
     dead against the level-4 wire — fetch_sidebar wants the retired
     .node.body.sidebar node-tree shape (screens answer {id, html}) and the
     contract-downgrade section wants api<4 downgraded shapes (the server
     refuses api<4 with 426 contract_upgrade). The minimal level-4 fix could
     not make it green without rewriting its heart; the sanctioned
     fix-or-delete decision is delete.
EOF
ok "summary.txt written (PASS + key numbers)"
echo "== T209 QA green: evidence in $EVIDENCE =="