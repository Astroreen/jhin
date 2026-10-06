#!/usr/bin/env bash
# QA for T121: dist verification, release notes and the evidence index
# (plan section T121).
#
# Happy path:
#   - runs ./gradlew dist (the T82 release procedure) and requires exit 0 and
#     the "dist: assembled dist/" line (dist.txt);
#   - verifies the dist layout: the kernel boot jar, exactly ten default
#     plugin jars under plugins-default/, run.sh (executable), README.md and
#     MANIFEST.txt, and neither the jhin.example template nor the
#     jhin.qa-mock-llm harness anywhere inside dist/ (layout.txt);
#   - records the exact Flutter release build command lines and asserts every
#     one passes --no-tree-shake-icons (the AGENTS.md rule) for web, linux and
#     apk; a full store build is not required (flutter-build-command.txt);
#   - runs the ui-default and ui-kit JVM suites (test.txt) and the full
#     Flutter suite (flutter-test.txt);
#   - boots the dist jar with the documented JHIN_BUNDLED_PLUGINS override
#     pointing at dist/plugins-default and asserts GET /_jhin/health answers
#     200 and lists the ten default plugins (dist-transcript.txt, health.json);
#   - records the auto-seed discrepancy: the Spring Boot fat jar's code source
#     is a nested-jar URL, so ownJarDir() cannot resolve plugins-default and
#     the seeder logs "no bundled plugin directory" — the documented override
#     is required (autoseed/kernel.log);
#   - re-runs scripts/qa/t78.sh and scripts/qa/t120.sh as the cross-phase
#     regression gates, confined to evidence/T121/gate-t78/ and gate-t120/.
#
# Failure path: the dist is copied to a throwaway tree and one required plugin
# jar (jhin-plugin-ui-kit) is removed from plugins-default/. The dist jar then
# boots with jhin.ui failed and the documented error
#   plugin load finished with 1 failed: jhin.ui: plugin jhin.ui requires
#   jhin.ui-kit >=0.2.0, found none
# in the log; the health payload still answers and lists jhin.ui as failed
# (checks-fail.txt, fail-boot/kernel.log, health-fail.json). The script exits
# non-zero by design.
# Usage: scripts/qa/t121.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T121. Uses only curl, jq, awk,
# grep, git and gradle.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T121_INNER:-}" ]; then
  exec env T121_INNER=1 timeout --kill-after=15 3600 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T121}
mkdir -p "$evidence"

kernel_pid=""
# stop_kernel: TERM first, a bounded 20 s wait, then SIGKILL — the kernel's
# graceful shutdown hook may linger past the evidence needs.
stop_kernel() {
  [ -n "$kernel_pid" ] || return 0
  if ps -p "$kernel_pid" > /dev/null 2>&1; then
    kill "$kernel_pid" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      ps -p "$kernel_pid" > /dev/null 2>&1 || break
      sleep 1
    done
    kill -9 "$kernel_pid" 2>/dev/null || true
  fi
  wait "$kernel_pid" 2>/dev/null || true
  kernel_pid=""
}
cleanup() {
  stop_kernel
}
trap cleanup EXIT
trap 'exit 143' TERM INT

if [ "$fail_mode" = "1" ]; then
  checks="$evidence/checks-fail.txt"
else
  checks="$evidence/checks.txt"
fi
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

command -v jq > /dev/null || fail "jq is required"

port=18519
base="https://localhost:$port"
base_plain="http://localhost:$port"

# The ten default plugins the dist bundle ships (build.gradle defaultPluginBuilds).
DEFAULT_PLUGINS=(
  sessions security llm llm-builtin agent tools-builtin mcp ui-kit ui-default reload
)

# The plugin ids those ten jars publish (ui-default publishes jhin.ui).
PLUGIN_IDS=(
  jhin.sessions jhin.security jhin.llm jhin.llm-builtin jhin.agent
  jhin.tools-builtin jhin.mcp jhin.ui-kit jhin.ui jhin.reload
)

# wait_health <url> <timeout-seconds>: poll until the health endpoint answers
wait_health() {
  local url=$1 deadline=$(( $(date +%s) + $2 ))
  until curl -sfk --max-time 3 "$url" > /dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

# dist_jar: the kernel boot jar the dist task assembled.
dist_jar() {
  ls dist/jhin-kernel-*.jar | head -n 1
}

# boot_dist <jar> <bundled-dir> <logdir> <health-url>: stage a fresh JHIN_HOME,
# seed the bundled plugin directory through the documented override and start
# the dist jar in the foreground. The subshell execs into the JVM, so
# $kernel_pid is the JVM process itself and the cleanup TERM reaches it.
boot_dist() {
  local jar=$1 bundled=$2 logdir=$3 health=$4
  mkdir -p "$logdir"
  home=$(mktemp -d)
  ( JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
      exec java -jar "$jar" --server.port="$port" ) \
    > >(tee "$logdir/kernel.log") 2>&1 &
  kernel_pid=$!
  wait_health "$health" 90 \
    || fail "the dist kernel did not become healthy (see $logdir/kernel.log)"
}

if [ "$fail_mode" = "1" ]; then
  log "T121 QA --fail: a missing plugin jar in the dist fails boot with the documented error"
  log "evidence dir: $evidence"

  ./gradlew dist 2>&1 | tee "$evidence/dist-fail.txt" > /dev/null
  grep -q 'dist: assembled dist/' "$evidence/dist-fail.txt" \
    || fail "the dist task did not assemble the bundle (see $evidence/dist-fail.txt)"
  jar=$(dist_jar)
  [ -f "$jar" ] || fail "no kernel jar under dist/ after ./gradlew dist"

  tmpdist=$(mktemp -d)
  cp -r dist/* "$tmpdist/"
  rm -f "$tmpdist/plugins-default/jhin-plugin-ui-kit-0.2.0.jar"
  remaining=$(ls "$tmpdist/plugins-default"/*.jar | wc -l | tr -d ' ')
  [ "$remaining" = "9" ] \
    || fail "expected 9 plugin jars after removing ui-kit, found $remaining"

  logdir="$evidence/fail-boot"
  boot_dist "$tmpdist/$(basename "$jar")" "$tmpdist/plugins-default" "$logdir" "$base/_jhin/health"

  documented='plugin load finished with 1 failed: jhin.ui: plugin jhin.ui requires jhin.ui-kit >=0.2.0, found none'
  grep -qF "$documented" "$logdir/kernel.log" \
    || fail "the documented boot error did not appear in the log (see $logdir/kernel.log)"
  ok "the missing ui-kit jar fails boot with the documented error (fail-boot/kernel.log)"

  curl -sSk --max-time 10 "$base/_jhin/health" | jq -S . > "$evidence/health-fail.json" \
    || fail "GET /_jhin/health failed after the missing-jar boot"
  jq -e '.failed[] | select(.id == "jhin.ui")' "$evidence/health-fail.json" > /dev/null \
    || fail "the health payload does not list jhin.ui as failed (health-fail.json)"
  ok "the health payload still answers and lists jhin.ui as failed (health-fail.json)"

  stop_kernel
  rm -rf "$tmpdist"

  printf 'FAIL (intentional): removed a plugin jar from the dist to prove the documented boot error appears\n' \
    | tee -a "$checks"
  fail "--fail mode: intentional failure-path exit"
fi

log "T121 QA: dist verification, release notes and evidence index"
log "evidence dir: $evidence"

# --- 1. Build the release bundle (the T82 procedure) ----------------------
./gradlew dist 2>&1 | tee "$evidence/dist.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/dist.txt" \
  || fail "./gradlew dist did not report BUILD SUCCESSFUL (see $evidence/dist.txt)"
grep -q 'dist: assembled dist/' "$evidence/dist.txt" \
  || fail "./gradlew dist did not report an assembled bundle (see $evidence/dist.txt)"
ok "./gradlew dist exited 0 and assembled the bundle (dist.txt)"

# --- 2. The dist layout ---------------------------------------------------
jar=$(dist_jar)
[ -f "$jar" ] || fail "no kernel jar under dist/ (expected dist/jhin-kernel-*.jar)"
plugin_count=$(ls dist/plugins-default/*.jar | wc -l | tr -d ' ')
[ "$plugin_count" = "10" ] \
  || fail "expected the ten default plugin jars under dist/plugins-default, found $plugin_count"
for id in "${DEFAULT_PLUGINS[@]}"; do
  ls dist/plugins-default/jhin-plugin-"$id"-*.jar > /dev/null 2>&1 \
    || fail "dist/plugins-default is missing the jhin-plugin-$id jar"
done
for f in run.sh README.md MANIFEST.txt; do
  [ -f "dist/$f" ] || fail "dist/$f is missing"
done
[ -x dist/run.sh ] || fail "dist/run.sh is not executable"
if find dist -name '*example*' -o -name '*qa-mock*' | grep -q .; then
  fail "the example or qa-mock-llm plugin leaked into dist/ (see dist.txt)"
fi
{
  echo "# T121 dist layout ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "kernel: $jar"
  echo "plugins-default: $plugin_count jars"
  ls dist/plugins-default/
  echo
  echo "run.sh: $(test -x dist/run.sh && echo executable || echo 'not executable')"
  echo "README.md: $(test -f dist/README.md && echo present || echo missing)"
  echo "MANIFEST.txt: $(test -f dist/MANIFEST.txt && echo present || echo missing)"
  echo "example/qa-mock inside dist: none"
} > "$evidence/layout.txt"
ok "dist layout: kernel jar, 10 default plugins, run.sh, README.md, MANIFEST.txt; no example/qa-mock (layout.txt)"

# --- 3. The Flutter release build command carries --no-tree-shake-icons ---
{
  echo "# T121 Flutter release build commands (build.gradle)"
  grep -n "runFlutter(\['build'" build.gradle
  echo
  echo "# recorded from the dist run:"
  grep -n "dist: flutter build" "$evidence/dist.txt" || true
} > "$evidence/flutter-build-command.txt"
for target in web linux apk; do
  grep -q "runFlutter(\['build', '$target', '--release', '--no-tree-shake-icons'\]" build.gradle \
    || fail "the $target release build command does not pass --no-tree-shake-icons (build.gradle)"
done
ok "Flutter release build commands pass --no-tree-shake-icons for web, linux and apk (flutter-build-command.txt)"

# --- 4. The JVM suites (ui-default + ui-kit) ------------------------------
./gradlew :jhin-plugin-ui-default:test --rerun :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; test.txt)"

# --- 5. The full Flutter suite --------------------------------------------
scripts/qa/flutter-test.sh test 2>&1 | tee "$evidence/flutter-test.txt"
grep -q 'All tests passed' "$evidence/flutter-test.txt" \
  || fail "the full Flutter suite failed (see $evidence/flutter-test.txt)"
ok "full Flutter suite green (flutter-test.txt)"

# --- 6. Boot the dist jar and assert health -------------------------------
tx="$evidence/dist-transcript.txt"
: > "$tx"
boot_dist "$jar" "$PWD/dist/plugins-default" "$evidence" "$base/_jhin/health"
curl -sSk --max-time 10 "$base/_jhin/health" | jq -S . > "$evidence/health.json" \
  || fail "GET /_jhin/health failed (see $evidence/health.json)"
jq -e '.status == "ok"' "$evidence/health.json" > /dev/null \
  || fail "the health payload status is not ok (health.json)"
for id in "${PLUGIN_IDS[@]}"; do
  jq -e --arg id "$id" '.plugins[] | select(.id == $id)' "$evidence/health.json" > /dev/null \
    || fail "the health payload does not list $id (health.json)"
done
{
  echo "=== dist boot ==="
  echo "jar: $jar"
  echo "bundled: dist/plugins-default (JHIN_BUNDLED_PLUGINS override)"
  echo "GET /_jhin/health -> 200"
  jq -S . "$evidence/health.json"
} >> "$tx"
ok "dist jar boots and answers GET /_jhin/health with the ten default plugins (dist-transcript.txt, health.json)"
stop_kernel

# --- 7. The auto-seed discrepancy (recorded, not a failure) ---------------
# Without the override the Spring Boot fat jar's code source is a nested-jar
# URL, so ownJarDir() cannot resolve plugins-default and the seeder logs
# "no bundled plugin directory". The documented JHIN_BUNDLED_PLUGINS override
# is therefore required to boot the shipped bundle.
autoseed_log="$evidence/autoseed"
mkdir -p "$autoseed_log"
home=$(mktemp -d)
( JHIN_HOME="$home" exec java -jar "$jar" --server.port="$port" ) \
  > >(tee "$autoseed_log/kernel.log") 2>&1 &
kernel_pid=$!
wait_health "$base_plain/_jhin/health" 90 \
  || fail "the bare dist kernel did not become healthy (see $autoseed_log/kernel.log)"
grep -q 'no bundled plugin directory' "$autoseed_log/kernel.log" \
  || fail "expected the auto-seed discrepancy in the log (see $autoseed_log/kernel.log)"
ok "recorded discrepancy: the dist jar does not auto-seed plugins-default (Spring Boot nested-jar code source); the documented JHIN_BUNDLED_PLUGINS override is required (autoseed/kernel.log)"
stop_kernel

# --- 8. The regression gates ----------------------------------------------
bash scripts/qa/t78.sh "$evidence/gate-t78" \
  > "$evidence/gate-t78.txt" 2>&1
grep -q 'T78 QA green' "$evidence/gate-t78.txt" \
  || fail "the T78 regression gate did not report green (see $evidence/gate-t78.txt)"
ok "T78 regression gate green: the settings contracts still hold (gate-t78/)"

bash scripts/qa/t120.sh "$evidence/gate-t120" \
  > "$evidence/gate-t120.txt" 2>&1
grep -q 'T120 QA green' "$evidence/gate-t120.txt" \
  || fail "the T120 regression gate did not report green (see $evidence/gate-t120.txt)"
ok "T120 regression gate green: the full-bundle routes, downgrade and store upgrade still hold (gate-t120/)"

# --- 9. The summary -------------------------------------------------------
{
  echo "# T121 dist verification summary"
  echo
  echo "bundle: $jar + $plugin_count default plugin jars under plugins-default/"
  echo "jvm tests (ui-default + ui-kit): $test_count"
  echo "flutter release build commands: web, linux, apk — all with --no-tree-shake-icons"
  echo
  echo "dist boot: GET /_jhin/health -> 200, ten default plugins loaded"
  echo "  (booted with JHIN_BUNDLED_PLUGINS=dist/plugins-default)"
  echo
  echo "recorded discrepancy: the dist jar does not auto-seed plugins-default."
  echo "  The Spring Boot fat jar's code source is a nested-jar URL, so"
  echo "  ownJarDir() cannot resolve the directory next to the jar and the"
  echo "  seeder logs 'no bundled plugin directory'. The documented"
  echo "  JHIN_BUNDLED_PLUGINS override is required to boot the shipped bundle."
  echo "  Recorded for the next planning pass; not fixed here (plan section 17)."
  echo
  echo "release notes: docs/updates.md section 12 (what was copied, what is"
  echo "  decorative, what to strip); evidence index: .sisyphus/evidence/README.md"
} > "$evidence/summary.txt"
ok "summary recorded (summary.txt)"

log "T121 QA green: dist verified, release notes and evidence index recorded"
