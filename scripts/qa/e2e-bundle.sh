#!/usr/bin/env bash
# QA for T46: end-to-end — the full release bundle runs one real agent turn
# and survives plugin deletion.
# Usage: scripts/qa/e2e-bundle.sh [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T46. The full script transcript
# lands in <evidence>/e2e-bundle.txt (mirrored on the console), both kernel
# consoles in kernel-1.log / kernel-2.log, both captured event streams in
# events-1.sse / events-2.sse, every assertion in checks.txt, the deletion
# phase transcript in phase2-no-tools.txt and the failure-mode contrast in
# failure.txt. All assertions run and are listed even when one fails; the run
# exits non-zero when any assertion failed.
#
# Flow: ./gradlew dist assembles the release bundle (the qa-mock-llm harness
# is built with it, never shipped); a fresh JHIN_HOME is seeded from
# JHIN_BUNDLED_PLUGINS holding the ten default plugin jars plus the
# jhin-plugin-qa-mock-llm jar; the dist kernel jar boots with
# --server.port=18443 under the run-kernel.sh conventions (one foreground
# java process, console captured, SIGTERM + wait to stop). dist/run.sh itself
# is a never-ending restart loop that cannot be stopped with SIGTERM, so the
# kernel jar is run directly — the release artifact under test is the same
# dist/jhin-kernel-0.2.0.jar.
#
# Full bundle has jhin.security, so the listener is TLS and every request goes
# to https://localhost:18443 with curl -k (the t28/t37 pattern). The device
# token comes from POST /enroll with a CLI-issued single-use code. One mock
# provider (format mock, served by the jhin.qa-mock-llm harness) drives one
# real agent turn: the scripted model calls the write tool once
# (tool_use/tool_result, a file lands in the session workdir) and then answers
# with text. The deletability phase removes jhin-plugin-tools-builtin-*.jar
# from $JHIN_HOME/plugins, restarts the host and proves the agent still runs
# with zero tools: message_end without any tool_use.
#
# JHIN_LLM_BUILTIN_QA is explicitly unset everywhere: only jhin.qa-mock-llm
# serves format mock (the llm-builtin echo mock stays off and cannot collide
# on the service qualifier).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${E2E_BUNDLE_INNER:-}" ]; then
  exec env E2E_BUNDLE_INNER=1 timeout --kill-after=15 1200 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

evidence=${1:-.sisyphus/evidence/T46}
mkdir -p "$evidence"
exec > >(tee "$evidence/e2e-bundle.txt") 2>&1

base="https://localhost:18443"
client_hdr='X-Jhin-Client: api=4; version=0.0.0-web; schema=5; caps=sse,open_url,secure_storage'
kernel_pid=""
token=""
sid=""
failures=0

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

# Assertion failure: recorded and counted; the run continues so every
# property is listed, and exits non-zero at the end.
bad() {
  printf 'FAIL: %s\n' "$*" | tee -a "$checks" >&2
  failures=$((failures + 1))
}

# Hard failure: the run cannot continue (prerequisites, build, boot).
fail() {
  printf 'FAIL: %s\n' "$*" | tee -a "$checks" >&2
  exit 1
}

assert_eq() {
  if [ "$1" = "$2" ]; then
    ok "$3"
  else
    bad "$3: expected [$2], got [$1]"
  fi
}

# Boots the dist kernel jar in the background (run-kernel.sh conventions);
# polls the TLS health endpoint until it answers 200. Sets kernel_pid.
start_kernel() {
  local out=$1
  env -u JHIN_LLM_BUILTIN_QA JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
    java -jar dist/jhin-kernel-0.2.0.jar --server.port=18443 \
    > >(tee "$out") 2>&1 &
  kernel_pid=$!
  local code=000
  for _ in $(seq 1 90); do
    code=$(curl -k -s --max-time 2 -o "$evidence/health.body" -w '%{http_code}' \
      -H "$client_hdr" "$base/_jhin/health" 2>/dev/null) || code=000
    if [ "$code" = "200" ]; then
      printf '%s\n' "$code" > "$evidence/health.status"
      return 0
    fi
    kill -0 "$kernel_pid" 2>/dev/null \
      || fail "kernel (pid $kernel_pid) exited before health answered"
    sleep 0.5
  done
  fail "health endpoint did not answer 200 in time (last code $code)"
}

# Stops the kernel with SIGTERM, polls until it is gone and reaps it with
# `wait`; rc 143 (killed by SIGTERM after its shutdown hook) is graceful.
stop_kernel() {
  local label=$1
  kill "$kernel_pid" 2>/dev/null || true
  local stopped=0
  for _ in $(seq 1 60); do
    if ! kill -0 "$kernel_pid" 2>/dev/null; then
      stopped=1
      break
    fi
    sleep 0.5
  done
  [ "$stopped" = "1" ] || fail "kernel ($label) did not stop on SIGTERM"
  local rc=0
  wait "$kernel_pid" 2>/dev/null || rc=$?
  kernel_pid=""
  printf '%s\n' "$rc" > "$evidence/kernel-$label.rc"
  case "$rc" in
    0 | 143)
      ok "kernel $label stopped on SIGTERM and was reaped with wait (rc $rc)"
      ;;
    *)
      bad "kernel $label wait rc $rc (expected 0 or 143)"
      ;;
  esac
}

# Streams GET /sessions/{id}/events?fromSeq=N into $1 until the event type
# $2 appears in the stream (then the curl is stopped) or the poll window
# expires. The SSE preamble replays the stored rows, so a run that already
# finished is still observed.
consume_events() {
  local out=$1 from=$2 until_type=$3
  curl -k -sN --max-time 90 -H "$client_hdr" -H "Authorization: Bearer $token" \
    "$base/sessions/$sid/events?fromSeq=$from" \
    > "$out" 2> "$out.curl.log" &
  local cpid=$!
  local seen=0
  for _ in $(seq 1 120); do
    if sed -n 's/^data: //p' "$out" 2> /dev/null | jq -r '.type' 2> /dev/null \
        | grep -qx "$until_type"; then
      seen=1
      break
    fi
    kill -0 "$cpid" 2>/dev/null || break
    sleep 0.5
  done
  kill "$cpid" 2>/dev/null || true
  wait "$cpid" 2>/dev/null || true
  sed -n 's/^data: //p' "$out" | jq -r '.type' > "$out.types"
  [ "$seen" = "1" ] || fail "event stream $out never showed $until_type: $(tr '\n' ' ' < "$out.types")"
}

# Asserts that the event types in $1 contain the remaining arguments in order
# (other types may interleave; each wanted type must appear after the last).
assert_order() {
  local types_file=$1
  shift
  local want idx=0 found i t
  for want in "$@"; do
    found=-1
    i=0
    while IFS= read -r t; do
      i=$((i + 1))
      if [ "$t" = "$want" ] && [ "$i" -gt "$idx" ]; then
        found=$i
        break
      fi
    done < "$types_file"
    if [ "$found" -lt 0 ]; then
      bad "event sequence lacks $want after position $idx: $(tr '\n' ' ' < "$types_file")"
      return 0
    fi
    idx=$found
  done
  ok "event sequence contains in order: $*"
  return 0
}

# The last tool count the qa-mock-llm harness observed in a kernel log.
observed_tool_count() {
  sed -n 's/.*tool specifications observed: \([0-9][0-9]*\).*/\1/p' "$1" | tail -1
}

log "T46 QA: end-to-end — the full bundle runs an agent turn and survives plugin deletion"
log "evidence dir: $evidence"

command -v jq > /dev/null 2>&1 || fail "jq is required for the JSON assertions"
{
  printf 'jq: %s\n' "$(jq --version)"
  printf 'java: %s\n' "$(java -version 2>&1 | head -1)"
} > "$evidence/tool-versions.txt"
ok "jq and java present"

log "STEP 1: build the release bundle and the qa-mock-llm harness tests"
timeout 900 ./gradlew dist :jhin-plugin-qa-mock-llm:test > "$evidence/build.log" 2>&1 \
  || fail "gradle build failed (see $evidence/build.log)"
find dist -type f | sort > "$evidence/dist-listing.txt"
[ -f dist/jhin-kernel-0.2.0.jar ] || fail "dist kernel jar missing"
[ -f dist/run.sh ] || fail "dist run.sh missing"
default_count=$(ls dist/plugins-default/*.jar 2> /dev/null | wc -l | tr -d ' ')
assert_eq "$default_count" "10" "dist/plugins-default carries exactly the ten default plugin jars"
if grep -E 'example|qa-mock' "$evidence/dist-listing.txt" > /dev/null; then
  bad "dist listing leaks a non-shipped plugin: $(grep -E 'example|qa-mock' "$evidence/dist-listing.txt")"
else
  ok "dist listing shows neither jhin-plugin-example nor jhin-plugin-qa-mock-llm"
fi
qa_jar=plugins/qa-mock-llm/build/libs/jhin-plugin-qa-mock-llm-0.2.0.jar
[ -f "$qa_jar" ] || fail "qa-mock-llm harness jar not found: $qa_jar"
ok "build green: dist/jhin-kernel-0.2.0.jar + 10 default plugins + harness $qa_jar"

log "STEP 2: seed a fresh JHIN_HOME from the bundle plus the harness jar"
home=$(mktemp -d /tmp/e2e-bundle-home.XXXXXX)
bundled=$(mktemp -d /tmp/e2e-bundle-bundled.XXXXXX)
workdir=$(mktemp -d /tmp/e2e-bundle-work.XXXXXX)
cp dist/plugins-default/*.jar "$bundled/"
cp "$qa_jar" "$bundled/"
bundled_count=$(ls "$bundled"/*.jar | wc -l | tr -d ' ')
assert_eq "$bundled_count" "11" "bundled plugin dir holds 10 default jars + the qa-mock-llm jar"
{
  printf 'JHIN_HOME=%s\n' "$home"
  printf 'JHIN_BUNDLED_PLUGINS=%s\n' "$bundled"
  printf 'workdir=%s\n' "$workdir"
  printf 'JHIN_LLM_BUILTIN_QA=unset (only jhin.qa-mock-llm serves format mock)\n'
} > "$evidence/kernel-env.txt"

log "STEP 3: boot the full bundle on TLS port 18443"
start_kernel "$evidence/kernel-1.log"
ok "kernel up on $base (pid $kernel_pid, home $home)"
plugins_count=$(jq -r '(.plugins | length)' "$evidence/health.body")
assert_eq "$plugins_count" "11" "health lists all eleven seeded plugins"
for id in jhin.sessions jhin.security jhin.llm jhin.llm-builtin jhin.agent \
          jhin.tools-builtin jhin.mcp jhin.ui-kit jhin.ui jhin.reload jhin.qa-mock-llm; do
  if jq -e --arg id "$id" '.plugins[] | select(.id == $id)' "$evidence/health.body" > /dev/null; then
    ok "health lists $id"
  else
    bad "health payload does not list $id: $(cat "$evidence/health.body")"
  fi
done
home_count=$(ls "$home/plugins"/*.jar 2> /dev/null | wc -l | tr -d ' ')
assert_eq "$home_count" "11" "the seeder copied all eleven jars into \$JHIN_HOME/plugins"

log "STEP 4: seed one account and one enrollment code through the admin CLI"
last_rc=0
run_cli() {
  local label=$1
  shift
  last_rc=0
  env -u JHIN_LLM_BUILTIN_QA JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
    timeout 120 java -jar dist/jhin-kernel-0.2.0.jar cli "$@" \
    > "$evidence/cli-$label.txt" 2> "$evidence/cli-$label.err" || last_rc=$?
  printf '%s\n' "$last_rc" > "$evidence/cli-$label.rc"
}
run_cli create-account create-account qa
assert_eq "$last_rc" "0" "cli create-account qa exit code"
run_cli create-enrollment create-enrollment qa
assert_eq "$last_rc" "0" "cli create-enrollment qa exit code"
enroll_code=$(sed -n 's/^code: //p' "$evidence/cli-create-enrollment.txt")
[ -n "$enroll_code" ] \
  || fail "create-enrollment printed no code: $(cat "$evidence/cli-create-enrollment.txt")"
ok "cli create-account qa and create-enrollment qa, code captured once"

log "STEP 5: enroll a device with the single-use code"
code=$(curl -k -s --max-time 15 -o "$evidence/enroll.body" -w '%{http_code}' \
  -X POST "$base/enroll" -H "$client_hdr" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$enroll_code\",\"deviceName\":\"e2e-bundle\"}") \
  || fail "POST /enroll: curl failed"
printf '%s\n' "$code" > "$evidence/enroll.status"
assert_eq "$code" "200" "POST /enroll"
token=$(jq -r '.token' "$evidence/enroll.body")
[ -n "$token" ] && [ "$token" != "null" ] \
  || fail "POST /enroll returned no token: $(cat "$evidence/enroll.body")"
ok "POST /enroll -> 200, device token captured"

log "STEP 6: create the mock provider"
code=$(curl -k -s --max-time 15 -o "$evidence/providers.body" -w '%{http_code}' \
  -X POST "$base/providers" -H "$client_hdr" -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  -d '{"format":"mock","model":"mock-1"}') \
  || fail "POST /providers: curl failed"
printf '%s\n' "$code" > "$evidence/providers.status"
assert_eq "$code" "201" "POST /providers {format:mock, model:mock-1}"
pid=$(jq -r '.id' "$evidence/providers.body")
[ -n "$pid" ] && [ "$pid" != "null" ] \
  || fail "POST /providers returned no id: $(cat "$evidence/providers.body")"
code=$(curl -k -s --max-time 15 -o "$evidence/formats.body" -w '%{http_code}' \
  -H "$client_hdr" -H "Authorization: Bearer $token" "$base/providers/formats") \
  || fail "GET /providers/formats: curl failed"
printf '%s\n' "$code" > "$evidence/formats.status"
if jq -e 'index("mock") != null' "$evidence/formats.body" > /dev/null; then
  ok "GET /providers/formats lists mock (harness factory visible), provider id $pid"
else
  bad "GET /providers/formats lacks mock: $(cat "$evidence/formats.body")"
fi

log "STEP 7: create the session with a fresh workdir"
code=$(curl -k -s --max-time 15 -o "$evidence/session.body" -w '%{http_code}' \
  -X POST "$base/sessions" -H "$client_hdr" -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"t46\",\"workdir\":\"$workdir\",\"providerId\":\"$pid\"}") \
  || fail "POST /sessions: curl failed"
printf '%s\n' "$code" > "$evidence/session.status"
assert_eq "$code" "201" "POST /sessions {title, workdir, providerId}"
sid=$(jq -r '.id' "$evidence/session.body")
[ -n "$sid" ] && [ "$sid" != "null" ] \
  || fail "POST /sessions returned no id: $(cat "$evidence/session.body")"
ok "POST /sessions -> 201, session $sid (workdir $workdir)"

log "STEP 8: run one real agent turn and consume the event stream"
code=$(curl -k -s --max-time 15 -o "$evidence/messages-1.body" -w '%{http_code}' \
  -X POST "$base/sessions/$sid/messages" -H "$client_hdr" \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"text":"do the work"}') \
  || fail "POST /sessions/{id}/messages: curl failed"
printf '%s\n' "$code" > "$evidence/messages-1.status"
assert_eq "$code" "202" "POST /sessions/{id}/messages {text:do the work}"
run1=$(jq -r '.runId' "$evidence/messages-1.body")
[ -n "$run1" ] && [ "$run1" != "null" ] \
  || fail "POST /sessions/{id}/messages returned no runId: $(cat "$evidence/messages-1.body")"
consume_events "$evidence/events-1.sse" 0 run_end
assert_order "$evidence/events-1.sse.types" \
  run_start tool_use tool_result message_end run_end
tool_name=$(sed -n 's/^data: //p' "$evidence/events-1.sse" \
  | jq -r 'select(.type == "tool_use") | (.payload | if type == "string" then fromjson else . end) | .name' \
  | head -1)
assert_eq "$tool_name" "write" "the tool_use event names the write tool"
written="$workdir/qa-mock-output.txt"
if [ -f "$written" ]; then
  ok "the tool-written file exists in the session workdir: $written"
else
  bad "the tool-written file is missing from $workdir: $(ls -la "$workdir")"
fi
code=$(curl -k -s --max-time 15 -o "$evidence/bootstrap.body" -w '%{http_code}' \
  -H "$client_hdr" "$base/_jhin/bootstrap") || fail "GET /_jhin/bootstrap: curl failed"
printf '%s\n' "$code" > "$evidence/bootstrap.status"
assert_eq "$code" "200" "GET /_jhin/bootstrap -> 200 at api=4 (contract level 4)"
if jq -e '(.screens | length) > 0 and all(.screens[]; (.id | length) > 0 and (.html | length) > 0)' \
    "$evidence/bootstrap.body" > /dev/null; then
  ok "GET /_jhin/bootstrap carries screens[].html (level-4 shape)"
else
  bad "bootstrap lacks screens[].html: $(cat "$evidence/bootstrap.body")"
fi
for screen_id in "sessions" "chat:$sid"; do
  screen_key=${screen_id%%:*}
  code=$(curl -k -s --max-time 15 -o "$evidence/screen-$screen_key.body" -w '%{http_code}' \
    -H "$client_hdr" -H "Authorization: Bearer $token" "$base/ui/screen/$screen_id") \
    || fail "GET /ui/screen/$screen_id: curl failed"
  printf '%s\n' "$code" > "$evidence/screen-$screen_key.status"
  assert_eq "$code" "200" "GET /ui/screen/$screen_id -> 200 (screen reachable)"
  if jq -e --arg id "$screen_id" '.id == $id and (.html | length) > 0' \
      "$evidence/screen-$screen_key.body" > /dev/null; then
    ok "GET /ui/screen/$screen_id answers {id, html} (level-4 shape)"
  else
    bad "GET /ui/screen/$screen_id lacks {id, html}: $(cat "$evidence/screen-$screen_key.body")"
  fi
done
count1=$(observed_tool_count "$evidence/kernel-1.log")
if [ -n "$count1" ] && [ "$count1" -gt 0 ] 2> /dev/null; then
  ok "harness seam: the model observed $count1 tool specification(s) in phase 1"
else
  bad "harness seam: phase 1 model calls reported no tool count: $(grep 'tool specifications observed' "$evidence/kernel-1.log" | tail -3)"
fi
max_seq=$(sed -n 's/^data: //p' "$evidence/events-1.sse" | jq -r '.seq' | sort -n | tail -1)
ok "phase 1 captured $(wc -l < "$evidence/events-1.sse.types") events, last seq $max_seq"

log "STEP 9: deletability — remove the tools plugin jar and restart"
rm -f "$home/plugins"/jhin-plugin-tools-builtin-*.jar
home_count=$(ls "$home/plugins"/*.jar 2> /dev/null | wc -l | tr -d ' ')
assert_eq "$home_count" "10" "jhin-plugin-tools-builtin jar removed from \$JHIN_HOME/plugins"
stop_kernel boot1
start_kernel "$evidence/kernel-2.log"
ok "kernel restarted on $base (pid $kernel_pid) without the tools plugin"
if jq -e '.plugins[] | select(.id == "jhin.tools-builtin")' "$evidence/health.body" > /dev/null; then
  bad "health still lists jhin.tools-builtin after deletion: $(cat "$evidence/health.body")"
else
  ok "health no longer lists jhin.tools-builtin (deletion is final)"
fi
plugins_count=$(jq -r '(.plugins | length)' "$evidence/health.body")
assert_eq "$plugins_count" "10" "health lists the remaining ten plugins"

log "STEP 10: the agent still runs — one turn, zero tools"
code=$(curl -k -s --max-time 15 -o "$evidence/messages-2.body" -w '%{http_code}' \
  -X POST "$base/sessions/$sid/messages" -H "$client_hdr" \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"text":"do the work again"}') \
  || fail "POST /sessions/{id}/messages (second turn): curl failed"
printf '%s\n' "$code" > "$evidence/messages-2.status"
assert_eq "$code" "202" "POST /sessions/{id}/messages {text:do the work again}"
run2=$(jq -r '.runId' "$evidence/messages-2.body")
[ -n "$run2" ] && [ "$run2" != "null" ] \
  || fail "second POST /sessions/{id}/messages returned no runId: $(cat "$evidence/messages-2.body")"
consume_events "$evidence/events-2.sse" "$max_seq" run_end
types2="$evidence/events-2.sse.types"
if grep -qx message_end "$types2" && grep -qx run_end "$types2"; then
  ok "phase 2 turn completes: message_end and run_end present"
else
  bad "phase 2 turn does not complete: $(tr '\n' ' ' < "$types2")"
fi
if grep -qx tool_use "$types2"; then
  bad "phase 2 shows tool_use although the tools plugin is gone: $(tr '\n' ' ' < "$types2")"
else
  ok "phase 2 shows NO tool_use — zero tools registered"
fi
if grep -qx tool_result "$types2"; then
  bad "phase 2 shows tool_result although the tools plugin is gone: $(tr '\n' ' ' < "$types2")"
else
  ok "phase 2 shows NO tool_result"
fi
count2=$(observed_tool_count "$evidence/kernel-2.log")
if [ -n "$count2" ] && [ "$count2" = "0" ]; then
  ok "harness seam: the model observed tools: 0 in phase 2"
else
  bad "harness seam: phase 2 expected tools: 0, got [${count2:-<none>}]: $(grep 'tool specifications observed' "$evidence/kernel-2.log" | tail -3)"
fi
{
  echo "T46 phase 2 transcript: the agent turn after deleting jhin-plugin-tools-builtin"
  echo
  echo "setup:"
  echo "  removed \$JHIN_HOME/plugins/jhin-plugin-tools-builtin-*.jar (home has $home_count jars)"
  echo "  restarted the host, health no longer lists jhin.tools-builtin (plugins: $plugins_count)"
  echo "  second message: {text:\"do the work again\"} -> runId $run2"
  echo
  echo "captured events (type per line, fromSeq=$max_seq):"
  sed 's/^/  /' "$types2"
  echo
  echo "assertions:"
  echo "  message_end present: $(grep -cx message_end "$types2" || true)"
  echo "  run_end present: $(grep -cx run_end "$types2" || true)"
  echo "  tool_use present: $(grep -cx tool_use "$types2" || true)"
  echo "  tool_result present: $(grep -cx tool_result "$types2" || true)"
  echo "  harness observed tool count (kernel-2.log): ${count2:-<none>}"
  echo
  echo "conclusion: the turn completes (message_end, run_end) with NO tool_use."
  echo "The agent runs with zero tools after the tools plugin jar was deleted."
} > "$evidence/phase2-no-tools.txt"
ok "phase 2 transcript written to $evidence/phase2-no-tools.txt"

log "STEP 11: graceful shutdown (SIGTERM + wait)"
stop_kernel boot2

log "STEP 12: failure-mode contrast for the final phase (failure.txt)"
contrast=1
phase1_use=$(grep -cx tool_use "$evidence/events-1.sse.types" || true)
phase2_use=$(grep -cx tool_use "$types2" || true)
[ "$phase1_use" -gt 0 ] || contrast=0
[ "$phase2_use" = "0" ] || contrast=0
{
  echo "T46 failure-mode evidence: the deletability contrast (phase 2 IS the failure mode)"
  echo
  echo "run WITH the tools plugin (phase 1, full bundle):"
  echo "  events: $(tr '\n' ' ' < "$evidence/events-1.sse.types")"
  echo "  tool_use events: $(grep -cx tool_use "$evidence/events-1.sse.types" || true)"
  echo "  tool-written file: $written ($([ -f "$written" ] && echo present || echo missing))"
  echo
  echo "run WITHOUT the tools plugin (phase 2, jar deleted):"
  echo "  events: $(tr '\n' ' ' < "$types2")"
  echo "  tool_use events: $(grep -cx tool_use "$types2" || true)"
  echo "  harness observed tool count: ${count2:-<none>}"
  echo
  echo "contrast check: a run WITH tools observed tool_use while the run WITHOUT tools did not"
} > "$evidence/failure.txt"
if [ "$contrast" = "1" ]; then
  printf 'ok: contrast verified (with tools -> tool_use, without tools -> none)\n' \
    | tee -a "$evidence/failure.txt" | tee -a "$checks"
else
  printf 'FAIL: contrast violated\n' | tee -a "$evidence/failure.txt" >&2
  bad "deletability contrast violated (phase1 tool_use / phase2 tool_use: $phase1_use / $phase2_use)"
fi

# Deliberate demonstration on a mutated expectation: the check now demands
# tool_use in the without-tools run and must exit non-zero — proof that the
# phase-2 assertion is not vacuous.
mutated_rc=0
{
  echo
  echo "mutated expectation demonstration (deliberate):"
  echo "  mutated check: the without-tools run must show tool_use"
} >> "$evidence/failure.txt"
if grep -qx tool_use "$types2"; then
  {
    echo "ok: mutated expectation holds (UNEXPECTED — the contrast would be vacuous)"
  } >> "$evidence/failure.txt"
  mutated_rc=0
else
  {
    echo "FAIL: mutated expectation violated: the without-tools run shows no tool_use"
    echo "  (expected: the mutated check fails; this is the demonstration)"
  } >> "$evidence/failure.txt"
  mutated_rc=1
fi
printf 'exit code: %s\n' "$mutated_rc" >> "$evidence/failure.txt"
if [ "$mutated_rc" -eq 0 ]; then
  fail "the mutated expectation unexpectedly passed — the deletability evidence is vacuous"
fi
ok "mutated expectation exited $mutated_rc as required (failure demo recorded)"
printf 'contrast check exit code: %s\n' "$([ "$contrast" = "1" ] && echo 0 || echo 1)" \
  >> "$evidence/failure.txt"

if [ "$failures" -gt 0 ]; then
  log "T46 QA: FAILED — $failures assertion(s) violated"
  log "exit code: 1"
  exit 1
fi
log "T46 QA green: the full bundle ran a real agent turn (run_start, tool_use, tool_result,"
log "  message_end, run_end; tool-written file present; bootstrap screens[].html; screens reachable)"
log "  and survived plugin deletion (message_end/run_end with zero tools)"
log "exit code: 0"
