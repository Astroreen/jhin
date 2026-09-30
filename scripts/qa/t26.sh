#!/usr/bin/env bash
# QA for T26: sessions REST routes and the SSE replay endpoint.
# Usage: scripts/qa/t26.sh [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T26. Kernel console lands in
# <evidence>/kernel.log, every check transcript next to it. Exits non-zero
# on the first failed assertion; a stuck step fails the run instead of
# hanging (whole-run watchdog plus explicit curl timeouts).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T26_INNER:-}" ]; then
  exec env T26_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

evidence=${1:-.sisyphus/evidence/T26}
mkdir -p "$evidence"

kernel_pid=""
cleanup() {
  if [ -n "$kernel_pid" ] && kill -0 "$kernel_pid" 2>/dev/null; then
    kill "$kernel_pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$kernel_pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$kernel_pid" 2>/dev/null || true
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

log "T26 QA: sessions REST routes and SSE replay endpoint"
log "evidence dir: $evidence"

log "STEP 1: build the kernel boot jar and the sessions plugin jar"
timeout 600 ./gradlew :kernel:bootJar :jhin-plugin-sessions:jar > "$evidence/build.log" 2>&1 \
  || fail "gradle build failed (see $evidence/build.log)"
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
sessions_jar=plugins/sessions/build/libs/jhin-plugin-sessions-0.2.0.jar
[ -f "$jar_path" ] || fail "kernel boot jar not found: $jar_path"
[ -f "$sessions_jar" ] || fail "sessions plugin jar not found: $sessions_jar"
ok "build green: $jar_path + $sessions_jar"

log "STEP 2: start the kernel with only the sessions plugin on port 18443"
home=$(mktemp -d /tmp/t26-home.XXXXXX)
bundled=$(mktemp -d /tmp/t26-bundled.XXXXXX)
cp "$sessions_jar" "$bundled/jhin-plugin-sessions-0.2.0.jar"
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\nJHIN_SESSIONS_QA=true\n' \
  "$home" "$bundled" > "$evidence/kernel-env.txt"
JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" JHIN_SESSIONS_QA=true \
  java -jar "$jar_path" --server.port=18443 > "$evidence/kernel.log" 2>&1 &
kernel_pid=$!
ok "kernel started (pid $kernel_pid, home $home)"

health_ready=0
for _ in $(seq 1 60); do
  code=$(curl -s --max-time 2 -o "$evidence/health.body" -w '%{http_code}' \
    'http://localhost:18443/_jhin/health' 2>/dev/null) || code=000
  if [ "$code" = "200" ]; then
    health_ready=1
    break
  fi
  sleep 0.5
done
printf '%s\n' "$code" > "$evidence/health.status"
assert_eq "$health_ready" "1" "health endpoint did not answer 200 in time"
jq -e '.plugins[] | select(.id == "jhin.sessions")' "$evidence/health.body" > /dev/null \
  || fail "health payload does not list jhin.sessions: $(cat "$evidence/health.body")"
plugin_count=$(jq '.plugins | length' "$evidence/health.body")
assert_eq "$plugin_count" "1" "expected exactly one loaded plugin"
ok "health 200, lists jhin.sessions as the only plugin"

log "STEP 3: happy path: create session, stream 5 events, resume"
code=$(curl -s --max-time 15 -o "$evidence/create-session.body" -w '%{http_code}' \
  -X POST 'http://localhost:18443/sessions' -H 'Content-Type: application/json' \
  -d '{"title":"t","workdir":"/tmp"}') || fail "POST /sessions: curl failed"
printf '%s\n' "$code" > "$evidence/create-session.status"
assert_eq "$code" "201" "POST /sessions"
sid=$(jq -r '.id' "$evidence/create-session.body")
[ -n "$sid" ] && [ "$sid" != "null" ] || fail "POST /sessions returned no id: $(cat "$evidence/create-session.body")"
ok "POST /sessions -> 201, id $sid"

curl --max-time 15 -N "http://localhost:18443/sessions/$sid/events?fromSeq=0" \
  > "$evidence/stream-full.sse" 2> "$evidence/stream-full.curl.log" &
stream_pid=$!
sleep 1

for i in 1 2 3 4 5; do
  code=$(curl -s --max-time 15 -o "$evidence/append-$i.body" -w '%{http_code}' \
    -X POST "http://localhost:18443/sessions/$sid/events" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"text_delta\",\"payload\":{\"n\":$i}}") || fail "event append $i: curl failed"
  assert_eq "$code" "201" "event append $i"
  got=$(jq -r '.seq' "$evidence/append-$i.body")
  assert_eq "$got" "$i" "event append $i seq"
done
ok "5 events appended via the QA helper route, seq 1..5"

stream_rc=0
wait "$stream_pid" || stream_rc=$?
printf '%s\n' "$stream_rc" > "$evidence/stream-full.rc"
[ "$stream_rc" = "0" ] || [ "$stream_rc" = "28" ] \
  || fail "stream curl exited with unexpected code $stream_rc"
sed -n 's/^data: //p' "$evidence/stream-full.sse" | jq -r '.seq' > "$evidence/stream-full.seqs" || true
sed -n 's/^data: //p' "$evidence/stream-full.sse" | jq -r '.type' > "$evidence/stream-full.types" || true
seqs=$(paste -sd' ' "$evidence/stream-full.seqs")
count=$(wc -l < "$evidence/stream-full.seqs" | tr -d ' ')
dups=$(sort "$evidence/stream-full.seqs" | uniq -d | wc -l | tr -d ' ')
assert_eq "$count" "5" "streamed event count"
assert_eq "$seqs" "1 2 3 4 5" "streamed seq order"
assert_eq "$dups" "0" "duplicate seq count"
ok "stream captured 5 events in seq order 1 2 3 4 5, duplicates: $dups"

resume_rc=0
code=$(curl -s --max-time 5 -o "$evidence/stream-resume.sse" -w '%{http_code}' \
  "http://localhost:18443/sessions/$sid/events?fromSeq=3" 2> "$evidence/stream-resume.curl.log") || resume_rc=$?
printf '%s\n' "$code" > "$evidence/stream-resume.status"
printf '%s\n' "$resume_rc" > "$evidence/stream-resume.rc"
[ "$resume_rc" = "0" ] || [ "$resume_rc" = "28" ] \
  || fail "resume curl exited with unexpected code $resume_rc"
assert_eq "$code" "200" "resume stream HTTP status"
sed -n 's/^data: //p' "$evidence/stream-resume.sse" | jq -r '.seq' > "$evidence/stream-resume.seqs" || true
resume_seqs=$(paste -sd' ' "$evidence/stream-resume.seqs")
resume_count=$(wc -l < "$evidence/stream-resume.seqs" | tr -d ' ')
assert_eq "$resume_count" "2" "resume streamed event count"
assert_eq "$resume_seqs" "4 5" "resume streamed seq order"
ok "resume fromSeq=3 -> exactly seq 4 5"

log "STEP 4: failure paths: 404 not_found and 400 naming workdir"
code=$(curl -s --max-time 15 -o "$evidence/fail-get.body" -w '%{http_code}' \
  'http://localhost:18443/sessions/nope') || fail "GET /sessions/nope: curl failed"
printf '%s\n' "$code" > "$evidence/fail-get.status"
assert_eq "$code" "404" "GET /sessions/nope HTTP status"
grep -q 'not_found' "$evidence/fail-get.body" \
  || fail "GET /sessions/nope body lacks not_found: $(cat "$evidence/fail-get.body")"
ok "GET /sessions/nope -> 404 with not_found"

code=$(curl -s --max-time 15 -o "$evidence/fail-create.body" -w '%{http_code}' \
  -X POST 'http://localhost:18443/sessions' -H 'Content-Type: application/json' -d '{}') \
  || fail "POST /sessions {}: curl failed"
printf '%s\n' "$code" > "$evidence/fail-create.status"
assert_eq "$code" "400" "POST /sessions {} HTTP status"
grep -q 'workdir' "$evidence/fail-create.body" \
  || fail "POST /sessions {} body does not name workdir: $(cat "$evidence/fail-create.body")"
ok "POST /sessions {} -> 400 naming workdir"

log "STEP 5: test suites stay green"
timeout 600 ./gradlew :jhin-plugin-sessions:build > "$evidence/sessions-build.log" 2>&1 \
  || fail "sessions plugin build failed (see $evidence/sessions-build.log)"
sessions_tests=$(count_tests plugins/sessions/build/test-results/test)
assert_eq "$sessions_tests" "27" "sessions plugin test count"
ok "sessions plugin build green with $sessions_tests tests"
printf 'exit code: 0\ntests: %s\n' "$sessions_tests" > "$evidence/sessions-tests.txt"

timeout 600 ./gradlew :kernel:test --rerun-tasks > "$evidence/kernel-test.log" 2>&1 \
  || fail "kernel tests failed (see $evidence/kernel-test.log)"
kernel_tests=$(count_tests kernel/build/test-results/test)
assert_eq "$kernel_tests" "101" "kernel test count"
ok "kernel tests green with $kernel_tests tests"
printf 'exit code: 0\ntests: %s\n' "$kernel_tests" > "$evidence/kernel-tests.txt"

git add -f "$evidence"
ok "evidence staged with git add -f: $evidence"

log "T26 QA: ALL CHECKS PASSED"
