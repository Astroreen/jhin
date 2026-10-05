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
}
