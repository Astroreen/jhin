#!/usr/bin/env bash
# QA for T60: text/rich_text typography parity, real markdown rendering and
# code blocks.
# Usage: scripts/qa/t60.sh [--fail] [evidence-dir]
# Default evidence dir: .sisyphus/evidence/T60. The directory is gitignored;
# the task commit stages it with `git add -f`.
#
# Happy path (exit 0):
#   - test.txt: the full frontend suite (scripts/qa/flutter-test.sh — the
#     plan's `test/sdui` directory was folded into the flat test/ layout)
#     followed by ./gradlew :jhin-plugin-ui-kit:test (conformance, lattice,
#     enum, regression, GalleryDump) — both must report green;
#   - markdown-tree.txt: the ~30-line markdown fixture and the mapped
#     primitive tree of test/primitives_batch5_test.dart (paragraphs, h1-h3,
#     fence, nested lists, quote, table, link, image, an HTML block and a
#     footnote);
#   - degrade.txt: the §2.4 degrades — an unbalanced/unclosed fence degrades
#     to plain text (no crash), unknown markdown constructs degrade to
#     text, an unknown rich_text span action drops the action but keeps the
#     text, an unknown span field is ignored, and a code_block with an
#     unknown language just labels it;
#   - clipboard.txt: the copy affordance of `code_block` — Clipboard
#     receives the exact source and a toast is shown (clipboard spied via
#     TestDefaultBinaryMessenger);
#   - goldens.txt: the recorded T60 golden delta (before/after counts plus
#     the new and updated baselines) and the transcript of a regeneration
#     run (scripts/qa/flutter-test.sh test/gallery --update-goldens) whose
#     baseline checksums must come back byte-identical — no silent golden
#     updates (markdown text renders differently under Ahem — expected);
#   - enum-negative.txt: a standalone Java probe against the built classes
#     proving Ui.text().overflow("nope"), Ui.text().textWidthBasis("nope"),
#     Ui.span("x").style("nope") and friends throw IllegalArgumentException
#     at build time while every documented literal is accepted;
#   - checks.txt: the ok/FAIL line log, including the flutter_markdown
#     absence check and the recorded exit codes.
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

evidence=${1:-.sisyphus/evidence/T60}
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

log "T60 QA: typography parity, rich text, real markdown and code blocks"
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

# --- 2. Markdown fixture + mapped primitive tree (markdown-tree.txt) ---
{
  echo "T60 markdown mapping — the fixture and the primitive tree it maps to"
  echo "(docs/sdui.md §2.6 'Markdown block mapping'; assertions in"
  echo " test/primitives_batch5_test.dart 'markdown fixture renders the expected primitive tree')"
  echo
} > "$evidence/markdown-tree.txt"
scripts/qa/flutter-test.sh test/primitives_batch5_test.dart \
    --plain-name "markdown fixture renders the expected primitive tree" \
    >> "$evidence/markdown-tree.txt" 2>&1 \
  || fail "markdown tree test failed (see $evidence/markdown-tree.txt)"
grep -q 'All tests passed!' "$evidence/markdown-tree.txt" \
  || fail "markdown tree test did not report 'All tests passed!'"
grep -q 'T60_MARKDOWN_TREE_BEGIN' "$evidence/markdown-tree.txt" \
  || fail "markdown tree dump markers missing (see $evidence/markdown-tree.txt)"
ok "markdown-tree.txt written: fixture + mapped primitive tree recorded"

# --- 3. Degrades (degrade.txt) ---
{
  echo "T60 degrade evidence — §2.4: the client never crashes on server content"
  echo
} > "$evidence/degrade.txt"
for name in \
    "unbalanced markdown fence degrades to plain text" \
    "an unbalanced markdown fence renders as plain text without a crash" \
    "unknown markdown construct degrades to text" \
    "an unknown markdown construct renders as text without a crash" \
    "a rich_text span with an unknown action drops the action but keeps the text" \
    "an unknown rich_text span field is ignored" \
    "code_block with unknown language just labels it"; do
  {
    echo "=== $name ==="
  } >> "$evidence/degrade.txt"
  scripts/qa/flutter-test.sh test/primitives_batch5_test.dart --plain-name "$name" \
    >> "$evidence/degrade.txt" 2>&1 \
    || fail "degrade test '$name' failed (see $evidence/degrade.txt)"
  grep -q 'All tests passed!' "$evidence/degrade.txt" \
    || fail "degrade test '$name' did not report 'All tests passed!'"
done
ok "degrade.txt written: unbalanced fence -> text, unknown constructs -> text, unknown span action/field drop cleanly, unknown language labels only"

# --- 4. Clipboard spy (clipboard.txt) ---
{
  echo "T60 clipboard spy — code_block copy sends the exact source to the"
  echo "Clipboard (spied via TestDefaultBinaryMessenger) and shows a toast"
  echo
} > "$evidence/clipboard.txt"
scripts/qa/flutter-test.sh test/primitives_batch5_test.dart \
    --plain-name "code_block copy sends the exact source to the clipboard and toasts" \
    >> "$evidence/clipboard.txt" 2>&1 \
  || fail "clipboard spy test failed (see $evidence/clipboard.txt)"
grep -q 'All tests passed!' "$evidence/clipboard.txt" \
  || fail "clipboard spy test did not report 'All tests passed!'"
ok "clipboard.txt written: Clipboard.setData carries the exact source and the toast fires"

# --- 5. Goldens: recorded delta + regeneration transcript (goldens.txt) ---
goldens=frontend/test/gallery/goldens
golden_count=$(ls "$goldens"/*.png 2>/dev/null | wc -l | tr -d ' ')
new_count=0
for primitive in rich_text code_block; do
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
  echo "T60 golden delta"
  echo "before: $before_count PNGs (T59: 80 fixtures x light+dark)"
  echo "after: $golden_count PNGs (84 fixtures x light+dark)"
  echo "new files ($new_count):"
  for primitive in rich_text code_block; do
    for variant in basic propheavy; do
      for theme in light dark; do
        echo "  $goldens/fixture-${primitive}-${variant}-${theme}.png"
      done
    done
  done
  echo "updated files (10):"
  echo "  fixture-markdown-basic-{light,dark}.png   (markdown renders real blocks now;"
  echo "    markdown text renders differently under Ahem — expected for goldens)"
  echo "  fixture-markdown-propheavy-{light,dark}.png"
  echo "  fixture-text-propheavy-{light,dark}.png    (new strutStyle/textWidthBasis/"
  echo "    locale/selectionColor fixture props + the typography token mapping)"
  echo "  fixture-row-propheavy-{light,dark}.png     (caption maps to the small token)"
  echo "  fixture-screen-propheavy-{light,dark}.png  (typography token mapping)"
  echo
  echo "regen transcript (scripts/qa/flutter-test.sh test/gallery --update-goldens):"
} > "$evidence/goldens.txt"
ok "golden delta recorded: $before_count -> $golden_count PNGs, $new_count new, 10 updated baselines"

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

# --- 6. Enum negatives, Java (enum-negative.txt) ---
classes=plugins/ui-kit/build/classes/java/main
[ -d "$classes" ] || fail "missing $classes — run the gradle build first"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/T60Probe.java" <<'EOF'
import com.astroreen.jhin.plugin.uikit.Ui;
import java.util.Map;

/**
 * T60 QA probe. Mode {@code negative}: the T60 enum-typed setters must throw
 * IllegalArgumentException on an unknown literal at build time and accept
 * every documented one (actual setter names — {@code code_block} carries no
 * enum-typed setter of its own, so its universal lattice enums are probed).
 * Mode {@code failprobe}: asserts the deliberately wrong expectation —
 * "an unknown enum literal is accepted" — and always exits non-zero.
 */
public class T60Probe {

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
        System.out.println("T60 enum-negative probe — unknown literals throw at build time");
        System.out.println();

        mustThrow("text().overflow(\"nope\")", () -> Ui.text("x").overflow("nope"));
        mustThrow("text().textOverflow(\"nope\")", () -> Ui.text("x").textOverflow("nope"));
        mustThrow("text().style(\"nope\")", () -> Ui.text("x").style("nope"));
        mustThrow("text().textWidthBasis(\"nope\")", () -> Ui.text("x").textWidthBasis("nope"));
        mustThrow("text().fontStyle(\"bold\")", () -> Ui.text("x").fontStyle("bold"));
        mustThrow("text().textDecoration(\"strike\")", () -> Ui.text("x").textDecoration("strike"));
        mustThrow("span(\"x\").style(\"nope\")", () -> Ui.span("x").style("nope"));
        mustThrow("richText().cursor(\"nope\")", () -> Ui.richText().cursor("nope"));
        mustThrow("richText().overflow(\"nope\")", () -> Ui.richText().overflow("nope"));
        mustThrow("codeBlock(\"c\").overflow(\"nope\")", () -> Ui.codeBlock("c").overflow("nope"));
        mustThrow("codeBlock(\"c\").clip(\"nope\")", () -> Ui.codeBlock("c").clip("nope"));
        mustThrow("markdown(\"m\").overflow(\"nope\")", () -> Ui.markdown("m").overflow("nope"));

        mustPass("text().overflow(\"ellipsis\")", () -> Ui.text("x").overflow("ellipsis"));
        mustPass("text().textOverflow(\"visible\")", () -> Ui.text("x").textOverflow("visible"));
        mustPass("text().style(\"caption\")", () -> Ui.text("x").style("caption"));
        mustPass("text().textWidthBasis(\"character\")", () -> Ui.text("x").textWidthBasis("character"));
        mustPass("text().strutStyle map", () -> Ui.text("x").strutStyle(Map.of("size", 18)));
        mustPass("span(\"x\").style(\"mono\")", () -> Ui.span("x").style("mono"));
        mustPass("span style map", () -> Ui.richText().span(Ui.span("x").style(Map.of("fontWeight", 700)).build()));
        mustPass("richText() span with action", () -> Ui.richText().span(
                Ui.span("x").action(Map.of("op", "openUrl", "value", "https://example.invalid")).build()));
        mustPass("codeBlock() wrap/copyable/maxLines/lineNumbers", () -> Ui.codeBlock("c")
                .language("java").wrap(true).copyable(true).maxLines(2).lineNumbers(true));
        mustPass("markdown() codeBlockStyle/syntax", () -> Ui.markdown("m").codeBlockStyle("boxed").syntax(true));

        System.out.println();
        System.out.println("every unknown literal threw IllegalArgumentException at build time;");
        System.out.println("every documented literal stayed accepted");
    }

    private static void failprobe() {
        System.out.println("failprobe: asserting text().style(\"nope\") is ACCEPTED (wrong on purpose)");
        try {
            Ui.text("x").style("nope");
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
javac -cp "$classes" -d "$work" "$work/T60Probe.java" || fail "probe compilation failed"

if [ "$fail_mode" = "1" ]; then
  {
    echo
    echo "T60Probe negative re-verification (--fail mode):"
  } >> "$evidence/enum-negative.txt"
  java -cp "$classes:$work" T60Probe negative >> "$evidence/enum-negative.txt" \
    || fail "negative probe failed (see $evidence/enum-negative.txt)"
  grep -q 'FAIL' "$evidence/enum-negative.txt" && fail "negative probe reported failures"
  ok "--fail probes passed: every unknown literal throws, documented literals pass"
  if java -cp "$classes:$work" T60Probe failprobe >> "$evidence/enum-negative.txt" 2>&1; then
    fail "--fail probe: wrong expectation ('unknown enum literal is accepted') unexpectedly passed (checker is broken)"
  fi
  ok "--fail probe: wrong expectation tripped as intended (the builder throws; appended to enum-negative.txt)"
  printf -- '--fail exit code 1 (intentional failure-path exit)\n' | tee -a "$evidence/checks.txt"
  fail "--fail mode: intentional failure-path exit"
fi

java -cp "$classes:$work" T60Probe negative > "$evidence/enum-negative.txt" \
  || fail "negative probe failed (see $evidence/enum-negative.txt)"
if grep -q 'FAIL' "$evidence/enum-negative.txt"; then
  fail "negative probe reported failures (see $evidence/enum-negative.txt)"
fi
ok "enum-negative.txt written: Ui.text().overflow/.textWidthBasis/.style, Ui.span().style and the universal enums of rich_text/code_block throw at build time"

# --- 7. flutter_markdown is absent (the decision: markdown parser + own renderer) ---
if rg -q 'flutter_markdown' frontend/pubspec.yaml; then
  fail "frontend/pubspec.yaml references flutter_markdown (the T60 decision is the markdown parser + own renderer)"
fi
ok "no flutter_markdown dependency in frontend/pubspec.yaml"
markdown_version=$(sed -n '/^  markdown:/,/^  [a-z]/p' frontend/pubspec.lock | grep 'version:' | head -1 | cut -d'"' -f2)
ok "markdown package resolved at ${markdown_version:-unknown} (constraint ^7.2.2)"

printf 'happy exit code 0\n' | tee -a "$evidence/checks.txt"
log "T60 QA green: typography parity, rich text, real markdown and code blocks verified"
