#!/usr/bin/env bash
# QA for T36: the SDUI plugin surface — bootstrap, screen, action and stream
# endpoints (kernel + sessions + ui-kit + ui-default).
# Usage: scripts/qa/t36.sh [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T36. The kernel console lands in
# <evidence>/kernel.log, every check transcript next to it. Exits non-zero on
# the first failed assertion; a stuck step fails the run instead of hanging
# (whole-run watchdog plus explicit curl timeouts). The kernel is shut down
# with SIGTERM and `wait` only — every request is --max-time bounded.
# JSON assertions run with jq (present on the QA machine; recorded in
# <evidence>/tool-versions.txt).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T36_INNER:-}" ]; then
  exec env T36_INNER=1 timeout 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

evidence=${1:-.sisyphus/evidence/T36}
mkdir -p "$evidence"

kernel_pid=""
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

log "T36 QA: bootstrap, screen, action and stream endpoints"
log "evidence dir: $evidence"

command -v jq > /dev/null 2>&1 || fail "jq is required for the JSON assertions"
{
  printf 'jq: %s\n' "$(jq --version)"
  printf 'java: %s\n' "$(java -version 2>&1 | head -1)"
} > "$evidence/tool-versions.txt"
ok "jq present ($(jq --version))"

log "STEP 1: build the kernel boot jar and the three plugin jars"
timeout 600 ./gradlew :kernel:bootJar :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar \
  :jhin-plugin-ui-default:jar > "$evidence/build.log" 2>&1 \
  || fail "gradle build failed (see $evidence/build.log)"
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
sessions_jar=plugins/sessions/build/libs/jhin-plugin-sessions-0.2.0.jar
uikit_jar=plugins/ui-kit/build/libs/jhin-plugin-ui-kit-0.2.0.jar
uidefault_jar=plugins/ui-default/build/libs/jhin-plugin-ui-default-0.2.0.jar
[ -f "$jar_path" ] || fail "kernel boot jar not found: $jar_path"
[ -f "$sessions_jar" ] || fail "sessions plugin jar not found: $sessions_jar"
[ -f "$uikit_jar" ] || fail "ui-kit plugin jar not found: $uikit_jar"
[ -f "$uidefault_jar" ] || fail "ui-default plugin jar not found: $uidefault_jar"
ok "build green: $jar_path + three plugin jars"

log "STEP 2: start the kernel with sessions + ui-kit + ui-default on port 18443"
home=$(mktemp -d /tmp/t36-home.XXXXXX)
bundled=$(mktemp -d /tmp/t36-bundled.XXXXXX)
cp "$sessions_jar" "$bundled/jhin-plugin-sessions-0.2.0.jar"
cp "$uikit_jar" "$bundled/jhin-plugin-ui-kit-0.2.0.jar"
cp "$uidefault_jar" "$bundled/jhin-plugin-ui-default-0.2.0.jar"
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\nJHIN_SESSIONS_QA=true\n' \
  "$home" "$bundled" > "$evidence/kernel-env.txt"
JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" JHIN_SESSIONS_QA=true \
  scripts/qa/run-kernel.sh "$evidence" --server.port=18443 &
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
for id in jhin.sessions jhin.ui-kit jhin.ui; do
  jq -e --arg id "$id" '.plugins[] | select(.id == $id)' "$evidence/health.body" > /dev/null \
    || fail "health payload does not list $id: $(cat "$evidence/health.body")"
done
plugin_count=$(jq '.plugins | length' "$evidence/health.body")
assert_eq "$plugin_count" "3" "expected exactly three loaded plugins"
ok "health 200, lists jhin.sessions, jhin.ui-kit and jhin.ui"

log "STEP 3: create one session so the session screen carries an activity stream"
code=$(curl -s --max-time 15 -o "$evidence/create-session.body" -w '%{http_code}' \
  -X POST 'http://localhost:18443/sessions' -H 'Content-Type: application/json' \
  -d '{"title":"t36","workdir":"/tmp"}') || fail "POST /sessions: curl failed"
printf '%s\n' "$code" > "$evidence/create-session.status"
assert_eq "$code" "201" "POST /sessions"
sid=$(jq -r '.id' "$evidence/create-session.body")
[ -n "$sid" ] && [ "$sid" != "null" ] || fail "POST /sessions returned no id"
ok "POST /sessions -> 201, id $sid"

log "STEP 4: happy bootstrap: empty=false, entry is a screen id, screens >= 1"
code=$(curl -s --max-time 15 -o "$evidence/bootstrap.body" -w '%{http_code}' \
  'http://localhost:18443/_jhin/bootstrap') || fail "GET /_jhin/bootstrap: curl failed"
printf '%s\n' "$code" > "$evidence/bootstrap.status"
assert_eq "$code" "200" "GET /_jhin/bootstrap"
jq -r '.empty, .entry, (.screens|length)' "$evidence/bootstrap.body" > "$evidence/bootstrap-summary.txt"
empty=$(jq -r '.empty' "$evidence/bootstrap.body")
entry=$(jq -r '.entry' "$evidence/bootstrap.body")
screen_count=$(jq '.screens | length' "$evidence/bootstrap.body")
assert_eq "$empty" "false" "bootstrap .empty"
jq -e --arg entry "$entry" '.screens[] | select(.id == $entry)' "$evidence/bootstrap.body" > /dev/null \
  || fail "bootstrap .entry [$entry] is not one of the screen ids"
[ "$screen_count" -ge 1 ] || fail "bootstrap .screens length is $screen_count"
ok "bootstrap: empty=false, entry=$entry, screens=$screen_count"

log "STEP 5: GET /ui/screen/sessions answers 200 with id and node"
code=$(curl -s --max-time 15 -o "$evidence/screen-sessions.body" -w '%{http_code}' \
  'http://localhost:18443/ui/screen/sessions') || fail "GET /ui/screen/sessions: curl failed"
printf '%s\n' "$code" > "$evidence/screen-sessions.status"
assert_eq "$code" "200" "GET /ui/screen/sessions"
assert_eq "$(jq -r '.id' "$evidence/screen-sessions.body")" "sessions" "screen response .id"
jq -e '.node.type' "$evidence/screen-sessions.body" > /dev/null \
  || fail "screen response carries no node: $(cat "$evidence/screen-sessions.body")"
ok "GET /ui/screen/sessions -> 200 with id=sessions and a node"

log "STEP 6: POST /ui/action/nope answers 404 unknown_action"
code=$(curl -s --max-time 15 -o "$evidence/action-nope.body" -w '%{http_code}' \
  -X POST 'http://localhost:18443/ui/action/nope' -H 'Content-Type: application/json' \
  -d '{"action":"nope","payload":{}}') || fail "POST /ui/action/nope: curl failed"
printf '%s\n' "$code" > "$evidence/action-nope.status"
assert_eq "$code" "404" "POST /ui/action/nope HTTP status"
grep -q 'unknown_action' "$evidence/action-nope.body" \
  || fail "POST /ui/action/nope body lacks unknown_action: $(cat "$evidence/action-nope.body")"
ok "POST /ui/action/nope -> 404 with unknown_action"

log "STEP 7: bootstrap fallbacks keys and capability tailoring"
code=$(curl -s --max-time 15 -o "$evidence/bootstrap-caps-sse.body" -w '%{http_code}' \
  -H 'X-Jhin-Client: api=1; version=0.2.0; caps=sse' \
  'http://localhost:18443/_jhin/bootstrap') || fail "bootstrap caps=sse: curl failed"
printf '%s\n' "$code" > "$evidence/bootstrap-caps-sse.status"
assert_eq "$code" "200" "bootstrap caps=sse"
jq -c '.fallbacks|keys' "$evidence/bootstrap-caps-sse.body" > "$evidence/fallbacks-keys.txt"
fallbacks=$(cat "$evidence/fallbacks-keys.txt")
assert_eq "$fallbacks" '["error","offline"]' "bootstrap .fallbacks|keys"
ok "fallbacks keys: $fallbacks"

code=$(curl -s --max-time 15 -o "$evidence/bootstrap-caps-full.body" -w '%{http_code}' \
  -H 'X-Jhin-Client: api=1; version=0.2.0; caps=sse,open_url,secure_storage,multi_profile' \
  'http://localhost:18443/_jhin/bootstrap') || fail "bootstrap full caps: curl failed"
printf '%s\n' "$code" > "$evidence/bootstrap-caps-full.status"
jq '[.. | objects | select(.type? == "stream_view")] | length' \
  "$evidence/bootstrap-caps-full.body" > "$evidence/scan-full-streamview.txt"
jq '[.. | objects | select(.op? == "openUrl")] | length' \
  "$evidence/bootstrap-caps-full.body" > "$evidence/scan-full-openurl.txt"
assert_eq "$(cat "$evidence/scan-full-streamview.txt")" "1" "full caps: stream_view count"
assert_eq "$(cat "$evidence/scan-full-openurl.txt")" "1" "full caps: openUrl op count"
ok "full caps: one stream_view node and one openUrl op in the payload"

code=$(curl -s --max-time 15 -o "$evidence/bootstrap-caps-empty.body" -w '%{http_code}' \
  -H 'X-Jhin-Client: api=1; caps=' \
  'http://localhost:18443/_jhin/bootstrap') || fail "bootstrap caps=: curl failed"
printf '%s\n' "$code" > "$evidence/bootstrap-caps-empty.status"
assert_eq "$code" "200" "bootstrap caps="
jq '[.. | objects | select(.type? == "stream_view")] | length' \
  "$evidence/bootstrap-caps-empty.body" > "$evidence/scan-empty-streamview.txt"
jq '[.. | objects | select(.op? == "openUrl")] | length' \
  "$evidence/bootstrap-caps-empty.body" > "$evidence/scan-empty-openurl.txt"
jq '[.. | objects | select(.op? == "setToken")] | length' \
  "$evidence/bootstrap-caps-empty.body" > "$evidence/scan-empty-settoken.txt"
assert_eq "$(cat "$evidence/scan-empty-streamview.txt")" "0" "caps=: stream_view count"
assert_eq "$(cat "$evidence/scan-empty-openurl.txt")" "0" "caps=: openUrl op count"
assert_eq "$(cat "$evidence/scan-empty-settoken.txt")" "0" "caps=: setToken op count"
jq '[.. | objects | select(.type? == "list")] | length' \
  "$evidence/bootstrap-caps-empty.body" > "$evidence/scan-empty-lists.txt"
lists=$(cat "$evidence/scan-empty-lists.txt")
[ "$lists" -ge 1 ] || fail "caps=: expected a snapshot list node, found $lists"
ok "caps=: no stream_view nodes, no openUrl/setToken ops, $lists list snapshot(s)"

log "STEP 8: session stream translates events into SDUI frames"
code=$(curl -s --max-time 15 -o "$evidence/append-1.body" -w '%{http_code}' \
  -X POST "http://localhost:18443/sessions/$sid/events" -H 'Content-Type: application/json' \
  -d '{"type":"user_message","payload":{"text":"hello"}}') || fail "append 1: curl failed"
assert_eq "$code" "201" "append user_message"

curl -sN --max-time 8 "http://localhost:18443/ui/stream/session/$sid" \
  > "$evidence/stream.sse" 2> "$evidence/stream.curl.log" &
stream_pid=$!
sleep 1

for step in 'message_start|{"role":"assistant"}' 'text_delta|{"text":"Hi"}' 'message_end|{"text":"Hi"}'; do
  type=${step%%|*}
  payload=${step#*|}
  code=$(curl -s --max-time 15 -o "$evidence/append-live.body" -w '%{http_code}' \
    -X POST "http://localhost:18443/sessions/$sid/events" -H 'Content-Type: application/json' \
    -d "{\"type\":\"$type\",\"payload\":$payload}") || fail "append $type: curl failed"
  assert_eq "$code" "201" "append $type"
done

stream_rc=0
wait "$stream_pid" || stream_rc=$?
printf '%s\n' "$stream_rc" > "$evidence/stream.rc"
[ "$stream_rc" = "0" ] || [ "$stream_rc" = "28" ] \
  || fail "stream curl exited with unexpected code $stream_rc"
sed -n 's/^data: //p' "$evidence/stream.sse" > "$evidence/stream-frames.jsonl"
frame_count=$(wc -l < "$evidence/stream-frames.jsonl" | tr -d ' ')
[ "$frame_count" -ge 4 ] || fail "expected at least 4 stream frames, got $frame_count"
node_frames=$(jq -c 'select(.node)' "$evidence/stream-frames.jsonl" | wc -l | tr -d ' ')
patch_frames=$(jq -c 'select(.patch)' "$evidence/stream-frames.jsonl" | wc -l | tr -d ' ')
[ "$node_frames" -ge 2 ] || fail "expected at least 2 node frames, got $node_frames"
[ "$patch_frames" -ge 2 ] || fail "expected at least 2 patch frames, got $patch_frames"
replayed=$(jq -c 'select(.node.id=="ev-1")' "$evidence/stream-frames.jsonl" | wc -l | tr -d ' ')
assert_eq "$replayed" "1" "replayed user_message node count"
user_frames=$(jq -c 'select(.node.text=="hello")' "$evidence/stream-frames.jsonl" | wc -l | tr -d ' ')
[ "$user_frames" -ge 1 ] || fail "no frame carries the user message text"
ok "stream: $frame_count frames ($node_frames node, $patch_frames patch), replay + live, no duplicates"

log "STEP 9: failure check — no providers screen while jhin.llm is absent"
jq -r '[.screens[].id] | join(",")' "$evidence/bootstrap-caps-empty.body" > "$evidence/screen-ids.txt"
if grep -q 'providers' "$evidence/screen-ids.txt"; then
  fail "bootstrap lists a providers screen without jhin.llm: $(cat "$evidence/screen-ids.txt")"
fi
ok "no providers screen in the payload (screens: $(cat "$evidence/screen-ids.txt"))"

log "STEP 10: graceful kernel shutdown (SIGTERM and wait)"
kill "$kernel_pid" 2>/dev/null || true
stopped=0
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
ok "kernel stopped on SIGTERM and was reaped with wait"

log "STEP 11: the gate build and test suites stay green"
timeout 600 ./gradlew :jhin-plugin-ui-kit:build :jhin-plugin-ui-default:build \
  :jhin-plugin-sessions:build :kernel:test --rerun-tasks > "$evidence/gate.log" 2>&1 \
  || fail "gate build failed (see $evidence/gate.log)"
uikit_tests=$(count_tests plugins/ui-kit/build/test-results/test)
uidefault_tests=$(count_tests plugins/ui-default/build/test-results/test)
sessions_tests=$(count_tests plugins/sessions/build/test-results/test)
kernel_tests=$(count_tests kernel/build/test-results/test)
{
  printf 'exit code: 0\n'
  printf 'jhin-plugin-ui-kit: %s\n' "$uikit_tests"
  printf 'jhin-plugin-ui-default: %s\n' "$uidefault_tests"
  printf 'jhin-plugin-sessions: %s\n' "$sessions_tests"
  printf 'kernel: %s\n' "$kernel_tests"
} > "$evidence/test-counts.txt"
for pair in "jhin-plugin-ui-kit:$uikit_tests" "jhin-plugin-ui-default:$uidefault_tests" \
            "jhin-plugin-sessions:$sessions_tests" "kernel:$kernel_tests"; do
  name=${pair%%:*}
  count=${pair#*:}
  [ "$count" -ge 1 ] || fail "$name reported $count tests"
done
ok "gate green: ui-kit=$uikit_tests ui-default=$uidefault_tests sessions=$sessions_tests kernel=$kernel_tests"

git add -f "$evidence"
ok "evidence staged with git add -f: $evidence"

log "T36 QA: ALL CHECKS PASSED"
