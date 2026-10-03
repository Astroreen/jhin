#!/usr/bin/env bash
# QA for T52: kernel scheduler seam and client schema passthrough.
#
# happy: the kernel test suite is green (including KernelPurityTest, checked
#        from the JUnit XML because Gradle stays silent about passing tests)
#        and a clean boot with jhin.reload installed answers
#        GET /_jhin/health -> 200 with a kernel.log free of Exception.
# --fail: a probe plugin whose scheduled task throws on every run is logged
#        (task <name> failed) while GET /_jhin/health still answers 200 —
#        the host survives the throwing task.
#
# Usage: scripts/qa/t52.sh [--fail]
# Evidence: .sisyphus/evidence/T52/{test.txt,kernel.log,health.json} for the
# happy path and .sisyphus/evidence/T52/{task-failure.txt,fail-boot/} for the
# failure path. The kernel is stopped with SIGTERM and reaped with `wait`
# (rc 143 is the graceful outcome); every request is --max-time bounded.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

evidence=.sisyphus/evidence/T52
mkdir -p "$evidence"

kernel_pid=""

cleanup() {
  if [ -n "$kernel_pid" ] && ps -p "$kernel_pid" > /dev/null 2>&1; then
    kill "$kernel_pid" 2>/dev/null || true
    wait "$kernel_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# wait_health <url> <timeout-seconds>: poll until the health endpoint answers
wait_health() {
  local url=$1 deadline=$(( $(date +%s) + $2 ))
  until curl -sf --max-time 3 "$url" > /dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

build() {
  ./gradlew :sdk:jar :kernel:bootJar :jhin-plugin-reload:jar
}

if [ "${1:-}" = "--fail" ]; then
  build

  # one tiny probe plugin whose periodic task throws on every run
  work=$(mktemp -d)
  sdk_jar=$(ls "$PWD"/sdk/build/libs/jhin-sdk-*.jar | head -1)
  cat > "$work/SchedFailurePlugin.java" <<'EOF'
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.sched.TaskSpec;

public class SchedFailurePlugin implements JhinPlugin {

    public SchedFailurePlugin() {}

    @Override
    public void start(PluginContext ctx) {
        ctx.sched().schedule(TaskSpec.periodic("sched-failure", 100, 300,
                () -> { throw new RuntimeException("deliberate task failure"); }));
    }
}
EOF
  cat > "$work/jhin-plugin.json" <<'EOF'
{"id":"jhin.sched-failure","version":"0.1.0","apiVersion":1,
 "name":"Sched failure probe",
 "description":"QA probe: a scheduled task that throws on every run",
 "mainClass":"SchedFailurePlugin","exports":[],"requires":[]}
EOF
  (cd "$work" && javac -cp "$sdk_jar" SchedFailurePlugin.java \
      && jar cf jhin-sched-failure.jar SchedFailurePlugin*.class jhin-plugin.json)

  home=$(mktemp -d)
  mkdir -p "$home/plugins"
  cp plugins/reload/build/libs/jhin-plugin-reload-*.jar "$home/plugins/"
  cp "$work/jhin-sched-failure.jar" "$home/plugins/"

  JHIN_HOME="$home" scripts/qa/run-kernel.sh "$evidence/fail-boot" \
      --server.port=18452 &
  kernel_pid=$!
  url=http://localhost:18452/_jhin/health
  wait_health "$url" 30
  sleep 2   # let the task throw a few times
  curl -s --max-time 5 "$url" -o "$evidence/health-after-failures.json"
  kill "$kernel_pid" 2>/dev/null || true
  wait "$kernel_pid" 2>/dev/null || true
  kernel_pid=""

  {
    echo "T52 task-failure evidence"
    echo
    echo "--- health after the throwing task ran for ~2 s ---"
    cat "$evidence/health-after-failures.json"
    echo
    echo "--- kernel log lines about the failing task ---"
    grep -E "task .* failed" "$evidence/fail-boot/kernel.log" || true
    echo "--- the host answered 200 after the failures ---"
    grep -o '"status":"ok"' "$evidence/health-after-failures.json" || true
  } > "$evidence/task-failure.txt"

  grep -qE "task .* failed" "$evidence/fail-boot/kernel.log"
  grep -q '"status":"ok"' "$evidence/health-after-failures.json"
  echo "T52 --fail OK (evidence in $evidence/task-failure.txt)"
  exit 0
fi

# happy path: the kernel test suite, then a clean boot
./gradlew :kernel:test 2>&1 | tee "$evidence/test.txt"

purity_xml=kernel/build/test-results/test/TEST-com.astroreen.jhin.kernel.KernelPurityTest.xml
grep -q '<testcase name="kernelSourcesAreDomainFree' "$purity_xml"
grep -q '<testcase name="kernelClasspathIsDependencyPure' "$purity_xml"
if grep -qE '<failure|<error' "$purity_xml"; then
  echo "KernelPurityTest FAILED" >&2
  exit 1
fi
echo "KernelPurityTest PASSED" >> "$evidence/test.txt"
for suite in \
    kernel/build/test-results/test/TEST-com.astroreen.jhin.kernel.sched.SchedulerRegistryImplTest.xml \
    kernel/build/test-results/test/TEST-com.astroreen.jhin.kernel.loader.PluginSchedulerWiringTest.xml \
    kernel/build/test-results/test/TEST-com.astroreen.jhin.kernel.http.RequestImplClientTest.xml; do
  [ -f "$suite" ]
  if grep -qE '<failure|<error' "$suite"; then
    echo "new T52 suite FAILED: $suite" >&2
    exit 1
  fi
  echo "$(basename "$suite" .xml) PASSED" >> "$evidence/test.txt"
done

build
home=$(mktemp -d)
mkdir -p "$home/plugins"
cp plugins/reload/build/libs/jhin-plugin-reload-*.jar "$home/plugins/"

JHIN_HOME="$home" scripts/qa/run-kernel.sh "$evidence" --server.port=18451 &
kernel_pid=$!
url=http://localhost:18451/_jhin/health
wait_health "$url" 30
curl -s --max-time 5 "$url" -o "$evidence/health.json"
kill "$kernel_pid" 2>/dev/null || true
wait "$kernel_pid" 2>/dev/null || true
kernel_pid=""

grep -q '"status":"ok"' "$evidence/health.json"
if grep -q "Exception" "$evidence/kernel.log"; then
  echo "kernel.log contains Exception lines" >&2
  exit 1
fi
echo "T52 OK (evidence in $evidence)"
