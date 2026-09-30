#!/usr/bin/env bash
# QA for T31: the three deletable built-in LLM factories plugin.
# Usage: scripts/qa/t31.sh [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T31. Both boots land there as
# boot1/kernel.log and boot2/kernel.log, the two /providers/formats transcripts
# as formats-with-builtin.txt and formats-after-removal.txt, every check and
# the exit-code summary in checks.txt. Exits non-zero on the first failed
# assertion; a stuck step fails the run instead of hanging (whole-run watchdog
# plus explicit curl timeouts).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T31_INNER:-}" ]; then
  exec env T31_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

evidence=${1:-.sisyphus/evidence/T31}
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

start_kernel() {
  local boot_dir=$1
  JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
    scripts/qa/run-kernel.sh "$boot_dir" --server.port=18443 &
  kernel_pid=$!
  health_ready=0
  for _ in $(seq 1 60); do
    code=$(curl -s --max-time 2 -o "$boot_dir/health.body" -w '%{http_code}' \
      'http://localhost:18443/_jhin/health' 2>/dev/null) || code=000
    if [ "$code" = "200" ]; then
      health_ready=1
      break
    fi
    kill -0 "$kernel_pid" 2>/dev/null || fail "kernel (boot $boot_dir) exited before health answered"
    sleep 0.5
  done
  printf '%s\n' "$code" > "$boot_dir/health.status"
  [ "$health_ready" = "1" ] || fail "health endpoint did not answer 200 in time (boot $boot_dir)"
}

stop_kernel() {
  local label=$1
  kill -TERM "$kernel_pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    kill -0 "$kernel_pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -0 "$kernel_pid" 2>/dev/null && fail "kernel (boot $label) ignored SIGTERM"
  rc=0
  wait "$kernel_pid" || rc=$?
  kernel_pid=""
  printf '%s\n' "$rc" > "$evidence/kernel-$label.rc"
  printf 'kernel boot %s exit code: %s\n' "$label" "$rc" >> "$checks"
  ok "kernel boot $label stopped gracefully (exit code $rc)"
}

fetch_formats() {
  local label=$1 expected=$2
  rc=0
  code=$(curl -s --max-time 15 -o "$evidence/formats-$label.txt" -w '%{http_code}' \
    'http://localhost:18443/providers/formats' 2> "$evidence/formats-$label.curl.log") || rc=$?
  printf '%s\n' "$code" > "$evidence/formats-$label.status"
  printf '%s\n' "$rc" > "$evidence/formats-$label.rc"
  assert_eq "$rc" "0" "curl exit code (formats-$label)"
  assert_eq "$code" "200" "GET /providers/formats HTTP status (formats-$label)"
  assert_eq "$(cat "$evidence/formats-$label.txt")" "$expected" \
    "GET /providers/formats body (formats-$label)"
  ok "GET /providers/formats -> 200 with exactly $expected (formats-$label)"
}

log "T31 QA: built-in LLM factories plugin (the three deletable factories)"
log "evidence dir: $evidence"

log "STEP 1: build the kernel boot jar and the llm + llm-builtin plugin jars"
timeout 600 ./gradlew :kernel:bootJar :jhin-plugin-llm:jar :jhin-plugin-llm-builtin:jar \
  > "$evidence/build.log" 2>&1 \
  || fail "gradle build failed (see $evidence/build.log)"
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
llm_jar=plugins/llm/build/libs/jhin-plugin-llm-0.2.0.jar
builtin_jar=plugins/llm-builtin/build/libs/jhin-plugin-llm-builtin-0.2.0.jar
[ -f "$jar_path" ] || fail "kernel boot jar not found: $jar_path"
[ -f "$llm_jar" ] || fail "llm plugin jar not found: $llm_jar"
[ -f "$builtin_jar" ] || fail "llm-builtin plugin jar not found: $builtin_jar"
ok "build green: $jar_path + $llm_jar + $builtin_jar"

log "STEP 2: jar contents: the three integration libs are bundled, sqlite is not"
command -v unzip > /dev/null || fail "unzip is required for the jar contents check"
unzip -l "$builtin_jar" > "$evidence/jar-contents.txt" 2>&1 \
  || fail "cannot list $builtin_jar (see $evidence/jar-contents.txt)"
for marker in \
  'dev/langchain4j/model/anthropic/AnthropicChatModel.class' \
  'dev/langchain4j/model/openai/OpenAiChatModel.class' \
  'dev/langchain4j/model/googleai/GoogleAiGeminiChatModel.class'; do
  grep -q "$marker" "$evidence/jar-contents.txt" \
    || fail "plugin jar misses $marker (see $evidence/jar-contents.txt)"
done
if grep -qi sqlite "$evidence/jar-contents.txt"; then
  fail "plugin jar bundles sqlite (see $evidence/jar-contents.txt)"
fi
ok "jar bundles anthropic, openai and gemini integration classes; sqlite absent"

log "STEP 3: boot 1 with llm + llm-builtin: formats list all three"
home=$(mktemp -d /tmp/t31-home.XXXXXX)
bundled=$(mktemp -d /tmp/t31-bundled.XXXXXX)
removed=$(mktemp -d /tmp/t31-removed.XXXXXX)
cp "$llm_jar" "$bundled/jhin-plugin-llm-0.2.0.jar"
cp "$builtin_jar" "$bundled/jhin-plugin-llm-builtin-0.2.0.jar"
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\n' \
  "$home" "$bundled" > "$evidence/kernel-env.txt"

start_kernel "$evidence/boot1"
ok "kernel boot 1 started (pid $kernel_pid, home $home)"
fetch_formats with-builtin '["anthropic","gemini","openai"]'
stop_kernel 1

log "STEP 4: remove the llm-builtin jar (user deletion; deletion memory keeps it gone)"
mv "$home/plugins/jhin-plugin-llm-builtin-0.2.0.jar" "$removed/"
[ ! -f "$home/plugins/jhin-plugin-llm-builtin-0.2.0.jar" ] \
  || fail "llm-builtin jar still present in $home/plugins"
printf 'moved jhin-plugin-llm-builtin-0.2.0.jar from %s/plugins/ to %s\n' \
  "$home" "$removed" > "$evidence/removal.txt"
ok "jhin-plugin-llm-builtin-0.2.0.jar moved out of the home plugin directory"

log "STEP 5: boot 2 on the same home: formats list is empty"
start_kernel "$evidence/boot2"
ok "kernel boot 2 started (pid $kernel_pid, home $home)"
grep -q 'the seeded copy was removed and stays removed' "$evidence/boot2/kernel.log" \
  || fail "deletion memory did not keep the jar gone (see $evidence/boot2/kernel.log)"
ok "deletion memory kept the removed jar gone on the second seeding pass"
fetch_formats after-removal '[]'
stop_kernel 2

log "STEP 6: evidence summary and staging"
printf 'build exit code: 0\ncurl formats-with-builtin exit code: %s\ncurl formats-after-removal exit code: %s\n' \
  "$(cat "$evidence/formats-with-builtin.rc")" \
  "$(cat "$evidence/formats-after-removal.rc")" >> "$checks"
git add -f "$evidence"
ok "evidence staged with git add -f: $evidence"

log "T31 QA: ALL CHECKS PASSED"
