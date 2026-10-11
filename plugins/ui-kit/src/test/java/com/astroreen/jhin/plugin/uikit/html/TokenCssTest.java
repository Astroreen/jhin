/**
 * {@link TokenCss}: the token &rarr; CSS emitter of docs/sdui.md section 9.4.
 * Pins the two {@code :root} layers (palette + alias), the appearance
 * override, the density rules, {@code theme.colors} override precedence and
 * the {@code <style>} breakout rule.
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TokenCssTest {

    private static final Map<String, Object> THEME = Map.of(
            "appearance", "dark",
            "canvas", "#16161e",
            "accent", "#7E57C2");

    private static String root(Map<String, Object> theme, String density) {
        return TokenCss.root(theme, Map.of(), density);
    }

    @Test
    void aliasLayerIndirectionsAndRemStepsArePresent() {
        String css = root(THEME, "comfortable");

        assertThat(css).contains("--color-accent: var(--accent)");
        assertThat(css).contains("--radius-base: 0.625rem");
        assertThat(css).contains("--text-sm-size: 0.875rem");
        assertThat(css).contains("--font-sans:");
        assertThat(css).contains("--motion-ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)");
        assertThat(css).contains("--space-workspace-gutter-base:");
        assertThat(css).contains("--space-workspace-gutter-sm:");
    }

    @Test
    void bothLayersArePresentInOrder() {
        String css = root(THEME, "comfortable");
        int palette = css.indexOf("/* palette */");
        int alias = css.indexOf("/* alias */");

        assertThat(palette).isNotNegative();
        assertThat(alias).isGreaterThan(palette);
        assertThat(css.substring(palette, alias))
                .as("palette layer: the generated colours and the contrast indirections")
                .contains("--background: #16161e")
                .contains("--accent:")
                .contains("--contrast-foreground: color-mix(");
        assertThat(css.substring(alias))
                .as("alias layer: the token surface values")
                .contains("--color-accent: var(--accent)")
                .contains("--radius-base: 0.625rem");
    }

    @Test
    void appearanceFamiliesEmitMediaBlocksAndAttributeOverrides() {
        String css = root(THEME, "comfortable");

        assertThat(css).contains("@media (prefers-color-scheme: light)");
        assertThat(css).contains("@media (prefers-color-scheme: dark)");
        assertThat(css).contains("[data-appearance=\"light\"]");
        assertThat(css).contains("[data-appearance=\"dark\"]");
        assertThat(css).contains("--glass-blur: 12px");
        assertThat(css).contains("--glass-blur: 16px");
        assertThat(css).contains("--shadow-composer:");
        assertThat(css.indexOf("[data-appearance=\"light\"]"))
                .as("the explicit appearance override beats the OS preference")
                .isGreaterThan(css.indexOf("@media (prefers-color-scheme: dark)"));
    }

    @Test
    void densityRulesScaleSpacingThroughCalc() {
        String css = root(THEME, "comfortable");

        assertThat(css).contains("[data-density=\"compact\"]");
        assertThat(css).contains("[data-density=\"comfortable\"]");
        assertThat(css).contains("[data-density=\"spacious\"]");
        assertThat(css).contains("calc(0.5rem * 0.75)");
        assertThat(css).contains("calc(0.5rem * 1.25)");
    }

    @Test
    void densityArgumentSeedsTheRootScale() {
        String css = root(THEME, "compact");

        assertThat(css).contains("--space-control: calc(0.5rem * 0.75)");
    }

    @Test
    void themeColorsOverridesWinInPaletteLayer() {
        Map<String, Object> theme = new LinkedHashMap<>(THEME);
        theme.put("colors", Map.of("card", "#123456"));
        String css = root(theme, "comfortable");

        int paletteStart = css.indexOf("/* palette */");
        int aliasStart = css.indexOf("/* alias */");
        int override = css.indexOf("--card: #123456");

        assertThat(override)
                .as("theme.colors override lands in the palette layer")
                .isGreaterThan(paletteStart)
                .isLessThan(aliasStart);
    }

    @Test
    void angleBracketCannotBreakOutOfTheStyleBlock() {
        Map<String, Object> theme = new LinkedHashMap<>(THEME);
        theme.put("colors", Map.of("card", "#123</style><script>alert(1)</script>"));
        String css = root(theme, "comfortable");

        assertThat(css)
                .doesNotContain("<")
                .doesNotContain("</style")
                .contains("\\00003c");
    }

    @Test
    void compositeValuesFlattenToTheirSubKeys() {
        String css = root(THEME, "comfortable");

        assertThat(css).contains("--text-sm-size: 0.875rem");
        assertThat(css).contains("--text-sm-line-height: calc(1.25 / 0.875)");
        assertThat(css).contains("--space-workspace-gutter-base: calc(0.75rem");
        assertThat(css).contains("--space-workspace-gutter-sm: calc(1.25rem");
    }

    @Test
    void tokenOverridesMergeKeyByKeyAndIgnoreUnknownKeys() {
        Map<String, Object> tokens = Map.of(
                "radius", Map.of("base", "1rem", "notAKey", "9rem"),
                "motion", Map.of("panel", 200));

        String css = TokenCss.root(THEME, tokens, "comfortable");

        assertThat(css).contains("--radius-base: 1rem");
        assertThat(css).contains("--motion-panel: 200ms");
        assertThat(css).doesNotContain("notAKey");
        assertThat(css).contains("--radius-sm: calc(0.625rem - 4px)");
    }

    @Test
    void level2NamespacesResolve() {
        String css = root(THEME, "comfortable");

        assertThat(css).contains("--spacing-md: calc(12px * 1)");
        assertThat(css).contains("--elevation-md: 4px");
        assertThat(css).contains("--size-sidebar: 280px");
        assertThat(css).contains("--radius-full: 9999px");
        assertThat(css).contains("--motion-fast: 120ms");
        assertThat(css).contains("--color-surface: var(--surface)");
    }

    @Test
    void resolveReferenceFoldsDotsAndCamelCaseToHyphens() {
        assertThat(TokenCss.resolveReference("$color.accent")).isEqualTo("var(--color-accent)");
        assertThat(TokenCss.resolveReference("$motion.easeDrawer"))
                .isEqualTo("var(--motion-ease-drawer)");
        assertThat(TokenCss.resolveReference("$color.contrast.foreground"))
                .isEqualTo("var(--color-contrast-foreground)");
        assertThat(TokenCss.resolveReference("$spacing.md")).isEqualTo("var(--spacing-md)");
        assertThat(TokenCss.resolveReference("$color.nope"))
                .as("unknown references render as the literal string (section 2.4)")
                .isEqualTo("$color.nope");
        assertThat(TokenCss.resolveReference("plain")).isEqualTo("plain");
    }
}
