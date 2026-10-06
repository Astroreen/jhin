/**
 * T103: the ContextChip kind accents of the Flutter design layer match the
 * upstream colour identities. The Dart constants
 * ({@code frontend/lib/design/context_chip_accents.dart}) are parsed and
 * every hex is verified against the shared OKLCH port — the same
 * {@code Oklch.toRgb(Oklch.mapToSrgbGamut(...))} conversion the theme
 * generator uses — so the client tint and the upstream
 * {@code oklch(0.62 …)} literals cannot drift apart
 * ({@code components/ContextChip.tsx:30-48}, commit {@code 37de6cb}).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.Oklch;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class ContextChipAccentsTest {

    /** The design-layer accent table, relative to this module. */
    private static final Path DART =
            Path.of("..", "..", "frontend", "lib", "design", "context_chip_accents.dart");

    /** The upstream kind accents, as the oklch literals of the source. */
    private static final Map<String, String> UPSTREAM = Map.ofEntries(
            Map.entry("image", "oklch(0.62 0.16 16)"),
            Map.entry("video", "oklch(0.62 0.16 48)"),
            Map.entry("file", "oklch(0.62 0.136 237)"),
            Map.entry("mention", "oklch(0.62 0.11 215)"),
            Map.entry("terminal", "oklch(0.62 0.134 163)"),
            Map.entry("element", "oklch(0.62 0.134 70)"),
            Map.entry("review-comment", "oklch(0.62 0.16 292)"),
            Map.entry("pull-request", "oklch(0.62 0.16 277)"),
            Map.entry("pr-open", "oklch(0.62 0.134 163)"),
            Map.entry("pr-draft", "oklch(0.62 0.02 259)"),
            Map.entry("pr-merged", "oklch(0.62 0.16 292)"),
            Map.entry("pr-closed", "oklch(0.62 0.16 16)"),
            Map.entry("skill", "oklch(0.62 0.16 322)"),
            Map.entry("thread", "oklch(0.62 0.12 190)"),
            Map.entry("citation", "oklch(0.62 0.16 259)"));

    private static final Pattern ENTRY = Pattern.compile(
            "'([a-z-]+)': Color\\(0xFF([0-9a-f]{6})\\)");

    @Test
    void everyUpstreamKindHasADartAccentMatchingTheOklchPort() throws IOException {
        Map<String, String> dartAccents = parse(Files.readString(DART, StandardCharsets.UTF_8));
        assertThat(dartAccents.keySet()).isEqualTo(UPSTREAM.keySet());

        Map<String, String> expected = new LinkedHashMap<>();
        for (Map.Entry<String, String> kind : UPSTREAM.entrySet()) {
            Oklch.Lch lch = Oklch.parseOklch(kind.getValue());
            Oklch.Rgb rgb = Oklch.toRgb(Oklch.mapToSrgbGamut(lch));
            expected.put(kind.getKey(), Oklch.toHex(rgb).substring(1).toLowerCase());
        }
        assertThat(dartAccents).isEqualTo(expected);
    }

    /** The {@code '<kind>': Color(0xFFrrggbb)} entries of the Dart map. */
    private static Map<String, String> parse(String dart) {
        Map<String, String> accents = new LinkedHashMap<>();
        Matcher matcher = ENTRY.matcher(dart);
        while (matcher.find()) {
            accents.put(matcher.group(1), matcher.group(2).toLowerCase());
        }
        return accents;
    }
}
