/**
 * T85: the six-theme catalogue. The ids and their order, the reserved
 * appearance modes, the jhin identity seeds (the exact pre-plan palette)
 * and the derived seed pairs of the upstream built-ins. The verbatim
 * upstream triples live in {@link ThemeCatalog}; here the derived hex pairs
 * are pinned so a maths or transcription regression cannot slip through.
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ThemeCatalogTest {

    @Test
    void carriesTheSixThemesInCatalogueOrder() {
        assertThat(ThemeCatalog.ids()).containsExactly(
                "t3-chat", "grove", "ocean", "ember", "iris", "jhin");
        assertThat(ThemeCatalog.get("t3-chat").label()).isEqualTo("T3 Chat");
        assertThat(ThemeCatalog.get("grove").label()).isEqualTo("Grove");
        assertThat(ThemeCatalog.get("ocean").label()).isEqualTo("Ocean");
        assertThat(ThemeCatalog.get("ember").label()).isEqualTo("Ember");
        assertThat(ThemeCatalog.get("iris").label()).isEqualTo("Iris");
        assertThat(ThemeCatalog.get("jhin").label()).isEqualTo("Jhin");
    }

    @Test
    void unknownIdAnswersNull() {
        assertThat(ThemeCatalog.get("nope")).isNull();
        assertThat(ThemeCatalog.get(null)).isNull();
        assertThat(ThemeCatalog.isThemeId("nope")).isFalse();
        assertThat(ThemeCatalog.isThemeId(null)).isFalse();
    }

    @Test
    void appearanceModesAreReservedButNotThemes() {
        for (String reserved : List.of("system", "light", "dark")) {
            assertThat(ThemeCatalog.isReserved(reserved)).as(reserved).isTrue();
            assertThat(ThemeCatalog.isThemeId(reserved)).as(reserved).isFalse();
            assertThat(ThemeCatalog.get(reserved)).as(reserved).isNull();
        }
        assertThat(ThemeCatalog.isReserved("t3-chat")).isFalse();
        assertThat(ThemeCatalog.isReserved(null)).isFalse();
    }

    @Test
    void jhinKeepsTheExactPrePlanPalette() {
        ThemeCatalog.Theme jhin = ThemeCatalog.get("jhin");
        assertThat(jhin.light().canvas()).isEqualTo("#16161e");
        assertThat(jhin.light().accent()).isEqualTo("#7E57C2");
        assertThat(jhin.dark().canvas()).isEqualTo("#16161e");
        assertThat(jhin.dark().accent()).isEqualTo("#7E57C2");
    }

    @Test
    void builtInSeedPairsConvertToTheUpstreamHex() {
        // The expected hex values are the Oklch conversion of the verbatim
        // themePalettes.ts triples (commit 37de6cb), pinned here so a maths
        // regression in the conversion pipeline fails loudly.
        assertThat(ThemeCatalog.get("t3-chat").light())
                .isEqualTo(new ThemeCatalog.Seeds("#fdf7fd", "#db2777"));
        assertThat(ThemeCatalog.get("t3-chat").dark())
                .isEqualTo(new ThemeCatalog.Seeds("#1f1a24", "#a3004c"));
        assertThat(ThemeCatalog.get("grove").light())
                .isEqualTo(new ThemeCatalog.Seeds("#f3f7f4", "#1b7d50"));
        assertThat(ThemeCatalog.get("grove").dark())
                .isEqualTo(new ThemeCatalog.Seeds("#1b2821", "#69d69a"));
        assertThat(ThemeCatalog.get("ocean").light())
                .isEqualTo(new ThemeCatalog.Seeds("#f5f7f8", "#2672af"));
        assertThat(ThemeCatalog.get("ocean").dark())
                .isEqualTo(new ThemeCatalog.Seeds("#17212b", "#70b9ee"));
        assertThat(ThemeCatalog.get("ember").light())
                .isEqualTo(new ThemeCatalog.Seeds("#f9f7f5", "#ae552a"));
        assertThat(ThemeCatalog.get("ember").dark())
                .isEqualTo(new ThemeCatalog.Seeds("#291e1a", "#f09a64"));
        assertThat(ThemeCatalog.get("iris").light())
                .isEqualTo(new ThemeCatalog.Seeds("#f8f7f9", "#7253b9"));
        assertThat(ThemeCatalog.get("iris").dark())
                .isEqualTo(new ThemeCatalog.Seeds("#1d1929", "#9d7df2"));
    }

    @Test
    void systemAppearanceResolvesToTheLightPair() {
        for (String id : ThemeCatalog.ids()) {
            ThemeCatalog.Theme theme = ThemeCatalog.get(id);
            assertThat(theme.seeds("system")).isEqualTo(theme.light());
            assertThat(theme.seeds("light")).isEqualTo(theme.light());
            assertThat(theme.seeds("dark")).isEqualTo(theme.dark());
        }
    }

    @Test
    void everyThemeCarriesTheStageArtMetadata() {
        for (String id : ThemeCatalog.ids()) {
            ThemeCatalog.Theme theme = ThemeCatalog.get(id);
            for (String appearance : List.of("light", "dark", "system")) {
                assertThat(theme.stageArt(appearance).keySet())
                        .as(id + " " + appearance)
                        .containsExactlyInAnyOrderElementsOf(ThemeCatalog.STAGE_ART_KEYS);
                for (String value : theme.stageArt(appearance).values()) {
                    assertThat(value).startsWith("oklch(").endsWith(")");
                }
            }
            assertThat(theme.stageArt("system")).isEqualTo(theme.stageArtLight());
        }
    }

    @Test
    void jhinCarriesTheRootStageArtDefaults() {
        ThemeCatalog.Theme jhin = ThemeCatalog.get("jhin");
        // The :root dark resolution overrides top/mid/bottom only; highlight
        // and line keep their light value (CSS inheritance, index.css :root).
        assertThat(jhin.stageArtDark())
                .containsEntry("stage-art-highlight", jhin.stageArtLight().get("stage-art-highlight"))
                .containsEntry("stage-art-line", jhin.stageArtLight().get("stage-art-line"))
                .isNotEqualTo(jhin.stageArtLight());
    }

    @Test
    void stageArtHexConvertsEveryTokenThroughThePaletteEngine() {
        for (String id : ThemeCatalog.ids()) {
            ThemeCatalog.Theme theme = ThemeCatalog.get(id);
            for (String appearance : List.of("light", "dark", "system")) {
                Map<String, String> hex = theme.stageArtHex(appearance);
                assertThat(hex.keySet()).as(id + " " + appearance)
                        .containsExactlyInAnyOrderElementsOf(ThemeCatalog.STAGE_ART_KEYS);
                for (String value : hex.values()) {
                    assertThat(value).as(id + " " + appearance).matches("#[0-9a-f]{6}");
                }
            }
            assertThat(theme.stageArtHex("system")).isEqualTo(theme.stageArtHex("light"));
        }
    }

    @Test
    void stageArtHexPinsTheT3ChatLightConversion() {
        // The expected hex values are the Oklch conversion of the verbatim
        // index.css stage-art literals (commit 37de6cb), pinned so a maths
        // regression fails loudly (the seed-pair pinning precedent).
        assertThat(ThemeCatalog.get("t3-chat").stageArtHex("light"))
                .containsEntry("stage-art-top", "#f28ac1")
                .containsEntry("stage-art-mid", "#cb3e86")
                .containsEntry("stage-art-bottom", "#73194f")
                .containsEntry("stage-art-highlight", "#ffe6f6")
                .containsEntry("stage-art-line", "#ffe7f8");
    }

    // --- T301: the explicit OKLCH colour maps ---------------------------

    @Test
    void everyThemeCarriesEveryColorKeyInBothAppearances() {
        for (String id : ThemeCatalog.ids()) {
            ThemeCatalog.Theme theme = ThemeCatalog.get(id);
            for (String appearance : List.of("light", "dark")) {
                Map<String, String> colors = theme.colors(appearance);
                assertThat(colors.keySet())
                        .as("%s %s colour keys", id, appearance)
                        .isEqualTo(UiTokens.COLOR_KEYS);
                for (Map.Entry<String, String> entry : colors.entrySet()) {
                    assertThat(entry.getValue())
                            .as("%s %s %s", id, appearance, entry.getKey())
                            .isNotNull()
                            .isNotEmpty();
                }
            }
            assertThat(theme.colors("system")).isEqualTo(theme.colors("light"));
        }
    }

    @Test
    void colorKeyCountIsTheUpstreamSixtyThree() {
        assertThat(UiTokens.COLOR_KEYS).hasSize(63);
        assertThat(UiTokens.COLOR_KEYS).contains(
                "app-chrome-background", "toolbar-background", "toolbar-foreground",
                "toolbar-border", "toolbar-control", "toolbar-control-foreground",
                "toolbar-control-hover");
    }

    @Test
    void t3ChatDarkPrimaryIsTheUpstreamSentinel() {
        // themePalettes.ts: t3-chat dark messageAction (the --primary binding).
        assertThat(ThemeCatalog.get("t3-chat").colors("dark").get("primary"))
                .isEqualTo("oklch(0.460685 0.185347 4.099)");
    }

    @Test
    void themeColorSentinelsMatchThemePalettesVerbatim() {
        assertSentinels("t3-chat", "light",
                "oklch(0.591646 0.217985 0.584)", "oklch(0.982446 0.010114 325.653)",
                "oklch(0.325698 0.116116 325.037)", "oklch(0.939552 0.024286 321.664)",
                "oklch(0.923531 0.021247 328.096)");
        assertSentinels("t3-chat", "dark",
                "oklch(0.460685 0.185347 4.099)", "oklch(0.22813 0.020366 307.469)",
                "oklch(0.980735 0.004092 301.426)", "oklch(0.364912 0.050794 308.491)",
                "oklch(0.266943 0.015262 302.425)");
        assertSentinels("grove", "light",
                "oklch(0.535028 0.106403 77.549)", "oklch(0.972369 0.005497 157.15)",
                "oklch(0.222003 0.03479 328.979)", "oklch(0.909438 0.021521 164.612)",
                "oklch(0.864831 0.01312 167.255)");
        assertSentinels("grove", "dark",
                "oklch(0.791603 0.129713 83.299)", "oklch(0.260865 0.02152 162.75)",
                "oklch(0.990339 0.008411 325.64)", "oklch(0.437021 0.060312 158.962)",
                "oklch(0.457475 0.044046 160.971)");
        assertSentinels("ocean", "light",
                "oklch(0.493961 0.08175 201.584)", "oklch(0.974199 0.002856 241.597)",
                "oklch(0.222003 0.03479 328.979)", "oklch(0.91295 0.018827 241.836)",
                "oklch(0.867646 0.013482 252.362)");
        assertSentinels("ocean", "dark",
                "oklch(0.793363 0.105022 199.893)", "oklch(0.242641 0.024125 250.573)",
                "oklch(0.990339 0.008411 325.64)", "oklch(0.413315 0.051874 243.855)",
                "oklch(0.438653 0.039496 245.44)");
        assertSentinels("ember", "light",
                "oklch(0.516323 0.161628 24.82)", "oklch(0.976527 0.002685 60.725)",
                "oklch(0.222003 0.03479 328.979)", "oklch(0.916502 0.01832 49.597)",
                "oklch(0.870631 0.013204 39.431)");
        assertSentinels("ember", "dark",
                "oklch(0.747955 0.135578 29.432)", "oklch(0.245899 0.019144 42.044)",
                "oklch(0.990339 0.008411 325.64)", "oklch(0.416048 0.055354 50.484)",
                "oklch(0.44099 0.040202 48.807)");
        assertSentinels("iris", "light",
                "oklch(0.516084 0.185229 340.776)", "oklch(0.976531 0.003855 303.226)",
                "oklch(0.222003 0.03479 328.979)", "oklch(0.914882 0.022965 299.986)",
                "oklch(0.869608 0.018226 303.859)");
        assertSentinels("iris", "dark",
                "oklch(0.789904 0.130063 337.621)", "oklch(0.225975 0.031062 293.741)",
                "oklch(0.990339 0.008411 325.64)", "oklch(0.372436 0.07841 294.204)",
                "oklch(0.40874 0.058536 295.893)");
    }

    /** The five per-theme sentinels of themePalettes.ts, exactly. */
    private static void assertSentinels(String id, String mode,
            String primary, String background, String foreground, String accent, String border) {
        Map<String, String> colors = ThemeCatalog.get(id).colors(mode);
        assertThat(colors.get("primary")).as("%s %s primary", id, mode).isEqualTo(primary);
        assertThat(colors.get("background")).as("%s %s background", id, mode).isEqualTo(background);
        assertThat(colors.get("foreground")).as("%s %s foreground", id, mode).isEqualTo(foreground);
        assertThat(colors.get("accent")).as("%s %s accent", id, mode).isEqualTo(accent);
        assertThat(colors.get("border")).as("%s %s border", id, mode).isEqualTo(border);
    }
}
