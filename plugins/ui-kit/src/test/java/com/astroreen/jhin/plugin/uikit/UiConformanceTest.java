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
