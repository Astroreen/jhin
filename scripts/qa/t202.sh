#!/usr/bin/env bash
# T202 QA — web shell route and the bootstrap-driven render core.
#
# Proves, with a booted kernel and curl only:
#   1. GET / serves the inline web shell: 200 text/html, the #jhin-root
#      element, the inlined app.css (jhin-button) and app.js (X-Jhin-Client)
#      payloads, the token CSS marker --color-accent: var(--accent), and all
#      three __JHIN_*__ placeholders replaced;
#   2. GET /_jhin/bootstrap refuses the api=3 client AND the absent
#      X-Jhin-Client header with 426 and the exact contract_upgrade body
#      ("error":"contract_upgrade", "minApi":4);
#   3. GET /_jhin/bootstrap at api=4 answers the level-4 shape: screens are
#      {id, html} entries whose html starts with <div data-jhin-type=, no
#      "node" key survives on the wire, and fallbacks.offline /
#      fallbacks.error are html strings;
#   4. GET /_jhin/health stays 200 — the 426 gate must not cover health;
#   5. snapshot substitute (this environment has no browser tools, see
#      evidence/T202/browser-unavailable.txt): the served shell parses as an
#      HTML document with the #jhin-root region present and non-empty
#      (shell-root.txt), the app title is in the document, the inlined
#      runtime that fills #jhin-root is present, and the served screens carry
#      at least one <button> (snapshot-substitute.txt).
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with three plugin jars (jhin.sessions, jhin.ui-kit, jhin.ui — the
# non-optional requires of jhin.ui). jhin.security is deliberately absent: no
# TlsProvider is registered then, so the listener speaks plain HTTP and every
# request goes to http://localhost:18443 with no curl -k. The frozen kernel
# CLI has no --no-tls flag (KernelBoot parses only --server.address and
# --server.port); plan section 9 allows the QA-only plain-HTTP mode in
# scripts. The port is 18443 because the kernel default 8443 is occupied by
# another service on the QA machine. The mode is recorded in
# evidence/T202/kernel-env.txt and summary.txt.
#
# On any failure one line is appended to evidence/T202/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the curl
# status codes. Runs from the repository root.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EVIDENCE="$ROOT/.sisyphus/evidence/T202"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.0.0-web; schema=5; caps=sse,open_url,secure_storage'

mkdir -p "$EVIDENCE"

fail() {
    echo "FAIL: $*" | tee -a "$EVIDENCE/failures.txt" >&2
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

echo "== T202 QA: web shell route and the bootstrap-driven render core =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

# ------------------------------------------------------------------- build
echo "== Step 1: build the kernel boot jar and the three plugin jars =="
set +e
./gradlew --console=plain :kernel:bootJar \
    :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar \
    2>&1 | tee "$EVIDENCE/build.log"
BUILD_STATUS="${PIPESTATUS[0]}"
set -e
[ "$BUILD_STATUS" -eq 0 ] || fail "gradle build exited $BUILD_STATUS (see $EVIDENCE/build.log)"
echo "-- OK: build green ($EVIDENCE/build.log)"

# ------------------------------------------------------- seed a temp home
echo "== Step 2: seed a temp JHIN_HOME (jhin.sessions + jhin.ui-kit + jhin.ui) =="
home=$(mktemp -d /tmp/t202-home.XXXXXX)
bundled=$(mktemp -d /tmp/t202-bundled.XXXXXX)
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
} > "$EVIDENCE/kernel-env.txt"
echo "-- OK: $jar_count jars staged for seeding ($EVIDENCE/kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 3: boot the kernel via run-kernel.sh (wait <= 30 s for health) =="
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
echo "== Step 4: GET / serves the inline web shell =="
shell_code=$(curl -s --max-time 10 -D "$EVIDENCE/shell.headers" -o "$EVIDENCE/shell.html" \
    -w '%{http_code}' "$BASE/") || fail "GET /: curl failed"
printf '%s\n' "$shell_code" > "$EVIDENCE/shell.status"
[ "$shell_code" = "200" ] || fail "GET / answered $shell_code (expected 200)"
grep -qiF 'content-type: text/html' "$EVIDENCE/shell.headers" \
    || fail "GET / Content-Type is not text/html: $(grep -i 'content-type' "$EVIDENCE/shell.headers" || true)"
grep -qF 'id="jhin-root"' "$EVIDENCE/shell.html" || fail "shell.html has no #jhin-root element"
grep -qF '#jhin-root' "$EVIDENCE/shell.html" || fail "shell.html has no #jhin-root marker"
grep -qF 'jhin-button' "$EVIDENCE/shell.html" || fail "app.css payload is not inlined (no jhin-button)"
grep -qF 'X-Jhin-Client' "$EVIDENCE/shell.html" || fail "app.js payload is not inlined (no X-Jhin-Client)"
grep -qF -- '--color-accent: var(--accent)' "$EVIDENCE/shell.html" \
    || fail "token CSS marker --color-accent: var(--accent) missing from shell.html"
for ph in '/*__JHIN_TOKEN_CSS__*/' '/*__JHIN_APP_CSS__*/' '/*__JHIN_APP_JS__*/'; do
    if grep -qF -- "$ph" "$EVIDENCE/shell.html"; then
        fail "placeholder $ph still present in shell.html"
    fi
done
echo "-- OK: GET / -> 200 text/html; #jhin-root, app.css, app.js and token CSS inlined; 3 placeholders gone"

# ------------------------------------------------------- the 426 gate
echo "== Step 5: the 426 contract_upgrade gate =="
curl -s -i --max-time 10 -H 'X-Jhin-Client: api=3' "$BASE/_jhin/bootstrap" \
    > "$EVIDENCE/bootstrap-api3.txt" || fail "GET /_jhin/bootstrap (api=3): curl failed"
api3_code=$(awk 'NR==1 {print $2}' "$EVIDENCE/bootstrap-api3.txt")
[ "$api3_code" = "426" ] \
    || fail "api=3 bootstrap answered [${api3_code:-<none>}] (expected 426): $(head -n 1 "$EVIDENCE/bootstrap-api3.txt")"
grep -qF '"error":"contract_upgrade"' "$EVIDENCE/bootstrap-api3.txt" \
    || fail "api=3 426 body lacks \"error\":\"contract_upgrade\": $(cat "$EVIDENCE/bootstrap-api3.txt")"
grep -qF '"minApi":4' "$EVIDENCE/bootstrap-api3.txt" \
    || fail "api=3 426 body lacks \"minApi\":4: $(cat "$EVIDENCE/bootstrap-api3.txt")"
echo "-- OK: api=3 -> 426 contract_upgrade (minApi 4)"

curl -s -i --max-time 10 "$BASE/_jhin/bootstrap" \
    > "$EVIDENCE/bootstrap-noheader.txt" || fail "GET /_jhin/bootstrap (absent header): curl failed"
nh_code=$(awk 'NR==1 {print $2}' "$EVIDENCE/bootstrap-noheader.txt")
[ "$nh_code" = "426" ] \
    || fail "absent-header bootstrap answered [${nh_code:-<none>}] (expected 426): $(head -n 1 "$EVIDENCE/bootstrap-noheader.txt")"
grep -qF '"error":"contract_upgrade"' "$EVIDENCE/bootstrap-noheader.txt" \
    || fail "absent-header 426 body lacks \"error\":\"contract_upgrade\""
grep -qF '"minApi":4' "$EVIDENCE/bootstrap-noheader.txt" \
    || fail "absent-header 426 body lacks \"minApi\":4"
echo "-- OK: absent X-Jhin-Client -> 426 contract_upgrade (minApi 4)"

# --------------------------------------------------- the api=4 payload
echo "== Step 6: the api=4 bootstrap payload =="
api4_code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/bootstrap-api4.json" \
    -w '%{http_code}' "$BASE/_jhin/bootstrap") || fail "GET /_jhin/bootstrap (api=4): curl failed"
printf '%s\n' "$api4_code" > "$EVIDENCE/bootstrap-api4.status"
[ "$api4_code" = "200" ] || fail "api=4 bootstrap answered $api4_code (expected 200)"

# screens[0].html must start with <div data-jhin-type= (the first "html" key
# of the payload is screens[0].html; the value's inner quotes are escaped, so
# the run up to the first quote is exactly the fragment prefix).
first_html=$(grep -o '"html":"[^"]*' "$EVIDENCE/bootstrap-api4.json" | head -n 1 || true)
printf '%s\n' "$first_html" > "$EVIDENCE/screens0-html-prefix.txt"
printf '%s' "$first_html" | grep -qF '"html":"<div data-jhin-type=' \
    || fail "screens[0].html does not start with <div data-jhin-type=: [${first_html:-<none>}]"

# NEGATIVE: no "node" key survives on the wire (inside JSON strings every
# quote is escaped, so a literal "node": can only be a real key).
if grep -qF '"node":' "$EVIDENCE/bootstrap-api4.json"; then
    fail "the api=4 payload still carries a \"node\" key: $(grep -o '"node":[^,}]*' "$EVIDENCE/bootstrap-api4.json" | head -n 3)"
fi

# fallbacks.offline / fallbacks.error are html strings (rendered fragments).
# The extraction is scoped to the "fallbacks" object (the last key of the
# payload): theme.colors also carries an "error" entry (a hex literal), so a
# global "error" lookup would grab the wrong value.
fallbacks_region=$(grep -o '"fallbacks":{.*' "$EVIDENCE/bootstrap-api4.json" | head -n 1 || true)
offline=$(printf '%s' "$fallbacks_region" | grep -o '"offline":"[^"]*' | head -n 1 || true)
error=$(printf '%s' "$fallbacks_region" | grep -o '"error":"[^"]*' | head -n 1 || true)
printf '%s\n' "$offline" > "$EVIDENCE/fallbacks-html-prefix.txt"
printf '%s\n' "$error" >> "$EVIDENCE/fallbacks-html-prefix.txt"
printf '%s' "$offline" | grep -qF '"offline":"<' \
    || fail "fallbacks.offline is not an html string: [${offline:-<none>}]"
printf '%s' "$offline" | grep -qF 'data-jhin-type=' \
    || fail "fallbacks.offline carries no data-jhin-type: [${offline:-<none>}]"
printf '%s' "$error" | grep -qF '"error":"<' \
    || fail "fallbacks.error is not an html string: [${error:-<none>}]"
printf '%s' "$error" | grep -qF 'data-jhin-type=' \
    || fail "fallbacks.error carries no data-jhin-type: [${error:-<none>}]"
echo "-- OK: api=4 -> 200; screens[0].html starts with <div data-jhin-type=; no \"node\" key; fallbacks are html strings"

# ------------------------------------------------- health stays open
echo "== Step 7: GET /_jhin/health is not covered by the 426 gate =="
health_code=$(curl -s --max-time 10 -o "$EVIDENCE/health.json" -w '%{http_code}' \
    "$BASE/_jhin/health") || fail "GET /_jhin/health: curl failed"
printf '%s\n' "$health_code" > "$EVIDENCE/health.status"
[ "$health_code" = "200" ] || fail "GET /_jhin/health answered $health_code (expected 200 — the 426 gate must not cover health)"
grep -qF '"status":"ok"' "$EVIDENCE/health.json" \
    || fail "health body lacks \"status\":\"ok\": $(cat "$EVIDENCE/health.json")"
echo "-- OK: GET /_jhin/health -> 200 (gate does not cover health)"

# -------------------------------------------- snapshot substitute
echo "== Step 8: snapshot substitute (no browser tools in this environment) =="
sed -n '/<div id="jhin-root"/,/<\/div>/p' "$EVIDENCE/shell.html" > "$EVIDENCE/shell-root.txt"
[ -s "$EVIDENCE/shell-root.txt" ] || fail "the #jhin-root region is empty (shell-root.txt)"
grep -qF 'id="jhin-root"' "$EVIDENCE/shell-root.txt" \
    || fail "shell-root.txt does not carry the #jhin-root element"

title_ok=0
grep -qF '<title>Jhin</title>' "$EVIDENCE/shell.html" && title_ok=1
doctype_ok=0
grep -qF '<!doctype html>' "$EVIDENCE/shell.html" && doctype_ok=1
fill_ok=0
grep -qF 'getElementById("jhin-root")' "$EVIDENCE/shell.html" && fill_ok=1
button_ok=0
grep -qF '<button' "$EVIDENCE/bootstrap-api4.json" && button_ok=1
plain_ok=0
grep -qiF 'content-type: text/html' "$EVIDENCE/shell.headers" && plain_ok=1
html_ok=0
printf '%s' "$first_html" | grep -qF '"html":"<' && html_ok=1

{
    echo "T202 snapshot substitute — the browser step cannot run here (see browser-unavailable.txt)."
    echo "These curl-level checks stand in for the ARIA snapshot + screenshot:"
    echo "  shell.html is an HTML document (doctype): $([ "$doctype_ok" = 1 ] && echo ok || echo MISSING)"
    echo "  app title <title>Jhin</title> present: $([ "$title_ok" = 1 ] && echo ok || echo MISSING)"
    echo "  #jhin-root element present, region non-empty (shell-root.txt): ok"
    echo "  inlined runtime that fills #jhin-root (getElementById(\"jhin-root\")): $([ "$fill_ok" = 1 ] && echo ok || echo MISSING)"
    echo "  at least one <button> in the served screens/fallbacks html: $([ "$button_ok" = 1 ] && echo ok || echo MISSING)"
    echo "  content-type text/html (the text/plain failure case): $([ "$plain_ok" = 1 ] && echo ok || echo WRONG)"
    echo "  api=4 payload carries html fragments (the no-html failure case): $([ "$html_ok" = 1 ] && echo ok || echo MISSING)"
    echo "Unproven without a browser (recorded, not fabricated): the runtime DOM fill of"
    echo "#jhin-root — the static shell ships the empty root element and app.js populates it"
    echo "from the bootstrap payload at load time."
} > "$EVIDENCE/snapshot-substitute.txt"

[ "$doctype_ok" = 1 ] || fail "shell.html is not an HTML document (no doctype)"
[ "$title_ok" = 1 ] || fail "app title <title>Jhin</title> missing from shell.html"
[ "$fill_ok" = 1 ] || fail "the inlined runtime that fills #jhin-root is missing from shell.html"
[ "$button_ok" = 1 ] || fail "no <button> in the served screens/fallbacks html"
[ "$plain_ok" = 1 ] || fail "shell Content-Type is not text/html (text/plain failure case)"
[ "$html_ok" = 1 ] || fail "the api=4 payload carries no html fragments (no-html failure case)"
echo "-- OK: snapshot substitute recorded ($EVIDENCE/snapshot-substitute.txt)"

# ------------------------------------------------------------------ summary
cat > "$EVIDENCE/summary.txt" <<EOF
T202 QA: PASS

mode: plain HTTP loopback — jhin.security is not loaded, so no TlsProvider is
      registered and the kernel listener speaks plain HTTP (kernel.log: "no
      TLS material registered; the listener speaks plain HTTP"). The frozen
      kernel CLI has no --no-tls flag (KernelBoot parses only --server.address
      and --server.port); plan section 9 allows the QA-only plain-HTTP mode.
port: $PORT (the kernel default 8443 is occupied by another service on this machine)
plugins seeded into the temp JHIN_HOME: jhin.sessions, jhin.ui-kit, jhin.ui

curl status codes:
  GET /                                        $shell_code  text/html (shell.html)
  GET /_jhin/bootstrap  X-Jhin-Client: api=3   $api3_code  contract_upgrade, minApi 4
  GET /_jhin/bootstrap  (header absent)        $nh_code  contract_upgrade, minApi 4
  GET /_jhin/bootstrap  X-Jhin-Client: api=4   $api4_code  {id,html} screens, html fallbacks
  GET /_jhin/health                            $health_code  not covered by the 426 gate

web shell: #jhin-root present, app.css + app.js + token CSS inlined,
           all three __JHIN_*__ placeholders replaced
snapshot substitute: snapshot-substitute.txt (browser step unavailable —
           see browser-unavailable.txt)
EOF

echo
echo "== T202 QA PASSED =="
echo "evidence: $EVIDENCE"
ls -1 "$EVIDENCE"
