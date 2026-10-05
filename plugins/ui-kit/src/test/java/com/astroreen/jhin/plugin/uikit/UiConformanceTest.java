/**
 * The T55 conformance test: generates {@code prop-keys.txt} — the full set of
 * wire keys the builders can emit, collected by the reflection probe — and
 * asserts every key is documented in {@code docs/sdui.md} (the doc's tables
 * are parsed; a key counts as documented when the doc mentions it in any
 * table row). Doc/code drift is a test failure; the fix is to align them,
 * never to weaken this test (plan section 12).
 *
 * <p>Outputs, written into the module {@code build/} directory for the QA
 * script to copy into the evidence:
 * <ul>
 *   <li>{@code prop-keys.txt} — the sorted key inventory;</li>
 *   <li>{@code unknown-keys.txt} — emitted keys missing from the doc (empty
 *       when conformant);</li>
 *   <li>{@code prop-keys-unreachable.txt} — documented keys no builder emits
 *       yet (informational: primitives arrive through T58+).</li>
 * </ul>
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

class UiConformanceTest {

    /** The normative contract document, relative to this module. */
    private static final Path DOC = Path.of("..", "..", "docs", "sdui.md");

    private static final Path PROP_KEYS = Path.of("build", "prop-keys.txt");
    private static final Path UNKNOWN_KEYS = Path.of("build", "unknown-keys.txt");
    private static final Path UNREACHABLE_KEYS = Path.of("build", "prop-keys-unreachable.txt");

    /** The node discriminator lives in the section 2 prose, not in a table row. */
    private static final String NODE_DISCRIMINATOR = "type";

    private static final Pattern BACKTICK = Pattern.compile("`([^`]+)`");
    private static final Pattern WORD = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*");

    @Test
    void everyEmittableKeyIsDocumentedInTheContract() throws IOException {
        assertThat(DOC).as("docs/sdui.md exists relative to the module").exists();
        Set<String> documented = documentedKeys(DOC);
        assertThat(documented).as("doc tables parsed").isNotEmpty();

        Map<Class<?>, Set<String>> keysByBuilder = BuilderProbe.probeAllKeys();
        assertThat(keysByBuilder).as("every builder probed").hasSize(BuilderProbe.BUILDERS.size());

        Set<String> emitted = keysByBuilder.values().stream()
                .flatMap(Set::stream)
                .filter(key -> !key.equals(NODE_DISCRIMINATOR))
                .collect(Collectors.toCollection(TreeSet::new));
        assertThat(emitted).as("the builders emit keys").isNotEmpty();

        List<String> unknown = emitted.stream()
                .filter(key -> !documented.contains(key))
                .toList();
        List<String> unreachable = documented.stream()
                .filter(key -> !emitted.contains(key))
                .sorted()
                .toList();

        Files.createDirectories(PROP_KEYS.getParent());
        Files.writeString(PROP_KEYS, String.join("\n", emitted) + "\n", StandardCharsets.UTF_8);
        Files.writeString(UNKNOWN_KEYS, String.join("\n", unknown) + (unknown.isEmpty() ? "" : "\n"),
                StandardCharsets.UTF_8);
        Files.writeString(UNREACHABLE_KEYS, String.join("\n", unreachable) + "\n", StandardCharsets.UTF_8);

        assertThat(unknown)
                .as("builder keys missing from docs/sdui.md — align code or doc, never weaken this test")
                .isEmpty();
    }

    /**
     * The escape hatch stays available: {@code set} emits any key, which is
     * exactly why it is documented as unstable and why the typed setters plus
     * this conformance test exist.
     */
    @Test
    void escapeHatchStillEmitsArbitraryKeys() {
        UiNode node = Ui.divider().set("madeUpProp", 1).build();
        assertThat(node.toJson()).containsEntry("madeUpProp", 1);
    }

    /**
     * The level-3 glass group (docs/sdui.md section 2.1) is accepted on
     * exactly the five glass-capable surfaces — {@code card}, {@code sheet},
     * {@code dialog}, {@code menu} and {@code banner} — and rejected
     * everywhere else with the standard unsupported-prop error path.
     */
    @Test
    void glassIsAcceptedOnExactlyTheFiveGlassSurfaces() {
        Map<String, Object> card = Ui.card().glass(true).glassTint("$color.destructive").build().toJson();
        assertThat(card).containsEntry("glass", true).containsEntry("glassTint", "$color.destructive");
        Map<String, Object> sheet = Ui.sheet().glass(true).glassTint("$color.destructive").build().toJson();
        assertThat(sheet).containsEntry("glass", true).containsEntry("glassTint", "$color.destructive");
        Map<String, Object> dialog = Ui.dialog().glass(true).glassTint("$color.destructive").build().toJson();
        assertThat(dialog).containsEntry("glass", true).containsEntry("glassTint", "$color.destructive");
        Map<String, Object> menu = Ui.menu().glass(true).glassTint("$color.destructive").build().toJson();
        assertThat(menu).containsEntry("glass", true).containsEntry("glassTint", "$color.destructive");
        Map<String, Object> banner = Ui.banner().glass(true).glassTint("$color.warning").build().toJson();
        assertThat(banner).containsEntry("glass", true).containsEntry("glassTint", "$color.warning");

        for (Ui.NodeBuilder<?> builder : List.of(
                Ui.text("probe"), Ui.container(), Ui.button("probe"), Ui.divider(), Ui.progress())) {
            assertThatThrownBy(() -> builder.set("glass", true))
                    .as("glass on %s", builder.type())
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("unsupported prop");
            assertThatThrownBy(() -> builder.set("glassTint", "$color.destructive"))
                    .as("glassTint on %s", builder.type())
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("unsupported prop");
        }
    }

    /**
     * The reflection probe inventory agrees: {@code glass}/{@code glassTint}
     * are emittable by exactly the five glass-capable builders and by no
     * other builder in the catalog.
     */
    @Test
    void theProbeEmitsGlassOnlyOnTheFiveGlassSurfaces() {
        Map<Class<?>, Set<String>> keysByBuilder = BuilderProbe.probeAllKeys();
        Set<Class<?>> glassBuilders = keysByBuilder.entrySet().stream()
                .filter(entry -> entry.getValue().contains("glass"))
                .map(Map.Entry::getKey)
                .collect(Collectors.toSet());
        assertThat(glassBuilders).containsExactlyInAnyOrder(
                Ui.CardBuilder.class,
                Ui.SheetBuilder.class,
                Ui.DialogBuilder.class,
                Ui.MenuBuilder.class,
                Ui.BannerBuilder.class);
    }

    /**
     * T94 closes phase B: every node type the builders can emit is in the
     * docs/sdui.md section 2.5 catalog, and the catalog carries no type no
     * builder emits. The catalog is exactly 68 names — the 64 builder types
     * (58 of level 2 plus the six level-3 primitives) plus the four level-3
     * universal prop names ({@code glass}, {@code demo}, {@code statusPulse},
     * {@code safeArea}), which are props of the universal surface, not node
     * types. Doc/code drift is a test failure; the fix is to align them,
     * never to weaken this test.
     */
    @Test
    void everyEmittedNodeTypeIsInTheSection25Catalog() throws IOException {
        Set<String> catalog = section25Catalog();

        Map<Class<?>, String> typesByBuilder = BuilderProbe.probeAllTypes();
        assertThat(typesByBuilder).hasSize(BuilderProbe.BUILDERS.size());
        Set<String> emitted = new TreeSet<>(typesByBuilder.values());

        // The per-type containment first: a type missing from the doc fails
        // with the type name in the message (the T94 --fail probe greps it).
        for (Map.Entry<Class<?>, String> entry : typesByBuilder.entrySet()) {
            assertThat(catalog)
                    .as("builder %s emits type %s missing from the docs/sdui.md section 2.5 catalog",
                            entry.getKey().getSimpleName(), entry.getValue())
                    .contains(entry.getValue());
        }

        Set<String> universal = Set.of("glass", "demo", "statusPulse", "safeArea");
        Set<String> catalogTypes = new TreeSet<>(catalog);
        catalogTypes.removeAll(universal);
        assertThat(catalogTypes).as("catalog types minus the four universal prop names")
                .isEqualTo(emitted);
        assertThat(catalog).as("the section 2.5 catalog parsed from docs/sdui.md").hasSize(68);
    }

    /**
     * The level-3 universal props land exactly on their documented surfaces:
     * {@code statusPulse} is a typed setter of {@code progress} alone (the
     * three duty-cycle modes reach the wire, unknown literals throw),
     * {@code demo} is a typed setter of the decorative {@code diff_view}
     * alone, and the {@code safeArea} group is a universal escape-hatch prop
     * every builder accepts.
     */
    @Test
    void level3UniversalPropsLandOnTheirDocumentedSurfaces() {
        assertThat(Ui.progress().statusPulse("pulse").build().toJson()).containsEntry("statusPulse", "pulse");
        assertThat(Ui.progress().statusPulse("ping").build().toJson()).containsEntry("statusPulse", "ping");
        assertThat(Ui.progress().statusPulse("skeleton").build().toJson()).containsEntry("statusPulse", "skeleton");
        assertThatThrownBy(() -> Ui.progress().statusPulse("blink"))
                .as("unknown statusPulse literal")
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown statusPulse literal");

        assertThat(Ui.diffView().demo(true).build().toJson()).containsEntry("demo", true);

        Map<String, Object> safeArea = Map.of("top", true, "bottom", true);
        assertThat(Ui.box().set("safeArea", safeArea).build().toJson()).containsEntry("safeArea", safeArea);
        assertThat(Ui.text("probe").set("safeArea", true).build().toJson()).containsEntry("safeArea", true);

        Map<Class<?>, Set<String>> keysByBuilder = BuilderProbe.probeAllKeys();
        assertThat(keysByBuilder.entrySet().stream()
                .filter(entry -> entry.getValue().contains("statusPulse"))
                .map(Map.Entry::getKey)
                .toList())
                .as("statusPulse is a typed setter of progress alone")
                .containsExactly(Ui.ProgressBuilder.class);
        assertThat(keysByBuilder.entrySet().stream()
                .filter(entry -> entry.getValue().contains("demo"))
                .map(Map.Entry::getKey)
                .toList())
                .as("demo is a typed setter of the decorative diff_view alone")
                .containsExactly(Ui.DiffViewBuilder.class);
    }

    /**
     * The primitive names of the docs/sdui.md section 2.5 catalog: every
     * backtick span of the bullet list (including its wrapped continuation
     * lines) between the section headings.
     */
    private static Set<String> section25Catalog() throws IOException {
        assertThat(DOC).as("docs/sdui.md exists relative to the module").exists();
        Set<String> names = new TreeSet<>();
        boolean inSection = false;
        for (String line : Files.readAllLines(DOC, StandardCharsets.UTF_8)) {
            if (line.startsWith("### 2.5 ")) {
                inSection = true;
                continue;
            }
            if (inSection && line.startsWith("### ")) {
                break;
            }
            if (!inSection) {
                continue;
            }
            String stripped = line.strip();
            boolean bullet = stripped.startsWith("- ");
            boolean continuation = line.startsWith("  ") && !stripped.isEmpty();
            if (!bullet && !continuation) {
                continue;
            }
            Matcher span = BACKTICK.matcher(line);
            while (span.find()) {
                names.add(span.group(1));
            }
        }
        return names;
    }

    /**
     * Every identifier mentioned in any table row of the doc. Deliberately a
     * superset of the prop-name column: the check only needs to catch keys
     * the doc never mentions.
     */
    private static Set<String> documentedKeys(Path doc) throws IOException {
        Set<String> keys = new TreeSet<>();
        for (String line : Files.readAllLines(doc, StandardCharsets.UTF_8)) {
            String trimmed = line.strip();
            if (!trimmed.startsWith("|")) {
                continue;
            }
            Matcher span = BACKTICK.matcher(trimmed);
            while (span.find()) {
                Matcher word = WORD.matcher(span.group(1));
                while (word.find()) {
                    keys.add(word.group());
                }
            }
        }
        return keys;
    }
}
