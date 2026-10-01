#!/usr/bin/env bash
# QA for T38: the restart endpoint (jhin.reload) and the reference plugin
# (jhin.example).
# Usage: scripts/qa/t38.sh [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T38. Kernel consoles land in
# per-stage logs next to every check transcript. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). Kernels are stopped with SIGTERM and
# `wait`/gone-polling only. JSON assertions run with jq and the table check
# runs with sqlite3 (both present on the QA machine; versions recorded in
# <evidence>/tool-versions.txt). No jhin.security is loaded in any stage, so
# every request goes to plain http://localhost:18443.
#
# Stage 1 (happy, restart): the kernel runs under deploy/run.sh; POST
#   /admin/reload must answer 202 {"status":"restarting"}, the java process
#   PID must change and /_jhin/health must answer again afterwards.
# Stage 2 (happy, five surfaces): the example jar is installed into
#   $JHIN_HOME/plugins/ (user-install path of the seeder semantics) with
#   jhin.agent present; its route answers 200 and reports tools=1, its CLI
#   command exits 0, its table exists in data/jhin.db and one stream event is
#   observed live on the SSE endpoint while the status route publishes.
# Stage 3 (failure): with jhin.agent absent the example still loads and its
#   route reports tools=0.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T38_INNER:-}" ]; then
  exec env T38_INNER=1 timeout --kill-after=15 1200 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

evidence=${1:-.sisyphus/evidence/T38}
mkdir -p "$evidence"

runsh_pid=""
kernel_pid=""
cleanup() {
  if [ -n "$runsh_pid" ] && ps -p "$runsh_pid" > /dev/null 2>&1; then
    for child in $(pgrep -P "$runsh_pid" 2>/dev/null || true); do
      kill "$child" 2>/dev/null || true
    done
    kill "$runsh_pid" 2>/dev/null || true
    wait "$runsh_pid" 2>/dev/null || true
  fi
  if [ -n "$kernel_pid" ] && ps -p "$kernel_pid" > /dev/null 2>&1; then
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

base="http://localhost:18443"

# Polls the kernel health endpoint until it answers 200.
wait_health() {
  local out=$1 code=000
  mkdir -p "$out"
  for _ in $(seq 1 90); do
    code=$(curl -s --max-time 2 -o "$out/health.body" -w '%{http_code}' \
      "$base/_jhin/health" 2>/dev/null) || code=000
    if [ "$code" = "200" ]; then
      printf '%s\n' "$code" > "$out/health.status"
      return 0
    fi
    sleep 0.5
  done
  fail "health endpoint did not answer 200 in time (last code $code)"
}

# Boots the kernel in the background against the given home and bundle dir;
# polls the health endpoint until it answers 200. Sets kernel_pid.
start_kernel() {
  local home=$1 bundled=$2 out=$3
  mkdir -p "$out"
  JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
    scripts/qa/run-kernel.sh "$out" --server.port=18443 &
  kernel_pid=$!
  wait_health "$out"
}

stop_kernel() {
  kill "$kernel_pid" 2>/dev/null || true
  local stopped=0
  for _ in $(seq 1 60); do
    if ! ps -p "$kernel_pid" > /dev/null 2>&1; then
      stopped=1
      break
    fi
    sleep 0.5
  done
  assert_eq "$stopped" "1" "kernel did not stop on SIGTERM"
  wait "$kernel_pid" 2>/dev/null || true
  kernel_pid=""
}

log "T38 QA: restart endpoint and reference plugin"
log "evidence dir: $evidence"

command -v jq > /dev/null 2>&1 || fail "jq is required for the JSON assertions"
command -v sqlite3 > /dev/null 2>&1 || fail "sqlite3 is required for the table check"
command -v pgrep > /dev/null 2>&1 || fail "pgrep is required for the PID assertions"
{
  printf 'jq: %s\n' "$(jq --version)"
  printf 'java: %s\n' "$(java -version 2>&1 | head -1)"
  printf 'sqlite3: %s\n' "$(sqlite3 --version | head -1)"
} > "$evidence/tool-versions.txt"
ok "jq, java and sqlite3 present"

log "STEP 1: run the T38 gate and build the jars used by the stages"
last_rc=0
timeout 900 ./gradlew :jhin-plugin-reload:build :jhin-plugin-example:build \
  :kernel:test --rerun-tasks > "$evidence/gate.log" 2>&1 || last_rc=$?
printf '%s\n' "$last_rc" > "$evidence/gate.rc"
assert_eq "$last_rc" "0" "gate: :jhin-plugin-reload:build :jhin-plugin-example:build :kernel:test"
{
  printf 'reload: %s\n' "$(count_tests plugins/reload/build/test-results/test)"
  printf 'example: %s\n' "$(count_tests plugins/example/build/test-results/test)"
  printf 'kernel: %s\n' "$(count_tests kernel/build/test-results/test)"
} > "$evidence/test-counts.txt"
ok "gate green ($(tr '\n' ' ' < "$evidence/test-counts.txt"))"

timeout 600 ./gradlew :kernel:bootJar :jhin-plugin-sessions:jar :jhin-plugin-llm:jar \
  :jhin-plugin-agent:jar > "$evidence/build.log" 2>&1 \
  || fail "gradle build failed (see $evidence/build.log)"
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
[ -f "$jar_path" ] || fail "kernel boot jar not found: $jar_path"
for plugin in reload example sessions llm agent; do
  [ -f "plugins/$plugin/build/libs/jhin-plugin-$plugin-0.2.0.jar" ] \
    || fail "plugin jar not found: jhin-plugin-$plugin"
done
ok "build green: $jar_path + reload, example, sessions, llm, agent jars"

log "STEP 2: stage 1 - POST /admin/reload restarts the kernel under deploy/run.sh"
home1=$(mktemp -d /tmp/t38-home.XXXXXX)
bundled1=$(mktemp -d /tmp/t38-bundled.XXXXXX)
cp plugins/reload/build/libs/jhin-plugin-reload-0.2.0.jar "$bundled1/"
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\n' "$home1" "$bundled1" > "$evidence/stage1-env.txt"

JHIN_HOME="$home1" JHIN_BUNDLED_PLUGINS="$bundled1" \
  deploy/run.sh "$jar_path" --server.port=18443 > "$evidence/runsh.log" 2>&1 &
runsh_pid=$!
wait_health "$evidence/stage1"
pid_before=$(pgrep -P "$runsh_pid" | head -1)
[ -n "$pid_before" ] || fail "no java child under run.sh (pid $runsh_pid)"
printf '%s\n' "$pid_before" > "$evidence/pid-before.txt"
jq -e '.plugins[] | select(.id == "jhin.reload")' "$evidence/stage1/health.body" > /dev/null \
  || fail "health payload does not list jhin.reload: $(cat "$evidence/stage1/health.body")"
ok "run.sh loop up: run.sh pid $runsh_pid, java pid $pid_before, jhin.reload loaded"

code=$(curl -s --max-time 15 -o "$evidence/reload.body" -w '%{http_code}' \
  -X POST "$base/admin/reload") || fail "POST /admin/reload: curl failed"
printf '%s\n' "$code" > "$evidence/reload.status"
assert_eq "$code" "202" "POST /admin/reload"
jq -e '.status == "restarting" and (keys == ["status"])' "$evidence/reload.body" > /dev/null \
  || fail "reload response is not {\"status\":\"restarting\"}: $(cat "$evidence/reload.body")"
ok "POST /admin/reload -> 202 {\"status\":\"restarting\"}"

pid_after=""
for _ in $(seq 1 60); do
  pid_after=$(pgrep -P "$runsh_pid" | head -1 || true)
  if [ -n "$pid_after" ] && [ "$pid_after" != "$pid_before" ]; then
    code=$(curl -s --max-time 2 -o "$evidence/stage1/health-after.body" -w '%{http_code}' \
      "$base/_jhin/health" 2>/dev/null) || code=000
    if [ "$code" = "200" ]; then
      break
    fi
  fi
  pid_after=""
  sleep 0.5
done
[ -n "$pid_after" ] || fail "no restarted java process with a fresh PID and a live health endpoint"
printf '%s\n' "$pid_after" > "$evidence/pid-after.txt"
assert_eq "$([ "$pid_after" != "$pid_before" ] && echo changed || echo same)" "changed" \
  "java PID after /admin/reload"
jq -e '.plugins[] | select(.id == "jhin.reload")' "$evidence/stage1/health-after.body" > /dev/null \
  || fail "health after restart does not list jhin.reload: $(cat "$evidence/stage1/health-after.body")"
ok "restart observed: java pid $pid_before -> $pid_after, health answers again"

for child in $(pgrep -P "$runsh_pid" 2>/dev/null || true); do
  kill "$child" 2>/dev/null || true
done
kill "$runsh_pid" 2>/dev/null || true
wait "$runsh_pid" 2>/dev/null || true
runsh_pid=""
ok "stage 1 stopped (SIGTERM + wait)"

log "STEP 3: stage 2 - install the example jar and observe all five surfaces"
home2=$(mktemp -d /tmp/t38-home.XXXXXX)
bundled2=$(mktemp -d /tmp/t38-bundled.XXXXXX)
for plugin in sessions llm agent; do
  cp "plugins/$plugin/build/libs/jhin-plugin-$plugin-0.2.0.jar" "$bundled2/"
done
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\n' "$home2" "$bundled2" > "$evidence/stage2-env.txt"

start_kernel "$home2" "$bundled2" "$evidence/stage2a"
if jq -e '.plugins[] | select(.id == "jhin.example")' "$evidence/stage2a/health.body" > /dev/null; then
  fail "jhin.example is loaded before its jar was installed"
fi
stop_kernel
ok "stage 2a up and down without the example plugin"

cp plugins/example/build/libs/jhin-plugin-example-0.2.0.jar "$home2/plugins/"
ok "example jar installed into $home2/plugins/ (user-install path)"
start_kernel "$home2" "$bundled2" "$evidence/stage2"
jq -e '.plugins[] | select(.id == "jhin.example")' "$evidence/stage2/health.body" > /dev/null \
  || fail "health payload does not list jhin.example: $(cat "$evidence/stage2/health.body")"
jq -e '.plugins[] | select(.id == "jhin.agent")' "$evidence/stage2/health.body" > /dev/null \
  || fail "health payload does not list jhin.agent: $(cat "$evidence/stage2/health.body")"
ok "restarted with jhin.example and jhin.agent loaded"

code=$(curl -s --max-time 15 -o "$evidence/example-status.body" -w '%{http_code}' \
  "$base/example/status") || fail "GET /example/status: curl failed"
printf '%s\n' "$code" > "$evidence/example-status.status"
assert_eq "$code" "200" "GET /example/status"
jq -e '.tools == 1' "$evidence/example-status.body" > /dev/null \
  || fail "status route does not report one tool: $(cat "$evidence/example-status.body")"
jq -e '.events >= 1' "$evidence/example-status.body" > /dev/null \
  || fail "status route reports no published events: $(cat "$evidence/example-status.body")"
ok "surface 1 (route): 200 with tools=1 and events>=1 ($(cat "$evidence/example-status.body"))"

curl -sN --max-time 5 "$base/example/stream" > "$evidence/example-stream.sse" 2> "$evidence/example-stream.err" &
sse_pid=$!
sleep 1.5
curl -s --max-time 15 -o "$evidence/example-status2.body" "$base/example/status" \
  || fail "GET /example/status (stream trigger): curl failed"
wait "$sse_pid" 2>/dev/null || true
grep -q 'example_status' "$evidence/example-stream.sse" \
  || fail "no stream event observed on /example/stream: $(cat "$evidence/example-stream.sse")"
ok "surface 4 (stream): example_status observed live on the SSE endpoint"

last_rc=0
JHIN_HOME="$home2" JHIN_BUNDLED_PLUGINS="$bundled2" \
  timeout 120 java -jar "$jar_path" cli example-hello t38 \
  > "$evidence/cli-example-hello.txt" 2> "$evidence/cli-example-hello.err" || last_rc=$?
printf '%s\n' "$last_rc" > "$evidence/cli-example-hello.rc"
assert_eq "$last_rc" "0" "cli example-hello exit code"
grep -q 'hello, t38' "$evidence/cli-example-hello.txt" \
  || fail "cli example-hello printed no greeting: $(cat "$evidence/cli-example-hello.txt")"
ok "surface 2 (CLI): example-hello exited 0 and greeted"

table=$(sqlite3 "$home2/data/jhin.db" \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='jhin_example_notes'")
assert_eq "$table" "jhin_example_notes" "table jhin_example_notes in data/jhin.db"
notes=$(sqlite3 "$home2/data/jhin.db" "SELECT COUNT(*) FROM jhin_example_notes")
[ "$notes" -ge 1 ] || fail "jhin_example_notes has no recorded events (count $notes)"
ok "surface 3 (migration): jhin_example_notes exists with $notes recorded event(s)"
stop_kernel

log "STEP 4: stage 3 - the example loads without jhin.agent and registers zero tools"
home3=$(mktemp -d /tmp/t38-home.XXXXXX)
bundled3=$(mktemp -d /tmp/t38-bundled.XXXXXX)
cp plugins/example/build/libs/jhin-plugin-example-0.2.0.jar "$bundled3/"
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\n' "$home3" "$bundled3" > "$evidence/stage3-env.txt"

start_kernel "$home3" "$bundled3" "$evidence/stage3"
jq -e '.plugins[] | select(.id == "jhin.example")' "$evidence/stage3/health.body" > /dev/null \
  || fail "health payload does not list jhin.example without the agent: $(cat "$evidence/stage3/health.body")"
if jq -e '.plugins[] | select(.id == "jhin.agent")' "$evidence/stage3/health.body" > /dev/null; then
  fail "jhin.agent is loaded in the failure stage"
fi
code=$(curl -s --max-time 15 -o "$evidence/example-status-noagent.body" -w '%{http_code}' \
  "$base/example/status") || fail "GET /example/status (no agent): curl failed"
printf '%s\n' "$code" > "$evidence/example-status-noagent.status"
assert_eq "$code" "200" "GET /example/status without jhin.agent"
jq -e '.tools == 0' "$evidence/example-status-noagent.body" > /dev/null \
  || fail "status route does not report zero tools: $(cat "$evidence/example-status-noagent.body")"
ok "surface 5 (tools): jhin.example loaded without jhin.agent, route reports $(cat "$evidence/example-status-noagent.body")"
stop_kernel

log "T38 QA green: restart loop, five example surfaces and the zero-tool degradation"
