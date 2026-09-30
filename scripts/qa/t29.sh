#!/usr/bin/env bash
# QA for T29: security plugin admin CLI commands.
# Usage: scripts/qa/t29.sh [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T29. Every CLI transcript lands
# there (cli-*.txt stdout, cli-*.err stderr, cli-*.rc exit codes), the
# kernel/plugin log copy as kernel.log. Exits non-zero on the first failed
# assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit timeouts).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T29_INNER:-}" ]; then
  exec env T29_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

evidence=${1:-.sisyphus/evidence/T29}
mkdir -p "$evidence"

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

log "T29 QA: security plugin admin CLI commands"
log "evidence dir: $evidence"

log "STEP 1: build the kernel boot jar and the security plugin jar"
timeout 600 ./gradlew :kernel:bootJar :jhin-plugin-security:jar > "$evidence/build.log" 2>&1 \
  || fail "gradle build failed (see $evidence/build.log)"
jar_path=$(ls kernel/build/libs/kernel-*.jar | grep -v -- '-plain\.jar$')
security_jar=plugins/security/build/libs/jhin-plugin-security-0.2.0.jar
[ -f "$jar_path" ] || fail "kernel boot jar not found: $jar_path"
[ -f "$security_jar" ] || fail "security plugin jar not found: $security_jar"
ok "build green: $jar_path + $security_jar"

log "STEP 2: fresh home with only the security plugin, bare cli lists four commands"
command -v sqlite3 > /dev/null || fail "sqlite3 is required to seed a device row"
home=$(mktemp -d /tmp/t29-home.XXXXXX)
bundled=$(mktemp -d /tmp/t29-bundled.XXXXXX)
cp "$security_jar" "$bundled/jhin-plugin-security-0.2.0.jar"
printf 'JHIN_HOME=%s\nJHIN_BUNDLED_PLUGINS=%s\n' \
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

run_cli commands
assert_eq "$last_rc" "0" "bare cli exit code"
for cmd in create-account create-enrollment list-devices revoke-device; do
  grep -q "^$cmd" "$evidence/cli-commands.txt" \
    || fail "bare cli listing misses $cmd: $(cat "$evidence/cli-commands.txt")"
done
ok "bare cli exits 0 and lists create-account, create-enrollment, list-devices, revoke-device"

log "STEP 3: happy path: create-account, create-enrollment, list-devices, revoke-device"
run_cli create-account-alice create-account alice
assert_eq "$last_rc" "0" "create-account alice exit code"
alice_id=$(sed -n 's/^created account: alice (id: \(.*\))$/\1/p' "$evidence/cli-create-account-alice.txt")
[ -n "$alice_id" ] || fail "create-account did not print id: $(cat "$evidence/cli-create-account-alice.txt")"
grep -qF "created account: alice (id: $alice_id)" "$evidence/cli-create-account-alice.txt" \
  || fail "create-account stdout shape unexpected: $(cat "$evidence/cli-create-account-alice.txt")"
ok "create-account alice -> id $alice_id"

run_cli create-enrollment-alice create-enrollment alice
assert_eq "$last_rc" "0" "create-enrollment alice exit code"
grep -q '^issued enrollment code for alice ' "$evidence/cli-create-enrollment-alice.txt" \
  || fail "create-enrollment stdout shape unexpected: $(cat "$evidence/cli-create-enrollment-alice.txt")"
code=$(sed -n 's/^code: //p' "$evidence/cli-create-enrollment-alice.txt")
[ -n "$code" ] || fail "create-enrollment printed no code: $(cat "$evidence/cli-create-enrollment-alice.txt")"
code_lines=$(grep -c '^code: ' "$evidence/cli-create-enrollment-alice.txt" || true)
assert_eq "$code_lines" "1" "code line count"
code_hits=$(grep -o -F -- "$code" "$evidence/cli-create-enrollment-alice.txt" | wc -l | tr -d ' ') || true
assert_eq "$code_hits" "1" "enrollment code occurrences on stdout"
if grep -F -- "$code" "$evidence/cli-create-enrollment-alice.err" > /dev/null 2>&1; then
  fail "enrollment code leaked into stderr"
fi
ok "create-enrollment alice: code printed exactly once on stdout (full leak scan in step 6)"

run_cli list-devices-empty list-devices
assert_eq "$last_rc" "0" "list-devices exit code"
grep -qxF 'no devices' "$evidence/cli-list-devices-empty.txt" \
  || fail "list-devices empty shape unexpected: $(cat "$evidence/cli-list-devices-empty.txt")"
if grep -q '^ID' "$evidence/cli-list-devices-empty.txt"; then
  fail "list-devices printed a device table while none exist"
fi
run_cli list-devices-alice-empty list-devices alice
assert_eq "$last_rc" "0" "list-devices alice exit code"
grep -qxF 'no devices' "$evidence/cli-list-devices-alice-empty.txt" \
  || fail "list-devices alice empty shape unexpected: $(cat "$evidence/cli-list-devices-alice-empty.txt")"
ok "list-devices and list-devices alice report no devices"

# Constraint: a device row is created by EnrollmentServiceImpl.redeem, reachable
# only through POST /enroll (T28, not built yet). The revoke happy path over a
# service-created row is covered by SecurityCliTest; here the identical row
# shape (same columns as redeem's INSERT) is seeded directly via sqlite3 so the
# script still exercises revoke end to end.
now_ms=$(($(date +%s) * 1000))
device_id=t29-qa-device-0001
token_sha=$(printf '%064s' '' | tr ' ' 'a')
sqlite3 "$home/data/jhin.db" \
  "INSERT INTO jhin_security_devices(id, account_id, name, token_sha256, created_at, last_seen_at, revoked_at) VALUES ('$device_id', '$alice_id', 'qa-device', '$token_sha', $now_ms, $now_ms, NULL);" \
  > "$evidence/cli-seed-device.txt" 2>&1 \
  || fail "sqlite3 seed failed (see $evidence/cli-seed-device.txt)"
printf 'seeded device row id=%s account_id=%s name=qa-device (row shape of EnrollmentServiceImpl.redeem; redeem needs the T28 HTTP route)\n' \
  "$device_id" "$alice_id" >> "$evidence/cli-seed-device.txt"
ok "device row seeded for the revoke happy path: $device_id"

run_cli list-devices-seeded list-devices
assert_eq "$last_rc" "0" "list-devices (seeded) exit code"
grep -qF "$device_id" "$evidence/cli-list-devices-seeded.txt" \
  || fail "seeded device missing from list-devices: $(cat "$evidence/cli-list-devices-seeded.txt")"
grep -q 'qa-device' "$evidence/cli-list-devices-seeded.txt" \
  || fail "seeded device name missing from list-devices"
grep -q 'alice' "$evidence/cli-list-devices-seeded.txt" \
  || fail "account name missing from list-devices"
grep -q 'active' "$evidence/cli-list-devices-seeded.txt" \
  || fail "active marker missing from list-devices"
run_cli list-devices-alice-seeded list-devices alice
assert_eq "$last_rc" "0" "list-devices alice (seeded) exit code"
grep -qF "$device_id" "$evidence/cli-list-devices-alice-seeded.txt" \
  || fail "seeded device missing from list-devices alice"
ok "list-devices shows id, name, account, last seen and active status"

run_cli revoke-device-happy revoke-device "$device_id"
assert_eq "$last_rc" "0" "revoke-device happy exit code"
grep -qxF "revoked device: $device_id" "$evidence/cli-revoke-device-happy.txt" \
  || fail "revoke-device happy shape unexpected: $(cat "$evidence/cli-revoke-device-happy.txt")"
run_cli list-devices-revoked list-devices
assert_eq "$last_rc" "0" "list-devices (revoked) exit code"
grep -q 'revoked' "$evidence/cli-list-devices-revoked.txt" \
  || fail "revoked marker missing from list-devices: $(cat "$evidence/cli-list-devices-revoked.txt")"
ok "revoke-device confirms and list-devices shows the revoked marker"

log "STEP 4: failure paths: unknown account and unknown device"
run_cli create-enrollment-ghost create-enrollment ghost
[ "$last_rc" != "0" ] || fail "create-enrollment ghost exited 0"
grep -qxF 'unknown account: ghost' "$evidence/cli-create-enrollment-ghost.err" \
  || fail "create-enrollment ghost stderr unexpected: $(cat "$evidence/cli-create-enrollment-ghost.err")"
ok "create-enrollment ghost exits $last_rc with 'unknown account: ghost'"

run_cli revoke-device-nope revoke-device nope
[ "$last_rc" != "0" ] || fail "revoke-device nope exited 0"
grep -qxF 'unknown device: nope' "$evidence/cli-revoke-device-nope.err" \
  || fail "revoke-device nope stderr unexpected: $(cat "$evidence/cli-revoke-device-nope.err")"
ok "revoke-device nope exits $last_rc with 'unknown device: nope'"

log "STEP 5: test suites stay green"
timeout 600 ./gradlew :jhin-plugin-security:build > "$evidence/security-build.log" 2>&1 \
  || fail "security plugin build failed (see $evidence/security-build.log)"
security_tests=$(count_tests plugins/security/build/test-results/test)
assert_eq "$security_tests" "28" "security plugin test count"
ok "security plugin build green with $security_tests tests"
printf 'exit code: 0\ntests: %s\n' "$security_tests" > "$evidence/security-tests.txt"

timeout 600 ./gradlew :kernel:test --rerun-tasks > "$evidence/kernel-test.log" 2>&1 \
  || fail "kernel tests failed (see $evidence/kernel-test.log)"
kernel_tests=$(count_tests kernel/build/test-results/test)
assert_eq "$kernel_tests" "101" "kernel test count"
ok "kernel tests green with $kernel_tests tests"
printf 'exit code: 0\ntests: %s\n' "$kernel_tests" > "$evidence/kernel-tests.txt"

log "STEP 6: kernel.log evidence and enrollment code leak scan"
# The CLI path never runs SpringApplication, so Spring file logging stays off
# and there is no logs/jhin.log; the boot log lines land on the console streams
# of every cli run. kernel.log is those log lines, extracted from the cli
# transcripts — that is exactly the surface "never logged" must hold on.
grep -h -E '^[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3} ' \
  "$evidence"/cli-*.txt "$evidence"/cli-*.err > "$evidence/kernel.log" || true
[ -s "$evidence/kernel.log" ] || fail "kernel.log is empty: no boot log lines captured"
if grep -F -- "$code" "$evidence/kernel.log" > /dev/null 2>&1; then
  fail "enrollment code appears in the kernel log lines"
fi
hits=0
for f in "$evidence"/cli-*.txt "$evidence"/cli-*.err; do
  n=$(grep -a -o -F -- "$code" "$f" 2>/dev/null | wc -l | tr -d ' ') || true
  hits=$((hits + n))
  if [ "$n" != "0" ] && [ "$(basename "$f")" != "cli-create-enrollment-alice.txt" ]; then
    fail "enrollment code leaked into $(basename "$f")"
  fi
done
assert_eq "$hits" "1" "total enrollment code occurrences across cli transcripts"
if grep -r -a -F -- "$code" "$home" > /dev/null 2>&1; then
  fail "enrollment code leaked into JHIN_HOME"
fi
ok "kernel.log stored; code appears exactly once (its own stdout), never in logs or JHIN_HOME"

git add -f "$evidence"
ok "evidence staged with git add -f: $evidence"

log "T29 QA: ALL CHECKS PASSED"
