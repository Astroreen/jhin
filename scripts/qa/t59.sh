#!/usr/bin/env bash
# QA for T59: stack/positioned, wrap, grid and lazy scroll/list primitives.
# Usage: scripts/qa/t59.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T59. The directory is gitignored;
# the task commit stages it with `git add -f`.
#
# Happy path (exit 0):
#   - test.txt: the full frontend suite (scripts/qa/flutter-test.sh) followed
#     by ./gradlew :jhin-plugin-ui-kit:test (conformance, lattice, enum,
#     regression, GalleryDump) — both must report green;
#   - perf.txt: the 10 000-item lazy list build wall time and the visible
#     child count from test/primitives_batch4_test.dart (build < 1 s,
#     visible Text widgets < 100);
#   - degrade.txt: the client-side degrades (§2.4) — a `positioned` without
#     a `stack` parent degrades to `align`, `grid.columns: 0` degrades to
#     `columns: 1`, unknown enum literals degrade to the documented
#     defaults and unknown props are ignored — none of them crash;
#   - goldens.txt: the recorded T59 golden delta (before/after counts plus
#     the list of new baselines) and the transcript of a regeneration run
#     (scripts/qa/flutter-test.sh test/gallery --update-goldens) whose
#     baseline checksums must come back byte-identical — no silent golden
#     updates;
#   - enum-negative.txt: a standalone Java probe against the built classes
#     proving Ui.stack().fit("nope"), Ui.wrap().direction("nope"),
#     Ui.grid().physics("nope") and friends throw IllegalArgumentException
#     at build time while every documented literal is accepted;
#   - checks.txt: the ok/FAIL line log, including the recorded exit codes.
#
# --fail mode (exit 1): reruns the enum-negative probe, then trips a
#   deliberately wrong expectation — "an unknown enum literal is accepted"
#   must NOT hold (the builder throws as designed) — and exits non-zero to
#   prove the checker fails when the builder behaves differently.
set -euo pipefail

script_path=$(readlink -f "${BASH_SOURCE[0]}")
cd "$(dirname "$script_path")/../.."

fail_mode=0
if [ "${1:-}" = "--fail" ]; then
  fail_mode=1
  shift
fi

evidence=${1:-.sisyphus/evidence/T59}
mkdir -p "$evidence"

log() {
  printf '%s\n' "$*"
}

ok() {
  printf 'ok: %s\n' "$*" | tee -a "$evidence/checks.txt"
}

fail() {
  printf 'FAIL: %s\n' "$*" | tee -a "$evidence/checks.txt" >&2
  exit 1
}

log "T59 QA: stack, wrap, grid and lazy scroll primitives"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

# --- 1. Full frontend suite + the ui-kit module suite (test.txt) ---
scripts/qa/flutter-test.sh 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "frontend suite did not report 'All tests passed!' (see $evidence/test.txt)"
ok "frontend suite green (scripts/qa/flutter-test.sh; transcript in test.txt)"

./gradlew :jhin-plugin-ui-kit:test --rerun 2>&1 | tee -a "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-ui-kit:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
ok "ui-kit module suite green (conformance/lattice/enum/regression/GalleryDump; appended to test.txt)"

# --- 2. Perf: the 10 000-item lazy list (perf.txt) ---
{
  echo "T59 perf — 10 000-item lazy list (test/primitives_batch4_test.dart)"
  echo
} > "$evidence/perf.txt"
scripts/qa/flutter-test.sh test/primitives_batch4_test.dart \
    --plain-name "10 000-item list" >> "$evidence/perf.txt" 2>&1 \
  || fail "perf test failed (see $evidence/perf.txt)"
grep -q 'All tests passed!' "$evidence/perf.txt" \
  || fail "perf test did not report 'All tests passed!' (see $evidence/perf.txt)"
build_ms=$(grep -o 'build_ms=[0-9]*' "$evidence/perf.txt" | head -1 | cut -d= -f2)
visible=$(grep -o 'visible_texts=[0-9]*' "$evidence/perf.txt" | head -1 | cut -d= -f2)
[ -n "$build_ms" ] && [ "$build_ms" -lt 1000 ] \
  || fail "10 000-item build took ${build_ms:-?} ms (budget: 1000)"
[ -n "$visible" ] && [ "$visible" -lt 100 ] \
  || fail "visible children ${visible:-?} not below 100 before scrolling"
ok "perf: 10 000 items built in ${build_ms} ms (< 1000), ${visible} visible Text widgets (< 100)"

# --- 3. Client-side degrades (degrade.txt) ---
{
  echo "T59 degrade evidence — §2.4: the client never crashes on server content"
  echo
} > "$evidence/degrade.txt"
for name in \
    "positioned without a stack parent degrades to align" \
    "grid columns 0 degrades to 1 column" \
    "unknown stack literals and unknown props degrade silently" \
    "unknown enum literals degrade client-side on wrap, grid and scroll"; do
  {
    echo "=== $name ==="
  } >> "$evidence/degrade.txt"
  scripts/qa/flutter-test.sh test/primitives_batch4_test.dart --plain-name "$name" \
    >> "$evidence/degrade.txt" 2>&1 \
    || fail "degrade test '$name' failed (see $evidence/degrade.txt)"
  grep -q 'All tests passed!' "$evidence/degrade.txt" \
    || fail "degrade test '$name' did not report 'All tests passed!'"
done
ok "degrade.txt written: positioned->align, grid.columns 0 -> 1, unknown enum literals/props degrade silently"

# --- 4. Goldens: recorded delta + regeneration transcript (goldens.txt) ---
goldens=frontend/test/gallery/goldens
golden_count=$(ls "$goldens"/*.png 2>/dev/null | wc -l | tr -d ' ')
new_count=0
for primitive in stack positioned wrap grid scroll; do
  for variant in basic propheavy; do
    for theme in light dark; do
      [ -f "$goldens/fixture-${primitive}-${variant}-${theme}.png" ] || fail \
        "missing golden baseline $goldens/fixture-${primitive}-${variant}-${theme}.png"
      new_count=$((new_count + 1))
    done
  done
done
before_count=$((golden_count - new_count))

{
  echo "T59 golden delta"
  echo "before: $before_count PNGs (70 fixtures x light+dark)"
  echo "after: $golden_count PNGs (80 fixtures x light+dark)"
  echo "new files ($new_count):"
  for primitive in stack positioned wrap grid scroll; do
    for variant in basic propheavy; do
      for theme in light dark; do
        echo "  $goldens/fixture-${primitive}-${variant}-${theme}.png"
      done
    done
  done
  echo "updated files (0):"
  echo "  (none — the list rewrite to ListView.builder is pixel-identical on"
  echo "  the existing fixtures; verified by the checksum diff recorded during"
  echo "  the T59 generation run: 140 committed baselines, 0 changed)"
  echo "  fixture-stack-basic is the badge-over-avatar composition golden"
  echo "  (a positioned box badge over an avatar figure)."
  echo
  echo "regen transcript (scripts/qa/flutter-test.sh test/gallery --update-goldens):"
} > "$evidence/goldens.txt"
ok "golden delta recorded: $before_count -> $golden_count PNGs, $new_count new baselines"

checksums_before=$(mktemp)
checksums_after=$(mktemp)
( cd "$goldens" && sha256sum *.png | sort ) > "$checksums_before"
scripts/qa/flutter-test.sh test/gallery --update-goldens >> "$evidence/goldens.txt" 2>&1 \
  || fail "golden regeneration run failed (see $evidence/goldens.txt)"
( cd "$goldens" && sha256sum *.png | sort ) > "$checksums_after"
if diff -u "$checksums_before" "$checksums_after" >> "$evidence/goldens.txt"; then
  printf '\n(regen is idempotent: baseline checksums byte-identical before/after — no silent golden updates)\n' \
    >> "$evidence/goldens.txt"
  ok "golden regeneration is idempotent (checksums identical; transcript in goldens.txt)"
else
  rm -f "$checksums_before" "$checksums_after"
  fail "golden regeneration CHANGED committed baselines (see $evidence/goldens.txt)"
fi
rm -f "$checksums_before" "$checksums_after"

# --- 5. Enum negatives, Java (enum-negative.txt) ---
classes=plugins/ui-kit/build/classes/java/main
[ -d "$classes" ] || fail "missing $classes — run the gradle build first"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/T59Probe.java" <<'EOF'
import com.astroreen.jhin.plugin.uikit.Ui;

/**
 * T59 QA probe. Mode {@code negative}: the T59 enum-typed setters must throw
 * IllegalArgumentException on an unknown literal at build time and accept
 * every documented one. Mode {@code failprobe}: asserts the deliberately
 * wrong expectation — "an unknown enum literal is accepted" — and always
 * exits non-zero.
 */
public class T59Probe {

    private static int failures = 0;

    public static void main(String[] args) {
        String mode = args.length > 0 ? args[0] : "negative";
        switch (mode) {
            case "negative" -> negative();
            case "failprobe" -> failprobe();
            default -> {
                System.out.println("unknown mode: " + mode);
                System.exit(2);
            }
        }
        if (failures > 0) {
            System.exit(1);
        }
    }

    private static void negative() {
        System.out.println("T59 enum-negative probe — unknown literals throw at build time");
        System.out.println();

        mustThrow("stack().fit(\"nope\")", () -> Ui.stack().fit("nope"));
        mustThrow("stack().fit(\"tight\")", () -> Ui.stack().fit("tight"));
        mustThrow("stack().alignment(\"middle\")", () -> Ui.stack().alignment("middle"));
        mustThrow("wrap().direction(\"nope\")", () -> Ui.wrap().direction("nope"));
        mustThrow("wrap().direction(\"row\")", () -> Ui.wrap().direction("row"));
        mustThrow("wrap().alignment(\"nope\")", () -> Ui.wrap().alignment("nope"));
        mustThrow("wrap().runAlignment(\"middle\")", () -> Ui.wrap().runAlignment("middle"));
        mustThrow("wrap().crossAxisAlignment(\"baseline\")", () -> Ui.wrap().crossAxisAlignment("baseline"));
        mustThrow("grid().physics(\"nope\")", () -> Ui.grid().physics("nope"));
        mustThrow("scroll().physics(\"nope\")", () -> Ui.scroll().physics("nope"));
        mustThrow("scroll().scrollDirection(\"diagonal\")", () -> Ui.scroll().scrollDirection("diagonal"));

        mustPass("stack().fit(\"passthrough\")", () -> Ui.stack().fit("passthrough"));
        mustPass("stack().alignment(\"bottomRight\")", () -> Ui.stack().alignment("bottomRight"));
        mustPass("wrap().direction(\"vertical\")", () -> Ui.wrap().direction("vertical"));
        mustPass("wrap().alignment(\"spaceBetween\")", () -> Ui.wrap().alignment("spaceBetween"));
        mustPass("wrap().crossAxisAlignment(\"end\")", () -> Ui.wrap().crossAxisAlignment("end"));
        mustPass("grid().physics(\"clamping\")", () -> Ui.grid().physics("clamping"));
        mustPass("scroll().scrollDirection(\"horizontal\")", () -> Ui.scroll().scrollDirection("horizontal"));

        System.out.println();
        System.out.println("every unknown literal threw IllegalArgumentException at build time;");
        System.out.println("every documented literal stayed accepted");
    }

    private static void failprobe() {
        System.out.println("failprobe: asserting grid().physics(\"nope\") is ACCEPTED (wrong on purpose)");
        try {
            Ui.grid().physics("nope");
            System.out.println("failprobe: unexpectedly passed — the builder accepted an unknown literal");
        } catch (IllegalArgumentException expected) {
            System.out.println("failprobe: intentional failure tripped (the builder threw as designed): "
                    + expected.getMessage());
            System.exit(1);
        }
    }

    private static void mustThrow(String what, Runnable call) {
        try {
            call.run();
            System.out.println("  FAIL: " + what + " did not throw");
            failures++;
        } catch (IllegalArgumentException expected) {
            System.out.println("  ok: " + what + " -> IllegalArgumentException: " + expected.getMessage());
        }
    }

    private static void mustPass(String what, Runnable call) {
        try {
            call.run();
            System.out.println("  ok: " + what + " accepted");
        } catch (RuntimeException e) {
            System.out.println("  FAIL: " + what + " threw " + e);
            failures++;
        }
    }
}
EOF
javac -cp "$classes" -d "$work" "$work/T59Probe.java" || fail "probe compilation failed"

if [ "$fail_mode" = "1" ]; then
  {
    echo
    echo "T59Probe negative re-verification (--fail mode):"
  } >> "$evidence/enum-negative.txt"
  java -cp "$classes:$work" T59Probe negative >> "$evidence/enum-negative.txt" \
    || fail "negative probe failed (see $evidence/enum-negative.txt)"
  grep -q 'FAIL' "$evidence/enum-negative.txt" && fail "negative probe reported failures"
  ok "--fail probes passed: every unknown literal throws, documented literals pass"
  if java -cp "$classes:$work" T59Probe failprobe >> "$evidence/enum-negative.txt" 2>&1; then
    fail "--fail probe: wrong expectation ('unknown enum literal is accepted') unexpectedly passed (checker is broken)"
  fi
  ok "--fail probe: wrong expectation tripped as intended (the builder throws; appended to enum-negative.txt)"
  printf -- '--fail exit code 1 (intentional failure-path exit)\n' | tee -a "$evidence/checks.txt"
  fail "--fail mode: intentional failure-path exit"
fi

java -cp "$classes:$work" T59Probe negative > "$evidence/enum-negative.txt" \
  || fail "negative probe failed (see $evidence/enum-negative.txt)"
if grep -q 'FAIL' "$evidence/enum-negative.txt"; then
  fail "negative probe reported failures (see $evidence/enum-negative.txt)"
fi
ok "enum-negative.txt written: Ui.stack().fit/.wrap().direction/.grid().physics and friends throw at build time"

printf 'happy exit code 0\n' | tee -a "$evidence/checks.txt"
log "T59 QA green: stack, wrap, grid and lazy scroll primitives verified"
