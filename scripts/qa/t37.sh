#!/usr/bin/env bash
# QA for T37: the default SDUI screens — enroll, sessions, chat, settings,
# providers and plugins (kernel + sessions + ui-kit + ui-default + security +
# llm + llm-builtin + agent, with the deterministic mock provider factory
# enabled by JHIN_LLM_BUILTIN_QA=true).
# Usage: scripts/qa/t37.sh [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T37. The kernel console lands in
# <evidence>/kernel.log, every check transcript next to it. Exits non-zero on
# the first failed assertion; a stuck step fails the run instead of hanging
# (whole-run watchdog plus explicit curl timeouts). Kernels are shut down
# with SIGTERM and `wait` only — every request is --max-time bounded.
# JSON assertions run with jq (present on the QA machine; recorded in
# <evidence>/tool-versions.txt). With jhin.security loaded the listener speaks
# HTTPS on a generated self-signed keystore, so the full-bundle requests go to
# https://localhost:18443 with curl -k (the same deviation as t28); the
# minimal bundle serves plain HTTP.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T37_INNER:-}" ]; then
  exec env T37_INNER=1 timeout --kill-after=15 1200 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

evidence=${1:-.sisyphus/evidence/T37}
mkdir -p "$evidence"

kernel_pid=""
base=""
client_hdr='X-Jhin-Client: api=1; version=0.2.0; caps=sse,open_url,secure_storage,multi_profile'
cleanup() {
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

# Boots the kernel in the background against the given home and bundle dir;
# polls the health endpoint until it answers 200. Sets kernel_pid.
start_kernel() {
  local home=$1 bundled=$2 out=$3
  mkdir -p "$out"
  JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" JHIN_LLM_BUILTIN_QA=true \
    scripts/qa/run-kernel.sh "$out" --server.port=18443 &
  kernel_pid=$!
  local code=000
  for _ in $(seq 1 60); do
    code=$(curl -k -s --max-time 2 -o "$out/health.body" -w '%{http_code}' \
      -H "$client_hdr" "$base/_jhin/health" 2>/dev/null) || code=000
    if [ "$code" = "200" ]; then
      printf '%s\n' "$code" > "$out/health.status"
      return 0
    fi
    sleep 0.5
  done
  fail "health endpoint did not answer 200 in time (last code $code)"
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

log "T37 QA: default screens for enroll, sessions, chat, settings, providers and plugins"
log "evidence dir: $evidence"

command -v jq > /dev/null 2>&1 || fail "jq is required for the JSON assertions"
{
  printf 'jq: %s\n' "$(jq --version)"
  printf 'java: %s\n' "$(java -version 2>&1 | head -1)"
} > "$evidence/tool-versions.txt"
ok "jq present ($(jq --version))"

log "STEP 1: build the kernel boot jar and the plugin jars"
timeout 600 ./gradlew :kernel:bootJar :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar \
  :jhin-plugin-ui-default:jar :jhin-plugin-security:jar :jhin-plugin-llm:jar \
  :jhin-plugin-llm-builtin:jar :jhin-plugin-agent:jar > "$evidence/build.log" 2>&1 \
  || fail "gradle build failed (see $evidence/build.log)"
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
[ -f "$jar_path" ] || fail "kernel boot jar not found: $jar_path"
for plugin in sessions ui-kit ui-default security llm llm-builtin agent; do
  [ -f "plugins/$plugin/build/libs/jhin-plugin-$plugin-0.2.0.jar" ] \
    || fail "plugin jar not found: jhin-plugin-$plugin"
done
ok "build green: $jar_path + seven plugin jars"

log "STEP 2: seed one account and one enrollment code through the admin CLI"
home=$(mktemp -d /tmp/t37-home.XXXXXX)
bundled=$(mktemp -d /tmp/t37-bundled.XXXXXX)
for plugin in sessions ui-kit ui-default security llm llm-builtin agent; do
  cp "plugins/$plugin/build/libs/jhin-plugin-$plugin-0.2.0.jar" "$bundled/"
done
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\nJHIN_LLM_BUILTIN_QA=true\n' \
  "$home" "$bundled" > "$evidence/kernel-env.txt"

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
run_cli create-account create-account alice
assert_eq "$last_rc" "0" "create-account alice exit code"
run_cli create-enrollment create-enrollment alice
assert_eq "$last_rc" "0" "create-enrollment alice exit code"
enroll_code=$(sed -n 's/^code: //p' "$evidence/cli-create-enrollment.txt")
[ -n "$enroll_code" ] || fail "create-enrollment printed no code: $(cat "$evidence/cli-create-enrollment.txt")"
ok "cli seeded account alice and one enrollment code"

log "STEP 3: start the full bundle kernel on port 18443"
base="https://localhost:18443"
start_kernel "$home" "$bundled" "$evidence"
ok "kernel started (pid $kernel_pid, home $home)"
for id in jhin.sessions jhin.ui-kit jhin.ui jhin.security jhin.llm jhin.llm-builtin jhin.agent; do
  jq -e --arg id "$id" '.plugins[] | select(.id == $id)' "$evidence/health.body" > /dev/null \
    || fail "health payload does not list $id: $(cat "$evidence/health.body")"
done
ok "health lists sessions, ui-kit, ui, security, llm, llm-builtin and agent"

log "STEP 4: enroll over the UI action and capture the device token"
code=$(curl -k -s --max-time 15 -o "$evidence/enroll.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/enroll" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d "{\"action\":\"enroll\",\"payload\":{\"code\":\"$enroll_code\",\"deviceName\":\"qa-device\"}}") \
  || fail "POST /ui/action/enroll: curl failed"
printf '%s\n' "$code" > "$evidence/enroll.status"
assert_eq "$code" "200" "POST /ui/action/enroll"
jq -e '.client | map(.op) | index("setToken") != null' "$evidence/enroll.body" > /dev/null \
  || fail "enroll response lacks setToken: $(cat "$evidence/enroll.body")"
jq -e '.client | map(select(.op == "navigate")) | .[0].screen == "sessions"' \
  "$evidence/enroll.body" > /dev/null \
  || fail "enroll response lacks navigate:sessions: $(cat "$evidence/enroll.body")"
token=$(jq -r '.client | map(select(.op == "setToken")) | .[0].value' "$evidence/enroll.body")
[ -n "$token" ] && [ "$token" != "null" ] || fail "setToken carries no token"
ok "enroll -> 200 with setToken and navigate:sessions"

log "STEP 5: create one session over the UI action"
code=$(curl -k -s --max-time 15 -o "$evidence/create-session.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/create-session" \
  -H "$client_hdr" -H "Authorization: Bearer $token" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d '{"action":"create-session","payload":{"title":"t37","workdir":"/tmp"}}') \
  || fail "POST /ui/action/create-session: curl failed"
printf '%s\n' "$code" > "$evidence/create-session.status"
assert_eq "$code" "200" "POST /ui/action/create-session"
jq -e '.client | map(select(.op == "navigate")) | .[0].screen | startswith("chat:")' \
  "$evidence/create-session.body" > /dev/null \
  || fail "create-session response lacks chat navigation: $(cat "$evidence/create-session.body")"
sid=$(jq -r '.client | map(select(.op == "navigate")) | .[0].screen' \
  "$evidence/create-session.body" | sed 's/^chat://')
ok "create-session -> 200, chat:$sid"

log "STEP 6: configure the mock provider and attach it to the session"
code=$(curl -k -s --max-time 15 -o "$evidence/screen-providers.body" -w '%{http_code}' \
  -H "$client_hdr" -H "Authorization: Bearer $token" "${base}/ui/screen/providers") \
  || fail "GET /ui/screen/providers: curl failed"
printf '%s\n' "$code" > "$evidence/screen-providers.status"
assert_eq "$code" "200" "GET /ui/screen/providers"
jq -e '[.. | objects | select(.type? == "dropdown") | .items[]? | .value] | index("mock") != null' \
  "$evidence/screen-providers.body" > /dev/null \
  || fail "providers screen format dropdown lacks mock: $(cat "$evidence/screen-providers.body")"
ok "providers screen lists the mock format in its dropdown"

code=$(curl -k -s --max-time 15 -o "$evidence/create-provider.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/create-provider" \
  -H "$client_hdr" -H "Authorization: Bearer $token" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d '{"action":"create-provider","payload":{"format":"mock","model":"echo"}}') \
  || fail "POST /ui/action/create-provider: curl failed"
printf '%s\n' "$code" > "$evidence/create-provider.status"
assert_eq "$code" "200" "POST /ui/action/create-provider"
jq -e '.client | map(.op) | index("refresh") != null' "$evidence/create-provider.body" > /dev/null \
  || fail "create-provider response lacks refresh: $(cat "$evidence/create-provider.body")"
code=$(curl -k -s --max-time 15 -o "$evidence/list-providers.body" -w '%{http_code}' \
  -H "$client_hdr" -H "Authorization: Bearer $token" "${base}/providers") \
  || fail "GET /providers: curl failed"
printf '%s\n' "$code" > "$evidence/list-providers.status"
assert_eq "$code" "200" "GET /providers"
jq -e 'length == 1 and .[0].format == "mock"' "$evidence/list-providers.body" > /dev/null \
  || fail "provider list is not the one mock provider: $(cat "$evidence/list-providers.body")"
pid=$(jq -r '.[0].id' "$evidence/list-providers.body")
code=$(curl -k -s --max-time 15 -o "$evidence/attach-provider.body" -w '%{http_code}' \
  -X PATCH "${base}/sessions/$sid" \
  -H "$client_hdr" -H "Authorization: Bearer $token" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d "{\"providerId\":\"$pid\"}") || fail "PATCH /sessions: curl failed"
printf '%s\n' "$code" > "$evidence/attach-provider.status"
assert_eq "$code" "200" "PATCH /sessions/$sid"
ok "mock provider $pid created and attached to session $sid"

log "STEP 7: send one message over the UI action"
code=$(curl -k -s --max-time 15 -o "$evidence/send.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/send" \
  -H "$client_hdr" -H "Authorization: Bearer $token" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d "{\"action\":\"send\",\"payload\":{\"sessionId\":\"$sid\",\"messageInput\":\"hello\"}}") \
  || fail "POST /ui/action/send: curl failed"
printf '%s\n' "$code" > "$evidence/send.status"
assert_eq "$code" "200" "POST /ui/action/send"
jq -e '.client | length == 0' "$evidence/send.body" > /dev/null \
  || fail "send answered with directives: $(cat "$evidence/send.body")"
ok "send -> 200 with an empty directive list"

log "STEP 8: observe the text_delta-derived frames on the UI stream"
sleep 3
curl -k -sN --max-time 4 -H "$client_hdr" -H "Authorization: Bearer $token" \
  "${base}/ui/stream/session/$sid" \
  > "$evidence/stream.sse" 2> "$evidence/stream.curl.log" || true
sed -n 's/^data: //p' "$evidence/stream.sse" > "$evidence/stream-frames.jsonl"
echo_frames=$(jq -c 'select((.patch.props.text? // "") | startswith("Echo: hello"))' \
  "$evidence/stream-frames.jsonl" | wc -l | tr -d ' ')
[ "$echo_frames" -ge 1 ] || fail "no text_delta-derived frame carries the echo: $(cat "$evidence/stream-frames.jsonl")"
jq -e -s 'map(select(.node.text? == "hello")) | length >= 1' "$evidence/stream-frames.jsonl" > /dev/null \
  || fail "no frame carries the user message"
ok "stream: $echo_frames echo patch frame(s) and the user message node"

log "STEP 9: cancel a live run and a missing one"
code=$(curl -k -s --max-time 15 -o "$evidence/send2.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/send" \
  -H "$client_hdr" -H "Authorization: Bearer $token" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d "{\"action\":\"send\",\"payload\":{\"sessionId\":\"$sid\",\"messageInput\":\"second\"}}") \
  || fail "second send: curl failed"
assert_eq "$code" "200" "second POST /ui/action/send"
code=$(curl -k -s --max-time 15 -o "$evidence/cancel.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/cancel" \
  -H "$client_hdr" -H "Authorization: Bearer $token" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d "{\"action\":\"cancel\",\"payload\":{\"sessionId\":\"$sid\"}}") \
  || fail "POST /ui/action/cancel: curl failed"
printf '%s\n' "$code" > "$evidence/cancel.status"
assert_eq "$code" "200" "POST /ui/action/cancel"
jq -e '.client | map(.op) == ["toast"] and (.[0].text // "" | contains("Run cancelled"))' \
  "$evidence/cancel.body" > /dev/null \
  || fail "cancel did not answer Run cancelled: $(cat "$evidence/cancel.body")"
sleep 3
code=$(curl -k -s --max-time 15 -o "$evidence/cancel-idle.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/cancel" \
  -H "$client_hdr" -H "Authorization: Bearer $token" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d "{\"action\":\"cancel\",\"payload\":{\"sessionId\":\"$sid\"}}") \
  || fail "idle cancel: curl failed"
printf '%s\n' "$code" > "$evidence/cancel-idle.status"
assert_eq "$code" "200" "idle POST /ui/action/cancel"
jq -e '.client | map(.op) == ["toast"] and (.[0].text // "" | contains("no active run"))' \
  "$evidence/cancel-idle.body" > /dev/null \
  || fail "idle cancel did not answer no active run: $(cat "$evidence/cancel-idle.body")"
ok "cancel -> Run cancelled on a live run, no active run when idle"

log "STEP 10: failure — sending without a provider configured"
code=$(curl -k -s --max-time 15 -o "$evidence/create-session2.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/create-session" \
  -H "$client_hdr" -H "Authorization: Bearer $token" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d '{"action":"create-session","payload":{"title":"no-provider","workdir":"/tmp"}}') \
  || fail "second create-session: curl failed"
assert_eq "$code" "200" "second POST /ui/action/create-session"
sid2=$(jq -r '.client | map(select(.op == "navigate")) | .[0].screen' \
  "$evidence/create-session2.body" | sed 's/^chat://')
code=$(curl -k -s --max-time 15 -o "$evidence/send-noprovider.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/send" \
  -H "$client_hdr" -H "Authorization: Bearer $token" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d "{\"action\":\"send\",\"payload\":{\"sessionId\":\"$sid2\",\"messageInput\":\"hello\"}}") \
  || fail "send without provider: curl failed"
printf '%s\n' "$code" > "$evidence/send-noprovider.status"
assert_eq "$code" "200" "POST /ui/action/send without a provider"
jq -e '.client | map(select(.op == "toast")) | .[0].style == "error" and (.[0].text // "" | contains("no provider configured"))' \
  "$evidence/send-noprovider.body" > /dev/null \
  || fail "send without provider lacks the error toast: $(cat "$evidence/send-noprovider.body")"
sleep 1
curl -k -sN --max-time 4 -H "$client_hdr" -H "Authorization: Bearer $token" \
  "${base}/ui/stream/session/$sid2" \
  > "$evidence/stream-noprovider.sse" 2> "$evidence/stream-noprovider.curl.log" || true
sed -n 's/^data: //p' "$evidence/stream-noprovider.sse" > "$evidence/stream-noprovider-frames.jsonl"
error_frames=$(jq -c 'select(.node and (.node | tostring | contains("no provider configured")))' \
  "$evidence/stream-noprovider-frames.jsonl" | wc -l | tr -d ' ')
[ "$error_frames" -ge 1 ] || fail "no error node on the stream: $(cat "$evidence/stream-noprovider-frames.jsonl")"
ok "no provider: error toast on the action, error node on the stream ($error_frames frame(s))"

log "STEP 11: the plugins screen lists the loaded catalog"
code=$(curl -k -s --max-time 15 -o "$evidence/screen-plugins.body" -w '%{http_code}' \
  -H "$client_hdr" -H "Authorization: Bearer $token" "${base}/ui/screen/plugins") \
  || fail "GET /ui/screen/plugins: curl failed"
printf '%s\n' "$code" > "$evidence/screen-plugins.status"
assert_eq "$code" "200" "GET /ui/screen/plugins"
jq -e '[.. | objects | select(.type? == "table")] | length == 1' \
  "$evidence/screen-plugins.body" > /dev/null \
  || fail "plugins screen carries no table: $(cat "$evidence/screen-plugins.body")"
for id in jhin.ui jhin.sessions jhin.security jhin.llm jhin.agent; do
  jq -e --arg id "$id" '.. | strings | select(. == $id)' "$evidence/screen-plugins.body" > /dev/null \
    || fail "plugins screen table lacks $id"
done
ok "plugins screen renders the table with the loaded plugins"

log "STEP 12: the settings screen carries the client-owned controls"
code=$(curl -k -s --max-time 15 -o "$evidence/screen-settings.body" -w '%{http_code}' \
  -H "$client_hdr" -H "Authorization: Bearer $token" "${base}/ui/screen/settings") \
  || fail "GET /ui/screen/settings: curl failed"
printf '%s\n' "$code" > "$evidence/screen-settings.status"
assert_eq "$code" "200" "GET /ui/screen/settings"
jq -e '[.. | objects | select(.op? == "clearToken")] | length == 1' \
  "$evidence/screen-settings.body" > /dev/null || fail "settings screen lacks clearToken"
jq -e '[.. | objects | select(.op? == "openProfiles")] | length == 1' \
  "$evidence/screen-settings.body" > /dev/null || fail "settings screen lacks openProfiles"
ok "settings screen: clearToken and openProfiles present"

log "STEP 13: enrolling with a spent code is refused with a toast"
code=$(curl -k -s --max-time 15 -o "$evidence/enroll-reuse.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/enroll" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d '{"action":"enroll","payload":{"code":"'"$enroll_code"'","deviceName":"qa-second"}}') \
  || fail "second enroll: curl failed"
printf '%s\n' "$code" > "$evidence/enroll-reuse.status"
assert_eq "$code" "200" "second POST /ui/action/enroll"
jq -e '.client | map(.op) == ["toast"] and (.[0].text // "" | contains("already used"))' \
  "$evidence/enroll-reuse.body" > /dev/null \
  || fail "spent code not refused: $(cat "$evidence/enroll-reuse.body")"
ok "spent enrollment code answers with one error toast"

log "STEP 14: graceful kernel shutdown (SIGTERM and wait)"
stop_kernel
ok "kernel stopped on SIGTERM and was reaped with wait"

log "STEP 15: degradation — a runtime without the optional plugins"
home2=$(mktemp -d /tmp/t37-home-min.XXXXXX)
bundled2=$(mktemp -d /tmp/t37-bundled-min.XXXXXX)
for plugin in sessions ui-kit ui-default; do
  cp "plugins/$plugin/build/libs/jhin-plugin-$plugin-0.2.0.jar" "$bundled2/"
done
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\n' "$home2" "$bundled2" \
  > "$evidence/kernel-env-min.txt"
base="http://localhost:18443"
start_kernel "$home2" "$bundled2" "$evidence/min"
code=$(curl -k -s --max-time 15 -o "$evidence/bootstrap-min.body" -w '%{http_code}' \
  -H "$client_hdr" "${base}/_jhin/bootstrap") || fail "minimal bootstrap: curl failed"
printf '%s\n' "$code" > "$evidence/bootstrap-min.status"
assert_eq "$code" "200" "GET /_jhin/bootstrap (minimal bundle)"
jq -e '[.screens[].id] | index("connect") == null and index("providers") == null' \
  "$evidence/bootstrap-min.body" > /dev/null \
  || fail "minimal bundle exposes connect/providers: $(cat "$evidence/bootstrap-min.body")"
code=$(curl -k -s --max-time 15 -o "$evidence/enroll-min.body" -w '%{http_code}' \
  -X POST "${base}/ui/action/enroll" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d '{"action":"enroll","payload":{}}') || fail "minimal enroll: curl failed"
printf '%s\n' "$code" > "$evidence/enroll-min.status"
assert_eq "$code" "200" "POST /ui/action/enroll (minimal bundle)"
jq -e '.client | map(.op) == ["toast"] and (.[0].text // "" | contains("no security plugin"))' \
  "$evidence/enroll-min.body" > /dev/null \
  || fail "minimal enroll not degraded: $(cat "$evidence/enroll-min.body")"
ok "minimal bundle: no connect/providers screens, enroll answers with a toast"
stop_kernel
ok "minimal kernel stopped on SIGTERM and was reaped with wait"

log "STEP 16: the gate build and test suites stay green"
timeout 900 ./gradlew :jhin-plugin-ui-kit:build :jhin-plugin-ui-default:build \
  :jhin-plugin-sessions:build :kernel:test :jhin-plugin-security:build \
  :jhin-plugin-agent:build :jhin-plugin-llm:build :jhin-plugin-llm-builtin:build \
  --rerun-tasks > "$evidence/gate.log" 2>&1 \
  || fail "gate build failed (see $evidence/gate.log)"
uikit_tests=$(count_tests plugins/ui-kit/build/test-results/test)
uidefault_tests=$(count_tests plugins/ui-default/build/test-results/test)
sessions_tests=$(count_tests plugins/sessions/build/test-results/test)
kernel_tests=$(count_tests kernel/build/test-results/test)
security_tests=$(count_tests plugins/security/build/test-results/test)
agent_tests=$(count_tests plugins/agent/build/test-results/test)
llm_tests=$(count_tests plugins/llm/build/test-results/test)
llmbuiltin_tests=$(count_tests plugins/llm-builtin/build/test-results/test)
{
  printf 'exit code: 0\n'
  printf 'jhin-plugin-ui-kit: %s\n' "$uikit_tests"
  printf 'jhin-plugin-ui-default: %s\n' "$uidefault_tests"
  printf 'jhin-plugin-sessions: %s\n' "$sessions_tests"
  printf 'jhin-plugin-security: %s\n' "$security_tests"
  printf 'jhin-plugin-agent: %s\n' "$agent_tests"
  printf 'jhin-plugin-llm: %s\n' "$llm_tests"
  printf 'jhin-plugin-llm-builtin: %s\n' "$llmbuiltin_tests"
  printf 'kernel: %s\n' "$kernel_tests"
} > "$evidence/test-counts.txt"
for pair in "jhin-plugin-ui-kit:$uikit_tests" "jhin-plugin-ui-default:$uidefault_tests" \
            "jhin-plugin-sessions:$sessions_tests" "jhin-plugin-security:$security_tests" \
            "jhin-plugin-agent:$agent_tests" "jhin-plugin-llm:$llm_tests" \
            "jhin-plugin-llm-builtin:$llmbuiltin_tests" "kernel:$kernel_tests"; do
  name=${pair%%:*}
  count=${pair#*:}
  [ "$count" -ge 1 ] || fail "$name reported $count tests"
done
ok "gate green: ui-kit=$uikit_tests ui-default=$uidefault_tests sessions=$sessions_tests security=$security_tests agent=$agent_tests llm=$llm_tests llm-builtin=$llmbuiltin_tests kernel=$kernel_tests"

git add -f "$evidence"
ok "evidence staged with git add -f: $evidence"

log "T37 QA: ALL CHECKS PASSED"
