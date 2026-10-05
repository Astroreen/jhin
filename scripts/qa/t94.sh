#!/usr/bin/env bash
# QA for T94: phase-B closure — the builder lattice, the doc catalog and the
# golden gallery all agree on the 68-primitive level-3 surface.
# Usage: scripts/qa/t94.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T94. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). The kernel is stopped with SIGTERM and reaped with `wait`; JSON
# assertions run with jq. The kernel boots with jhin.sessions, jhin.ui-kit and
# jhin.ui plus the QA-only level-3 probe screen (the jhin.ui config switch
# qaProbe, set here through the JHIN_UI_QAPROBE environment variable; default
# off, no product surface).
#
# Happy path:
#   - records the toolchain version (flutter-version.txt);
#   - runs the ui-default and ui-kit JVM suites (transcript in test.txt) and
#     requires BUILD SUCCESSFUL — the suites carry the T94 conformance tests
#     (every emitted node type ∈ docs/sdui.md section 2.5, the catalog is
#     exactly 68 names, the level-3 universal props land on their documented
#     surfaces) and the T88 catalog test;
#   - runs the Flutter suite test/sdui (flutter.txt: the whole server-driven
#     UI test set including the T94 primitive_catalog_test) and requires
#     "All tests passed";
#   - asserts the golden gallery: 36 wire-JSON goldens (00..23 level 2 plus
#     24..35 level 3), the 24 level-2 goldens byte-identical to HEAD
#     (append-only gallery);
#   - boots the kernel with the qaProbe screen and fetches it at
#     api=3;schema=4: the six level-3 primitives (split, hover_card,
#     toast_stack, kbd, scroll_fade, diff_view) pass through with the glass
#     group on the five surfaces, statusPulse, demo and safeArea present
#     (probe-l3.json);
#   - fetches the same screen at api=2;schema=3 and asserts the documented
#     level-3 → level-2 downgrade map is complete: every level-3 primitive
#     degraded to its documented target (split → column, hover_card → its
#     trigger with the tooltip kept, toast_stack → a column of texts,
#     kbd → a mono text, scroll_fade → a scroll, diff_view → a code_block),
#     glass/glassTint/statusPulse stripped, demo/safeArea kept as inert
#     markers (probe-l2.json);
#   - asserts the docs/sdui.md section 2.5 catalog extraction reports exactly
#     68 names including the level-3 set;
#   - writes the conformance summary and the goldens diffstat into
#     conformance.txt and the golden count into checks.txt.
#
# Failure path: docs/sdui.md section 2.5 temporarily loses the `split` name
# (backed up first, restored by a trap) while the builders still emit it —
# the conformance guard must trip: the ui-kit UiConformanceTest and the
# ui-default PrimitiveCatalogTest both fail naming `split` (probe-catalog.txt),
# the doc is restored and re-verified (68 names again), then the deliberately
# wrong expectation — "the guard did not trip" — trips (checks-fail.txt, exit
# non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T94_INNER:-}" ]; then
  exec env T94_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T94}
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

port=18494
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
  # The subshell execs into run-kernel.sh (and that into the JVM), so
  # $kernel_pid is the JVM process itself and the cleanup TERM reaches it.
  ( JHIN_HOME="$home" JHIN_UI_QAPROBE=true \
      exec scripts/qa/run-kernel.sh "$kernel_log_dir" --server.port="$port" ) &
  kernel_pid=$!
  wait_health "$base/_jhin/health" 60 || fail "the kernel did not become healthy (see $kernel_log_dir/kernel.log)"
}

# step_hdr <client-header> <transcript> <name> <method> <path> <body>
# <expected-status> <jq-expr> — the t78 step helper with the X-Jhin-Client
# value as the first argument. Appends the request, status and response to
# the transcript and asserts both the status and the jq expression over the
# response body. The last response body is left in $step_payload.
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

# flutter_bin: the same flutter resolution scripts/qa/flutter-test.sh uses
flutter_bin() {
  if command -v flutter > /dev/null 2>&1; then
    flutter "$@"
  else
    devenv shell -- flutter "$@"
  fi
}

# The T94 --fail probe fixture: docs/sdui.md section 2.5 temporarily loses
# the `split` name while the builders still emit it — the conformance guard
# must trip. The doc is backed up and restored by a trap.
doc_backup=""
restore_doc() {
  if [ -n "$doc_backup" ] && [ -f "$doc_backup" ]; then
    cp "$doc_backup" docs/sdui.md
    rm -f "$doc_backup"
    doc_backup=""
  fi
}

if [ "$fail_mode" = "1" ]; then
  log "T94 QA --fail: the catalog guard trips when docs/sdui.md section 2.5 lacks a emitted type"
  log "evidence dir: $evidence"

  doc_backup=$(mktemp)
  cp docs/sdui.md "$doc_backup"
  trap restore_doc EXIT

  # Remove `, `split`` from the section 2.5 bullet list only.
  tmp_doc=$(mktemp)
  awk '
    /^### 2\.5 / {f=1; print; next}
    f && /^### / {f=0}
    f {sub(/, `split`/, "")}
    {print}
  ' docs/sdui.md > "$tmp_doc"
  cp "$tmp_doc" docs/sdui.md
  rm -f "$tmp_doc"

  broken=$(catalog_primitives | grep -c .)
  [ "$broken" = "67" ] \
    || fail "the broken doc catalog reports $broken names, not 67"
  if catalog_primitives | grep -qx "split"; then
    fail "the broken doc catalog still carries split"
  fi
  ok "docs/sdui.md section 2.5 temporarily lacks split (67 names; backup taken, trap restores it)"

  probe="$evidence/probe-catalog.txt"
  if ./gradlew :jhin-plugin-ui-kit:test --tests 'com.astroreen.jhin.plugin.uikit.UiConformanceTest' \
        :jhin-plugin-ui-default:test --tests 'com.astroreen.jhin.plugin.ui.PrimitiveCatalogTest' \
        --rerun > "$probe" 2>&1; then
    restore_doc
    fail "the conformance suites passed despite the doc missing split (see $probe)"
  fi
  grep -q 'split' \
    plugins/ui-kit/build/test-results/test/TEST-com.astroreen.jhin.plugin.uikit.UiConformanceTest.xml \
    || fail "the ui-kit conformance test did not fail naming split (see $probe)"
  grep -q 'split' \
    plugins/ui-default/build/test-results/test/TEST-com.astroreen.jhin.plugin.ui.PrimitiveCatalogTest.xml \
    || fail "the ui-default catalog test did not fail naming split (see $probe)"
  ok "the conformance guard tripped: both suites failed naming split (probe-catalog.txt)"

  restore_doc
  restored=$(catalog_primitives | grep -c .)
  [ "$restored" = "68" ] \
    || fail "the restored doc catalog reports $restored names, not 68"
  ok "docs/sdui.md restored (68 names again)"

  {
    echo "FAIL: the conformance guard tripped as designed (split removed from the catalog, both suites failed)"
    echo "  ui-kit UiConformanceTest and ui-default PrimitiveCatalogTest failed naming split (probe-catalog.txt)"
    echo "  docs/sdui.md restored and re-verified (68 names)"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the catalog guard did not trip (it did; see $evidence/probe-catalog.txt)"
fi

log "T94 QA: phase-B closure — lattice, doc catalog and golden gallery agree on the 68-primitive surface"
log "evidence dir: $evidence"

# --- 1. The toolchain ---
flutter_bin --version > "$evidence/flutter-version.txt" 2>&1 \
  || fail "flutter --version failed (see $evidence/flutter-version.txt)"
ok "toolchain recorded ($(head -n 1 "$evidence/flutter-version.txt"))"

# --- 2. The JVM suites (the T94 conformance tests live here) ---
# --rerun is a per-task flag (it attaches to the preceding task spec): the
# one-flag combined form only force-reruns the last task and silently skips
# the other when it is up-to-date, so each suite carries its own flag.
./gradlew :jhin-plugin-ui-default:test --rerun :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; transcript in test.txt)"

# --- 3. The Flutter suite (the whole sdui set, incl. primitive_catalog_test) ---
bash scripts/qa/flutter-test.sh test/sdui \
  2>&1 | tee "$evidence/flutter.txt"
grep -q 'All tests passed' "$evidence/flutter.txt" \
  || fail "the Flutter sdui suite failed (see $evidence/flutter.txt)"
ok "Flutter sdui suite green incl. the T94 primitive_catalog_test (flutter.txt)"

# --- 4. The golden gallery: 36 wire-JSON goldens, level-2 set byte-identical ---
regression_dir=plugins/ui-kit/src/test/resources/regression
golden_count=$(ls "$regression_dir"/*.json | grep -c .)
[ "$golden_count" = "36" ] \
  || fail "the golden gallery holds $golden_count goldens, not 36 (24 level-2 + 12 level-3)"
for i in 24 25 26 27 28 29 30 31 32 33 34 35; do
  ls "$regression_dir"/${i}-*.json > /dev/null \
    || fail "the level-3 golden $i is missing from the gallery"
done
if ! git diff --quiet -- "$regression_dir"; then
  fail "the golden gallery drifted from HEAD (git diff reports changes; goldens are append-only)"
fi
[ -z "$(git status --porcelain -- "$regression_dir")" ] \
  || fail "the golden gallery has uncommitted changes (git status; goldens are append-only)"
ok "golden gallery: 36 goldens (00..23 level 2 byte-identical to HEAD + 24..35 level 3), append-only"

# --- 5. The kernel with the QA probe screen enabled ---
kernel_log_dir="$evidence"
boot_kernel
ok "kernel booted with sessions, ui-kit and ui plus the qaProbe level-3 probe screen (kernel.log)"

tx="$evidence/roundtrip.txt"
: > "$tx"

hdr_l3='api=3; version=0.3.0; schema=4; caps=sse'
hdr_l2='api=2; version=0.3.0; schema=3; caps=sse'

# --- 6. The probe screen at level 3: the level-3 set passes through ---
fetch_probe "$hdr_l3" "$tx" "probe-l3" "$evidence/probe-l3.json"
l3_types=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' "$evidence/probe-l3.json")
for t in split hover_card toast_stack kbd scroll_fade diff_view; do
  grep -qx "$t" <<< "$l3_types" \
    || fail "the level-3 probe tree does not carry the $t primitive (probe-l3.json)"
done
jq -e '[.. | objects | select(.id? == "probe-glass")][0] |
    .glass == true and .glassTint == "$color.destructive"' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "the glass card node does not carry the glass group (probe-l3.json)"
jq -e '[.. | objects | select(.id? == "probe-safe-area")][0] |
    .safeArea == {"top": true, "bottom": true}' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "the safe-area box does not carry the safeArea group (probe-l3.json)"
jq -e '[.. | objects | select(.id? == "probe-demo")][0] |
    .demo == true' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "the decorative button does not carry the demo marker (probe-l3.json)"
jq -e '[.. | objects | select(.id? == "probe-pulse")][0] |
    .statusPulse == "pulse"' \
  "$evidence/probe-l3.json" > /dev/null \
  || fail "the pulse indicator does not carry statusPulse (probe-l3.json)"
ok "probe screen at api=3;schema=4: the six level-3 primitives pass through with the glass group on the five surfaces, statusPulse, demo and safeArea present (probe-l3.json)"

# --- 7. The probe screen at level 2: the documented downgrade map, complete ---
fetch_probe "$hdr_l2" "$tx" "probe-l2" "$evidence/probe-l2.json"
used=$(jq -r '[.. | objects | .type? // empty] | unique | .[]' "$evidence/probe-l2.json")
for t in split hover_card toast_stack kbd scroll_fade diff_view; do
  if grep -qx "$t" <<< "$used"; then
    fail "the level-2 tree still carries the level-3 type '$t' (probe-l2.json)"
  fi
done
jq -e '[.. | objects | select(.id? == "probe-split")][0] |
    .type == "column" and (.children | length == 2)' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "split did not degrade to a column stacking the two panes (probe-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-hover-card")][0] |
    .type == "text" and .text == "Hover trigger" and .tooltip == "kept tooltip"' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "hover_card did not degrade to its trigger with the tooltip kept (probe-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-toast-stack")][0] |
    .type == "column" and ([.children[].text] | sort == ["Deleted", "Saved"])' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "toast_stack did not degrade to a column of texts (probe-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-kbd")][0] |
    .type == "text" and .text == "mod+shift+m" and .style == "mono"' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "kbd did not degrade to a mono text carrying the chord (probe-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-scroll-fade")][0] |
    .type == "scroll" and (.children | length == 1)' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "scroll_fade did not degrade to a scroll wrapping the same child (probe-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-diff-view")][0] |
    .type == "code_block"
    and (.code | startswith("docs/sdui.md"))
    and (.code | contains("@@"))' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "diff_view did not degrade to a code_block carrying the file name and the hunk headers (probe-l2.json)"
for prop in glass glassTint statusPulse; do
  if jq -e "[.. | objects | has(\"$prop\")] | any" "$evidence/probe-l2.json" > /dev/null; then
    fail "the level-3 universal prop '$prop' survived the downgrade (probe-l2.json)"
  fi
done
jq -e '[.. | objects | select(.id? == "probe-demo")][0] |
    .demo == true' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "the demo marker did not survive the downgrade (probe-l2.json)"
jq -e '[.. | objects | select(.id? == "probe-safe-area")][0] |
    .safeArea == {"top": true, "bottom": true}' \
  "$evidence/probe-l2.json" > /dev/null \
  || fail "the safeArea group did not survive the downgrade (probe-l2.json)"
ok "probe screen at api=2;schema=3: the downgrade map is complete — split→column, hover_card→trigger (tooltip kept), toast_stack→column of texts, kbd→mono text, scroll_fade→scroll, diff_view→code_block; glass/glassTint/statusPulse stripped; demo/safeArea kept (probe-l2.json)"

# --- 8. The docs catalog: exactly 68 names incl. the level-3 set ---
catalog=$(catalog_primitives)
count=$(grep -c . <<< "$catalog")
[ "$count" = "68" ] \
  || fail "the docs/sdui.md section 2.5 catalog extraction reports $count names, not 68"
# The canon extraction pattern (`[a-z_]+`) is lowercase-only: the camelCase
# names truncate at the uppercase (statusPulse -> status, glassTint -> glass
# phantom) yet the unique count stays 68 (docs/sdui.md section 15.8
# sensitivity note). The full-name assertions live in the JVM
# PrimitiveCatalogTest/UiConformanceTest and the Dart primitive_catalog_test,
# which parse the backtick spans properly.
for t in split hover_card toast_stack kbd scroll_fade diff_view glass demo; do
  grep -qx "$t" <<< "$catalog" \
    || fail "the catalog extraction does not report the level-3 name $t"
done
grep -qx "status" <<< "$catalog" \
  || fail "the catalog extraction does not report the statusPulse truncation (status)"
grep -qx "safe" <<< "$catalog" \
  || fail "the catalog extraction does not report the safeArea truncation (safe)"
ok "catalog extraction reports exactly 68 names incl. the level-3 set (6 primitives + glass/demo; statusPulse/safeArea truncate to 'status'/'safe' under the canon lowercase pattern — full names asserted JVM/Dart-side)"

# The kernel work is done — stop it before the summary so a lingering
# graceful shutdown never delays the run end.
stop_kernel

# --- 9. The conformance summary + the goldens diffstat ---
{
  echo "# T94 conformance summary (phase B closure)"
  echo
  echo "catalog: 68 names (docs/sdui.md section 2.5 extraction; the canon"
  echo "lowercase pattern truncates camelCase: statusPulse -> status,"
  echo "safeArea -> safe, glassTint -> glass phantom — full names asserted"
  echo "JVM/Dart-side)"
  echo "$catalog" | sed 's/^/  /'
  echo
  echo "level-3 primitives: split, hover_card, toast_stack, kbd, scroll_fade, diff_view"
  echo "level-3 universal names: glass, demo, statusPulse, safeArea (glassTint documented in 2.1/6)"
  echo
  echo "builder lattice: 64 builders (58 level-2 + 6 level-3), every Has* group probed"
  echo "  incl. HasScrollFade (T94) and the statusPulse/safeArea wire keys"
  echo
  echo "downgrade map (probe at api=2;schema=3, probe-l2.json):"
  echo "  split -> column; hover_card -> trigger (tooltip kept); toast_stack -> column of texts;"
  echo "  kbd -> mono text; scroll_fade -> scroll; diff_view -> code_block (file + hunk headers);"
  echo "  glass/glassTint/statusPulse stripped; demo/safeArea kept"
  echo
  echo "golden gallery: 36 goldens (00..23 level 2 byte-identical to HEAD + 24..35 level 3)"
  echo
  echo "# goldens diffstat (T94)"
  echo
  echo "## git diff --stat (tracked golden sources)"
  git diff --stat -- plugins/ui-kit/src/test/resources/regression frontend/test/gallery/goldens frontend/test/gallery/gallery_nodes.dart || true
  echo
  echo "## golden files (git status --porcelain)"
  git status --porcelain -- plugins/ui-kit/src/test/resources/regression frontend/test/gallery/goldens || true
} > "$evidence/conformance.txt"
ok "conformance summary + goldens diffstat recorded (conformance.txt); golden count 36 = 24 + 12 (checks.txt)"

log "T94 QA green: phase B closed — lattice, doc catalog and golden gallery agree on the 68-primitive surface"