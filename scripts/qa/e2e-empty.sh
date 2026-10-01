#!/usr/bin/env bash
# QA for T45: end-to-end — the empty server. A bare kernel with zero plugins
# serves nothing product-shaped: a fresh JHIN_HOME and a JHIN_BUNDLED_PLUGINS
# directory holding nothing (so no seeding happens) must answer
#   GET /_jhin/health     -> 200 listing zero plugins
#   GET /_jhin/bootstrap  -> 200 with empty:true and no plugins
#   GET /sessions         -> 404
#   boot log              -> the D-8 security warning (SECURITY + filter)
# Usage: scripts/qa/e2e-empty.sh [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T45. The kernel console lands in
# <evidence>/kernel.log, every assertion in <evidence>/checks.txt and on the
# console. All four assertions run and are listed even when one fails, and
# the run exits non-zero when any assertion failed — the failure demo below
# must show the empty:true violation next to the health violation. The
# kernel is stopped with SIGTERM and reaped with `wait` (rc 143 is the
# graceful outcome); every request is --max-time bounded; a whole-run
# watchdog turns a stuck step into a failure instead of a hang. JSON
# assertions run with jq (present on the QA machine; recorded in
# <evidence>/tool-versions.txt). No jhin.security is loaded, so every
# request goes to plain http://localhost:18443.
#
# Failure demo variant: E2E_EMPTY_SEED_JAR=<plugin-jar> copies that jar into
# the bundled plugin directory before boot (build it first, e.g.
# ./gradlew :jhin-plugin-sessions:jar). The same assertions then fail and
# the run exits non-zero, naming the violation.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${E2E_EMPTY_INNER:-}" ]; then
  exec env E2E_EMPTY_INNER=1 timeout --kill-after=15 600 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

evidence=${1:-.sisyphus/evidence/T45}
mkdir -p "$evidence"

base="http://localhost:18443"
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
failures=0

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

# Kills the kernel with SIGTERM, polls until it is gone and reaps it with
# `wait`; rc 143 (killed by SIGTERM after its shutdown hook) is graceful.
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
  [ "$stopped" = "1" ] || fail "kernel did not stop on SIGTERM"
  local rc=0
  wait "$kernel_pid" 2>/dev/null || rc=$?
  printf '%s\n' "$rc" > "$evidence/kernel-wait.rc"
  kernel_pid=""
  case "$rc" in
    0 | 143)
      ok "kernel stopped on SIGTERM and was reaped with wait (rc $rc)"
      ;;
    *)
      bad "kernel wait rc $rc (expected 0 or 143)"
      ;;
  esac
}

log "T45 QA: end-to-end — the empty server serves nothing"
log "evidence dir: $evidence"

command -v jq > /dev/null 2>&1 || fail "jq is required for the JSON assertions"
command -v pgrep > /dev/null 2>&1 || fail "pgrep is required for the process checks"
{
  printf 'jq: %s\n' "$(jq --version)"
  printf 'java: %s\n' "$(java -version 2>&1 | head -1)"
} > "$evidence/tool-versions.txt"
ok "jq and java present"

log "STEP 1: build the kernel boot jar"
timeout 600 ./gradlew :kernel:bootJar > "$evidence/build.log" 2>&1 \
  || fail "gradle build failed (see $evidence/build.log)"
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
[ -f "$jar_path" ] || fail "kernel boot jar not found: $jar_path"
ok "build green: $jar_path"

log "STEP 2: boot the empty kernel (fresh JHIN_HOME, empty bundled plugin dir)"
home=$(mktemp -d /tmp/e2e-empty-home.XXXXXX)
bundled=$(mktemp -d /tmp/e2e-empty-bundled.XXXXXX)
if [ -n "${E2E_EMPTY_SEED_JAR:-}" ]; then
  [ -f "$E2E_EMPTY_SEED_JAR" ] \
    || fail "E2E_EMPTY_SEED_JAR not found: $E2E_EMPTY_SEED_JAR (build it first, e.g. ./gradlew :jhin-plugin-sessions:jar)"
  cp "$E2E_EMPTY_SEED_JAR" "$bundled/"
  log "failure demo: one plugin jar seeded into the bundled dir: $E2E_EMPTY_SEED_JAR"
fi
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\n' "$home" "$bundled" \
  > "$evidence/kernel-env.txt"

JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
  scripts/qa/run-kernel.sh "$evidence" --server.port=18443 &
kernel_pid=$!

code=000
for _ in $(seq 1 90); do
  code=$(curl -s --max-time 2 -o "$evidence/wait-health.body" -w '%{http_code}' \
    "$base/_jhin/health" 2>/dev/null) || code=000
  if [ "$code" = "200" ]; then
    break
  fi
  sleep 0.5
done
[ "$code" = "200" ] || fail "health endpoint did not answer 200 in time (last code $code)"
ok "kernel up on $base (pid $kernel_pid, home $home)"

log "STEP 3: capture the three answers"
code=$(curl -s --max-time 10 -o "$evidence/health.body" -w '%{http_code}' \
  "$base/_jhin/health") || fail "GET /_jhin/health: curl failed"
printf '%s\n' "$code" > "$evidence/health.status"
code=$(curl -s --max-time 10 -o "$evidence/bootstrap.body" -w '%{http_code}' \
  "$base/_jhin/bootstrap") || fail "GET /_jhin/bootstrap: curl failed"
printf '%s\n' "$code" > "$evidence/bootstrap.status"
code=$(curl -s --max-time 10 -o "$evidence/sessions.body" -w '%{http_code}' \
  "$base/sessions") || fail "GET /sessions: curl failed"
printf '%s\n' "$code" > "$evidence/sessions.status"

log "STEP 4: assert the four properties of the empty server"

health_code=$(cat "$evidence/health.status")
health_plugins=$(jq -r '(.plugins | length)' "$evidence/health.body" 2>/dev/null || echo '?')
if [ "$health_code" != "200" ]; then
  bad "health: expected 200, got $health_code"
elif [ "$health_plugins" = "0" ]; then
  ok "health: 200 with zero plugins listed"
else
  bad "health lists $health_plugins plugin(s), expected 0: $(cat "$evidence/health.body")"
fi

boot_code=$(cat "$evidence/bootstrap.status")
boot_plugins=$(jq -r '(.plugins | length)' "$evidence/bootstrap.body" 2>/dev/null || echo '?')
if [ "$boot_code" != "200" ]; then
  bad "bootstrap: expected 200, got $boot_code"
elif ! jq -e '.empty == true' "$evidence/bootstrap.body" > /dev/null 2>&1; then
  bad "bootstrap lacks empty:true: $(cat "$evidence/bootstrap.body")"
elif [ "$boot_plugins" != "0" ] || [ "$health_plugins" != "0" ]; then
  bad "bootstrap is empty:true but plugins exist / health lists $health_plugins plugin(s): $(cat "$evidence/bootstrap.body")"
else
  ok "bootstrap: empty:true with zero plugins"
fi

sessions_code=$(cat "$evidence/sessions.status")
if [ "$sessions_code" = "404" ]; then
  ok "sessions: 404 (no product route)"
else
  bad "GET /sessions: expected 404, got $sessions_code: $(cat "$evidence/sessions.body")"
fi

warn=0
for _ in $(seq 1 20); do
  if grep -qi 'security' "$evidence/kernel.log" 2>/dev/null \
      && grep -qi 'filter' "$evidence/kernel.log" 2>/dev/null; then
    warn=1
    break
  fi
  sleep 0.5
done
if [ "$warn" = "1" ]; then
  ok "log: D-8 security warning (SECURITY + filter)"
else
  bad "boot log lacks the D-8 security warning (SECURITY + filter): see $evidence/kernel.log"
fi

log "STEP 5: graceful shutdown (SIGTERM + wait)"
stop_kernel

if [ "$failures" -gt 0 ]; then
  log "T45 QA: FAILED — $failures assertion(s) violated"
  exit 1
fi
log "T45 QA green: empty server serves nothing (health 0 plugins, bootstrap empty:true, /sessions 404, security warning)"
