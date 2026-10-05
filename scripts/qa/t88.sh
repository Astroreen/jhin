#!/usr/bin/env bash
# QA for T88: contract level 3 — the 68-primitive catalog, the schema
# negotiation and the level-3 -> level-2 downgrade.
# Usage: scripts/qa/t88.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T88. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog plus explicit curl timeouts). The kernel is stopped with SIGTERM
# and reaped with `wait`; JSON assertions run with jq. The kernel boots with
# jhin.sessions, jhin.ui-kit and jhin.ui plus the QA-only level-3 probe
# screen (the jhin.ui config switch qaProbe, set here through the
# JHIN_UI_QAPROBE environment variable; default off, no product surface).
#
# Happy path:
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL;
#   - fetches GET /_jhin/bootstrap at api=3;schema=4 and asserts the level-3
#     contract block {api:3, minApi:2, schema:4, minSchema:3}
#     (bootstrap-l3.json);
#   - fetches GET /ui/screen/qa-level3 at api=3;schema=4 and asserts every
#     level-3 primitive passes through with its props (downgrade-l3.json);
#   - fetches the same screen at api=2;schema=3 and asserts the downgrade per
#     the docs/sdui.md section 6 map: zero level-3 node types, split->column,
#     hover_card->trigger with the tooltip kept, toast_stack->column of
#     texts, kbd->text (mono), scroll_fade->scroll, diff_view->code_block,
#     glass/statusPulse stripped, demo kept (downgrade-l2.json); the two
#     trees are diffed into downgrade.diff;
#   - asserts the docs/sdui.md section 2.5 catalog extraction reports exactly
#     68 names including the six level-3 primitives, and that every node
#     type of the probe tree is inside it.
#
# Failure path: the same kernel, then a bootstrap and a probe-screen fetch
# with schema=2 (below minSchema 3) — both answer HTTP 200 with the
# documented version-gate payload (entry version_gate, no crash); recorded
# in version-gate.json. Then a deliberately wrong expectation — that the
# payload also carries a server-rendered version_gate node — trips
# (checks-fail.txt, exit non-zero): the gate surface is client-owned chrome,
# the server only names it through the entry (docs/sdui.md section 6).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T88_INNER:-}" ]; then
  exec env T88_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T88}
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

port=18488
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
  JHIN_HOME="$home" JHIN_UI_QAPROBE=true \
    scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 60 || fail "the kernel did not become healthy (see $kernel_log_dir/kernel.log)"
}

# step_hdr <client-header> <transcript> <name> <method> <path> <body>
# <expected-status> <jq-expr> — the t78 step helper with the X-Jhin-Client
# value as the first argument (this task negotiates at two levels). Appends
# the request, status and response to the transcript and asserts both the
# status and the jq expression over the response body. The last response
# body is left in $step_payload for the caller.
step_hdr() {
  local hdr=$1 tx=$2 name=$3 method=$4 path=$5 body=$6 expected=$7 expr=$8
  local response status payload
  response=$(curl -sS --max-time 10 -X "$method" \
      -H 'Content-Type: application/json' \
      -H "X-Jhin-Client: $hdr" \
      --data "$body" \
      -w $'\n%{http_code}' "$base$path")
  status=${response##*$'\n'}
  payload=${response%$'\n'*}
  step_payload=$payload
  {
    echo "=== $name ==="
    echo "$method $path"
    echo "client: $hdr"
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

# fetch_probe <header> <transcript> <name> <out-json>: the probe screen node
fetch_probe() {
  local hdr=$1 tx=$2 name=$3 out=$4
  step_hdr "$hdr" "$tx" "$name" GET /ui/screen/qa-level3 '' 200 '.node.type == "screen"'
  jq -S .node <<< "$step_payload" > "$out"
}

# catalog_primitives: the docs/sdui.md section 2.5 primitive names
catalog_primitives() {
  awk '/^### 2\.5 /{f=1;next} /^### /{f=0} f' docs/sdui.md \
    | grep -oE '`[a-z_]+' | tr -d '`' | sort -u
}

hdr_l3='api=3; version=0.3.0; schema=4; caps=sse'
hdr_l2='api=2; version=0.3.0; schema=3; caps=sse'
hdr_gate='api=3; version=0.3.0; schema=2; caps=sse'

if [ "$fail_mode" = "1" ]; then
  log "T88 QA --fail: a schema=2 client (below minSchema 3) gets the version-gate surface, not a crash"
  log "evidence dir: $evidence"
  kernel_log_dir="$evidence/fail-boot"
  mkdir -p "$kernel_log_dir"
  boot_kernel
  tx="$evidence/version-gate.txt"
  : > "$tx"

  # The documented version-gate payload: HTTP 200, entry version_gate.
  step_hdr "$hdr_gate" "$tx" "bootstrap-schema2" GET /_jhin/bootstrap '' 200 \
    '.entry == "version_gate" and .contract.minSchema == 3 and .api == 3'
  jq -S . <<< "$step_payload" > "$evidence/version-gate.json"
  ok "schema=2 bootstrap answers 200 with entry version_gate and minSchema 3 (version-gate.json)"

  step_hdr "$hdr_gate" "$tx" "probe-schema2" GET /ui/screen/qa-level3 '' 200 '.node.type == "screen"'
  ok "the probe screen still renders for a schema=2 client: HTTP 200, no crash (version-gate.txt)"

  # Deliberately wrong expectation: the version-gate surface is client-owned
  # chrome (docs/sdui.md section 6) — the server only names it via entry, no
  # server-rendered version_gate node exists.
  if jq -e '[.screens[] | select(.id == "version_gate")] | length > 0' \
      "$evidence/version-gate.json" > /dev/null; then
    fail "deliberately wrong expectation held: the payload carries a server-rendered version_gate node (see $evidence/version-gate.json)"
  fi
  fail "deliberately wrong expectation: the version_gate surface is client-owned chrome and never server-rendered (it is not in the screens list; see $evidence/version-gate.json)"
fi

log "T88 QA: contract level 3 — 68 primitives, schema negotiation, level-3 downgrade"
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

# --- 2. The kernel with the QA probe screen enabled ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui plus the qaProbe level-3 probe screen (kernel.log)"

tx="$evidence/roundtrip.txt"
: > "$tx"

# --- 3. Bootstrap at level 3: the new contract block ---
step_hdr "$hdr_l3" "$tx" "bootstrap-l3" GET /_jhin/bootstrap '' 200 \
  '.api == 3 and .contract.api == 3 and .contract.minApi == 2 and .contract.schema == 4 and .contract.minSchema == 3'
jq -S . <<< "$step_payload" > "$evidence/bootstrap-l3.json"
ok "bootstrap at api=3;schema=4 carries contract {api:3, minApi:2, schema:4, minSchema:3} (bootstrap-l3.json)"

# --- 4. The probe screen at level 3: everything passes through ---
fetch_probe "$hdr_l3" "$tx" "probe-l3" "$evidence/downgrade-l3.json"
for probe_id in probe-split probe-hover-card probe-toast-stack probe-kbd \
                probe-scroll-fade probe-diff-view probe-glass probe-pulse \
                probe-demo probe-safe-area; do
  jq -e --arg id "$probe_id" '[.. | objects | select(.id? == $id)] | length == 1' \
    "$evidence/downgrade-l3.json" > /dev/null \
    || fail "the level-3 probe tree is missing the '$probe_id' node (downgrade-l3.json)"
done
for probe_type in split hover_card toast_stack kbd scroll_fade diff_view; do
  jq -e --arg t "$probe_type" '[.. | objects | select(.type? == $t)] | length >= 1' \
    "$evidence/downgrade-l3.json" > /dev/null \
    || fail "the level-3 probe tree does not pass the '$probe_type' node through (downgrade-l3.json)"
done
jq -e '[.. | objects | select(.id? == "probe-glass")][0].glass == true' \
  "$evidence/downgrade-l3.json" > /dev/null \
  || fail "the glass prop did not pass through at level 3 (downgrade-l3.json)"
jq -e '[.. | objects | select(.id? == "probe-pulse")][0].statusPulse == "pulse"' \
  "$evidence/downgrade-l3.json" > /dev/null \
  || fail "the statusPulse prop did not pass through at level 3 (downgrade-l3.json)"
ok "probe screen at api=3;schema=4: all ten nodes pass through with glass/statusPulse (downgrade-l3.json)"

# --- 5. The probe screen at level 2: the documented downgrade map ---
fetch_probe "$hdr_l2" "$tx" "probe-l2" "$evidence/downgrade-l2.json"

used=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' "$evidence/downgrade-l2.json")
for probe_type in split hover_card toast_stack kbd scroll_fade diff_view; do
  if grep -qx "$probe_type" <<< "$used"; then
    fail "the level-2 tree still carries the level-3 type '$probe_type' (downgrade-l2.json)"
  fi
done
ok "probe screen at api=2;schema=3: zero level-3 node types (downgrade-l2.json)"

jq -e '[.. | objects | select(.id? == "probe-split")][0] | .type == "column" and (.children | length) == 2' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "split did not degrade to a column stacking the two panes (downgrade-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-hover-card")][0] | .type == "text" and .text == "Hover trigger" and .tooltip == "kept tooltip"' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "hover_card did not degrade to its trigger with the tooltip kept (downgrade-l2.json)"
jq -e '[.. | objects | select(.text? == "Hover content")] | length == 0' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "the hover_card content survived the downgrade (downgrade-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-toast-stack")][0] | .type == "column" and ([.children[].text] == ["Saved", "Deleted"])' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "toast_stack did not degrade to a column of the item texts (downgrade-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-kbd")][0] | .type == "text" and .text == "mod+shift+m" and .style == "mono"' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "kbd did not degrade to mono text carrying the chord (downgrade-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-scroll-fade")][0] | .type == "scroll" and (.children | length) == 1' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "scroll_fade did not degrade to a scroll around the same child (downgrade-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-diff-view")][0] | .type == "code_block" and (.code | contains("@@ -1,3 +1,4 @@")) and .language == "markdown"' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "diff_view did not degrade to a code_block with the hunk headers (downgrade-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-glass")][0] | has("glass") | not' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "the glass prop survived the downgrade (downgrade-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-pulse")][0] | has("statusPulse") | not' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "the statusPulse prop survived the downgrade (downgrade-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-demo")][0].demo == true' \
  "$evidence/downgrade-l2.json" > /dev/null \
  || fail "the demo marker did not survive the downgrade (downgrade-l2.json)"
ok "downgrade map verified: split->column, hover_card->trigger+tooltip, toast_stack->column, kbd->text, scroll_fade->scroll, diff_view->code_block; glass/statusPulse stripped, demo kept"

diff -u "$evidence/downgrade-l2.json" "$evidence/downgrade-l3.json" \
  > "$evidence/downgrade.diff" || true
[ -s "$evidence/downgrade.diff" ] \
  || fail "the level-2 and level-3 probe trees are identical — the downgrade did not run (downgrade.diff)"
ok "tree diff recorded (downgrade.diff)"

# --- 6. The docs catalog: exactly 68, probe types inside it ---
catalog=$(catalog_primitives)
count=$(grep -c . <<< "$catalog")
[ "$count" = "68" ] \
  || fail "the docs/sdui.md section 2.5 catalog extraction reports $count names, not 68"
for probe_type in split hover_card toast_stack kbd scroll_fade diff_view; do
  grep -qx "$probe_type" <<< "$catalog" \
    || fail "the catalog is missing the level-3 primitive '$probe_type'"
done
for type in $used; do
  grep -qx "$type" <<< "$catalog" \
    || fail "undocumented primitive type in the level-2 probe tree: $type"
done
ok "catalog extraction reports exactly 68 names incl. the six level-3 primitives; the level-2 tree uses only documented primitives"

log "T88 QA green: contract level 3 verified"
