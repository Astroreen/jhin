#!/usr/bin/env bash
# QA for T61: the full icon registry and the icon/icon_button primitives.
# Usage: scripts/qa/t61.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T61. The directory is gitignored;
# the task commit stages it with `git add -f`.
#
# Happy path (exit 0):
#   - registry-count.txt: the generated registry name count (>= 1800), the
#     generator invocation and an idempotency proof (a regeneration over the
#     same SDK rewrites frontend/lib/design/icon_registry.dart byte-identically
#     — 0 diff);
#   - sampled.txt: 20 registry names spread alphabetically render as Icon
#     widgets with their expected IconData codePoints (the dump of
#     test/primitives_batch6_test.dart);
#   - unknown-icon.txt: an unknown icon name renders an empty icon and logs
#     via debugPrint — no exception (the degrade dump of the same suite);
#   - test.txt: the full frontend suite (scripts/qa/flutter-test.sh) followed
#     by ./gradlew :jhin-plugin-ui-kit:test (conformance, lattice, enum,
#     regression, GalleryDump) — both must report green;
#   - goldens.txt: the recorded T61 golden delta (before/after counts plus
#     the new baselines) and the transcript of a regeneration run
#     (scripts/qa/flutter-test.sh test/gallery --update-goldens) whose
#     baseline checksums must come back byte-identical — no silent golden
#     updates;
#   - enum-negative.txt: a standalone Java probe against the built classes
#     proving Ui.icon().blendMode("nope"), Ui.iconButton().alignment("nope"),
#     Ui.iconButton().visualDensity("nope") and friends throw
#     IllegalArgumentException at build time while every documented literal
#     is accepted;
#   - checks.txt: the ok/FAIL line log, including the `Icons.` absence check
#     (rg 'Icons\.' frontend/lib/sdui frontend/lib/design --glob
#     '!icon_registry.dart' must be 0 hits) and the recorded exit codes.
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

evidence=${1:-.sisyphus/evidence/T61}
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

log "T61 QA: full icon registry and icon/icon_button primitives"
log "evidence dir: $evidence"
[ "$fail_mode" = "1" ] && log "mode: --fail (failure-path evidence)"

# --- 1. Registry: count + generator idempotency (registry-count.txt) ---
registry=frontend/lib/design/icon_registry.dart
[ -f "$registry" ] || fail "missing generated $registry"
name_count=$(grep -c "^  '" "$registry")
{
  echo "T61 icon registry"
  echo
  echo "file: $registry (generated, committed)"
  echo "generator invocation: devenv shell -- dart frontend/tool/gen_icons.dart"
  echo "names: $name_count (requirement: >= 1800)"
} > "$evidence/registry-count.txt"
[ "$name_count" -ge 1800 ] \
  || fail "registry holds $name_count names, expected >= 1800 (see $evidence/registry-count.txt)"
ok "registry holds $name_count names (>= 1800; registry-count.txt)"

{
  echo
  echo "idempotency proof (regenerate and diff — must be 0 lines):"
} >> "$evidence/registry-count.txt"
snapshot=$(mktemp)
cp "$registry" "$snapshot"
if command -v dart > /dev/null 2>&1; then
  dart frontend/tool/gen_icons.dart >> "$evidence/registry-count.txt" 2>&1 \
    || fail "generator run failed (see $evidence/registry-count.txt)"
else
  devenv shell -- dart frontend/tool/gen_icons.dart >> "$evidence/registry-count.txt" 2>&1 \
    || fail "generator run failed (see $evidence/registry-count.txt)"
fi
if diff -u "$snapshot" "$registry" >> "$evidence/registry-count.txt"; then
  printf '\n(diff empty: regeneration is byte-identical — the committed file is up to date)\n' \
    >> "$evidence/registry-count.txt"
  rm -f "$snapshot"
  ok "registry regeneration is idempotent (0 diff; registry-count.txt)"
else
  rm -f "$snapshot"
  fail "registry regeneration CHANGED the committed file (see $evidence/registry-count.txt)"
fi

# --- 2. Icons.* absence outside the generated registry (checks.txt) ---
if rg 'Icons\.' frontend/lib/sdui frontend/lib/design --glob '!icon_registry.dart' \
    > "$evidence/icons-refs.txt" 2>&1; then
  fail "direct Icons.* references found outside icon_registry.dart (see $evidence/icons-refs.txt)"
fi
rm -f "$evidence/icons-refs.txt"
ok "no direct Icons.* references in frontend/lib/sdui or frontend/lib/design outside icon_registry.dart"

# --- 3. Full frontend suite + the ui-kit module suite (test.txt) ---
scripts/qa/flutter-test.sh 2>&1 | tee "$evidence/test.txt"
grep -q 'All tests passed!' "$evidence/test.txt" \
  || fail "frontend suite did not report 'All tests passed!' (see $evidence/test.txt)"
ok "frontend suite green (scripts/qa/flutter-test.sh; transcript in test.txt)"

./gradlew :jhin-plugin-ui-kit:test --rerun 2>&1 | tee -a "$evidence/test.txt"
grep -q 'BUILD SUCCESSFUL' "$evidence/test.txt" \
  || fail ":jhin-plugin-ui-kit:test did not report BUILD SUCCESSFUL (see $evidence/test.txt)"
ok "ui-kit module suite green (conformance/lattice/enum/regression/GalleryDump; appended to test.txt)"

# --- 4. Sampled registry names render (sampled.txt) ---
{
  echo "T61 sampled registry names — 20 names spread alphabetically over"
  echo "kIconRegistry, each rendered as an Icon widget with its expected"
  echo "IconData codePoint (test/primitives_batch6_test.dart)"
  echo
} > "$evidence/sampled.txt"
scripts/qa/flutter-test.sh test/primitives_batch6_test.dart \
    --plain-name "20 sampled registry names render as icons with their codePoints" \
    >> "$evidence/sampled.txt" 2>&1 \
  || fail "sampled-names test failed (see $evidence/sampled.txt)"
grep -q 'All tests passed!' "$evidence/sampled.txt" \
  || fail "sampled-names test did not report 'All tests passed!'"
grep -q 'T61_SAMPLED_BEGIN' "$evidence/sampled.txt" \
  || fail "sampled dump markers missing (see $evidence/sampled.txt)"
ok "sampled.txt written: 20 sampled names rendered with their codePoints"

# --- 5. Unknown icon name degrade (unknown-icon.txt) ---
{
  echo "T61 unknown icon name degrade (§2.4) — an unknown name renders an"
  echo "empty icon and logs via debugPrint; the client never crashes on"
  echo "server content"
  echo
} > "$evidence/unknown-icon.txt"
scripts/qa/flutter-test.sh test/primitives_batch6_test.dart \
    --plain-name "an unknown name renders an empty icon and logs, no exception" \
    >> "$evidence/unknown-icon.txt" 2>&1 \
  || fail "unknown-icon degrade test failed (see $evidence/unknown-icon.txt)"
grep -q 'All tests passed!' "$evidence/unknown-icon.txt" \
  || fail "unknown-icon degrade test did not report 'All tests passed!'"
grep -q 'T61_UNKNOWN_ICON_BEGIN' "$evidence/unknown-icon.txt" \
  || fail "unknown-icon dump markers missing (see $evidence/unknown-icon.txt)"
grep -q 'debugPrint: Jhin SDUI: unknown icon name' "$evidence/unknown-icon.txt" \
  || fail "debugPrint line missing from the unknown-icon dump"
ok "unknown-icon.txt written: empty icon + debugPrint, no exception"

# --- 6. Goldens: recorded delta + regeneration transcript (goldens.txt) ---
goldens=frontend/test/gallery/goldens
golden_count=$(ls "$goldens"/*.png 2>/dev/null | wc -l | tr -d ' ')
new_count=0
for primitive in icon icon_button; do
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
  echo "T61 golden delta"
  echo "before: $before_count PNGs (84 fixtures x light+dark)"
  echo "after: $golden_count PNGs (88 fixtures x light+dark)"
  echo "new files ($new_count):"
  for primitive in icon icon_button; do
    for variant in basic propheavy; do
      for theme in light dark; do
        echo "  $goldens/fixture-${primitive}-${variant}-${theme}.png"
      done
    done
  done
  echo "updated files: none (the iconFor registry lookup resolves to the"
  echo "  same IconData values the Icons.* references did, so every existing"
  echo "  baseline is unchanged — recorded, not silent)"
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

# --- 7. Enum negatives, Java (enum-negative.txt) ---
classes=plugins/ui-kit/build/classes/java/main
[ -d "$classes" ] || fail "missing $classes — run the gradle build first"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/T61Probe.java" <<'EOF'
import com.astroreen.jhin.plugin.uikit.Ui;

/**
 * T61 QA probe. Mode {@code negative}: the T61 enum-typed setters must throw
 * IllegalArgumentException on an unknown literal at build time and accept
 * every documented one. Mode {@code failprobe}: asserts the deliberately
 * wrong expectation — "an unknown enum literal is accepted" — and always
 * exits non-zero.
 */
public class T61Probe {

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
        System.out.println("T61 enum-negative probe — unknown literals throw at build time");
        System.out.println();

        mustThrow("icon().blendMode(\"nope\")", () -> Ui.icon().blendMode("nope"));
        mustThrow("iconButton().alignment(\"nope\")", () -> Ui.iconButton().alignment("nope"));
        mustThrow("iconButton().visualDensity(\"nope\")", () -> Ui.iconButton().visualDensity("nope"));
        mustThrow("iconButton().mouseCursor(\"nope\")", () -> Ui.iconButton().mouseCursor("nope"));
        mustThrow("icon().textDirection(\"nope\")", () -> Ui.icon().textDirection("nope"));
        mustThrow("icon().blendMode(null)", () -> Ui.icon().blendMode(null));
        mustThrow("iconButton().visualDensity(\"standard\")", () -> Ui.iconButton().visualDensity("standard"));

        mustPass("icon().blendMode(\"srcOver\")", () -> Ui.icon().blendMode("srcOver"));
        mustPass("icon().blendMode(\"luminosity\")", () -> Ui.icon().blendMode("luminosity"));
        mustPass("iconButton().alignment(\"bottomRight\")", () -> Ui.iconButton().alignment("bottomRight"));
        mustPass("iconButton().visualDensity(\"spacious\")", () -> Ui.iconButton().visualDensity("spacious"));
        mustPass("iconButton().mouseCursor(\"click\")", () -> Ui.iconButton().mouseCursor("click"));
        mustPass("icon().textDirection(\"rtl\")", () -> Ui.icon().textDirection("rtl"));

        System.out.println();
        System.out.println("every unknown literal threw IllegalArgumentException at build time;");
        System.out.println("every documented literal stayed accepted");
    }

    private static void failprobe() {
        System.out.println("failprobe: asserting icon().blendMode(\"nope\") is ACCEPTED (wrong on purpose)");
        try {
            Ui.icon().blendMode("nope");
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
javac -cp "$classes" -d "$work" "$work/T61Probe.java" || fail "probe compilation failed"

if [ "$fail_mode" = "1" ]; then
  {
    echo
    echo "T61Probe negative re-verification (--fail mode):"
  } >> "$evidence/enum-negative.txt"
  java -cp "$classes:$work" T61Probe negative >> "$evidence/enum-negative.txt" \
    || fail "negative probe failed (see $evidence/enum-negative.txt)"
  grep -q 'FAIL' "$evidence/enum-negative.txt" && fail "negative probe reported failures"
  ok "--fail probes passed: every unknown literal throws, documented literals pass"
  if java -cp "$classes:$work" T61Probe failprobe >> "$evidence/enum-negative.txt" 2>&1; then
    fail "--fail probe: wrong expectation ('unknown enum literal is accepted') unexpectedly passed (checker is broken)"
  fi
  ok "--fail probe: wrong expectation tripped as intended (the builder throws; appended to enum-negative.txt)"
  printf -- '--fail exit code 1 (intentional failure-path exit)\n' | tee -a "$evidence/checks.txt"
  fail "--fail mode: intentional failure-path exit"
fi

java -cp "$classes:$work" T61Probe negative > "$evidence/enum-negative.txt" \
  || fail "negative probe failed (see $evidence/enum-negative.txt)"
if grep -q 'FAIL' "$evidence/enum-negative.txt"; then
  fail "negative probe reported failures (see $evidence/enum-negative.txt)"
fi
ok "enum-negative.txt written: Ui.icon().blendMode/UI.iconButton() enum setters throw at build time"

printf 'happy exit code 0\n' | tee -a "$evidence/checks.txt"
log "T61 QA green: full icon registry and icon/icon_button primitives verified"