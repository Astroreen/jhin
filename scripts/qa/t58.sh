#!/usr/bin/env bash
# QA for T58: box decoration and flex alignment parity.
# Usage: scripts/qa/t58.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T58. The directory is gitignored;
# the task commit stages it with `git add -f`.
#
# Happy path (exit 0):
#   - test.txt: the full frontend suite (scripts/qa/flutter-test.sh) followed
#     by ./gradlew :jhin-plugin-ui-kit:test (conformance, lattice, enum,
#     regression, GalleryDump) — both must report green;
#   - goldens.txt: the recorded T58 golden delta (before/after counts plus
#     the list of new baselines) and the transcript of a regeneration run
#     (scripts/qa/flutter-test.sh test/gallery --update-goldens) whose
#     baseline checksums must come back byte-identical — no silent golden
#     updates;
#   - enum-negative.txt: a standalone Java probe against the built classes
#     proving Ui.row().crossAxisAlignment("nope"), Ui.flex().mainAxisAlignment
#     ("nope") and Ui.box().shape("nope") throw IllegalArgumentException at
#     build time while every documented literal is accepted, plus the Flutter
#     degrade evidence (unknown gradient.type -> flat color, unknown prop
#     ignored, no exception) from test/primitives_batch3_test.dart;
#   - flaky-fix.txt: the Map.of fixture-order flake note (2 regression
#     fixtures recaptured, chart_line deterministic) and the GalleryDump
#     idempotency probe;
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

evidence=${1:-.sisyphus/evidence/T58}
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

log "T58 QA: box decoration and flex alignment parity"
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

# --- 2. Goldens: recorded delta + regeneration transcript (goldens.txt) ---
goldens=frontend/test/gallery/goldens
golden_count=$(ls "$goldens"/*.png 2>/dev/null | wc -l | tr -d ' ')
new_count=0
for primitive in box row column flex expanded flexible sized_box align center aspect_ratio; do
  for variant in basic propheavy; do
    for theme in light dark; do
      [ -f "$goldens/fixture-${primitive}-${variant}-${theme}.png" ] || fail \
        "missing golden baseline $goldens/fixture-${primitive}-${variant}-${theme}.png"
      new_count=$((new_count + 1))
    done
  done
done
before_count=$((golden_count - new_count))
for updated in fixture-figure-propheavy-light.png fixture-figure-propheavy-dark.png; do
  [ -f "$goldens/$updated" ] || fail "missing updated golden baseline $goldens/$updated"
done

{
  echo "T58 golden delta"
    echo "before: $before_count PNGs (T57 catalog, 50 fixtures x light+dark)"
    echo "after: $golden_count PNGs (70 fixtures x light+dark)"
    echo "new files ($new_count):"
    for primitive in box row column flex expanded flexible sized_box align center aspect_ratio; do
      for variant in basic propheavy; do
        for theme in light dark; do
          echo "  $goldens/fixture-${primitive}-${variant}-${theme}.png"
        done
      done
    done
    echo "updated files (2):"
    echo "  $goldens/fixture-figure-propheavy-light.png"
    echo "  $goldens/fixture-figure-propheavy-dark.png"
    echo "  (T58's shape-aware universal decoration: the figure fixture's"
    echo "  shape: circle is now also read by the BoxDecoration wrapper,"
    echo "  which paints as a circle instead of a rectangle — recorded,"
    echo "  not silent)"
    echo
    echo "regen transcript (scripts/qa/flutter-test.sh test/gallery --update-goldens):"
  } > "$evidence/goldens.txt"
ok "golden delta recorded: $before_count -> $golden_count PNGs, $new_count new + 2 updated baselines"

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

# --- 3. Enum negatives, Java + Flutter (enum-negative.txt) ---
classes=plugins/ui-kit/build/classes/java/main
[ -d "$classes" ] || fail "missing $classes — run the gradle build first"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/T58Probe.java" <<'EOF'
import com.astroreen.jhin.plugin.uikit.Ui;

/**
 * T58 QA probe. Mode {@code negative}: the T58 enum-typed setters must throw
 * IllegalArgumentException on an unknown literal at build time and accept
 * every documented one. Mode {@code failprobe}: asserts the deliberately
 * wrong expectation — "an unknown enum literal is accepted" — and always
 * exits non-zero.
 */
public class T58Probe {

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
        System.out.println("T58 enum-negative probe — unknown literals throw at build time");
        System.out.println();

        mustThrow("row().crossAxisAlignment(\"nope\")", () -> Ui.row().crossAxisAlignment("nope"));
        mustThrow("flex().mainAxisAlignment(\"nope\")", () -> Ui.flex("row").mainAxisAlignment("nope"));
        mustThrow("box().shape(\"nope\")", () -> Ui.box().shape("nope"));
        mustThrow("column().crossAxisAlignment(\"nope\")", () -> Ui.column().crossAxisAlignment("nope"));
        mustThrow("row().mainAxisAlignment(\"nope\")", () -> Ui.row().mainAxisAlignment("nope"));
        mustThrow("row().mainAxisSize(\"nope\")", () -> Ui.row().mainAxisSize("nope"));
        mustThrow("row().textDirection(\"nope\")", () -> Ui.row().textDirection("nope"));
        mustThrow("row().verticalDirection(\"nope\")", () -> Ui.row().verticalDirection("nope"));
        mustThrow("row().textBaseline(\"nope\")", () -> Ui.row().textBaseline("nope"));
        mustThrow("row().overflow(\"nope\")", () -> Ui.row().overflow("nope"));
        mustThrow("row().clipBehavior(\"nope\")", () -> Ui.row().clipBehavior("nope"));
        mustThrow("flex().direction(\"grid\")", () -> Ui.flex("row").direction("grid"));
        mustThrow("box().alignment(\"middle\")", () -> Ui.box().alignment("middle"));
        mustThrow("align().align(\"middle\")", () -> Ui.align().align("middle"));
        mustThrow("flexible().fit(\"expand\")", () -> Ui.flexible().fit("expand"));

        mustPass("row().crossAxisAlignment(\"baseline\")", () -> Ui.row().crossAxisAlignment("baseline"));
        mustPass("flex().mainAxisAlignment(\"spaceBetween\")", () -> Ui.flex("column").mainAxisAlignment("spaceBetween"));
        mustPass("box().shape(\"circle\")", () -> Ui.box().shape("circle"));
        mustPass("row().textBaseline(\"ideographic\")", () -> Ui.row().textBaseline("ideographic"));
        mustPass("box().alignment(\"bottomRight\")", () -> Ui.box().alignment("bottomRight"));
        mustPass("flexible().fit(\"tight\")", () -> Ui.flexible().fit("tight"));

        System.out.println();
        System.out.println("every unknown literal threw IllegalArgumentException at build time;");
        System.out.println("every documented literal stayed accepted");
    }

    private static void failprobe() {
        System.out.println("failprobe: asserting row().crossAxisAlignment(\"nope\") is ACCEPTED (wrong on purpose)");
        try {
            Ui.row().crossAxisAlignment("nope");
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
javac -cp "$classes" -d "$work" "$work/T58Probe.java" || fail "probe compilation failed"

if [ "$fail_mode" = "1" ]; then
  {
    echo
    echo "T58Probe negative re-verification (--fail mode):"
  } >> "$evidence/enum-negative.txt"
  java -cp "$classes:$work" T58Probe negative >> "$evidence/enum-negative.txt" \
    || fail "negative probe failed (see $evidence/enum-negative.txt)"
  grep -q 'FAIL' "$evidence/enum-negative.txt" && fail "negative probe reported failures"
  ok "--fail probes passed: every unknown literal throws, documented literals pass"
  if java -cp "$classes:$work" T58Probe failprobe >> "$evidence/enum-negative.txt" 2>&1; then
    fail "--fail probe: wrong expectation ('unknown enum literal is accepted') unexpectedly passed (checker is broken)"
  fi
  ok "--fail probe: wrong expectation tripped as intended (the builder throws; appended to enum-negative.txt)"
  printf -- '--fail exit code 1 (intentional failure-path exit)\n' | tee -a "$evidence/checks.txt"
  fail "--fail mode: intentional failure-path exit"
fi

java -cp "$classes:$work" T58Probe negative > "$evidence/enum-negative.txt" \
  || fail "negative probe failed (see $evidence/enum-negative.txt)"
if grep -q 'FAIL' "$evidence/enum-negative.txt"; then
  fail "negative probe reported failures (see $evidence/enum-negative.txt)"
fi
{
  echo
  echo "Flutter degrade evidence (scripts/qa/flutter-test.sh test/primitives_batch3_test.dart):"
} >> "$evidence/enum-negative.txt"
scripts/qa/flutter-test.sh test/primitives_batch3_test.dart >> "$evidence/enum-negative.txt" 2>&1 \
  || fail "primitives_batch3_test.dart failed (see $evidence/enum-negative.txt)"
grep -q 'All tests passed!' "$evidence/enum-negative.txt" \
  || fail "primitives_batch3_test.dart did not report 'All tests passed!'"
ok "enum-negative.txt written: Java throw-at-build evidence + Flutter degrade evidence (unknown gradient.type -> flat color, unknown prop ignored, no exception)"

# --- 4. Flaky fixture-order note + GalleryDump idempotency (flaky-fix.txt) ---
{
  echo "T58 flaky Map.of fixture-order fix"
  echo
  echo "The regression fixtures 21-chart_bar.json and 22-chart_pie.json were"
  echo "recaptured (2 fixture files changed): chart series/item maps were"
  echo "built with Map.of, whose small-map implementation randomizes"
  echo "iteration order per JVM run (hash-flooding mitigation), so the"
  echo "byte-identical fixture check flaked across runs. The fixtures now use"
  echo "the insertion-ordered entry() helper (LinkedHashMap), same as"
  echo "GalleryDump. 20-chart_line.json never flaked: its series maps are"
  echo "single-key maps, whose Map.of order is deterministic."
  echo
  echo "GalleryDump idempotency probe (two runs must produce a byte-identical"
  echo "frontend/test/gallery/gallery_nodes.dart):"
} > "$evidence/flaky-fix.txt"
dart_file=frontend/test/gallery/gallery_nodes.dart
snapshot=$(mktemp)
cp "$dart_file" "$snapshot"
./gradlew :jhin-plugin-ui-kit:test --tests '*GalleryDump*' --rerun >> "$evidence/flaky-fix.txt" 2>&1
if diff -u "$snapshot" "$dart_file" >> "$evidence/flaky-fix.txt"; then
  printf '\n(probe idempotent: gallery_nodes.dart byte-identical across runs)\n' >> "$evidence/flaky-fix.txt"
  rm -f "$snapshot"
  ok "flaky-fix.txt written (Map.of note + byte-identical GalleryDump probe)"
else
  rm -f "$snapshot"
  fail "GalleryDump probe is NOT idempotent (see $evidence/flaky-fix.txt)"
fi

printf 'happy exit code 0\n' | tee -a "$evidence/checks.txt"
log "T58 QA green: box decoration and flex alignment parity verified"
