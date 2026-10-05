/**
 * {@link UiTokens}: the token surface of the SDUI contract. Every typed
 * helper validates its key against the family vocabulary and emits the exact
 * {@code $token} wire string of docs/sdui.md section 2.2; an unknown key is
 * rejected at build time with an {@code unknown token} error (the QA failure
 * path greps the {@code T83_PROBE} proof lines below out of the test XML).
 * The composite helpers produce the spec shapes of section 2.1. No
 * server-side expansion happens anywhere — the strings go onto the wire
 * verbatim.
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class UiTokensTest {

    // --- level-2 namespaces (docs/sdui.md section 2.2) ---

    @Test
    void spacingHelpersEmitTheTokenStrings() {
        assertThat(UiTokens.spacing.xs()).isEqualTo("$spacing.xs");
        assertThat(UiTokens.spacing.sm()).isEqualTo("$spacing.sm");
        assertThat(UiTokens.spacing.md()).isEqualTo("$spacing.md");
        assertThat(UiTokens.spacing.lg()).isEqualTo("$spacing.lg");
        assertThat(UiTokens.spacing.xl()).isEqualTo("$spacing.xl");
        assertThat(UiTokens.spacing.xxl()).isEqualTo("$spacing.xxl");
    }

    @Test
    void colorHelpersEmitThePaletteTokenStrings() {
        assertThat(UiTokens.color.accent()).isEqualTo("$color.accent");
        assertThat(UiTokens.color.canvas()).isEqualTo("$color.canvas");
        assertThat(UiTokens.color.surface()).isEqualTo("$color.surface");
        assertThat(UiTokens.color.outline()).isEqualTo("$color.outline");
        assertThat(UiTokens.color.shadow()).isEqualTo("$color.shadow");
        assertThat(UiTokens.color.onAccent()).isEqualTo("$color.onAccent");
        assertThat(UiTokens.color.onCanvas()).isEqualTo("$color.onCanvas");
        assertThat(UiTokens.color.accentHover()).isEqualTo("$color.accentHover");
        assertThat(UiTokens.color.accentMuted()).isEqualTo("$color.accentMuted");
        assertThat(UiTokens.color.error()).isEqualTo("$color.error");
        assertThat(UiTokens.color.success()).isEqualTo("$color.success");
        assertThat(UiTokens.color.warning()).isEqualTo("$color.warning");
        assertThat(UiTokens.color.info()).isEqualTo("$color.info");
    }

    @Test
    void radiusMotionElevationSizeAndFontHelpersEmitTheirTokenStrings() {
        assertThat(UiTokens.radius.sm()).isEqualTo("$radius.sm");
        assertThat(UiTokens.radius.md()).isEqualTo("$radius.md");
        assertThat(UiTokens.radius.lg()).isEqualTo("$radius.lg");
        assertThat(UiTokens.radius.full()).isEqualTo("$radius.full");

        assertThat(UiTokens.motion.instant()).isEqualTo("$motion.instant");
        assertThat(UiTokens.motion.fast()).isEqualTo("$motion.fast");
        assertThat(UiTokens.motion.normal()).isEqualTo("$motion.normal");
        assertThat(UiTokens.motion.slow()).isEqualTo("$motion.slow");
        assertThat(UiTokens.motion.panel()).isEqualTo("$motion.panel");

        assertThat(UiTokens.elevation.none()).isEqualTo("$elevation.none");
        assertThat(UiTokens.elevation.sm()).isEqualTo("$elevation.sm");
        assertThat(UiTokens.elevation.md()).isEqualTo("$elevation.md");
        assertThat(UiTokens.elevation.lg()).isEqualTo("$elevation.lg");

        assertThat(UiTokens.size.sidebar()).isEqualTo("$size.sidebar");
        assertThat(UiTokens.font.mono()).isEqualTo("$font.mono");
    }

    // --- token surface (T83) ---

    @Test
    void typedHelpersEmitTheTokenStrings() {
        assertThat(UiTokens.color("sidebar-row-hover")).isEqualTo("$color.sidebar-row-hover");
        assertThat(UiTokens.color("accent")).isEqualTo("$color.accent");
        assertThat(UiTokens.contrast("foreground")).isEqualTo("$color.contrast.foreground");
        assertThat(UiTokens.radius("base")).isEqualTo("$radius.base");
        assertThat(UiTokens.radius("xl2")).isEqualTo("$radius.xl2");
        assertThat(UiTokens.text("xs5")).isEqualTo("$text.xs5");
        assertThat(UiTokens.font("composer")).isEqualTo("$font.composer");
        assertThat(UiTokens.space("commandContent")).isEqualTo("$space.commandContent");
        assertThat(UiTokens.layout("topbarHeight")).isEqualTo("$layout.topbarHeight");
        assertThat(UiTokens.glass("blur")).isEqualTo("$glass.blur");
        assertThat(UiTokens.motion("panel")).isEqualTo("$motion.panel");
        assertThat(UiTokens.motion("easeDrawer")).isEqualTo("$motion.easeDrawer");
        assertThat(UiTokens.shadow("composer")).isEqualTo("$shadow.composer");
        assertThat(UiTokens.scroll("thumbHover")).isEqualTo("$scroll.thumbHover");
        assertThat(UiTokens.z("sheet")).isEqualTo("$z.sheet");
    }

    @Test
    void everyFamilyKeyIsAccepted() {
        assertAccepted("color", UiTokens.COLOR_KEYS, UiTokens::color);
        assertAccepted("radius", UiTokens.RADIUS_KEYS, UiTokens::radius);
        assertAccepted("text", UiTokens.TEXT_KEYS, UiTokens::text);
        assertAccepted("font", UiTokens.FONT_KEYS, UiTokens::font);
        assertAccepted("space", UiTokens.SPACE_KEYS, UiTokens::space);
        assertAccepted("layout", UiTokens.LAYOUT_KEYS, UiTokens::layout);
        assertAccepted("glass", UiTokens.GLASS_KEYS, UiTokens::glass);
        assertAccepted("motion", UiTokens.MOTION_KEYS, UiTokens::motion);
        assertAccepted("shadow", UiTokens.SHADOW_KEYS, UiTokens::shadow);
        assertAccepted("scroll", UiTokens.SCROLL_KEYS, UiTokens::scroll);
        assertAccepted("z", UiTokens.Z_KEYS, UiTokens::z);
    }

    @Test
    void keySetsMatchTheFallbackValueMaps() {
        assertThat(UiTokens.COLOR_VALUES.keySet()).isEqualTo(UiTokens.COLOR_KEYS);
        assertThat(UiTokens.CONTRAST_VALUES.keySet()).isEqualTo(UiTokens.CONTRAST_KEYS);
        assertThat(UiTokens.RADIUS_VALUES.keySet()).isEqualTo(UiTokens.RADIUS_KEYS);
        assertThat(UiTokens.TEXT_VALUES.keySet()).isEqualTo(UiTokens.TEXT_KEYS);
        assertThat(UiTokens.FONT_VALUES.keySet()).isEqualTo(UiTokens.FONT_KEYS);
        assertThat(UiTokens.SPACE_VALUES.keySet()).isEqualTo(UiTokens.SPACE_KEYS);
        assertThat(UiTokens.LAYOUT_VALUES.keySet()).isEqualTo(UiTokens.LAYOUT_KEYS);
        assertThat(UiTokens.GLASS_VALUES.keySet()).isEqualTo(UiTokens.GLASS_KEYS);
        assertThat(UiTokens.SHADOW_VALUES.keySet()).isEqualTo(UiTokens.SHADOW_KEYS);
        assertThat(UiTokens.SCROLL_VALUES.keySet()).isEqualTo(UiTokens.SCROLL_KEYS);
        assertThat(UiTokens.Z_VALUES.keySet()).isEqualTo(UiTokens.Z_KEYS);
        // `motion.panel` is the one dynamic value: it comes from the settings
        // store per bootstrap, so the fallback map carries the other five.
        assertThat(UiTokens.MOTION_VALUES.keySet())
                .isEqualTo(Set.copyOf(UiTokens.MOTION_KEYS.stream()
                        .filter(key -> !key.equals("panel")).toList()));
    }

    @Test
    void fallbackValuesCarryTheUpstreamSurface() {
        assertThat(UiTokens.COLOR_KEYS).contains("sidebar-row-hover");
        assertThat(UiTokens.RADIUS_VALUES).containsEntry("base", "0.625rem");
        assertThat(UiTokens.LAYOUT_VALUES).containsEntry("topbarHeight", 52);
        assertThat(UiTokens.MOTION_VALUES)
                .containsEntry("easeDrawer", "cubic-bezier(0.32, 0.72, 0, 1)")
                .containsEntry("skeleton", "2.4s")
                .containsEntry("statusPulse", "2s")
                .containsEntry("statusPing", "2s")
                .containsEntry("reduced", false);
        assertThat(UiTokens.Z_VALUES).containsEntry("sheet", 46);
    }

    @Test
    void unknownTokenKeysAreRejectedWithUnknownToken() {
        reject("color", "no-such-token", () -> UiTokens.color("no-such-token"));
        reject("contrast", "no-such-token", () -> UiTokens.contrast("no-such-token"));
        reject("radius", "no-such-token", () -> UiTokens.radius("no-such-token"));
        reject("text", "no-such-token", () -> UiTokens.text("no-such-token"));
        reject("font", "no-such-token", () -> UiTokens.font("no-such-token"));
        reject("space", "no-such-token", () -> UiTokens.space("no-such-token"));
        reject("layout", "no-such-token", () -> UiTokens.layout("no-such-token"));
        reject("glass", "no-such-token", () -> UiTokens.glass("no-such-token"));
        reject("motion", "no-such-token", () -> UiTokens.motion("no-such-token"));
        reject("shadow", "no-such-token", () -> UiTokens.shadow("no-such-token"));
        reject("scroll", "no-such-token", () -> UiTokens.scroll("no-such-token"));
        reject("z", "no-such-token", () -> UiTokens.z("no-such-token"));
    }

    @Test
    void aNodePropCarryingAnUnknownTokenKeyFailsAtBuildTime() {
        try {
            Ui.box().color(UiTokens.color("no-such-token")).build();
            throw new AssertionError("props.color 'no-such-token' was accepted");
        } catch (IllegalArgumentException expected) {
            assertThat(expected).hasMessageContaining("unknown token");
            System.out.println("T83_PROBE: props.color \"no-such-token\" -> "
                    + expected.getClass().getSimpleName() + ": " + expected.getMessage());
        }
    }

    @Test
    void gradientHelperProducesTheDocumentedSpecShape() {
        assertThat(UiTokens.gradient(
                "linear", List.of("$color.accent", "$color.muted"), List.of("0", "1"),
                "topLeft", "bottomRight"))
                .containsEntry("type", "linear")
                .containsEntry("begin", "topLeft")
                .containsEntry("end", "bottomRight")
                .containsEntry("colors", List.of("$color.accent", "$color.muted"))
                .containsEntry("stops", List.of("0", "1"));
        assertThat(UiTokens.gradient("radial", List.of("$color.accent"), null, "center", "center"))
                .doesNotContainKey("stops");
    }

    @Test
    void shadowSpecHelperProducesTheDocumentedSpecShape() {
        assertThat(UiTokens.shadow("$color.shadow", 12, 0, 0, 4))
                .containsEntry("color", "$color.shadow")
                .containsEntry("blur", 12)
                .containsEntry("spread", 0)
                .containsEntry("offset", List.of(0, 4));
    }

    @Test
    void borderHelperPassesTokensThrough() {
        assertThat(UiTokens.border("$color.border")).isEqualTo("$color.border");
        assertThat(Ui.radius("$radius.lg")).isEqualTo("$radius.lg");
        assertThat(Ui.color("#16161e")).isEqualTo("#16161e");
    }

    @Test
    void tokensLandOnTheWireVerbatim() {
        Map<String, Object> shadow = UiTokens.shadow("$color.shadow", 12, 0, 0, 4);
        UiNode node = Ui.container()
                .padding(UiTokens.space("commandContent"))
                .color(UiTokens.color("surface-raised"))
                .borderRadius(UiTokens.radius("lg"))
                .border(UiTokens.border("$color.border"))
                .borderWidth(1)
                .shadow(shadow)
                .build();

        assertThat(node.toJson())
                .containsEntry("padding", "$space.commandContent")
                .containsEntry("color", "$color.surface-raised")
                .containsEntry("borderRadius", "$radius.lg")
                .containsEntry("border", "$color.border")
                .containsEntry("borderWidth", 1);
        assertThat(node.toJson().get("shadow")).isEqualTo(shadow);
    }

    private static void assertAccepted(String family, Set<String> keys,
                                       java.util.function.Function<String, String> helper) {
        for (String key : keys) {
            assertThatCode(() -> helper.apply(key))
                    .as("%s(%s)", family, key)
                    .doesNotThrowAnyException();
            assertThat(helper.apply(key)).isEqualTo("$" + family + "." + key);
        }
    }

    /**
     * Asserts the rejection and prints the {@code T83_PROBE} proof line the
     * QA failure path records as evidence (the test XML captures stdout).
     */
    private static void reject(String family, String key, Runnable call) {
        assertThatThrownBy(call::run)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown token");
        try {
            call.run();
        } catch (IllegalArgumentException expected) {
            System.out.println("T83_PROBE: " + family + "(\"" + key + "\") -> "
                    + expected.getClass().getSimpleName() + ": " + expected.getMessage());
        }
    }
}
