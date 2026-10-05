/**
 * The design-token surface of the SDUI contract: the eleven token families of
 * docs/sdui.md section 1 with their exact key sets and fallback values, plus
 * the typed reference helpers every builder call goes through.
 *
 * <p>Two jobs live here. First, the vocabulary: {@code color}, {@code radius},
 * {@code text}, {@code font}, {@code space}, {@code layout}, {@code glass},
 * {@code motion}, {@code shadow}, {@code scroll} and {@code z} carry the key
 * sets (and the fallback values the bootstrap {@code tokens} block is built
 * from), so an unknown key is rejected at build time instead of reaching the
 * wire. Second, the helpers: each {@code <family>(String key)} validates the
 * key against its family and emits the {@code $token} wire string of
 * docs/sdui.md section 2.2 — resolution happens client-side only, the server
 * never expands tokens.
 *
 * <p>Value shapes mirror the bootstrap block. CSS values that keep a unit or a
 * composite form are verbatim strings ({@code "0.625rem"}, {@code "80%"},
 * {@code "2.4s"}, {@code rgb(…)}, {@code calc(…)}, {@code cubic-bezier(…)});
 * plain pixel lengths and unitless numbers are numbers (a {@code px} length
 * loses its unit); theme-dependent values are {@code {light, dark}} maps and
 * the responsive gutter is a {@code {base, sm}} map — the client resolves both
 * against the active theme and viewport.
 */
package com.astroreen.jhin.plugin.uikit;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class UiTokens {

    // --- family key sets -------------------------------------------------

    /**
     * {@code color} keys: the semantic {@code --color-*} alias names of the
     * upstream {@code @theme inline} block, verbatim (the raw palette entry
     * {@code zinc-25} is not a semantic name and is not part of the set).
     */
    public static final Set<String> COLOR_KEYS = Set.of(
            "accent", "accent-foreground", "background", "border", "card", "card-foreground",
            "code", "code-foreground", "destructive", "destructive-foreground",
            "diff-addition", "diff-addition-foreground", "diff-deletion", "diff-deletion-foreground",
            "error", "error-foreground", "error-surface", "foreground", "icon-muted", "info",
            "info-foreground", "input", "message", "message-action", "message-action-foreground",
            "message-action-hover", "message-foreground", "muted", "muted-foreground",
            "placeholder", "popover", "popover-foreground", "primary", "primary-foreground",
            "ring", "secondary", "secondary-foreground", "secondary-label", "sidebar",
            "sidebar-border", "sidebar-control-surface", "sidebar-foreground",
            "sidebar-muted-foreground", "sidebar-row-active", "sidebar-row-hover",
            "sidebar-row-selected", "success", "success-foreground", "surface-raised",
            "tool-error-icon", "update", "update-foreground", "update-surface", "warning",
            "warning-foreground", "warning-surface");

    /**
     * {@code color.contrast} keys: the colour names that resolve through the
     * {@code --contrast-*} indirection layer (the user contrast boost).
     */
    public static final Set<String> CONTRAST_KEYS = Set.of(
            "accent-foreground", "border", "card-foreground", "foreground", "icon-muted",
            "input", "message-foreground", "muted-foreground", "placeholder",
            "popover-foreground", "secondary-foreground", "secondary-label", "sidebar-border",
            "sidebar-foreground", "sidebar-muted-foreground");

    /** {@code radius} keys: the base step plus the six-step corner scale. */
    public static final Set<String> RADIUS_KEYS =
            Set.of("base", "sm", "md", "lg", "xl", "xl2", "xl3");

    /** {@code text} keys: the four dense micro steps plus the five-step scale. */
    public static final Set<String> TEXT_KEYS =
            Set.of("xs5", "xs4", "xs3", "xs2", "xs", "sm", "base", "lg", "xl");

    /** {@code font} keys: the three family stacks and the three size roles. */
    public static final Set<String> FONT_KEYS = Set.of(
            "sans", "mono", "composer", "sizeInterface", "sizePrompt", "sizeCode");

    /** {@code space} keys: the compact-geometry insets and the page gutter. */
    public static final Set<String> SPACE_KEYS = Set.of(
            "control", "sidebarContent", "sidebarControlGap", "sidebarRowContent",
            "commandShell", "commandContent", "floatingContent", "workspaceGutter");

    /** {@code layout} keys: the shell metrics in logical px (rem steps keep their unit). */
    public static final Set<String> LAYOUT_KEYS = Set.of(
            "topbarHeight", "chatContentMaxWidth", "threadDetailsPanelWidth",
            "sidebarWidth", "sidebarMinWidth", "mainMinWidth");

    /** {@code glass} keys: the backdrop treatment. */
    public static final Set<String> GLASS_KEYS = Set.of("blur", "opacity", "saturation");

    /** {@code motion} keys: the panel duration, the drawer curve and the duty cycles. */
    public static final Set<String> MOTION_KEYS = Set.of(
            "panel", "easeDrawer", "skeleton", "statusPulse", "statusPing", "reduced");

    /** {@code shadow} keys: the composer elevation and the inset control shades. */
    public static final Set<String> SHADOW_KEYS =
            Set.of("composer", "controlHighlight", "controlPressed");

    /** {@code scroll} keys: the app scrollbar. */
    public static final Set<String> SCROLL_KEYS = Set.of("width", "thumb", "thumbHover");

    /** {@code z} keys: the docked-sheet layer. */
    public static final Set<String> Z_KEYS = Set.of("sheet");

    // --- family fallback values ------------------------------------------

    /** {@code color} values: the verbatim {@code --color-*} alias targets. */
    public static final Map<String, Object> COLOR_VALUES = mapOf(
            "accent", "var(--accent)",
            "accent-foreground", "var(--contrast-accent-foreground)",
            "background", "var(--background)",
            "border", "var(--contrast-border)",
            "card", "var(--card)",
            "card-foreground", "var(--contrast-card-foreground)",
            "code", "var(--code-background)",
            "code-foreground", "var(--code-foreground)",
            "destructive", "var(--destructive)",
            "destructive-foreground", "var(--destructive-foreground)",
            "diff-addition", "var(--diff-addition)",
            "diff-addition-foreground", "var(--diff-addition-foreground)",
            "diff-deletion", "var(--diff-deletion)",
            "diff-deletion-foreground", "var(--diff-deletion-foreground)",
            "error", "var(--error)",
            "error-foreground", "var(--error-foreground)",
            "error-surface", "var(--error-surface)",
            "foreground", "var(--contrast-foreground)",
            "icon-muted", "var(--contrast-icon-muted)",
            "info", "var(--info)",
            "info-foreground", "var(--info-foreground)",
            "input", "var(--contrast-input)",
            "message", "var(--message-surface)",
            "message-action", "var(--message-action)",
            "message-action-foreground", "var(--message-action-foreground)",
            "message-action-hover", "var(--message-action-hover)",
            "message-foreground", "var(--contrast-message-foreground)",
            "muted", "var(--muted)",
            "muted-foreground", "var(--contrast-muted-foreground)",
            "placeholder", "var(--contrast-placeholder)",
            "popover", "var(--popover)",
            "popover-foreground", "var(--contrast-popover-foreground)",
            "primary", "var(--primary)",
            "primary-foreground", "var(--primary-foreground)",
            "ring", "var(--ring)",
            "secondary", "var(--secondary)",
            "secondary-foreground", "var(--contrast-secondary-foreground)",
            "secondary-label", "var(--contrast-secondary-label)",
            "sidebar", "var(--sidebar)",
            "sidebar-border", "var(--contrast-sidebar-border)",
            "sidebar-control-surface", "var(--sidebar-control-surface)",
            "sidebar-foreground", "var(--contrast-sidebar-foreground)",
            "sidebar-muted-foreground", "var(--contrast-sidebar-muted-foreground)",
            "sidebar-row-active", "var(--sidebar-row-active)",
            "sidebar-row-hover", "var(--sidebar-row-hover)",
            "sidebar-row-selected", "var(--sidebar-row-selected)",
            "success", "var(--success)",
            "success-foreground", "var(--success-foreground)",
            "surface-raised", "var(--surface-raised)",
            "tool-error-icon", "var(--tool-error-icon)",
            "update", "var(--update)",
            "update-foreground", "var(--update-foreground)",
            "update-surface", "var(--update-surface)",
            "warning", "var(--warning)",
            "warning-foreground", "var(--warning-foreground)",
            "warning-surface", "var(--warning-surface)");

    /**
     * {@code color.contrast} values: the verbatim {@code --contrast-*}
     * color-mix recipes (the contrast boost mixes each foreground toward the
     * appearance contrast target).
     */
    public static final Map<String, Object> CONTRAST_VALUES = mapOf(
            "accent-foreground", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--accent-foreground) var(--appearance-contrast-base), var(--accent)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "border", "color-mix(in srgb, color-mix(in srgb,"
                    + " var(--border) var(--appearance-contrast-base), transparent),"
                    + " var(--foreground) var(--appearance-contrast-border-boost))",
            "card-foreground", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--card-foreground) var(--appearance-contrast-base), var(--card)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "foreground", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--foreground) var(--appearance-contrast-base), var(--background)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "icon-muted", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--icon-muted) var(--appearance-contrast-base), var(--background)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "input", "color-mix(in srgb, color-mix(in srgb,"
                    + " var(--input) var(--appearance-contrast-base), transparent),"
                    + " var(--foreground) var(--appearance-contrast-border-boost))",
            "message-foreground", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--message-foreground) var(--appearance-contrast-base),"
                    + " var(--message-surface)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "muted-foreground", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--muted-foreground) var(--appearance-contrast-base),"
                    + " var(--background)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "placeholder", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--placeholder) var(--appearance-contrast-base), var(--background)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "popover-foreground", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--popover-foreground) var(--appearance-contrast-base),"
                    + " var(--popover)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "secondary-foreground", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--secondary-foreground) var(--appearance-contrast-base),"
                    + " var(--secondary)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "secondary-label", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--secondary-label) var(--appearance-contrast-base),"
                    + " var(--background)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "sidebar-border", "color-mix(in srgb, color-mix(in srgb,"
                    + " var(--sidebar-border) var(--appearance-contrast-base), transparent),"
                    + " var(--sidebar-foreground) var(--appearance-contrast-border-boost))",
            "sidebar-foreground", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--sidebar-foreground) var(--appearance-contrast-base),"
                    + " var(--sidebar)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))",
            "sidebar-muted-foreground", "color-mix(in oklab, color-mix(in oklab,"
                    + " var(--sidebar-muted-foreground) var(--appearance-contrast-base),"
                    + " var(--sidebar)),"
                    + " var(--appearance-contrast-target) var(--appearance-contrast-boost))");

    /** {@code radius} values: {@code --radius} 0.625rem and the ±px scale around it. */
    public static final Map<String, Object> RADIUS_VALUES = mapOf(
            "base", "0.625rem",
            "sm", "calc(0.625rem - 4px)",
            "md", "calc(0.625rem - 2px)",
            "lg", "0.625rem",
            "xl", "calc(0.625rem + 4px)",
            "xl2", "calc(0.625rem + 8px)",
            "xl3", "calc(0.625rem + 12px)");

    /**
     * {@code text} values: {@code {size, lineHeight}} per step. The four dense
     * steps come from the upstream {@code --text-5xs..2xs} tokens; the five
     * scale steps are the default theme sizes with their default line heights.
     */
    public static final Map<String, Object> TEXT_VALUES = mapOf(
            "xs5", mapOf("size", "0.4375rem", "lineHeight", "1"),
            "xs4", mapOf("size", "0.5rem", "lineHeight", "1"),
            "xs3", mapOf("size", "0.625rem", "lineHeight", "calc(0.875 / 0.625)"),
            "xs2", mapOf("size", "0.6875rem", "lineHeight", "calc(1 / 0.6875)"),
            "xs", mapOf("size", "0.75rem", "lineHeight", "calc(1 / 0.75)"),
            "sm", mapOf("size", "0.875rem", "lineHeight", "calc(1.25 / 0.875)"),
            "base", mapOf("size", "1rem", "lineHeight", "calc(1.5 / 1)"),
            "lg", mapOf("size", "1.125rem", "lineHeight", "calc(1.75 / 1.125)"),
            "xl", mapOf("size", "1.25rem", "lineHeight", "calc(1.75 / 1.25)"));

    /**
     * {@code font} values: the two stylesheet stacks verbatim, the composer
     * stack (whose stylesheet default is the sans stack), and the three size
     * roles in CSS px (the persisted defaults of the appearance preferences).
     */
    public static final Map<String, Object> FONT_VALUES = mapOf(
            "sans", "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif",
            "mono", "ui-monospace, \"SF Mono\", \"SFMono-Regular\", Menlo, Consolas,"
                    + " \"Liberation Mono\", monospace",
            "composer", "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif",
            "sizeInterface", 16,
            "sizePrompt", 14,
            "sizeCode", 13);

    /** {@code space} values: the compact-geometry insets and the page gutter. */
    public static final Map<String, Object> SPACE_VALUES = mapOf(
            "control", "0.5rem",
            "sidebarContent", "0.5rem",
            "sidebarControlGap", "0.5rem",
            "sidebarRowContent", "0.625rem",
            "commandShell", "0.5rem",
            "commandContent", "1rem",
            "floatingContent", "0.75rem",
            "workspaceGutter", mapOf("base", "0.75rem", "sm", "1.25rem"));

    /** {@code layout} values: px metrics as numbers, rem metrics verbatim. */
    public static final Map<String, Object> LAYOUT_VALUES = mapOf(
            "topbarHeight", 52,
            "chatContentMaxWidth", "46rem",
            "threadDetailsPanelWidth", "17.5rem",
            "sidebarWidth", 256,
            "sidebarMinWidth", 208,
            "mainMinWidth", 640);

    /** {@code glass} values: the backdrop treatment, light and dark variants. */
    public static final Map<String, Object> GLASS_VALUES = mapOf(
            "blur", mapOf("light", 12, "dark", 16),
            "opacity", "80%",
            "saturation", mapOf("light", 1.14, "dark", 1.08));

    /**
     * {@code motion} values without {@code panel}: the drawer curve and the
     * duty-cycled animation periods, plus the reduced-motion flag (resolved
     * from the platform, {@code false} until then).
     */
    public static final Map<String, Object> MOTION_VALUES = mapOf(
            "easeDrawer", "cubic-bezier(0.32, 0.72, 0, 1)",
            "skeleton", "2.4s",
            "statusPulse", "2s",
            "statusPing", "2s",
            "reduced", false);

    /** {@code shadow} values: the composer elevation and the inset control shades. */
    public static final Map<String, Object> SHADOW_VALUES = mapOf(
            "composer", mapOf(
                    "light", "0 12px 28px -18px rgb(0 0 0 / 40%)",
                    "dark", "0 14px 32px -18px rgb(0 0 0 / 75%)"),
            "controlHighlight", "0 1px rgb(255 255 255 / 16%)",
            "controlPressed", "0 1px rgb(0 0 0 / 8%)");

    /** {@code scroll} values: the app scrollbar, light and dark thumbs. */
    public static final Map<String, Object> SCROLL_VALUES = mapOf(
            "width", 6,
            "thumb", mapOf("light", "rgb(217 217 217)", "dark", "rgb(255 255 255 / 8%)"),
            "thumbHover", mapOf("light", "rgb(191 191 191)", "dark", "rgb(255 255 255 / 12%)"));

    /** {@code z} values: the docked-sheet layer. */
    public static final Map<String, Object> Z_VALUES = mapOf("sheet", 46);

    private UiTokens() {
    }

    // --- level-2 namespaces (docs/sdui.md section 2.2) -------------------
    //
    // The named-token helpers of the level-2 contract, kept so existing
    // screens keep emitting their exact wire strings. New authoring goes
    // through the typed surface helpers below: the two vocabularies share
    // the `$color` / `$radius` / `$motion` / `$font` namespaces on the wire
    // and differ only in which keys they accept.

    /** {@code $spacing.*} — the level-2 spacing scale (logical px). */
    public static final class spacing {

        private spacing() {
        }

        /** {@code $spacing.xs} */
        public static String xs() {
            return "$spacing.xs";
        }

        /** {@code $spacing.sm} */
        public static String sm() {
            return "$spacing.sm";
        }

        /** {@code $spacing.md} */
        public static String md() {
            return "$spacing.md";
        }

        /** {@code $spacing.lg} */
        public static String lg() {
            return "$spacing.lg";
        }

        /** {@code $spacing.xl} */
        public static String xl() {
            return "$spacing.xl";
        }

        /** {@code $spacing.xxl} */
        public static String xxl() {
            return "$spacing.xxl";
        }
    }

    /** {@code $color.*} — the level-2 theme palette names. */
    public static final class color {

        private color() {
        }

        /** {@code $color.canvas} */
        public static String canvas() {
            return "$color.canvas";
        }

        /** {@code $color.accent} */
        public static String accent() {
            return "$color.accent";
        }

        /** {@code $color.accentHover} */
        public static String accentHover() {
            return "$color.accentHover";
        }

        /** {@code $color.accentMuted} */
        public static String accentMuted() {
            return "$color.accentMuted";
        }

        /** {@code $color.onAccent} */
        public static String onAccent() {
            return "$color.onAccent";
        }

        /** {@code $color.onCanvas} */
        public static String onCanvas() {
            return "$color.onCanvas";
        }

        /** {@code $color.surface} */
        public static String surface() {
            return "$color.surface";
        }

        /** {@code $color.outline} */
        public static String outline() {
            return "$color.outline";
        }

        /** {@code $color.shadow} */
        public static String shadow() {
            return "$color.shadow";
        }

        /** {@code $color.error} */
        public static String error() {
            return "$color.error";
        }

        /** {@code $color.success} */
        public static String success() {
            return "$color.success";
        }

        /** {@code $color.warning} */
        public static String warning() {
            return "$color.warning";
        }

        /** {@code $color.info} */
        public static String info() {
            return "$color.info";
        }
    }

    /** {@code $radius.*} — the level-2 corner-radius scale. */
    public static final class radius {

        private radius() {
        }

        /** {@code $radius.sm} */
        public static String sm() {
            return "$radius.sm";
        }

        /** {@code $radius.md} */
        public static String md() {
            return "$radius.md";
        }

        /** {@code $radius.lg} */
        public static String lg() {
            return "$radius.lg";
        }

        /** {@code $radius.full} */
        public static String full() {
            return "$radius.full";
        }
    }

    /** {@code $motion.*} — the level-2 motion durations (ms). */
    public static final class motion {

        private motion() {
        }

        /** {@code $motion.instant} */
        public static String instant() {
            return "$motion.instant";
        }

        /** {@code $motion.fast} */
        public static String fast() {
            return "$motion.fast";
        }

        /** {@code $motion.normal} */
        public static String normal() {
            return "$motion.normal";
        }

        /** {@code $motion.slow} */
        public static String slow() {
            return "$motion.slow";
        }

        /** {@code $motion.panel} */
        public static String panel() {
            return "$motion.panel";
        }
    }

    /** {@code $elevation.*} — the level-2 elevation scale. */
    public static final class elevation {

        private elevation() {
        }

        /** {@code $elevation.none} */
        public static String none() {
            return "$elevation.none";
        }

        /** {@code $elevation.sm} */
        public static String sm() {
            return "$elevation.sm";
        }

        /** {@code $elevation.md} */
        public static String md() {
            return "$elevation.md";
        }

        /** {@code $elevation.lg} */
        public static String lg() {
            return "$elevation.lg";
        }
    }

    /** {@code $size.*} — the level-2 client-side layout constants. */
    public static final class size {

        private size() {
        }

        /** {@code $size.sidebar} */
        public static String sidebar() {
            return "$size.sidebar";
        }
    }

    /** {@code $font.*} — the level-2 font families. */
    public static final class font {

        private font() {
        }

        /** {@code $font.mono} */
        public static String mono() {
            return "$font.mono";
        }
    }

    // --- typed reference helpers -----------------------------------------

    /**
     * A {@code $color.<key>} reference; see {@link #COLOR_KEYS}.
     *
     * @param key the semantic colour name
     * @return the token wire string
     */
    public static String color(String key) {
        return reference("color", key, COLOR_KEYS);
    }

    /**
     * A {@code $color.contrast.<key>} reference; see {@link #CONTRAST_KEYS}.
     *
     * @param key the contrast foreground name
     * @return the token wire string
     */
    public static String contrast(String key) {
        requireKey("contrast", key, CONTRAST_KEYS);
        return "$color.contrast." + key;
    }

    /**
     * A {@code $radius.<key>} reference; see {@link #RADIUS_KEYS}.
     *
     * @param key the corner-radius step
     * @return the token wire string
     */
    public static String radius(String key) {
        return reference("radius", key, RADIUS_KEYS);
    }

    /**
     * A {@code $text.<key>} reference; see {@link #TEXT_KEYS}.
     *
     * @param key the text step
     * @return the token wire string
     */
    public static String text(String key) {
        return reference("text", key, TEXT_KEYS);
    }

    /**
     * A {@code $font.<key>} reference; see {@link #FONT_KEYS}.
     *
     * @param key the font stack or size role
     * @return the token wire string
     */
    public static String font(String key) {
        return reference("font", key, FONT_KEYS);
    }

    /**
     * A {@code $space.<key>} reference; see {@link #SPACE_KEYS}.
     *
     * @param key the spacing key
     * @return the token wire string
     */
    public static String space(String key) {
        return reference("space", key, SPACE_KEYS);
    }

    /**
     * A {@code $layout.<key>} reference; see {@link #LAYOUT_KEYS}.
     *
     * @param key the layout metric
     * @return the token wire string
     */
    public static String layout(String key) {
        return reference("layout", key, LAYOUT_KEYS);
    }

    /**
     * A {@code $glass.<key>} reference; see {@link #GLASS_KEYS}.
     *
     * @param key the glass key
     * @return the token wire string
     */
    public static String glass(String key) {
        return reference("glass", key, GLASS_KEYS);
    }

    /**
     * A {@code $motion.<key>} reference; see {@link #MOTION_KEYS}.
     *
     * @param key the motion key
     * @return the token wire string
     */
    public static String motion(String key) {
        return reference("motion", key, MOTION_KEYS);
    }

    /**
     * A {@code $shadow.<key>} reference; see {@link #SHADOW_KEYS}.
     *
     * @param key the shadow key
     * @return the token wire string
     */
    public static String shadow(String key) {
        return reference("shadow", key, SHADOW_KEYS);
    }

    /**
     * A {@code $scroll.<key>} reference; see {@link #SCROLL_KEYS}.
     *
     * @param key the scroll key
     * @return the token wire string
     */
    public static String scroll(String key) {
        return reference("scroll", key, SCROLL_KEYS);
    }

    /**
     * A {@code $z.<key>} reference; see {@link #Z_KEYS}.
     *
     * @param key the layer key
     * @return the token wire string
     */
    public static String z(String key) {
        return reference("z", key, Z_KEYS);
    }

    // --- spec helpers ----------------------------------------------------

    /**
     * A {@code gradient} spec referencing tokens: {@code {type, begin, end,
     * colors, stops?}}. The type is validated ({@code linear/radial/sweep}).
     *
     * @param type   the gradient type
     * @param colors the color stops, tokens or hex strings
     * @param stops  the stop positions, or null for none
     * @param begin  the start alignment literal
     * @param end    the end alignment literal
     * @return the gradient spec map
     */
    public static Map<String, Object> gradient(
            String type, List<String> colors, List<String> stops, String begin, String end) {
        UiEnums.require("gradient.type", type, UiEnums.GRADIENT_TYPE);
        Map<String, Object> gradient = new LinkedHashMap<>();
        gradient.put("type", type);
        gradient.put("begin", begin);
        gradient.put("end", end);
        gradient.put("colors", List.copyOf(colors));
        if (stops != null) {
            gradient.put("stops", List.copyOf(stops));
        }
        return gradient;
    }

    /**
     * A {@code shadow} spec referencing tokens: {@code {color, blur, spread,
     * offset: [x, y]}}.
     *
     * @param color   the shadow color or token
     * @param blur    the blur radius
     * @param spread  the spread
     * @param offsetX the x offset
     * @param offsetY the y offset
     * @return the shadow spec map
     */
    public static Map<String, Object> shadow(String color, Number blur, Number spread, Number offsetX, Number offsetY) {
        Map<String, Object> shadow = new LinkedHashMap<>();
        shadow.put("color", color);
        shadow.put("blur", blur);
        shadow.put("spread", spread);
        shadow.put("offset", List.of(offsetX, offsetY));
        return shadow;
    }

    /**
     * A {@code border} value: the doc keeps border color, width and style as
     * separate props, so the helper is the color (or token) itself; pair it
     * with the {@code borderWidth}/{@code borderStyle} setters.
     *
     * @param colorOrToken the border color or {@code $color} token
     * @return the value unchanged
     */
    public static String border(String colorOrToken) {
        return colorOrToken;
    }

    // --- validation ------------------------------------------------------

    /**
     * Validates one token key against its family and returns the
     * {@code $<family>.<key>} wire string. The single place a token lookup is
     * allowed to throw: an unknown key is an authoring bug and must fail the
     * build instead of reaching the wire.
     *
     * @param family the token family name (for the error message)
     * @param key    the candidate key
     * @param keys   the family's key set
     * @return the token wire string
     */
    static String reference(String family, String key, Set<String> keys) {
        requireKey(family, key, keys);
        return "$" + family + "." + key;
    }

    /**
     * Rejects a key outside the family vocabulary.
     *
     * @param family the token family name (for the error message)
     * @param key    the candidate key
     * @param keys   the family's key set
     */
    static void requireKey(String family, String key, Set<String> keys) {
        if (key == null || !keys.contains(key)) {
            throw new IllegalArgumentException(
                    "unknown token key \"" + key + "\" in " + family + " (known: " + keys + ")");
        }
    }

    /** Builds an insertion-ordered map from alternating key/value pairs. */
    private static Map<String, Object> mapOf(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }
}
