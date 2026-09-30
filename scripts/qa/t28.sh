#!/usr/bin/env bash
# QA for T28: security plugin bearer filter, enrollment rate limit, enroll
# route and generated TLS.
# Usage: scripts/qa/t28.sh [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T28. The kernel console lands in
# <evidence>/kernel.log, every check transcript next to it. Exits non-zero on
# the first failed assertion; a stuck step fails the run instead of hanging
# (whole-run watchdog plus explicit curl timeouts). The kernel is shut down
# with SIGTERM and `wait` only — no abrupt process-termination commands —
# and every request is --max-time bounded.
#
# Port deviation: the task pins port 8443, but 8443 is occupied on the QA
# machine, so the kernel runs with --server.port=18443 and every request goes
# to https://localhost:18443. The deviation is recorded in
# <evidence>/port-note.txt and in the T28 report.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T28_INNER:-}" ]; then
  exec env T28_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

evidence=${1:-.sisyphus/evidence/T28}
mkdir -p "$evidence"

kernel_pid=""
cleanup() {
  if [ -n "$kernel_pid" ] && kill -0 "$kernel_pid" 2>/dev/null; then
    kill "$kernel_pid" 2>/dev/null || true
    wait "$kernel_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT

checks="$evidence/checks.txt"
: > "$checks"

log() {
  printf '%s\n' "$*"
}

ok() {
  printf 'ok: %s\n' "$*" | tee -a "$checks"
}

fail() {
  printf 'FAIL: %s\n' "$*" | tee -a "$checks" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "$3: expected [$2], got [$1]"
}

count_tests() {
  local dir=$1 total=0 f n
  for f in "$dir"/*.xml; do
    [ -e "$f" ] || continue
    n=$(sed -n 's/.* tests="\([0-9]*\)".*/\1/p' "$f" | head -1)
    total=$((total + ${n:-0}))
  done
  printf '%s' "$total"
}

log "T28 QA: bearer filter, rate limit, enroll route and TLS"
log "evidence dir: $evidence"

log "STEP 1: build the kernel boot jar and the sessions + security plugin jars"
timeout 600 ./gradlew :kernel:bootJar :jhin-plugin-sessions:jar :jhin-plugin-security:jar \
  > "$evidence/build.log" 2>&1 \
  || fail "gradle build failed (see $evidence/build.log)"
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
sessions_jar=plugins/sessions/build/libs/jhin-plugin-sessions-0.2.0.jar
security_jar=plugins/security/build/libs/jhin-plugin-security-0.2.0.jar
[ -f "$jar_path" ] || fail "kernel boot jar not found: $jar_path"
[ -f "$sessions_jar" ] || fail "sessions plugin jar not found: $sessions_jar"
[ -f "$security_jar" ] || fail "security plugin jar not found: $security_jar"
ok "build green: $jar_path + $sessions_jar + $security_jar"

log "STEP 2: start the kernel with sessions + security on TLS port 18443"
home=$(mktemp -d /tmp/t28-home.XXXXXX)
bundled=$(mktemp -d /tmp/t28-bundled.XXXXXX)
cp "$sessions_jar" "$bundled/jhin-plugin-sessions-0.2.0.jar"
cp "$security_jar" "$bundled/jhin-plugin-security-0.2.0.jar"
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\n' \
  "$home" "$bundled" > "$evidence/kernel-env.txt"
cat > "$evidence/port-note.txt" <<'NOTE'
The T28 plan pins the HTTPS listener to port 8443, but 8443 is occupied on
this QA machine (per the task context). The kernel therefore runs with
--server.port=18443 and every request of this script goes to
https://localhost:18443. Behavior under test is unchanged: the listener is
HTTPS because the security plugin registers a TlsProvider.
NOTE
JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
  scripts/qa/run-kernel.sh "$evidence" --server.port=18443 \
  > "$evidence/kernel-stdout.log" 2>&1 &
kernel_pid=$!
ok "kernel started (pid $kernel_pid, home $home)"

health_ready=0
for _ in $(seq 1 60); do
  code=$(curl -k -s --max-time 2 -o "$evidence/health.body" -w '%{http_code}' \
    'https://localhost:18443/_jhin/health' 2>/dev/null) || code=000
  if [ "$code" = "200" ]; then
    health_ready=1
    break
  fi
  sleep 0.5
done
printf '%s\n' "$code" > "$evidence/health.status"
assert_eq "$health_ready" "1" "health endpoint did not answer 200 over HTTPS in time"
jq -e '.plugins[] | select(.id == "jhin.security")' "$evidence/health.body" > /dev/null \
  || fail "health payload does not list jhin.security: $(cat "$evidence/health.body")"
jq -e '.plugins[] | select(.id == "jhin.sessions")' "$evidence/health.body" > /dev/null \
  || fail "health payload does not list jhin.sessions: $(cat "$evidence/health.body")"
ok "https://localhost:18443/_jhin/health -> 200 unauthenticated (TLS handshake succeeded)"

plain_code=$(curl -s --max-time 2 -o "$evidence/health-plain.body" -w '%{http_code}' \
  'http://localhost:18443/_jhin/health' 2> "$evidence/health-plain.err") || plain_code=000
printf '%s\n' "$plain_code" > "$evidence/health-plain.status"
[ "$plain_code" != "200" ] \
  || fail "plaintext http:// probe got 200 — the listener is not TLS-only"
ok "plaintext http:// probe refused (status $plain_code): HTTPS is actually active"

log "STEP 3: every route except the allow-list demands a token"
code=$(curl -k -s --max-time 15 -o "$evidence/sessions-unauth.body" -w '%{http_code}' \
  'https://localhost:18443/sessions') || fail "GET /sessions unauthenticated: curl failed"
printf '%s\n' "$code" > "$evidence/sessions-unauth.status"
assert_eq "$code" "401" "GET /sessions without token"
grep -q '"error":"unauthorized"' "$evidence/sessions-unauth.body" \
  || fail "GET /sessions 401 body lacks \"error\":\"unauthorized\": $(cat "$evidence/sessions-unauth.body")"
ok "GET /sessions without token -> 401 with \"error\":\"unauthorized\""

log "STEP 4: happy path: enroll with a CLI-issued code and call with the token"
last_rc=0
run_cli() {
  local label=$1
  shift
  last_rc=0
  JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
    timeout 120 java -jar "$jar_path" cli "$@" \
    > "$evidence/cli-$label.txt" 2> "$evidence/cli-$label.err" || last_rc=$?
  printf '%s\n' "$last_rc" > "$evidence/cli-$label.rc"
}

run_cli create-account-alice create-account alice
assert_eq "$last_rc" "0" "create-account alice exit code"
alice_id=$(sed -n 's/^created account: alice (id: \(.*\))$/\1/p' "$evidence/cli-create-account-alice.txt")
[ -n "$alice_id" ] || fail "create-account did not print id: $(cat "$evidence/cli-create-account-alice.txt")"
run_cli create-enrollment-alice create-enrollment alice
assert_eq "$last_rc" "0" "create-enrollment alice exit code"
code_value=$(sed -n 's/^code: //p' "$evidence/cli-create-enrollment-alice.txt")
[ -n "$code_value" ] || fail "create-enrollment printed no code: $(cat "$evidence/cli-create-enrollment-alice.txt")"
ok "cli create-account alice -> id $alice_id, cli create-enrollment alice -> code captured"

code=$(curl -k -s --max-time 15 -o "$evidence/enroll.body" -w '%{http_code}' \
  -X POST 'https://localhost:18443/enroll' -H 'Content-Type: application/json' \
  -d "{\"code\":\"$code_value\",\"deviceName\":\"qa\"}") || fail "POST /enroll: curl failed"
printf '%s\n' "$code" > "$evidence/enroll.status"
assert_eq "$code" "200" "POST /enroll"
token=$(jq -r '.token' "$evidence/enroll.body")
device_id=$(jq -r '.deviceId' "$evidence/enroll.body")
account_name=$(jq -r '.accountName' "$evidence/enroll.body")
[ -n "$token" ] && [ "$token" != "null" ] || fail "POST /enroll returned no token: $(cat "$evidence/enroll.body")"
[ -n "$device_id" ] && [ "$device_id" != "null" ] || fail "POST /enroll returned no deviceId: $(cat "$evidence/enroll.body")"
assert_eq "$account_name" "alice" "POST /enroll accountName"
ok "POST /enroll -> 200, token captured, deviceId $device_id"

code=$(curl -k -s --max-time 15 -o "$evidence/sessions-auth.body" -w '%{http_code}' \
  -H "Authorization: Bearer $token" 'https://localhost:18443/sessions') \
  || fail "GET /sessions with token: curl failed"
printf '%s\n' "$code" > "$evidence/sessions-auth.status"
assert_eq "$code" "200" "GET /sessions with Bearer token"
jq -e 'type == "array"' "$evidence/sessions-auth.body" > /dev/null \
  || fail "GET /sessions with token did not return a JSON array: $(cat "$evidence/sessions-auth.body")"
ok "GET /sessions with Authorization: Bearer -> 200 JSON"

log "STEP 5: failure paths: the 11th rapid /enroll is 429, a revoked device is 403"
# The happy redeem above already consumed one slot of the 10-per-10-minutes
# window (same remote address), so the first 429 can arrive on rapid call 10;
# the acceptance condition is the 11th rapid call returning 429.
for i in $(seq 1 11); do
  code=$(curl -k -s --max-time 5 -o "$evidence/rate-$i.body" -w '%{http_code}' \
    -X POST 'https://localhost:18443/enroll' -H 'Content-Type: application/json' \
    -d '{"code":"RATELIMITPROBE","deviceName":"qa"}') || fail "rapid /enroll $i: curl failed"
  printf '%s\n' "$code" > "$evidence/rate-$i.status"
done
{ for i in $(seq 1 11); do printf 'rapid %s -> %s\n' "$i" "$(cat "$evidence/rate-$i.status")"; done; } \
  > "$evidence/rate-summary.txt"
assert_eq "$(cat "$evidence/rate-11.status")" "429" "rapid /enroll call 11 HTTP status"
grep -q '"error":"rate_limited"' "$evidence/rate-11.body" \
  || fail "rapid /enroll call 11 body lacks \"error\":\"rate_limited\": $(cat "$evidence/rate-11.body")"
assert_eq "$(cat "$evidence/rate-1.status")" "401" "rapid /enroll call 1 (must reach the route)"
ok "11 rapid POST /enroll: first reaches the route (401), 11th -> 429 rate_limited"

run_cli revoke-device-happy revoke-device "$device_id"
assert_eq "$last_rc" "0" "revoke-device exit code"
grep -qxF "revoked device: $device_id" "$evidence/cli-revoke-device-happy.txt" \
  || fail "revoke-device stdout unexpected: $(cat "$evidence/cli-revoke-device-happy.txt")"

code=$(curl -k -s --max-time 15 -o "$evidence/sessions-revoked.body" -w '%{http_code}' \
  -H "Authorization: Bearer $token" 'https://localhost:18443/sessions') \
  || fail "GET /sessions revoked: curl failed"
printf '%s\n' "$code" > "$evidence/sessions-revoked.status"
assert_eq "$code" "403" "GET /sessions with a revoked device token"
grep -q '"error":"forbidden"' "$evidence/sessions-revoked.body" \
  || fail "revoked 403 body lacks \"error\":\"forbidden\": $(cat "$evidence/sessions-revoked.body")"
ok "cli revoke-device $device_id, then the same token -> 403 with \"error\":\"forbidden\""

log "STEP 6: token leak scan and graceful kernel shutdown"
if grep -F -- "$token" "$evidence/kernel.log" > /dev/null 2>&1; then
  fail "the raw device token appears in the kernel log"
fi
ok "raw device token appears only in the enroll response, never in kernel.log"

kill "$kernel_pid" 2>/dev/null || true
stopped=0
for _ in $(seq 1 60); do
  if ! kill -0 "$kernel_pid" 2>/dev/null; then
    stopped=1
    break
  fi
  sleep 0.5
done
assert_eq "$stopped" "1" "kernel did not stop on SIGTERM"
wait "$kernel_pid" 2>/dev/null || true
kernel_pid=""
ok "kernel stopped on SIGTERM and was reaped with wait (no kill needed)"

log "STEP 7: test suites stay green and the plugin jar bundles BouncyCastle only"
timeout 600 ./gradlew :jhin-plugin-security:build :kernel:test --rerun-tasks \
  > "$evidence/tests.log" 2>&1 \
  || fail "build/test failed (see $evidence/tests.log)"
security_tests=$(count_tests plugins/security/build/test-results/test)
assert_eq "$security_tests" "48" "security plugin test count"
ok "security plugin build green with $security_tests tests"
printf 'exit code: 0\ntests: %s\n' "$security_tests" > "$evidence/security-tests.txt"

kernel_tests=$(count_tests kernel/build/test-results/test)
assert_eq "$kernel_tests" "101" "kernel test count"
ok "kernel tests green with $kernel_tests tests"
printf 'exit code: 0\ntests: %s\n' "$kernel_tests" > "$evidence/kernel-tests.txt"

jar tf "$security_jar" > "$evidence/security-jar-contents.txt"
grep -q '^org/bouncycastle/asn1/x500/X500Name\.class$' "$evidence/security-jar-contents.txt" \
  || fail "security plugin jar does not bundle the BouncyCastle classes"
grep -q '^org/bouncycastle/cert/jcajce/JcaX509v3CertificateBuilder\.class$' \
  "$evidence/security-jar-contents.txt" \
  || fail "security plugin jar does not bundle bcpkix"
if grep -q '^org/sqlite/' "$evidence/security-jar-contents.txt"; then
  fail "security plugin jar bundles sqlite classes"
fi
bc_count=$(grep -c '^org/bouncycastle/' "$evidence/security-jar-contents.txt" || true)
sqlite_count=$(grep -c '^org/sqlite/' "$evidence/security-jar-contents.txt" || true)
printf 'bouncycastle class entries: %s\nsqlite class entries: %s\n' \
  "$bc_count" "$sqlite_count" > "$evidence/security-jar-check.txt"
ok "security plugin jar bundles BouncyCastle ($bc_count entries), no sqlite classes"

git add -f "$evidence"
ok "evidence staged with git add -f: $evidence"

log "T28 QA: ALL CHECKS PASSED"
