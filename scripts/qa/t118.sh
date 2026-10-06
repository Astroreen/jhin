#!/usr/bin/env bash
# QA for T118: the docs alignment sweep (plan section T118; docs/sdui.md
# section 2.5 primitive catalog; AGENTS.md frontend rule).
#
# The delivered surface is contract level 3 with a 68-primitive catalog, and
# every document must agree: no stale "58 primitives" / "catalog of 58" /
# "contract level 2" claim may survive anywhere under docs/, README.md or
# AGENTS.md, and catalog_primitives() must report exactly 68. The AGENTS.md
# boot-surface sentence (the client hardcodes exactly one screen and one
# endpoint) must stay truthful.
#
# The happy path extracts the primitive catalog from docs/sdui.md section 2.5
# (catalog.txt), runs the stale-mention sweep (sweep.txt), asserts the
# AGENTS.md boot-surface sentence, runs the ui-default and ui-kit JVM suites
# (test.txt) and the T78 regression gate (gate-t78/). The failure path injects
# a stale "58 primitives" mention into a throwaway copy of the docs and
# asserts the sweep catches it.
# Usage: scripts/qa/t118.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T118. Exits non-zero on the first
# failed assertion; a stuck step fails the run instead of hanging (whole-run
# watchdog). This is a docs-only todo: no kernel boots, so the script needs
# only grep, awk, git and gradle.
#
# Happy path:
#   - catalog_primitives() output into catalog.txt and asserts exactly 68;
#   - the stale-mention sweep into sweep.txt and asserts it is empty;
#   - asserts the AGENTS.md boot-surface sentence is unchanged;
#   - runs the ui-default and ui-kit JVM suites (test.txt) and requires
#     BUILD SUCCESSFUL;
#   - runs scripts/qa/t78.sh as the regression gate (evidence in gate-t78/).
#
# Failure path: a stale "58 primitives" mention is injected into a temp copy
# of the docs. The real behavior is proven first (the clean docs pass the
# sweep), then the deliberately wrong expectation — that the sweep passes with
# the injected mention — is run and must fail; the real behavior is recorded
# in checks-fail.txt (exit non-zero).
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
if [ -z "${T118_INNER:-}" ]; then
  exec env T118_INNER=1 timeout --kill-after=15 1800 "$script_path" "$@"
fi

cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T118}
mkdir -p "$evidence"

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

# catalog_primitives: the docs/sdui.md section 2.5 primitive names (the same
# extraction every QA script uses).
catalog_primitives() {
  awk '/^### 2\.5 /{f=1;next} /^### /{f=0} f' docs/sdui.md \
    | grep -oE '`[a-z_]+' | tr -d '`' | sort -u
}

# The stale claims the sweep forbids: the pre-level-3 primitive count and the
# pre-level-3 contract level. The historical "grew the catalog from 25 to 58"
# sentence is deliberately worded without these phrases.
STALE_PATTERNS='58 primitives|catalog of 58|contract level 2'

# sweep <root>: print every stale-mention line under <root>/docs,
# <root>/README.md and <root>/AGENTS.md. Empty output means clean.
sweep() {
  local root=${1:-.}
  grep -rnE "$STALE_PATTERNS" \
    --include='*.md' "$root/docs" "$root/README.md" "$root/AGENTS.md" \
    2>/dev/null || true
}

if [ "$fail_mode" = "1" ]; then
  log "T118 QA --fail: an injected stale '58 primitives' mention is caught by the sweep"
  log "evidence dir: $evidence"

  # The real behavior holds: the clean docs pass the sweep.
  clean=$(sweep .)
  [ -z "$clean" ] \
    || fail "the clean docs already violate the sweep: $clean"
  ok "the clean docs pass the sweep"

  # Inject a stale mention into a throwaway copy and prove the sweep catches it.
  tmp=$(mktemp -d)
  cp -r docs "$tmp/docs"
  cp README.md AGENTS.md "$tmp/"
  printf '\nThe catalog is 58 primitives at contract level 2.\n' \
    >> "$tmp/docs/architecture.md"
  injected=$(sweep "$tmp")
  rm -rf "$tmp"
  if [ -z "$injected" ]; then
    fail "the sweep did not catch the injected stale mention"
  fi
  {
    echo "FAIL: the injected stale '58 primitives' mention was expected to pass the sweep (as designed)"
    echo "  the real behavior is the opposite: the sweep caught it —"
    printf '  %s\n' "$injected"
    echo "  the clean docs pass; the injected copy fails"
  } | tee -a "$checks"
  fail "deliberately wrong expectation: the injected stale mention passed the sweep (it is caught)"
fi

log "T118 QA: the docs alignment sweep"
log "evidence dir: $evidence"

# --- 1. The primitive catalog ---
catalog_primitives > "$evidence/catalog.txt"
catalog_count=$(wc -l < "$evidence/catalog.txt" | tr -d ' ')
[ "$catalog_count" = "68" ] \
  || fail "catalog_primitives() reported $catalog_count primitives, expected 68 (see $evidence/catalog.txt)"
ok "catalog_primitives() reports exactly 68 primitives (catalog.txt)"

# --- 2. The stale-mention sweep ---
sweep . > "$evidence/sweep.txt"
if [ -s "$evidence/sweep.txt" ]; then
  fail "stale primitive-count or contract-level mentions survive (see $evidence/sweep.txt)"
fi
ok "no stale '58 primitives' / 'catalog of 58' / 'contract level 2' mention survives (sweep.txt)"

# --- 3. The AGENTS.md boot-surface sentence stays truthful ---
grep -q 'hardcodes exactly one screen' AGENTS.md \
  || fail "AGENTS.md lost the boot-surface sentence (the client hardcodes exactly one screen)"
grep -q 'and one endpoint' AGENTS.md \
  || fail "AGENTS.md lost the boot-surface sentence (one endpoint)"
ok "AGENTS.md still hardcodes exactly one screen and one endpoint"

# --- 4. The JVM suites (the cross-plugin gate) ---
# --rerun is a per-task flag: each suite carries its own.
./gradlew :jhin-plugin-ui-default:test --rerun :jhin-plugin-ui-kit:test --rerun \
  2>&1 | tee "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail "the JVM suites did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
test_count=$(grep -h -o 'tests="[0-9]*"' \
    plugins/ui-default/build/test-results/test/TEST-*.xml \
    plugins/ui-kit/build/test-results/test/TEST-*.xml \
  | awk -F'"' '{s += $2} END {print s}')
ok "ui-default and ui-kit suites green ($test_count tests; test.txt)"

# --- 5. The regression gate ---
bash scripts/qa/t78.sh "$evidence/gate-t78" \
  2>&1 | tee "$evidence/gate-t78.txt"
grep -q 'T78 QA green' "$evidence/gate-t78.txt" \
  || fail "the T78 regression gate did not report green (see $evidence/gate-t78.txt)"
ok "T78 regression gate green: the settings contracts still hold (gate-t78/)"

log "T118 QA happy path complete"
