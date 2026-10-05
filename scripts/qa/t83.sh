#!/usr/bin/env bash
# QA for T83: the token vocabulary, scales and bootstrap token layer.
# Usage: scripts/qa/t83.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T83. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM and
# reaped with `wait`; JSON assertions run with jq (present on the QA machine).
# The kernel boots with jhin.sessions, jhin.ui-kit and jhin.ui — the three UI
# plugins whose jars carry the token surface and the bootstrap payload.
#
# Happy path:
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL;
#   - fetches GET /_jhin/bootstrap with `X-Jhin-Client: api=3` into
#     bootstrap-tokens.json and asserts the token surface of §4.3: the
#     eleven families with their exact key sets and the pinned values
#     (color["sidebar-row-hover"], radius.base "0.625rem",
#     layout.topbarHeight 52, motion.easeDrawer "cubic-bezier(0.32, 0.72, 0, 1)"),
#     plus the level-2 fields t78 pins (tokens.motion.panel, density);
#   - asserts every primitive type of the inline screens is in the
#     docs/sdui.md section 2.5 catalog.
#
# Failure path: a node prop carrying an invalid token key
# (`props.color: "no-such-token"`) must fail the builder test with
# `unknown token` at build time. The builder suite's T83_PROBE proof lines are
# recorded in checks-fail.txt and unknown-token.txt, then the deliberately
# wrong expectation — "the invalid key is accepted" — trips (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T83_INNER:-}" ]; then
  exec env T83_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T83}
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

port=18483
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

# fetch_bootstrap <transcript> <out-payload> <out-tokens>: the bootstrap
# payload and a quick-reference dump of its tokens block
fetch_bootstrap() {
  local tx=$1 out=$2 tokens=$3
  step "$tx" "bootstrap" GET /_jhin/bootstrap '' 200 '.api == 2'
  jq -S . <<< "$step_payload" > "$out"
  jq -S '.tokens' <<< "$step_payload" > "$tokens"
}

# catalog_primitives: the docs/sdui.md section 2.5 primitive names
catalog_primitives() {
  awk '/^### 2\.5 /{f=1;next} /^### /{f=0} f' docs/sdui.md \
    | grep -oE '`[a-z_]+' | tr -d '`' | sort -u
}

if [ "$fail_mode" = "1" ]; then
  log "T83 QA --fail: a node prop carrying an invalid token key must fail"
  log "the builder with 'unknown token'; evidence dir: $evidence"

  # --- 1. The builder suite proves the rejection at build time -----------
  ./gradlew :jhin-plugin-ui-kit:test \
      --tests 'com.astroreen.jhin.plugin.uikit.UiTokensTest' --rerun \
    2>&1 | tee "$evidence/test-fail.txt"
  grep -q 'BUILD SUCCESSFUL' "$evidence/test-fail.txt" \
    || fail "the builder suite did not report BUILD SUCCESSFUL (see $evidence/test-fail.txt)"
  xml=plugins/ui-kit/build/test-results/test/TEST-com.astroreen.jhin.plugin.uikit.UiTokensTest.xml
  [ -f "$xml" ] || fail "missing $xml — the builder suite wrote no test results"
  awk '/T83_PROBE:/ {gsub(/&quot;/, "\""); sub(/.*T83_PROBE:/, "T83_PROBE:"); print}' "$xml" \
    > "$evidence/unknown-token.txt"
  grep -q 'unknown token' "$evidence/unknown-token.txt" \
    || fail "the builder did not answer props.color \"no-such-token\" with an error mentioning 'unknown token' (see $evidence/unknown-token.txt)"
  grep -q 'props.color "no-such-token"' "$evidence/unknown-token.txt" \
    || fail "the props.color rejection proof line is missing (see $evidence/unknown-token.txt)"

  {
    echo "FAIL: props.color \"no-such-token\" was answered with an error mentioning 'unknown token' (rejected as designed)"
    awk '/T83_PROBE:/ {gsub(/&quot;/, "\""); sub(/.*T83_PROBE:/, "T83_PROBE:"); print "  " $0}' "$xml"
  } | tee -a "$checks"
  ok "--fail probe: the invalid token key is rejected at build time (unknown-token.txt, test-fail.txt)"
  fail "deliberately wrong expectation: props.color \"no-such-token\" is accepted (it is rejected with 'unknown token'; see $evidence/unknown-token.txt)"
fi

log "T83 QA: token vocabulary, scales and bootstrap token layer"
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

# --- 2. The kernel ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui (kernel.log)"

tx="$evidence/tokens.txt"
: > "$tx"

# --- 3. Bootstrap tokens: the §4.3 surface ---
fetch_bootstrap "$tx" "$evidence/bootstrap-tokens.json" "$evidence/tokens-block.json"

jq -e '.tokens.color["sidebar-row-hover"] == "var(--sidebar-row-hover)"' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.color[\"sidebar-row-hover\"] is missing or wrong (bootstrap-tokens.json)"
jq -e '.tokens.radius.base == "0.625rem"' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.radius.base is not '0.625rem' (bootstrap-tokens.json)"
jq -e '.tokens.layout.topbarHeight == 52' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.layout.topbarHeight is not 52 (bootstrap-tokens.json)"
jq -e '.tokens.motion.easeDrawer == "cubic-bezier(0.32, 0.72, 0, 1)"' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.motion.easeDrawer is not the upstream drawer curve (bootstrap-tokens.json)"
jq -e '.tokens.motion.panel == 0' "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "the default tokens.motion.panel is not 0 (bootstrap-tokens.json)"
jq -e '.density == "comfortable"' "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "the default density is not 'comfortable' (bootstrap-tokens.json)"
ok "pinned values: color[sidebar-row-hover], radius.base 0.625rem, layout.topbarHeight 52, motion.easeDrawer cubic-bezier(0.32, 0.72, 0, 1), motion.panel 0, density comfortable"

# --- 4. Every family key set of §4.3 ---
families='color radius text font space layout glass motion shadow scroll z'
for family in $families; do
  jq -e --arg family "$family" '.tokens[$family] | type == "object"' \
    "$evidence/bootstrap-tokens.json" > /dev/null \
    || fail "tokens.$family is missing or not an object (bootstrap-tokens.json)"
done
jq -e '.tokens | keys == ["color","font","glass","layout","motion","radius","scroll","shadow","space","text","z"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens does not carry exactly the eleven families (bootstrap-tokens.json)"
jq -e '.tokens.color | keys == ["accent","accent-foreground","background","border","card","card-foreground","code","code-foreground","contrast","destructive","destructive-foreground","diff-addition","diff-addition-foreground","diff-deletion","diff-deletion-foreground","error","error-foreground","error-surface","foreground","icon-muted","info","info-foreground","input","message","message-action","message-action-foreground","message-action-hover","message-foreground","muted","muted-foreground","placeholder","popover","popover-foreground","primary","primary-foreground","ring","secondary","secondary-foreground","secondary-label","sidebar","sidebar-border","sidebar-control-surface","sidebar-foreground","sidebar-muted-foreground","sidebar-row-active","sidebar-row-hover","sidebar-row-selected","success","success-foreground","surface-raised","tool-error-icon","update","update-foreground","update-surface","warning","warning-foreground","warning-surface"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.color does not carry the 56 semantic names plus contrast (bootstrap-tokens.json)"
jq -e '.tokens.color.contrast | keys == ["accent-foreground","border","card-foreground","foreground","icon-muted","input","message-foreground","muted-foreground","placeholder","popover-foreground","secondary-foreground","secondary-label","sidebar-border","sidebar-foreground","sidebar-muted-foreground"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.color.contrast does not carry the 15 foreground names (bootstrap-tokens.json)"
jq -e '.tokens.radius | keys == ["base","lg","md","sm","xl","xl2","xl3"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.radius key set is wrong (bootstrap-tokens.json)"
jq -e '.tokens.text | keys == ["base","lg","sm","xl","xs","xs2","xs3","xs4","xs5"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.text key set is wrong (bootstrap-tokens.json)"
jq -e '.tokens.font | keys == ["composer","mono","sans","sizeCode","sizeInterface","sizePrompt"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.font key set is wrong (bootstrap-tokens.json)"
jq -e '.tokens.space | keys == ["commandContent","commandShell","control","floatingContent","sidebarContent","sidebarControlGap","sidebarRowContent","workspaceGutter"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.space key set is wrong (bootstrap-tokens.json)"
jq -e '.tokens.layout | keys == ["chatContentMaxWidth","mainMinWidth","sidebarMinWidth","sidebarWidth","threadDetailsPanelWidth","topbarHeight"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.layout key set is wrong (bootstrap-tokens.json)"
jq -e '.tokens.glass | keys == ["blur","opacity","saturation"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.glass key set is wrong (bootstrap-tokens.json)"
jq -e '.tokens.motion | keys == ["easeDrawer","panel","reduced","skeleton","statusPing","statusPulse"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.motion key set is wrong (bootstrap-tokens.json)"
jq -e '.tokens.shadow | keys == ["composer","controlHighlight","controlPressed"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.shadow key set is wrong (bootstrap-tokens.json)"
jq -e '.tokens.scroll | keys == ["thumb","thumbHover","width"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.scroll key set is wrong (bootstrap-tokens.json)"
jq -e '.tokens.z | keys == ["sheet"]' \
  "$evidence/bootstrap-tokens.json" > /dev/null \
  || fail "tokens.z key set is wrong (bootstrap-tokens.json)"
ok "key sets: 56 color names + 15 contrast + radius/text/font/space/layout/glass/motion/shadow/scroll/z exactly per §4.3 (bootstrap-tokens.json)"

# --- 5. Inline screens stay inside the documented catalog ---
catalog=$(catalog_primitives)
used=$(jq -r '[.screens[].node | .. | objects | .type? // empty] | unique | .[]' \
  "$evidence/bootstrap-tokens.json")
undocumented=""
for type in $used; do
  if ! grep -qx "$type" <<< "$catalog"; then
    undocumented="$undocumented $type"
  fi
done
[ -z "$undocumented" ] \
  || fail "undocumented primitive types in the bootstrap screens:$undocumented (bootstrap-tokens.json)"
ok "bootstrap screens use only documented primitives (docs/sdui.md section 2.5)"

log "T83 QA green: token vocabulary, scales and bootstrap token layer verified"
