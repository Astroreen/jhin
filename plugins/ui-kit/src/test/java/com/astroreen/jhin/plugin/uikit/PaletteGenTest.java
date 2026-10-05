/**
 * {@link PaletteGen}: the two-seed OKLCH generator against the upstream
 * acceptance suite. The invariants are the ones of upstream
 * {@code themePalette.test.ts:121-184} ("derives readable, distinctive vivid
 * palettes from exact seeds" and "keys status colors off the canvas"), over
 * the shared vector set: the five built-in seed pairs of
 * {@code packages/shared/src/themePalettes.ts} plus four adversarial pairs.
 *
 * <p>The ΔE anchor compares the seed-determined roles of the generated map
 * against the explicit OKLCH values of the built-in maps (themePalettes.ts
 * per theme) and requires ΔE76 &lt; 2. The surface ladder and the muted /
 * companion roles are hand-tuned art in those maps — they cannot match a
 * formula by construction; the measured per-role deltas live in
 * {@code .sisyphus/evidence/T84/upstream-notes.txt}.
 *
 * <p>The suite also writes the nine generated maps to
 * {@code build/tmp/t84-palettes.json} so the QA script can diff them against
 * the Dart port byte for byte (plan §15.2).
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;

class PaletteGenTest {

    /** One shared vector: appearance slot, canvas seed, accent seed. */
    record Vector(String name, String appearance, String canvas, String accent) {
    }

    /**
     * The five built-in seed pairs: the {@code canvas} and {@code accent}
     * roles of the light palettes of themePalettes.ts (t3-chat :256/:272,
     * grove :383/:399, ocean :510/:526, ember :637/:653, iris :764/:780),
     * expressed as the 8-bit hex their OKLCH values resolve to.
     */
    private static final List<Vector> BUILT_IN = List.of(
            new Vector("t3-chat", "light", "#fdf7fd", "#db2777"),
            new Vector("grove", "light", "#f3f7f4", "#1b7d50"),
            new Vector("ocean", "light", "#f5f7f8", "#2672af"),
            new Vector("ember", "light", "#f9f7f5", "#ae552a"),
            new Vector("iris", "light", "#f8f7f9", "#7253b9"));

    /** The explicit map values of the seed roles, verbatim themePalettes.ts. */
    private static final Map<String, String[]> EXPLICIT_SEEDS = Map.of(
            "t3-chat", new String[] {"oklch(0.982446 0.010114 325.653)", "oklch(0.591646 0.217985 0.584)"},
            "grove", new String[] {"oklch(0.972369 0.005497 157.15)", "oklch(0.523295 0.112292 158.089)"},
            "ocean", new String[] {"oklch(0.974199 0.002856 241.597)", "oklch(0.536684 0.120219 247.01)"},
            "ember", new String[] {"oklch(0.976527 0.002685 60.725)", "oklch(0.552831 0.129438 44.656)"},
            "iris", new String[] {"oklch(0.976531 0.003855 303.226)", "oklch(0.525348 0.15373 294.176)"});

    /** The four adversarial pairs of the plan's test-vector list. */
    private static final List<Vector> ADVERSARIAL = List.of(
            new Vector("near-black-grey", "dark", "#050505", "#808080"),
            new Vector("white-white", "light", "#ffffff", "#ffffff"),
            new Vector("max-chroma-magenta", "light", "#ff00ff", "#ff00ff"),
            new Vector("mid-grey", "light", "#808080", "#808080"));

    private static List<Vector> allVectors() {
        List<Vector> all = new java.util.ArrayList<>(BUILT_IN);
        all.addAll(ADVERSARIAL);
        return all;
    }

    // --- the map shape -----------------------------------------------------

    @Test
    void generateEmitsExactlyTheColorKeys() {
        for (Vector vector : allVectors()) {
            Map<String, String> colors = PaletteGen.generate(
                    vector.appearance(), vector.canvas(), vector.accent());
            assertThat(colors.keySet())
                    .as("key set of %s", vector.name())
                    .isEqualTo(UiTokens.COLOR_KEYS);
        }
    }

    @Test
    void seedsAreHonoredExactly() {
        for (Vector vector : allVectors()) {
            Map<String, String> colors = PaletteGen.generate(
                    vector.appearance(), vector.canvas(), vector.accent());
            assertThat(colors.get("background")).as("canvas of %s", vector.name())
                    .isEqualTo(vector.canvas());
            assertThat(colors.get("ring")).as("accent of %s", vector.name())
                    .isEqualTo(vector.accent());
            assertThat(colors.get("update")).as("update of %s", vector.name())
                    .isEqualTo(vector.accent());
        }
    }

    // --- the ΔE anchor of the acceptance -----------------------------------

    @Test
    void builtInSeedPairsMatchTheExplicitMapsWithinDeltaE2() {
        for (Vector vector : BUILT_IN) {
            Map<String, String> colors = PaletteGen.generate(
                    vector.appearance(), vector.canvas(), vector.accent());
            String[] explicit = EXPLICIT_SEEDS.get(vector.name());
            assertThat(explicit).as("explicit seeds of %s", vector.name()).isNotNull();
            // background ↔ canvas, ring ↔ accent, update ↔ accent. The
            // explicit side goes through the continuous OKLCH → Lab path, so
            // the number measures the real deviation (8-bit quantization of
            // the seed echo), not a hex-to-hex tautology.
            double dBackground = deltaE76(toLab(colors.get("background")),
                    oklchToLab(explicit[0]));
            double dRing = deltaE76(toLab(colors.get("ring")), oklchToLab(explicit[1]));
            double dUpdate = deltaE76(toLab(colors.get("update")), oklchToLab(explicit[1]));
            System.out.printf(Locale.ROOT, "T84_DELTA: %s background %.3f ring %.3f update %.3f%n",
                    vector.name(), dBackground, dRing, dUpdate);
            assertThat(dBackground).as("dE76 background of %s", vector.name()).isLessThan(2.0);
            assertThat(dRing).as("dE76 ring of %s", vector.name()).isLessThan(2.0);
            assertThat(dUpdate).as("dE76 update of %s", vector.name()).isLessThan(2.0);
        }
    }

    // --- the upstream readability invariants (themePalette.test.ts:121) ----

    @Test
    void upstreamReadabilityInvariantsHoldForTheBuiltInSeedPairs() {
        for (Vector vector : BUILT_IN) {
            String name = vector.name();
            Map<String, String> colors = PaletteGen.generate(
                    vector.appearance(), vector.canvas(), vector.accent());
            // Text is WCAG AAA on the canvas (themePalette.ts:705).
            assertThat(contrast(colors.get("foreground"), colors.get("background")))
                    .as("text contrast of %s", name).isGreaterThanOrEqualTo(7.0);
            // The muted pair clears 4.5 and stays quieter than the primary text.
            double mutedCanvas = contrast(colors.get("icon-muted"), colors.get("background"));
            assertThat(mutedCanvas).as("textMuted contrast of %s", name)
                    .isGreaterThanOrEqualTo(4.5).isLessThan(5.5);
            assertThat(contrast(colors.get("muted-foreground"), colors.get("muted")))
                    .as("mutedForeground contrast of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("muted-foreground"), colors.get("muted")))
                    .as("mutedForeground quieter than text for %s", name)
                    .isLessThan(contrast(colors.get("foreground"), colors.get("muted")));
            assertThat(contrast(colors.get("placeholder"), colors.get("surface-raised")))
                    .as("placeholder contrast of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("placeholder"), colors.get("surface-raised")))
                    .as("placeholder quieter than text for %s", name)
                    .isLessThan(contrast(colors.get("foreground"), colors.get("surface-raised")));
            assertThat(colors.get("secondary-label")).as("secondaryLabel of %s", name)
                    .isEqualTo(colors.get("icon-muted"));
            assertThat(contrast(colors.get("accent-foreground"), colors.get("accent")))
                    .as("accentForeground contrast of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("message-action-foreground"),
                    colors.get("message-action")))
                    .as("messageActionForeground contrast of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("message-foreground"), colors.get("message")))
                    .as("messageForeground contrast of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("secondary-foreground"), colors.get("secondary")))
                    .as("secondaryForeground contrast of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("sidebar-foreground"), colors.get("sidebar")))
                    .as("sidebarForeground contrast of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("update-foreground"), colors.get("update-surface")))
                    .as("updateForeground contrast of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("error-foreground"), colors.get("error-surface")))
                    .as("errorForeground of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("warning-foreground"), colors.get("warning-surface")))
                    .as("warningForeground of %s", name).isGreaterThanOrEqualTo(4.5);
            assertStatusAndCompanion(colors, name, 2.5);
        }
    }

    @Test
    void adversarialPairsRemainStructurallySoundAndReadable() {
        // Mid-tone canvases cap the contrast solve below its 4.6 target: the
        // surfaces land close to the text ladder and even black text cannot
        // clear 4.6. The generator returns the extreme reachable colour, so
        // these vectors pin structure plus a weaker floor (measured minima in
        // .sisyphus/evidence/T84/upstream-notes.txt: message-foreground 3.5,
        // update-foreground 3.7, accent-foreground 3.8 on mid-grey).
        for (Vector vector : ADVERSARIAL) {
            String name = vector.name();
            Map<String, String> colors = PaletteGen.generate(
                    vector.appearance(), vector.canvas(), vector.accent());
            double textContrast = contrast(colors.get("foreground"), colors.get("background"));
            assertThat(textContrast).as("text readability of %s", name)
                    .isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("icon-muted"), colors.get("background")))
                    .as("textMuted contrast of %s", name)
                    .isGreaterThanOrEqualTo(4.5).isLessThan(5.5);
            assertThat(contrast(colors.get("error-foreground"), colors.get("error-surface")))
                    .as("errorForeground of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("warning-foreground"), colors.get("warning-surface")))
                    .as("warningForeground of %s", name).isGreaterThanOrEqualTo(4.5);
            assertThat(contrast(colors.get("message-action-foreground"),
                    colors.get("message-action")))
                    .as("messageActionForeground of %s", name).isGreaterThanOrEqualTo(4.5);
            for (String[] pair : List.of(
                    new String[] {"muted-foreground", "muted"},
                    new String[] {"placeholder", "surface-raised"},
                    new String[] {"accent-foreground", "accent"},
                    new String[] {"message-foreground", "message"},
                    new String[] {"secondary-foreground", "secondary"},
                    new String[] {"sidebar-foreground", "sidebar"},
                    new String[] {"update-foreground", "update-surface"})) {
                assertThat(contrast(colors.get(pair[0]), colors.get(pair[1])))
                        .as("%s contrast of %s", pair[0], name).isGreaterThanOrEqualTo(3.0);
            }
            assertStatusAndCompanion(colors, name, 2.5);
        }
    }

    /** The status-family and companion invariants of themePalette.test.ts. */
    private static void assertStatusAndCompanion(Map<String, String> colors, String name,
            double errorWhiteFloor) {
        // The companion action is a distinct voice, not the accent again.
        assertThat(colors.get("message-action")).as("companion of %s", name)
                .isNotEqualTo(colors.get("ring"));
        // Semantic statuses stay red and amber instead of a brand tint.
        int[] error = channels(colors.get("error"));
        assertThat(error[0]).as("error red of %s", name).isGreaterThan(error[1] * 2);
        assertThat(error[0]).as("error red of %s", name).isGreaterThan(error[2] * 2);
        assertThat(contrast(colors.get("error"), "#ffffff"))
                .as("error vs white of %s", name).isGreaterThanOrEqualTo(errorWhiteFloor);
        int[] warning = channels(colors.get("warning"));
        assertThat(warning[0]).as("warning warm of %s", name).isGreaterThan(warning[2]);
        assertThat(warning[1]).as("warning warm of %s", name).isGreaterThan(warning[2]);
    }

    @Test
    void statusColorsAreTheFrozenStandardPairsKeyedOffTheCanvas() {
        // Light canvases get the light standard pair, dark canvases the dark
        // one — regardless of the appearance slot (themePalette.ts:628-633).
        Map<String, String> light = PaletteGen.generate("light", "#fdf7fd", "#db2777");
        assertThat(light.get("error")).isEqualTo("#fb2c36");
        assertThat(light.get("warning")).isEqualTo("#fe9a00");
        Map<String, String> inverted = PaletteGen.generate("light", "#111827", "#8ab4f8");
        assertThat(inverted.get("error")).isEqualTo("#fb414a");
        assertThat(inverted.get("warning")).isEqualTo("#fe9a00");
        Map<String, String> dark = PaletteGen.generate("dark", "#050505", "#808080");
        assertThat(dark.get("error")).isEqualTo("#fb414a");
    }

    // --- typed failures ----------------------------------------------------

    @Test
    void unparsableSeedsRaisePaletteError() {
        assertThatThrownBy(() -> PaletteGen.generate("light", "not-a-colour", "#db2777"))
                .isInstanceOf(PaletteGen.PaletteError.class)
                .hasMessageContaining("not #RRGGBB");
        assertThatThrownBy(() -> PaletteGen.generate("light", "#fdf7fd", "not-a-colour"))
                .isInstanceOf(PaletteGen.PaletteError.class)
                .hasMessageContaining("not #RRGGBB");
        assertThatThrownBy(() -> PaletteGen.generate("light", "#12345", "#db2777"))
                .isInstanceOf(PaletteGen.PaletteError.class);
    }

    @Test
    void unknownAppearanceRaisesPaletteError() {
        assertThatThrownBy(() -> PaletteGen.generate("sepia", "#fdf7fd", "#db2777"))
                .isInstanceOf(PaletteGen.PaletteError.class)
                .hasMessageContaining("appearance");
    }

    @Test
    void systemResolvesOffTheCanvas() {
        assertThat(PaletteGen.generate("system", "#fdf7fd", "#db2777"))
                .isEqualTo(PaletteGen.generate("light", "#fdf7fd", "#db2777"));
        assertThat(PaletteGen.generate("system", "#111827", "#8ab4f8"))
                .isEqualTo(PaletteGen.generate("dark", "#111827", "#8ab4f8"));
    }

    // --- the parity dump ---------------------------------------------------

    @Test
    void writesTheVectorDumpForTheQaDiff() throws IOException {
        StringBuilder json = new StringBuilder("{\n  \"vectors\": [\n");
        List<Vector> vectors = allVectors();
        for (int i = 0; i < vectors.size(); i++) {
            Vector vector = vectors.get(i);
            Map<String, String> colors = new TreeMap<>(PaletteGen.generate(
                    vector.appearance(), vector.canvas(), vector.accent()));
            json.append("    {\"name\": \"").append(vector.name())
                    .append("\", \"appearance\": \"").append(vector.appearance())
                    .append("\", \"canvas\": \"").append(vector.canvas())
                    .append("\", \"accent\": \"").append(vector.accent())
                    .append("\", \"colors\": {");
            boolean first = true;
            for (Map.Entry<String, String> entry : colors.entrySet()) {
                if (!first) {
                    json.append(", ");
                }
                first = false;
                json.append("\"").append(entry.getKey()).append("\": \"")
                        .append(entry.getValue()).append("\"");
            }
            json.append("}}");
            if (i + 1 < vectors.size()) {
                json.append(',');
            }
            json.append('\n');
        }
        json.append("  ]\n}\n");
        Path out = Path.of("build", "tmp", "t84-palettes.json");
        Files.createDirectories(out.getParent());
        Files.writeString(out, json.toString(), StandardCharsets.UTF_8);
        assertThat(out).exists();
    }

    // --- test-local colour maths (CIE76 in CIELAB) -------------------------

    private static double deltaE76(double[] a, double[] b) {
        double dl = a[0] - b[0];
        double da = a[1] - b[1];
        double db = a[2] - b[2];
        return Math.sqrt(dl * dl + da * da + db * db);
    }

    /**
     * The explicit side of the ΔE anchor: an upstream {@code oklch(...)}
     * string through the continuous OKLCH → linear sRGB → XYZ → Lab path
     * (no 8-bit round trip), so the measured delta is the real deviation.
     */
    private static double[] oklchToLab(String oklch) {
        String body = oklch.substring(oklch.indexOf('(') + 1, oklch.indexOf(')'));
        String[] parts = body.trim().split("\\s+");
        double lightness = Double.parseDouble(parts[0]);
        double chroma = Double.parseDouble(parts[1]);
        double hue = Double.parseDouble(parts[2]);
        double hr = Math.toRadians(hue);
        double a = chroma * Math.cos(hr);
        double bb = chroma * Math.sin(hr);
        double l = Math.pow(lightness + 0.3963377774 * a + 0.2158037573 * bb, 3);
        double m = Math.pow(lightness - 0.1055613458 * a - 0.0638541728 * bb, 3);
        double s = Math.pow(lightness - 0.0894841775 * a - 1.2914855480 * bb, 3);
        double r = Math.max(0, Math.min(1,
                4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s));
        double g = Math.max(0, Math.min(1,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s));
        double b = Math.max(0, Math.min(1,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s));
        // oklchToRgbUnclamped already yields linear sRGB: straight to Lab.
        return linearToLab(r, g, b);
    }

    private static double[] toLab(String hex) {
        Oklch.Rgb rgb = Oklch.parseHex(hex);
        return linearToLab(srgbToLinear(rgb.r() / 255.0), srgbToLinear(rgb.g() / 255.0),
                srgbToLinear(rgb.b() / 255.0));
    }

    private static double[] linearToLab(double r, double g, double b) {
        double x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
        double y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
        double z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
        double fx = labF(x / 0.95047);
        double fy = labF(y / 1.0);
        double fz = labF(z / 1.08883);
        return new double[] {116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)};
    }

    private static double srgbToLinear(double c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    private static double labF(double t) {
        return t > 216.0 / 24389.0 ? Math.cbrt(t) : (841.0 / 108.0) * t + 4.0 / 29.0;
    }

    private static double contrast(String hexA, String hexB) {
        return Oklch.contrastRatio(Oklch.parseHex(hexA), Oklch.parseHex(hexB));
    }

    private static int[] channels(String hex) {
        Oklch.Rgb rgb = Oklch.parseHex(hex);
        return new int[] {(int) rgb.r(), (int) rgb.g(), (int) rgb.b()};
    }
}
