/**
 * {@link UiTokens}: every helper emits the exact {@code $token} wire string
 * of docs/sdui.md section 2.2, and the composite helpers produce the spec
 * shapes of section 2.1. No server-side expansion happens anywhere — the
 * strings go onto the wire verbatim (plan section 9).
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

class UiTokensTest {

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

    @Test
    void gradientHelperProducesTheDocumentedSpecShape() {
        assertThat(UiTokens.gradient(
                "linear", List.of("$color.accent", "$color.accentMuted"), List.of("0", "1"),
                "topLeft", "bottomRight"))
                .containsEntry("type", "linear")
                .containsEntry("begin", "topLeft")
                .containsEntry("end", "bottomRight")
                .containsEntry("colors", List.of("$color.accent", "$color.accentMuted"))
                .containsEntry("stops", List.of("0", "1"));
        assertThat(UiTokens.gradient("radial", List.of("$color.accent"), null, "center", "center"))
                .doesNotContainKey("stops");
    }

    @Test
    void shadowHelperProducesTheDocumentedSpecShape() {
        assertThat(UiTokens.shadow("$color.shadow", 12, 0, 0, 4))
                .containsEntry("color", "$color.shadow")
                .containsEntry("blur", 12)
                .containsEntry("spread", 0)
                .containsEntry("offset", List.of(0, 4));
    }

    @Test
    void borderAndRadiusHelpersPassTokensThrough() {
        assertThat(UiTokens.border("$color.outline")).isEqualTo("$color.outline");
        assertThat(UiTokens.radius("$radius.lg")).isEqualTo("$radius.lg");
        assertThat(Ui.color("#16161e")).isEqualTo("#16161e");
    }

    @Test
    void tokensLandOnTheWireVerbatim() {
        UiNode node = Ui.container()
                .padding(UiTokens.spacing.lg())
                .color(UiTokens.color.surface())
                .borderRadius(UiTokens.radius.lg())
                .border(UiTokens.border("$color.outline"))
                .borderWidth(1)
                .shadow(UiTokens.shadow("$color.shadow", 12, 0, 0, 4))
                .build();

        assertThat(node.toJson())
                .containsEntry("padding", "$spacing.lg")
                .containsEntry("color", "$color.surface")
                .containsEntry("borderRadius", "$radius.lg")
                .containsEntry("border", "$color.outline")
                .containsEntry("borderWidth", 1);
        assertThat(node.toJson().get("shadow")).isEqualTo(
                UiTokens.shadow("$color.shadow", 12, 0, 0, 4));
    }
}
