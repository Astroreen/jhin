#!/usr/bin/env bash
# QA for T84: the two-seed OKLCH palette generator with WCAG-solved
# foregrounds.
# Usage: scripts/qa/t84.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T84. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM
# and reaped with `wait`; JSON assertions run with jq (present on the QA
# machine). The kernel boots with jhin.sessions, jhin.ui-kit and jhin.ui —
# the three UI plugins whose jars carry the token surface and the bootstrap
# payload.
#
# Happy path:
#   - runs the ui-kit and ui-default JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL; PaletteGenTest also writes the nine
#     generated maps to build/tmp/t84-palettes.json;
#   - runs scripts/qa/flutter-test.sh test/design/palette_gen_test.dart with
#     T84_DUMP pointed at the evidence dir (transcript in flutter.txt), so
#     the Dart port writes its own nine maps;
#   - proves Java<->Dart parity byte-exact: jq structural equality plus a
#     normalized one-line grep match over the two dumps (plan §15.2), and
#     assembles evidence/palettes.json with both sides;
#   - boots the kernel and pushes all nine seed pairs through
#     save-appearance, asserting for each that the next bootstrap carries
#     the seeds back and that theme.colors equals the generated map of
#     palettes.json — the bootstrap reflects the generated palette;
#   - extracts the T84_DELTA probe lines of PaletteGenTest into deltaE.txt
#     (ΔE76 of the seed-determined roles vs themePalettes.ts).
#
# Failure path: an unparsable canvas ("not-a-colour") must be answered with
# the documented validation error (errorText patch + error toast, no crash,
# nothing persisted) and the generator must throw the typed PaletteError
# (the JVM probe suite). Both proofs land in checks-fail.txt and the
# deliberately wrong expectation — "the generator accepted the unparsable
# canvas" — trips the run (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T84_INNER:-}" ]; then
  exec env T84_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T84}
mkdir -p "$evidence"
evidence=$(readlink -f "$evidence")

kernel_pid=""
cleanup() {
  if [ -n "$kernel_pid" ] && ps -p "$kernel_pid" > /dev/null 2>&1; then
    kill "$kernel_pid" 2>/dev/null || true
    wait "$kernel_pid" 2>/dev/null || true
  fi
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

port=18484
base="http://localhost:$port"

# wait_health <url> <timeout-seconds>: poll until the health endpoint answers
wait_health() {
  local url=$1 deadline=$(( $(date +%s) + $2 ))
  until curl -sf --max-time 3 "$url" > /dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

boot_kernel() {
  ./gradlew :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar
  local home
  home=$(mktemp -d)
  mkdir -p "$home/plugins"
  cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$home/plugins/"
  cp plugins/ui-kit/build/libs/jhin-plugin-ui-kit-*.jar "$home/plugins/"
  cp plugins/ui-default/build/libs/jhin-plugin-ui-default-*.jar "$home/plugins/"
  JHIN_HOME="$home" \
    scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 60 || fail "the kernel did not become healthy (see $kernel_log_dir/kernel.log)"
}

# step <transcript> <name> <method> <path> <body> <expected-status> <jq-expr>
# Appends the request, status and response to the transcript and asserts both
# the status and the jq expression over the response body. The last response
# body is left in $step_payload for the caller.
step() {
  local tx=$1 name=$2 method=$3 path=$4 body=$5 expected=$6 expr=$7
  local response status payload
  response=$(curl -sS --max-time 10 -X "$method" \
      -H 'Content-Type: application/json' \
      -H 'X-Jhin-Client: api=3; version=0.3.0; schema=4; caps=sse' \
      --data "$body" \
      -w $'\n%{http_code}' "$base$path")
  status=${response##*$'\n'}
  payload=${response%$'\n'*}
  step_payload=$payload
  {
    echo "=== $name ==="
    echo "$method $path"
    echo "req:  $body"
    echo "status: $status"
    echo "resp: $payload"
    echo "assert: status=$expected, jq '$expr'"
  } >> "$tx"
  [ "$status" = "$expected" ] \
    || fail "$name: expected status $expected, got $status (resp: $payload)"
  if ! jq -e "$expr" <<< "$payload" > /dev/null; then
    fail "$name: jq assertion '$expr' failed on: $payload"
  fi
  echo "assert: ok" >> "$tx"
}

# fetch_bootstrap <transcript> <out-payload>: the bootstrap payload
fetch_bootstrap() {
  local tx=$1 out=$2
  step "$tx" "bootstrap" GET /_jhin/bootstrap '' 200 '.api == 2'
  jq -S . <<< "$step_payload" > "$out"
}

# --- the shared vector set (built-in seed pairs + adversarial pairs) ------
vector_names="t3-chat grove ocean ember iris near-black-grey white-white max-chroma-magenta mid-grey"
vector_appearance="light light light light light dark light light light"
vector_canvas="#fdf7fd #f3f7f4 #f5f7f8 #f9f7f5 #f8f7f9 #050505 #ffffff #ff00ff #808080"
vector_accent="#db2777 #1b7d50 #2672af #ae552a #7253b9 #808080 #ffffff #ff00ff #808080"

java_dump="plugins/ui-kit/build/tmp/t84-palettes.json"

if [ "$fail_mode" = "1" ]; then
  log "T84 QA --fail: an unparsable canvas must be answered with the"
  log "documented error and the typed PaletteError; evidence dir: $evidence"

  # --- 1. The generator probe: the typed PaletteError at unit level -------
  ./gradlew :jhin-plugin-ui-kit:test \
      --tests 'com.astroreen.jhin.plugin.uikit.PaletteGenTest' --rerun \
    2>&1 | tee "$evidence/test-fail.txt"
  grep -q 'BUILD SUCCESSFUL' "$evidence/test-fail.txt" \
    || fail "the generator probe suite did not report BUILD SUCCESSFUL (see $evidence/test-fail.txt)"
  xml=plugins/ui-kit/build/test-results/test/TEST-com.astroreen.jhin.plugin.uikit.PaletteGenTest.xml
  [ -f "$xml" ] || fail "missing $xml — the generator probe suite wrote no test results"
  grep -q 'unparsableSeedsRaisePaletteError' "$xml" \
    || fail "the PaletteError probe test is missing from $xml"
  grep -q 'unknownAppearanceRaisesPaletteError' "$xml" \
    || fail "the PaletteError appearance probe test is missing from $xml"
  {
    echo "FAIL: the generator threw the typed PaletteError for canvas \"not-a-colour\" (rejected as designed)"
    echo "  probe: PaletteGenTest.unparsableSeedsRaisePaletteError green (see $evidence/test-fail.txt)"
    echo "  probe: PaletteGenTest.unknownAppearanceRaisesPaletteError green (see $evidence/test-fail.txt)"
  } | tee -a "$checks"
  ok "--fail probe: PaletteError raised for \"not-a-colour\" and for an unknown appearance (test-fail.txt)"

  # --- 2. The server probe: documented error, no crash, no persistence ---
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/validation-fail.txt"
  : > "$tx"
  step "$tx" "save-invalid-canvas" POST /ui/action/save-appearance \
    '{"action":"save-appearance","payload":{"appearance":"light","canvas":"not-a-colour","accent":"#db2777","density":"comfortable","panelMotionMs":0}}' \
    200 '[.client[].op] == ["patch", "toast"]'
  jq -e '[.client[] | select(.op == "patch")][0].id == "canvas"' <<< "$step_payload" > /dev/null \
    || fail "the unparsable canvas answer does not patch the canvas field (validation-fail.txt)"
  jq -e '[.client[] | select(.op == "patch")][0].props.errorText | contains("#RRGGBB")' \
      <<< "$step_payload" > /dev/null \
    || fail "the unparsable canvas answer does not carry the documented errorText (validation-fail.txt)"
  jq -e '[.client[] | select(.op == "toast")][0].style == "error"' <<< "$step_payload" > /dev/null \
    || fail "the unparsable canvas answer does not toast an error (validation-fail.txt)"
  fetch_bootstrap "$tx" "$evidence/bootstrap-fail.json"
  jq -e '.theme.canvas == "#fdf7fd"' "$evidence/bootstrap-fail.json" > /dev/null \
    || fail "the unparsable canvas was persisted (bootstrap-fail.json)"
  {
    echo "FAIL: canvas \"not-a-colour\" was answered with the documented error (rejected as designed)"
    echo "  server: errorText patch on the canvas field, error toast, nothing persisted (validation-fail.txt)"
  } | tee -a "$checks"
  ok "--fail probe: the server answered the unparsable canvas with the documented error, no crash (validation-fail.txt)"
  fail "deliberately wrong expectation: the generator accepted the unparsable canvas \"not-a-colour\" (it raises PaletteError; see $evidence/checks-fail.txt)"
fi

log "T84 QA: OKLCH two-seed palette generator with WCAG-solved foregrounds"
log "evidence dir: $evidence"

# --- 1. The JVM suites ---
./gradlew :jhin-plugin-ui-default:test :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; transcript in test.txt)"

# --- 2. The Flutter suite (writes its dump through T84_DUMP) ---
T84_DUMP="$evidence/palettes-dart.json" \
  scripts/qa/flutter-test.sh test/design/palette_gen_test.dart \
  2>&1 | tee "$evidence/flutter.txt"
grep -q 'All tests passed!' "$evidence/flutter.txt" \
  || fail "the Flutter palette suite did not pass (see $evidence/flutter.txt)"
ok "flutter test/design/palette_gen_test.dart green (transcript in flutter.txt)"

# --- 3. Byte-exact parity of the two dumps (plan §15.2) ---
[ -f "$java_dump" ] || fail "missing $java_dump — PaletteGenTest wrote no dump"
[ -f "$evidence/palettes-dart.json" ] || fail "missing $evidence/palettes-dart.json — the Dart suite wrote no dump"
jq -e '.vectors | length == 9' "$java_dump" > /dev/null \
  || fail "the Java dump does not carry 9 vectors (palettes.json)"
jq -e '[.vectors[].colors | length == 56] | all' "$java_dump" > /dev/null \
  || fail "the Java dump does not carry 56 colours per vector (palettes.json)"
jq -e --slurp '.[0] == .[1]' "$java_dump" "$evidence/palettes-dart.json" > /dev/null \
  || fail "the Java and Dart palettes differ (palettes.json, palettes-dart.json)"
java_line=$(jq -S -c . "$java_dump")
dart_line=$(jq -S -c . "$evidence/palettes-dart.json")
grep -Fqx "$java_line" <<< "$dart_line" \
  || fail "the normalized dumps are not byte-identical (palettes.json, palettes-dart.json)"
jq -n --slurpfile j "$java_dump" --slurpfile d "$evidence/palettes-dart.json" \
    '{java: $j[0], dart: $d[0]}' > "$evidence/palettes.json"
ok "java-dart hex parity byte-exact over 9 vectors x 56 colours (palettes.json)"

# --- 4. The ΔE probes of the seed-determined roles ---
xml=plugins/ui-kit/build/test-results/test/TEST-com.astroreen.jhin.plugin.uikit.PaletteGenTest.xml
[ -f "$xml" ] || fail "missing $xml — PaletteGenTest wrote no test results"
sed 's/&#10;/\
/g' "$xml" | awk '/T84_DELTA:/ {sub(/.*T84_DELTA:/, "T84_DELTA:"); print}' \
  > "$evidence/deltaE.txt"
[ "$(wc -l < "$evidence/deltaE.txt")" = "5" ] \
  || fail "expected 5 T84_DELTA probe lines, got $(wc -l < "$evidence/deltaE.txt") (deltaE.txt)"
awk '/T84_DELTA:/ {
       for (i = 1; i <= NF; i++) if ($i + 0 > max) max = $i + 0
     } END { exit (max < 2.0) ? 0 : 1 }' "$evidence/deltaE.txt" \
  || fail "a seed-determined role exceeds dE76 2 against themePalettes.ts (deltaE.txt)"
ok "seed-determined roles within dE76 < 2 vs themePalettes.ts for the 5 built-in pairs (deltaE.txt)"

# --- 5. The kernel: save-appearance round-trips with generated colors ------
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/server.txt"
: > "$tx"

i=1
while [ "$i" -le 9 ]; do
  name=$(awk -v n="$i" '{print $n}' <<< "$vector_names")
  appearance=$(awk -v n="$i" '{print $n}' <<< "$vector_appearance")
  canvas=$(awk -v n="$i" '{print $n}' <<< "$vector_canvas")
  accent=$(awk -v n="$i" '{print $n}' <<< "$vector_accent")
  step "$tx" "save-appearance-$name" POST /ui/action/save-appearance \
    "{\"action\":\"save-appearance\",\"payload\":{\"appearance\":\"$appearance\",\"canvas\":\"$canvas\",\"accent\":\"$accent\",\"density\":\"comfortable\",\"panelMotionMs\":0}}" \
    200 '[.client[].op] == ["toast", "reloadBootstrap"]'
  fetch_bootstrap "$tx" "$evidence/bootstrap-$name.json"
  jq -e --arg c "$canvas" --arg a "$accent" \
      '.theme.canvas == $c and .theme.accent == $a' \
      "$evidence/bootstrap-$name.json" > /dev/null \
    || fail "$name: bootstrap did not carry the saved seeds (bootstrap-$name.json)"
  jq -e --arg n "$name" --slurpfile g "$java_dump" \
      '.theme.colors == ($g[0].vectors[] | select(.name == $n) | .colors)' \
      "$evidence/bootstrap-$name.json" > /dev/null \
    || fail "$name: theme.colors is not the generated palette of palettes.json (bootstrap-$name.json)"
  i=$(( i + 1 ))
done
{
  echo
  echo "assert: all 9 seed pairs round-trip through save-appearance and"
  echo "assert: bootstrap theme.colors equals the generated map of palettes.json"
} >> "$tx"
ok "save-appearance x9: bootstrap theme.canvas/accent round-trip and theme.colors equals the generated palette (server.txt)"

log "T84 QA green: OKLCH two-seed palette generator verified (9 vectors, byte-exact parity)"
