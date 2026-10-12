#!/usr/bin/env bash
# T301 QA — t3code token parity: 63 colour tokens and five OKLCH themes.
#
# Proves, with a booted kernel, curl and static greps only (browser tools are
# UNAVAILABLE in this environment — every browser step becomes
# evidence/T301/browser-unavailable.txt plus strengthened curl/static asserts,
# the T202–T208 precedent):
#   1. build + test gates: the kernel boot jar and the three plugin jars build
#      and the two suites stay green (:jhin-plugin-ui-kit:test,
#      :jhin-plugin-ui-default:test); counts are summed from the JUnit XML
#      reports, failures/errors asserted 0;
#   2. static token gates: web/css/tokens.css carries the five upstream raw
#      tokens verbatim (--workspace-topbar-height: 52px,
#      --chat-content-max-width: 46rem, --thread-details-panel-width: 17.5rem,
#      --z-sheet: 46, --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1));
#   3. wire token gates: GET /ui/assets/tokens.css serves the same five raw
#      tokens, and the inline style#jhin-token-css of GET / emits at least 63
#      distinct --color-* alias names — every one of the 63 UiTokens colour
#      keys among them (tokens.txt, color-names.txt);
#   4. theme sentinel gates: POST /ui/action/save-appearance selects t3-chat
#      dark, then t3-chat light; the inlined palette layer carries the
#      verbatim themePalettes.ts OKLCH sentinels (--primary/--background/
#      --foreground/--accent/--border) in both modes and
#      GET /_jhin/bootstrap theme.colors carries the same dark primary
#      sentinel — t3-chat dark --primary = oklch(0.460685 0.185347 4.099)
#      among them; the five built-in themes' dark primary sentinels are
#      pinned in the ThemePalettes source greps (themes.txt);
#   5. browser-unavailable.txt: computed-style / visual theme rendering cannot
#      be exercised here; the file lists exactly which interactive cases are
#      uncovered and which asserts substitute them;
#   6. summary.txt with every PASS line and the key numbers.
#
# --fail mode (the negative proofs — each must PASS, exit 0, into
# checks-fail.txt):
#   a. missing-keys.txt: the missing-key probe is proven to fail closed —
#      with --color-toolbar-background deleted from the served colour-name
#      set and --z-sheet: 46 deleted from the served raw-token set, the same
#      probe the happy path applies reports exactly those keys as MISSING (a
#      vacuously passing gate could not produce this file).
#
# The kernel is booted through scripts/qa/run-kernel.sh with a temp JHIN_HOME
# seeded with three plugin jars: jhin.sessions, jhin.ui-kit and jhin.ui (the
# non-optional requires of jhin.ui). jhin.security is deliberately absent: no
# bearer token is needed and the listener speaks plain HTTP on
# http://localhost:18443 (the kernel default 8443 is occupied on the QA
# machine; plan section 9 allows the QA-only plain-HTTP mode in scripts).
#
# On any failure one line is appended to evidence/T301/failures.txt and the
# run exits non-zero; on success summary.txt carries PASS and the key
# numbers. Runs from the repository root.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T301_INNER:-}" ]; then
    exec env T301_INNER=1 timeout --kill-after=15 900 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."
ROOT="$(pwd)"

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
    fail_mode=1
    shift
fi

EVIDENCE="${1:-$ROOT/.sisyphus/evidence/T301}"
PORT=18443
BASE="http://localhost:$PORT"
CLIENT_API4='X-Jhin-Client: api=4; version=0.2.0; schema=5; caps=sse,open_url,secure_storage'
TOKENS_CSS="plugins/ui-default/src/main/resources/web/css/tokens.css"
THEME_PALETTES="plugins/ui-kit/src/main/java/com/astroreen/jhin/plugin/uikit/ThemePalettes.java"

mkdir -p "$EVIDENCE"
rm -f "$EVIDENCE/failures.txt"
if [ "$fail_mode" = "1" ]; then
    checks="$EVIDENCE/checks-fail.txt"
else
    checks="$EVIDENCE/checks.txt"
fi
: > "$checks"

log() {
    printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$checks"
}

ok() {
    printf 'ok: %s\n' "$*" | tee -a "$checks"
}

fail() {
    printf 'FAIL: %s\n' "$*" | tee -a "$checks" >&2
    echo "FAIL: $*" >> "$EVIDENCE/failures.txt"
    exit 1
}

kernel_pid=""
cleanup() {
    if [ -n "$kernel_pid" ] && kill -0 "$kernel_pid" 2>/dev/null; then
        kill "$kernel_pid" 2>/dev/null || true
        wait "$kernel_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT

# stage_jars <dir>: copies the three plugin jars into <dir>, retrying briefly —
# a background IDE gradle build can be rewriting build/libs while we copy.
stage_jars() {
    local dest=$1 attempt
    for attempt in 1 2 3 4 5; do
        if cp plugins/sessions/build/libs/jhin-plugin-sessions-*.jar "$dest/" 2>/dev/null \
                && cp plugins/ui-kit/build/libs/jhin-plugin-ui-kit-*.jar "$dest/" 2>/dev/null \
                && cp plugins/ui-default/build/libs/jhin-plugin-ui-default-*.jar "$dest/" 2>/dev/null; then
            return 0
        fi
        rm -f "$dest"/*.jar 2>/dev/null || true
        sleep 1
    done
    return 1
}

# boot_kernel <home> <bundled>: starts run-kernel.sh and waits <= 30 s for health.
boot_kernel() {
    local home=$1 bundled=$2 start code
    JHIN_HOME="$home" JHIN_BUNDLED_PLUGINS="$bundled" \
        "$ROOT/scripts/qa/run-kernel.sh" "$EVIDENCE" --server.port="$PORT" &
    kernel_pid=$!
    start=$(date +%s)
    while :; do
        code=$(curl -s --max-time 2 -o "$EVIDENCE/health.body" -w '%{http_code}' \
            "$BASE/_jhin/health" 2>/dev/null) || code=000
        [ "$code" = "200" ] && break
        kill -0 "$kernel_pid" 2>/dev/null \
            || fail "kernel (pid $kernel_pid) exited before health answered (see $EVIDENCE/kernel.log)"
        [ $(( $(date +%s) - start )) -lt 30 ] \
            || fail "health endpoint did not answer 200 within 30 s (last code $code)"
        sleep 0.5
    done
    ok "kernel up on $BASE (pid $kernel_pid), GET /_jhin/health -> 200 in $(( $(date +%s) - start )) s"
}

# extract_token_css <shell.html> <out>: cuts the style#jhin-token-css payload
# out of a served shell document.
extract_token_css() {
    sed -n '/<style id="jhin-token-css"/,/<\/style>/p' "$1" \
        | sed '1s/.*<style id="jhin-token-css"[^>]*>//; $s/<\/style>.*//' > "$2"
}

# probe_missing <present> <required> <out>: appends "  MISSING <name>" to
# <out> for every required line absent from the present set. Returns 0
# always; the caller reads <out> to learn what the gate caught.
probe_missing() {
    local present=$1 required=$2 out=$3 name
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        grep -qxF -- "$name" "$present" || printf '  MISSING %s\n' "$name" >> "$out"
    done < "$required"
    return 0
}

# The 63 colour keys of UiTokens.COLOR_KEYS — the names every compliant token
# CSS must alias as --color-<key>. Delete nothing here: the --fail probe
# proves the check catches deletions.
required_color_names() {
    cat <<'EOF'
--color-accent
--color-accent-foreground
--color-app-chrome-background
--color-background
--color-border
--color-card
--color-card-foreground
--color-code
--color-code-foreground
--color-destructive
--color-destructive-foreground
--color-diff-addition
--color-diff-addition-foreground
--color-diff-deletion
--color-diff-deletion-foreground
--color-error
--color-error-foreground
--color-error-surface
--color-foreground
--color-icon-muted
--color-info
--color-info-foreground
--color-input
--color-message
--color-message-action
--color-message-action-foreground
--color-message-action-hover
--color-message-foreground
--color-muted
--color-muted-foreground
--color-placeholder
--color-popover
--color-popover-foreground
--color-primary
--color-primary-foreground
--color-ring
--color-secondary
--color-secondary-foreground
--color-secondary-label
--color-sidebar
--color-sidebar-border
--color-sidebar-control-surface
--color-sidebar-foreground
--color-sidebar-muted-foreground
--color-sidebar-row-active
--color-sidebar-row-hover
--color-sidebar-row-selected
--color-success
--color-success-foreground
--color-surface-raised
--color-toolbar-background
--color-toolbar-border
--color-toolbar-control
--color-toolbar-control-foreground
--color-toolbar-control-hover
--color-toolbar-foreground
--color-tool-error-icon
--color-update
--color-update-foreground
--color-update-surface
--color-warning
--color-warning-foreground
--color-warning-surface
EOF
}

# The five upstream raw tokens of index.css :root that T301 wired into
# web/css/tokens.css verbatim.
required_raw_tokens() {
    cat <<'EOF'
--workspace-topbar-height: 52px
--chat-content-max-width: 46rem
--thread-details-panel-width: 17.5rem
--z-sheet: 46
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)
EOF
}

# The t3-chat themePalettes.ts sentinels, exactly (palette-layer names).
t3_chat_dark_sentinels() {
    cat <<'EOF'
--primary: oklch(0.460685 0.185347 4.099)
--background: oklch(0.22813 0.020366 307.469)
--foreground: oklch(0.980735 0.004092 301.426)
--accent: oklch(0.364912 0.050794 308.491)
--border: oklch(0.266943 0.015262 302.425)
EOF
}

t3_chat_light_sentinels() {
    cat <<'EOF'
--primary: oklch(0.591646 0.217985 0.584)
--background: oklch(0.982446 0.010114 325.653)
--foreground: oklch(0.325698 0.116116 325.037)
--accent: oklch(0.939552 0.024286 321.664)
--border: oklch(0.923531 0.021247 328.096)
EOF
}

# ------------------------------------------------------------------ --fail
if [ "$fail_mode" = "1" ]; then
    echo "== T301 QA --fail: the negative proofs must PASS =="

    # ---- negative proof a: the missing-key probe fails closed.
    log "-- negative proof a: the missing-key probe catches deleted keys"
    ./gradlew --console=plain :kernel:bootJar \
        :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar \
        >> "$EVIDENCE/build-fail.log" 2>&1 \
        || fail "gradle build exited non-zero (see $EVIDENCE/build-fail.log)"
    home=$(mktemp -d)
    bundled=$(mktemp -d)
    stage_jars "$bundled" || fail "could not stage the three plugin jars into $bundled"
    boot_kernel "$home" "$bundled"

    shell="$EVIDENCE/shell-fail.html"
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$shell" -w '%{http_code}' "$BASE/") \
        || fail "GET /: curl failed"
    [ "$code" = "200" ] || fail "GET / answered $code (expected 200)"
    extract_token_css "$shell" "$EVIDENCE/token-css-fail.txt"
    grep -oE -- '--color-[a-z0-9-]+' "$EVIDENCE/token-css-fail.txt" | sort -u \
        > "$EVIDENCE/color-names-full.txt"
    required_color_names > "$EVIDENCE/color-names-required.txt"
    required_raw_tokens > "$EVIDENCE/raw-tokens-required.txt"
    code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/asset-tokens-fail.css" \
        -w '%{http_code}' "$BASE/ui/assets/tokens.css") || fail "GET /ui/assets/tokens.css: curl failed"
    [ "$code" = "200" ] || fail "GET /ui/assets/tokens.css answered $code (expected 200)"
    grep -oE -- '--[a-z0-9-]+: [^;]+' "$EVIDENCE/asset-tokens-fail.css" | sort -u \
        > "$EVIDENCE/raw-tokens-all.txt" || true

    {
        echo "T301 --fail: the missing-key probe must fail closed."
        echo ""
        echo "  probe: every line of the required set must be present in the"
        echo "  served set; absent lines are reported as MISSING."
        echo ""
    } > "$EVIDENCE/missing-keys.txt"

    # probe 1: a colour alias name deleted from the served set.
    grep -vxF -- '--color-toolbar-background' "$EVIDENCE/color-names-full.txt" \
        > "$EVIDENCE/color-names-mutated.txt"
    probe_missing "$EVIDENCE/color-names-mutated.txt" "$EVIDENCE/color-names-required.txt" \
        "$EVIDENCE/missing-keys.txt"
    grep -qF 'MISSING --color-toolbar-background' "$EVIDENCE/missing-keys.txt" \
        || fail "probe did not report the deleted --color-toolbar-background (missing-keys.txt)"
    printf '  colour probe: --color-toolbar-background deleted -> reported MISSING (PASS)\n' \
        >> "$EVIDENCE/missing-keys.txt"

    # probe 2: a raw token line deleted from the served set.
    grep -vxF -- '--z-sheet: 46' "$EVIDENCE/raw-tokens-all.txt" \
        > "$EVIDENCE/raw-tokens-mutated.txt" || true
    probe_missing "$EVIDENCE/raw-tokens-mutated.txt" "$EVIDENCE/raw-tokens-required.txt" \
        "$EVIDENCE/missing-keys.txt"
    grep -qF 'MISSING --z-sheet: 46' "$EVIDENCE/missing-keys.txt" \
        || fail "probe did not report the deleted --z-sheet: 46 (missing-keys.txt)"
    printf '  raw-token probe: --z-sheet: 46 deleted -> reported MISSING (PASS)\n' \
        >> "$EVIDENCE/missing-keys.txt"

    miss_count=$(grep -c '^  MISSING ' "$EVIDENCE/missing-keys.txt" || true)
    printf '\n  total MISSING lines reported: %s (exactly the two deleted keys)\n' "$miss_count" \
        >> "$EVIDENCE/missing-keys.txt"
    [ "$miss_count" = "2" ] \
        || fail "probe reported $miss_count missing keys (expected exactly 2; missing-keys.txt)"
    ok "missing-key probe fails closed on both deleted keys (missing-keys.txt)"

    ok "T301 QA --fail: the negative proof PASSes"
    exit 0
fi

# ------------------------------------------------------------------ happy
echo "== T301 QA: t3code token parity — 63 colour tokens and five OKLCH themes =="
echo "-- repository root: $ROOT"
echo "-- evidence: $EVIDENCE"

# ------------------------------------------------------------------- build
echo "== Step 1: build the jars + run the two test gates =="
set +e
./gradlew --console=plain :kernel:bootJar \
    :jhin-plugin-sessions:jar :jhin-plugin-ui-kit:jar :jhin-plugin-ui-default:jar \
    2>&1 | tee "$EVIDENCE/build.log"
BUILD_STATUS="${PIPESTATUS[0]}"
set -e
[ "$BUILD_STATUS" -eq 0 ] || fail "gradle build exited $BUILD_STATUS (see $EVIDENCE/build.log)"

set +e
./gradlew --console=plain \
    :jhin-plugin-ui-kit:test --rerun \
    :jhin-plugin-ui-default:test --rerun \
    2>&1 | tee -a "$EVIDENCE/build.log"
TEST_STATUS="${PIPESTATUS[0]}"
set -e
[ "$TEST_STATUS" -eq 0 ] || fail "gradle tests exited $TEST_STATUS (see $EVIDENCE/build.log)"
grep -qF 'BUILD SUCCESSFUL' "$EVIDENCE/build.log" \
    || fail "gradle did not report BUILD SUCCESSFUL (see $EVIDENCE/build.log)"

count_attr() {
    grep -h -o "$2=\"[0-9]*\"" "$1"/TEST-*.xml 2>/dev/null | awk -F'"' '{s += $2} END {print s+0}'
}
ui_kit_tests=$(count_attr plugins/ui-kit/build/test-results/test tests)
ui_default_tests=$(count_attr plugins/ui-default/build/test-results/test tests)
total_failures=$(( $(count_attr plugins/ui-kit/build/test-results/test failures) \
    + $(count_attr plugins/ui-default/build/test-results/test failures) ))
total_errors=$(( $(count_attr plugins/ui-kit/build/test-results/test errors) \
    + $(count_attr plugins/ui-default/build/test-results/test errors) ))
{
    echo "T301 test gates — the two suites green on the parity token set:"
    grep -E '^> Task :[^ ]+:test$|BUILD SUCCESSFUL|BUILD FAILED' "$EVIDENCE/build.log" || true
    echo ""
    echo "  :jhin-plugin-ui-kit:test      $ui_kit_tests tests (ThemeCatalogTest sentinels among them)"
    echo "  :jhin-plugin-ui-default:test  $ui_default_tests tests"
    echo "  failures=$total_failures errors=$total_errors (expected 0/0)"
} > "$EVIDENCE/test-gates.txt"
for suite in ':jhin-plugin-ui-kit:test' ':jhin-plugin-ui-default:test'; do
    grep -qF "> Task $suite" "$EVIDENCE/build.log" \
        || fail "test suite $suite did not run (see $EVIDENCE/build.log)"
done
[ "$total_failures" = "0" ] || fail "test failures=$total_failures (expected 0)"
[ "$total_errors" = "0" ] || fail "test errors=$total_errors (expected 0)"
ok "build + two test gates green ($ui_kit_tests/$ui_default_tests tests, 0 failures; test-gates.txt)"

# ------------------------------------------------------- static token gates
echo "== Step 2: the five upstream raw tokens in web/css/tokens.css =="
required_raw_tokens > "$EVIDENCE/raw-tokens-required.txt"
{
    echo "T301 static token gates — the upstream raw token layer of"
    echo "web/css/tokens.css (index.css :root vocabulary, verbatim)."
    echo ""
} > "$EVIDENCE/tokens.txt"
raw_ok=1
while IFS= read -r line; do
    [ -n "$line" ] || continue
    hits=$(grep -cF -- "$line" "$TOKENS_CSS" || true)
    printf '  %-52s %s hit(s)  %s\n' "$line" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" >> "$EVIDENCE/tokens.txt"
    [ "$hits" -ge 1 ] || raw_ok=0
done < "$EVIDENCE/raw-tokens-required.txt"
[ "$raw_ok" = "1" ] || fail "static raw-token gates failed (see $EVIDENCE/tokens.txt)"
ok "five upstream raw tokens present in web/css/tokens.css (tokens.txt)"

# ------------------------------------------------------- seed a temp home
echo "== Step 3: seed a temp JHIN_HOME (jhin.sessions + jhin.ui-kit + jhin.ui) =="
home=$(mktemp -d /tmp/t301-home.XXXXXX)
bundled=$(mktemp -d /tmp/t301-bundled.XXXXXX)
stage_jars "$bundled" || fail "could not stage the three plugin jars into $bundled"
jar_count=$(ls "$bundled"/*.jar 2>/dev/null | wc -l | tr -d ' ')
[ "$jar_count" = "3" ] || fail "expected 3 plugin jars in $bundled, got $jar_count"
{
    echo "JHIN_HOME=$home"
    echo "JHIN_BUNDLED_PLUGINS=$bundled"
    echo "port=$PORT"
    echo "base=$BASE"
    echo "mode=plain HTTP loopback"
    echo "mode-reason=jhin.security is not loaded -> no TlsProvider registered -> the kernel"
    echo "            listener speaks plain HTTP. Plan section 9 allows the QA-only"
    echo "            plain-HTTP mode in scripts."
    echo "port-reason=the kernel default 8443 is occupied by another service on this machine"
    echo "plugins=jhin.sessions, jhin.ui-kit, jhin.ui"
    echo "plugin-reason=the non-optional requires of jhin.ui; T301 drives the settings action"
    echo "              and the static payloads only, no LLM run is needed."
} > "$EVIDENCE/kernel-env.txt"
ok "$jar_count jars staged for seeding (kernel-env.txt)"

# -------------------------------------------------------------------- boot
echo "== Step 4: boot the kernel via run-kernel.sh (wait <= 30 s for health) =="
boot_kernel "$home" "$bundled"

# ------------------------------------------------------- wire token gates
echo "== Step 5: GET /ui/assets/tokens.css + GET / inline token CSS =="
code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/asset-tokens.css" \
    -w '%{http_code}' "$BASE/ui/assets/tokens.css") || fail "GET /ui/assets/tokens.css: curl failed"
[ "$code" = "200" ] || fail "GET /ui/assets/tokens.css answered $code (expected 200)"
{
    echo ""
    echo "T301 wire token gates — the same five raw tokens over the asset route,"
    echo "then the inline style#jhin-token-css alias layer of GET /."
    echo ""
} >> "$EVIDENCE/tokens.txt"
raw_ok=1
while IFS= read -r line; do
    [ -n "$line" ] || continue
    hits=$(grep -cF -- "$line" "$EVIDENCE/asset-tokens.css" || true)
    printf '  served %-46s %s hit(s)  %s\n' "$line" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" >> "$EVIDENCE/tokens.txt"
    [ "$hits" -ge 1 ] || raw_ok=0
done < "$EVIDENCE/raw-tokens-required.txt"
[ "$raw_ok" = "1" ] || fail "served raw-token gates failed (see $EVIDENCE/tokens.txt)"

shell="$EVIDENCE/shell.html"
code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$shell" -w '%{http_code}' "$BASE/") \
    || fail "GET /: curl failed"
[ "$code" = "200" ] || fail "GET / answered $code (expected 200)"
extract_token_css "$shell" "$EVIDENCE/token-css.txt"
grep -qF '/* palette */' "$EVIDENCE/token-css.txt" || fail "inline token CSS has no palette layer"
grep -qF '/* alias */' "$EVIDENCE/token-css.txt" || fail "inline token CSS has no alias layer"
grep -oE -- '--color-[a-z0-9-]+' "$EVIDENCE/token-css.txt" | sort -u \
    > "$EVIDENCE/color-names.txt"
required_color_names > "$EVIDENCE/color-names-required.txt"
color_count=$(wc -l < "$EVIDENCE/color-names.txt" | tr -d ' ')
{
    echo ""
    echo "T301 colour alias probe — every one of the 63 UiTokens colour keys must"
    echo "be emitted as --color-<key> in the inline alias layer."
    echo ""
    printf '  distinct --color-* names served: %s (must be >= 63)\n' "$color_count"
} >> "$EVIDENCE/tokens.txt"
[ "$color_count" -ge 63 ] \
    || fail "only $color_count distinct --color-* names served (expected >= 63; tokens.txt)"
: > "$EVIDENCE/color-names-missing.txt"
probe_missing "$EVIDENCE/color-names.txt" "$EVIDENCE/color-names-required.txt" \
    "$EVIDENCE/color-names-missing.txt"
if [ -s "$EVIDENCE/color-names-missing.txt" ]; then
    cat "$EVIDENCE/color-names-missing.txt" >> "$EVIDENCE/tokens.txt"
    fail "required colour names missing from the served alias layer (tokens.txt)"
fi
printf '  all 63 required colour names PRESENT\n' >> "$EVIDENCE/tokens.txt"
ok "served tokens.css carries the five raw tokens; inline CSS aliases >= 63 colour names ($color_count; tokens.txt)"

# -------------------------------------------------------- theme sentinels
echo "== Step 6: save-appearance t3-chat dark → palette sentinels + bootstrap =="
save_body='{"action":"save-appearance","payload":{"appearance":"dark","themeId":"t3-chat","canvas":"#101018","accent":"#ff0000","density":"comfortable","panelMotionMs":200}}'
code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
    -o "$EVIDENCE/action-save-dark.json" -w '%{http_code}' -d "$save_body" \
    "$BASE/ui/action/save-appearance") || fail "POST /ui/action/save-appearance: curl failed"
[ "$code" = "200" ] || fail "POST save-appearance (dark) answered $code (expected 200)"
grep -qF 'Appearance saved' "$EVIDENCE/action-save-dark.json" \
    || fail "save-appearance (dark) did not confirm the save (action-save-dark.json)"

code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/shell-dark.html" \
    -w '%{http_code}' "$BASE/") || fail "GET / (dark): curl failed"
[ "$code" = "200" ] || fail "GET / (dark) answered $code (expected 200)"
extract_token_css "$EVIDENCE/shell-dark.html" "$EVIDENCE/token-css-dark.txt"
t3_chat_dark_sentinels > "$EVIDENCE/sentinels-dark-required.txt"
{
    echo ""
    echo "T301 theme sentinels — t3-chat dark, the verbatim themePalettes.ts"
    echo "OKLCH roles in the served palette layer (primary=messageAction,"
    echo "background=canvas, foreground=text, accent=accentSurface, border=border)."
    echo ""
} > "$EVIDENCE/themes.txt"
sent_ok=1
while IFS= read -r line; do
    [ -n "$line" ] || continue
    hits=$(grep -cF -- "$line" "$EVIDENCE/token-css-dark.txt" || true)
    printf '  dark  %-48s %s hit(s)  %s\n' "$line" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" >> "$EVIDENCE/themes.txt"
    [ "$hits" -ge 1 ] || sent_ok=0
done < "$EVIDENCE/sentinels-dark-required.txt"

boot_code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/bootstrap-dark.json" \
    -w '%{http_code}' "$BASE/_jhin/bootstrap") || fail "GET /_jhin/bootstrap: curl failed"
[ "$boot_code" = "200" ] || fail "GET /_jhin/bootstrap answered $boot_code (expected 200)"
boot_hits=$(grep -cF 'oklch(0.460685 0.185347 4.099)' "$EVIDENCE/bootstrap-dark.json" || true)
primary_hits=$(grep -cF '"primary"' "$EVIDENCE/bootstrap-dark.json" || true)
printf '  bootstrap theme.colors: primary key %s hit(s), dark sentinel value %s hit(s)\n' \
    "$primary_hits" "$boot_hits" >> "$EVIDENCE/themes.txt"
[ "$boot_hits" -ge 1 ] && [ "$primary_hits" -ge 1 ] || sent_ok=0
[ "$sent_ok" = "1" ] || fail "t3-chat dark sentinel gates failed (see $EVIDENCE/themes.txt)"
ok "t3-chat dark sentinels served verbatim, --primary = oklch(0.460685 0.185347 4.099) (themes.txt)"

echo "== Step 7: save-appearance t3-chat light → light palette sentinels =="
save_body='{"action":"save-appearance","payload":{"appearance":"light","themeId":"t3-chat","canvas":"#101018","accent":"#ff0000","density":"comfortable","panelMotionMs":200}}'
code=$(curl -s --max-time 10 -H "$CLIENT_API4" -H 'Content-Type: application/json' \
    -o "$EVIDENCE/action-save-light.json" -w '%{http_code}' -d "$save_body" \
    "$BASE/ui/action/save-appearance") || fail "POST /ui/action/save-appearance (light): curl failed"
[ "$code" = "200" ] || fail "POST save-appearance (light) answered $code (expected 200)"
code=$(curl -s --max-time 10 -H "$CLIENT_API4" -o "$EVIDENCE/shell-light.html" \
    -w '%{http_code}' "$BASE/") || fail "GET / (light): curl failed"
[ "$code" = "200" ] || fail "GET / (light) answered $code (expected 200)"
extract_token_css "$EVIDENCE/shell-light.html" "$EVIDENCE/token-css-light.txt"
t3_chat_light_sentinels > "$EVIDENCE/sentinels-light-required.txt"
{
    echo ""
    echo "T301 theme sentinels — t3-chat light, same roles."
    echo ""
} >> "$EVIDENCE/themes.txt"
sent_ok=1
while IFS= read -r line; do
    [ -n "$line" ] || continue
    hits=$(grep -cF -- "$line" "$EVIDENCE/token-css-light.txt" || true)
    printf '  light %-48s %s hit(s)  %s\n' "$line" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" >> "$EVIDENCE/themes.txt"
    [ "$hits" -ge 1 ] || sent_ok=0
done < "$EVIDENCE/sentinels-light-required.txt"

# The five built-in themes' dark primary sentinels pinned in the source map.
{
    echo ""
    echo "T301 five-theme source sentinels — the dark messageAction role of every"
    echo "built-in theme in ThemePalettes.java (the five OKLCH maps)."
    echo ""
} >> "$EVIDENCE/themes.txt"
declare -A theme_sentinel=(
    [t3-chat]='messageAction=oklch(0.460685 0.185347 4.099)'
    [grove]='messageAction=oklch(0.791603 0.129713 83.299)'
    [ocean]='messageAction=oklch(0.793363 0.105022 199.893)'
    [ember]='messageAction=oklch(0.747955 0.135578 29.432)'
    [iris]='messageAction=oklch(0.789904 0.130063 337.621)'
)
for id in t3-chat grove ocean ember iris; do
    needle=${theme_sentinel[$id]}
    hits=$(grep -cF -- "$needle" "$THEME_PALETTES" || true)
    printf '  %-8s %-46s %s hit(s)  %s\n' "$id" "$needle" "$hits" \
        "$([ "$hits" -ge 1 ] && echo PRESENT || echo MISSING)" >> "$EVIDENCE/themes.txt"
    [ "$hits" -ge 1 ] || sent_ok=0
done
[ "$sent_ok" = "1" ] || fail "t3-chat light or five-theme sentinel gates failed (see $EVIDENCE/themes.txt)"
ok "t3-chat light sentinels + five built-in dark primaries verbatim (themes.txt)"

# --------------------------------------------------- browser unavailable
cat > "$EVIDENCE/browser-unavailable.txt" <<'EOF'
T301 browser steps — UNAVAILABLE in this environment.

Browser tooling (the agent browser / screenshots / evaluate) cannot run on
this QA machine; the T202–T208 precedent applies: every browser step is
recorded here and substituted with curl + static asserts.

Not executed (the plan's interactive/visual token cases):
  - Computed-style checks that the served tokens resolve (getComputedStyle on
    --color-*, --z-sheet, --ease-drawer): substituted by the served-byte
    greps in tokens.txt — the declarations are proven present in the exact
    bytes the client receives.
  - Visual theme rendering: switching the appearance grid and eyeballing the
    t3-chat light/dark palettes: substituted by the sentinel greps in
    themes.txt — the palette layer carries the verbatim themePalettes.ts
    OKLCH values the renderer would consume.
  - Contrast-indirection rendering (--contrast-* mixing under the user
    contrast boost): substituted by the TokenCssTest / UiTokensTest unit
    asserts on the color-mix recipes.

What IS proven here: the five upstream raw tokens ship verbatim (source and
wire), the alias layer serves every one of the 63 colour keys as --color-*,
and both appearance modes of the default theme carry the exact upstream
OKLCH sentinels in the served palette layer and the bootstrap payload.
EOF
ok "browser-unavailable.txt records the un-exercised visual cases"

# ---------------------------------------------------------------- summary
{
    echo "T301 QA — PASS"
    echo ""
    echo "  suites:            :jhin-plugin-ui-kit:test $ui_kit_tests, :jhin-plugin-ui-default:test $ui_default_tests (0 failures)"
    echo "  raw tokens:        5/5 present (source + served): topbar 52px, chat 46rem, details 17.5rem, z-sheet 46, ease-drawer"
    echo "  colour aliases:    $color_count distinct --color-* names served (>= 63), all 63 required PRESENT"
    echo "  dark sentinels:    5/5 t3-chat dark verbatim; --primary = oklch(0.460685 0.185347 4.099)"
    echo "  light sentinels:   5/5 t3-chat light verbatim"
    echo "  five themes:       t3-chat/grove/ocean/ember/iris dark messageAction pinned in ThemePalettes.java"
    echo "  bootstrap:         theme.colors carries the dark primary sentinel"
    echo ""
    echo "  evidence: $EVIDENCE"
    sed 's/^/  /' "$checks"
} > "$EVIDENCE/summary.txt"
ok "T301 QA PASS (summary.txt)"
