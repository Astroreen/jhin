/**
 * The six-theme catalogue (T85): the five t3code built-in themes plus the
 * {@code jhin} identity theme, selectable and persisted through the
 * {@code jhin.ui} settings ({@code themeId}, default {@code t3-chat}).
 *
 * <p>Seed pairs are the upstream {@code canvas}/{@code accent} roles of
 * {@code packages/shared/src/themePalettes.ts} (commit {@code 37de6cb}),
 * stored as verbatim OKLCH triples and converted to hex through
 * {@link Oklch#toRgb(Oklch.Lch)} and {@link Oklch#toHex(Oklch.Rgb)} when a
 * theme feeds {@link PaletteGen#generate}. The {@code jhin} theme keeps the
 * pre-catalogue hex seeds of {@code UiSettings} ({@code #16161e} /
 * {@code #7E57C2}) for both appearances, so selecting it reproduces the
 * exact pre-plan palette.
 *
 * <p>Stage-art backdrop tokens are theme metadata, not colour tokens: the
 * per-theme {@code --stage-art-*} overrides of {@code apps/web/src/index.css}
 * verbatim, with the {@code :root} defaults as the fallback layer (the
 * {@code jhin} theme carries the defaults). {@code UiTokens.COLOR_KEYS} and
 * {@link PaletteGen} are untouched by this metadata (orchestrator decision
 * D3).
 *
 * <p>Appearance resolution (orchestrator decision D5): every theme carries
 * both the light and the dark seed pair; {@code light} and {@code dark}
 * select their pair and {@code system} resolves to the light pair, because
 * the existing settings logic has no server-side system resolution - the
 * stored seeds answer as-is and the client's own mode override wins at
 * render time.
 */
package com.astroreen.jhin.plugin.uikit;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ThemeCatalog {

    /** The stage-art token names every theme carries (index.css :root). */
    public static final List<String> STAGE_ART_KEYS =
            List.of("stage-art-top", "stage-art-mid", "stage-art-bottom", "stage-art-highlight", "stage-art-line");

    /** The ids reserved as appearance modes, never theme ids (T85 step 5). */
    private static final List<String> RESERVED = List.of("system", "light", "dark");

    /** One theme's seed pair: the canvas and accent hex the palette generates from. */
    public record Seeds(String canvas, String accent) {
    }

    /** One catalogue entry: identity, both seed pairs and the stage-art metadata. */
    public record Theme(
            String id,
            String label,
            Seeds light,
            Seeds dark,
            Map<String, String> stageArtLight,
            Map<String, String> stageArtDark,
            Map<String, String> colorsLight,
            Map<String, String> colorsDark) {

        /**
        * The seed pair of one appearance; {@code system} resolves to the
        * light pair (see the class doc).
        *
        * @param appearance {@code light}, {@code dark} or {@code system}
        * @return the pair for that appearance
        */
        public Seeds seeds(String appearance) {
            return "dark".equals(appearance) ? dark : light;
        }

        /**
        * The explicit colour map of one appearance: every
        * {@link UiTokens#COLOR_KEYS} name mapped to its upstream colour,
        * {@code system} resolving to the light map (the same rule as
        * {@link #seeds(String)}).
        *
        * @param appearance {@code light}, {@code dark} or {@code system}
        * @return the colour map for that appearance
        */
        public Map<String, String> colors(String appearance) {
            return "dark".equals(appearance) ? colorsDark : colorsLight;
        }

        /** The stage-art metadata of one appearance; {@code system} is the light map. */
        public Map<String, String> stageArt(String appearance) {
            return "dark".equals(appearance) ? stageArtDark : stageArtLight;
        }

        /**
         * The stage-art metadata of one appearance as the 8-bit hex the
         * bootstrap {@code theme.stageArt} block carries (T95): the verbatim
         * OKLCH literals converted through the same engine the seeds use, so
         * the client's {@code parseColor} reads them without an OKLCH parser.
         */
        public Map<String, String> stageArtHex(String appearance) {
            Map<String, String> out = new LinkedHashMap<>();
            for (Map.Entry<String, String> entry : stageArt(appearance).entrySet()) {
                out.put(entry.getKey(), Oklch.toHex(Oklch.toRgb(Oklch.parseOklch(entry.getValue()))));
            }
            return Collections.unmodifiableMap(out);
        }
    }

    // --- verbatim upstream seed triples (themePalettes.ts) ---------------

    private static final Oklch.Lch SEED_T3_CHAT_LIGHT_CANVAS =
            new Oklch.Lch(0.982446, 0.010114, 325.653);
    private static final Oklch.Lch SEED_T3_CHAT_LIGHT_ACCENT =
            new Oklch.Lch(0.591646, 0.217985, 0.584);
    private static final Oklch.Lch SEED_T3_CHAT_DARK_CANVAS =
            new Oklch.Lch(0.22813, 0.020366, 307.469);
    private static final Oklch.Lch SEED_T3_CHAT_DARK_ACCENT =
            new Oklch.Lch(0.460685, 0.185347, 4.099);
    private static final Oklch.Lch SEED_GROVE_LIGHT_CANVAS =
            new Oklch.Lch(0.972369, 0.005497, 157.15);
    private static final Oklch.Lch SEED_GROVE_LIGHT_ACCENT =
            new Oklch.Lch(0.523295, 0.112292, 158.089);
    private static final Oklch.Lch SEED_GROVE_DARK_CANVAS =
            new Oklch.Lch(0.260865, 0.02152, 162.75);
    private static final Oklch.Lch SEED_GROVE_DARK_ACCENT =
            new Oklch.Lch(0.796228, 0.133058, 157.319);
    private static final Oklch.Lch SEED_OCEAN_LIGHT_CANVAS =
            new Oklch.Lch(0.974199, 0.002856, 241.597);
    private static final Oklch.Lch SEED_OCEAN_LIGHT_ACCENT =
            new Oklch.Lch(0.536684, 0.120219, 247.01);
    private static final Oklch.Lch SEED_OCEAN_DARK_CANVAS =
            new Oklch.Lch(0.242641, 0.024125, 250.573);
    private static final Oklch.Lch SEED_OCEAN_DARK_ACCENT =
            new Oklch.Lch(0.758933, 0.105833, 241.548);
    private static final Oklch.Lch SEED_EMBER_LIGHT_CANVAS =
            new Oklch.Lch(0.976527, 0.002685, 60.725);
    private static final Oklch.Lch SEED_EMBER_LIGHT_ACCENT =
            new Oklch.Lch(0.552831, 0.129438, 44.656);
    private static final Oklch.Lch SEED_EMBER_DARK_CANVAS =
            new Oklch.Lch(0.245899, 0.019144, 42.044);
    private static final Oklch.Lch SEED_EMBER_DARK_ACCENT =
            new Oklch.Lch(0.762174, 0.124117, 52.082);
    private static final Oklch.Lch SEED_IRIS_LIGHT_CANVAS =
            new Oklch.Lch(0.976531, 0.003855, 303.226);
    private static final Oklch.Lch SEED_IRIS_LIGHT_ACCENT =
            new Oklch.Lch(0.525348, 0.15373, 294.176);
    private static final Oklch.Lch SEED_IRIS_DARK_CANVAS =
            new Oklch.Lch(0.225975, 0.031062, 293.741);
    private static final Oklch.Lch SEED_IRIS_DARK_ACCENT =
            new Oklch.Lch(0.671712, 0.169136, 293.929);

    // --- verbatim upstream stage-art tokens (index.css) ------------------

    /** The :root defaults; the jhin theme carries them for both appearances. */
    private static final Map<String, String> STAGE_ART_ROOT_LIGHT = stageArt(Map.of(
            "stage-art-top", "oklch(0.782169 0.123386 240.226)",
            "stage-art-mid", "oklch(0.616111 0.195824 259.735)",
            "stage-art-bottom", "oklch(0.441553 0.232394 265.474)",
            "stage-art-highlight", "oklch(0.951597 0.037289 215.482)",
            "stage-art-line", "oklch(0.959666 0.029238 218.179)"
    ));

    /** The :root dark resolution: the @variant dark overrides, the rest inherited. */
    private static final Map<String, String> STAGE_ART_ROOT_DARK = stageArt(Map.of(
            "stage-art-top", "oklch(0.581473 0.149124 256.9)",
            "stage-art-mid", "oklch(0.456509 0.159377 261.945)",
            "stage-art-bottom", "oklch(0.291327 0.136578 267.649)",
            "stage-art-highlight", "oklch(0.951597 0.037289 215.482)",
            "stage-art-line", "oklch(0.959666 0.029238 218.179)"
    ));

    private static final Map<String, String> STAGE_ART_T3_CHAT_LIGHT = stageArt(Map.of(
            "stage-art-top", "oklch(0.760675 0.141361 348.019)",
            "stage-art-mid", "oklch(0.588093 0.188832 353.138)",
            "stage-art-bottom", "oklch(0.383959 0.135096 348.656)",
            "stage-art-highlight", "oklch(0.949689 0.034241 339.171)",
            "stage-art-line", "oklch(0.952158 0.034194 336.179)"
    ));
    private static final Map<String, String> STAGE_ART_T3_CHAT_DARK = stageArt(Map.of(
            "stage-art-top", "oklch(0.540689 0.143665 347.587)",
            "stage-art-mid", "oklch(0.396586 0.126592 347.6)",
            "stage-art-bottom", "oklch(0.249959 0.079694 340.523)",
            "stage-art-highlight", "oklch(0.921297 0.051708 343.229)",
            "stage-art-line", "oklch(0.945349 0.036045 341.433)"
    ));
    private static final Map<String, String> STAGE_ART_GROVE_LIGHT = stageArt(Map.of(
            "stage-art-top", "oklch(0.751465 0.112731 157.313)",
            "stage-art-mid", "oklch(0.567105 0.11099 158.859)",
            "stage-art-bottom", "oklch(0.367918 0.067635 160.558)",
            "stage-art-highlight", "oklch(0.976387 0.034353 161.456)",
            "stage-art-line", "oklch(0.981098 0.027812 158.718)"
    ));
    private static final Map<String, String> STAGE_ART_GROVE_DARK = stageArt(Map.of(
            "stage-art-top", "oklch(0.58719 0.09869 157.426)",
            "stage-art-mid", "oklch(0.454979 0.079031 159.756)",
            "stage-art-bottom", "oklch(0.297856 0.050355 161.167)",
            "stage-art-highlight", "oklch(0.952407 0.053872 158.44)",
            "stage-art-line", "oklch(0.961577 0.035285 157.03)"
    ));
    private static final Map<String, String> STAGE_ART_OCEAN_LIGHT = stageArt(Map.of(
            "stage-art-top", "oklch(0.792993 0.088072 220.421)",
            "stage-art-mid", "oklch(0.590296 0.116841 243.184)",
            "stage-art-bottom", "oklch(0.409123 0.093718 247.98)",
            "stage-art-highlight", "oklch(0.971217 0.023008 213.615)",
            "stage-art-line", "oklch(0.976025 0.019647 212.543)"
    ));
    private static final Map<String, String> STAGE_ART_OCEAN_DARK = stageArt(Map.of(
            "stage-art-top", "oklch(0.59663 0.089167 233.427)",
            "stage-art-mid", "oklch(0.461094 0.084904 243.478)",
            "stage-art-bottom", "oklch(0.294818 0.05947 250.526)",
            "stage-art-highlight", "oklch(0.952907 0.032224 221.27)",
            "stage-art-line", "oklch(0.961039 0.027355 219.756)"
    ));
    private static final Map<String, String> STAGE_ART_EMBER_LIGHT = stageArt(Map.of(
            "stage-art-top", "oklch(0.782439 0.118806 52.569)",
            "stage-art-mid", "oklch(0.62863 0.15922 39.401)",
            "stage-art-bottom", "oklch(0.404251 0.117664 30.424)",
            "stage-art-highlight", "oklch(0.962469 0.02774 70.95)",
            "stage-art-line", "oklch(0.970313 0.02052 67.583)"
    ));
    private static final Map<String, String> STAGE_ART_EMBER_DARK = stageArt(Map.of(
            "stage-art-top", "oklch(0.597533 0.120694 43.455)",
            "stage-art-mid", "oklch(0.437763 0.101287 34.86)",
            "stage-art-bottom", "oklch(0.264269 0.055858 26.548)",
            "stage-art-highlight", "oklch(0.929214 0.042638 55.801)",
            "stage-art-line", "oklch(0.945058 0.033906 58.824)"
    ));
    private static final Map<String, String> STAGE_ART_IRIS_LIGHT = stageArt(Map.of(
            "stage-art-top", "oklch(0.738305 0.113454 298.926)",
            "stage-art-mid", "oklch(0.551826 0.159189 294.531)",
            "stage-art-bottom", "oklch(0.37147 0.133317 289.999)",
            "stage-art-highlight", "oklch(0.949472 0.029204 303.081)",
            "stage-art-line", "oklch(0.960278 0.024064 306.969)"
    ));
    private static final Map<String, String> STAGE_ART_IRIS_DARK = stageArt(Map.of(
            "stage-art-top", "oklch(0.57297 0.145973 295.185)",
            "stage-art-mid", "oklch(0.419499 0.13752 292.131)",
            "stage-art-bottom", "oklch(0.274235 0.095798 286.608)",
            "stage-art-highlight", "oklch(0.916698 0.047206 300.224)",
            "stage-art-line", "oklch(0.940582 0.032921 299.076)"
    ));

    // --- upstream role binding (index.css html[data-theme-id] block) -------

    /**
     * The {@link UiTokens#COLOR_KEYS} name to upstream {@code themePalettes.ts}
     * role binding of the {@code html[data-theme-id]} block of index.css: the
     * semantic {@code --color-*} name resolves to its {@code --app-theme-*}
     * role (verbatim, {@code message} &rarr; {@code messageSurface} through
     * {@code --message-surface}, {@code code} &rarr; {@code codeBackground}
     * through {@code --code-background}, {@code tool-error-icon} and
     * {@code destructive*} riding the {@code error} roles exactly as
     * upstream, {@code diff-deletion} on {@code --destructive}).
     */
    private static final Map<String, String> COLOR_ROLE = Map.ofEntries(
            Map.entry("accent", "accentSurface"),
            Map.entry("accent-foreground", "accentSurfaceForeground"),
            Map.entry("app-chrome-background", "chrome"),
            Map.entry("background", "canvas"),
            Map.entry("border", "border"),
            Map.entry("card", "surface"),
            Map.entry("card-foreground", "text"),
            Map.entry("code", "codeBackground"),
            Map.entry("code-foreground", "codeForeground"),
            Map.entry("destructive", "error"),
            Map.entry("destructive-foreground", "errorForeground"),
            Map.entry("diff-deletion", "error"),
            Map.entry("error", "error"),
            Map.entry("error-foreground", "errorForeground"),
            Map.entry("error-surface", "errorSurface"),
            Map.entry("foreground", "text"),
            Map.entry("icon-muted", "iconMuted"),
            Map.entry("input", "input"),
            Map.entry("message", "messageSurface"),
            Map.entry("message-action", "messageAction"),
            Map.entry("message-action-foreground", "messageActionForeground"),
            Map.entry("message-action-hover", "messageActionHover"),
            Map.entry("message-foreground", "messageForeground"),
            Map.entry("muted", "muted"),
            Map.entry("muted-foreground", "mutedForeground"),
            Map.entry("placeholder", "placeholder"),
            Map.entry("popover", "surfaceOverlay"),
            Map.entry("popover-foreground", "text"),
            Map.entry("primary", "messageAction"),
            Map.entry("primary-foreground", "messageActionForeground"),
            Map.entry("ring", "focus"),
            Map.entry("secondary", "secondary"),
            Map.entry("secondary-foreground", "secondaryForeground"),
            Map.entry("secondary-label", "secondaryLabel"),
            Map.entry("sidebar", "sidebar"),
            Map.entry("sidebar-border", "sidebarBorder"),
            Map.entry("sidebar-control-surface", "sidebarControlSurface"),
            Map.entry("sidebar-foreground", "sidebarForeground"),
            Map.entry("sidebar-muted-foreground", "sidebarMutedForeground"),
            Map.entry("sidebar-row-active", "sidebarRowActive"),
            Map.entry("sidebar-row-hover", "sidebarRowHover"),
            Map.entry("sidebar-row-selected", "sidebarRowSelected"),
            Map.entry("surface-raised", "surfaceRaised"),
            Map.entry("toolbar-background", "toolbar"),
            Map.entry("toolbar-border", "toolbarBorder"),
            Map.entry("toolbar-control", "toolbarControl"),
            Map.entry("toolbar-control-foreground", "toolbarControlForeground"),
            Map.entry("toolbar-control-hover", "toolbarControlHover"),
            Map.entry("toolbar-foreground", "toolbarForeground"),
            Map.entry("tool-error-icon", "errorForeground"),
            Map.entry("update", "update"),
            Map.entry("update-foreground", "updateForeground"),
            Map.entry("update-surface", "updateSurface"),
            Map.entry("warning", "warning"),
            Map.entry("warning-foreground", "warningForeground"),
            Map.entry("warning-surface", "warningSurface"));

    /**
     * The theme-independent {@code light-dark()} tokens of the alias block
     * (index.css:1104-1107 and 2025-2028), verbatim: the emerald/blue/red
     * palette entries the same values {@link PaletteGen} carries.
     */
    private static final String INFO = "#3280ff";
    private static final String INFO_FOREGROUND_LIGHT = "#1447e6";
    private static final String INFO_FOREGROUND_DARK = "#56a2ff";
    private static final String SUCCESS = "#00b981";
    private static final String SUCCESS_FOREGROUND_LIGHT = "#007857";
    private static final String SUCCESS_FOREGROUND_DARK = "#00d294";
    private static final String DIFF_ADDITION = "#00b981";
    private static final String DIFF_ADDITION_FOREGROUND_LIGHT = "#009669";
    private static final String DIFF_ADDITION_FOREGROUND_DARK = "#00d294";
    private static final String DIFF_DELETION_FOREGROUND_LIGHT = "#e40016";
    private static final String DIFF_DELETION_FOREGROUND_DARK = "#ff6568";

    private static final Map<String, Theme> THEMES = build(); // insertion-ordered

    private ThemeCatalog() {
    }

    /** The catalogue ids, in catalogue order. */
    public static List<String> ids() {
        return List.copyOf(THEMES.keySet());
    }

    /**
    * One theme by id.
    *
    * @param id the theme id
    * @return the theme, or {@code null} when the id is not in the catalogue
    */
    public static Theme get(String id) {
        return id == null ? null : THEMES.get(id);
    }

    /** Whether the id is an appearance mode ({@code system/light/dark}), never a theme id. */
    public static boolean isReserved(String id) {
        return id != null && RESERVED.contains(id);
    }

    /** Whether the id names a catalogue theme (reserved ids are not themes). */
    public static boolean isThemeId(String id) {
        return id != null && THEMES.containsKey(id);
    }

    private static Map<String, Theme> build() {
        Map<String, Theme> themes = new LinkedHashMap<>();
        themes.put("t3-chat", new Theme("t3-chat", "T3 Chat",
                new Seeds(hex(SEED_T3_CHAT_LIGHT_CANVAS), hex(SEED_T3_CHAT_LIGHT_ACCENT)),
                new Seeds(hex(SEED_T3_CHAT_DARK_CANVAS), hex(SEED_T3_CHAT_DARK_ACCENT)),
                STAGE_ART_T3_CHAT_LIGHT,
                STAGE_ART_T3_CHAT_DARK,
                upstreamColors("t3-chat", "light"), upstreamColors("t3-chat", "dark")));
        themes.put("grove", new Theme("grove", "Grove",
                new Seeds(hex(SEED_GROVE_LIGHT_CANVAS), hex(SEED_GROVE_LIGHT_ACCENT)),
                new Seeds(hex(SEED_GROVE_DARK_CANVAS), hex(SEED_GROVE_DARK_ACCENT)),
                STAGE_ART_GROVE_LIGHT,
                STAGE_ART_GROVE_DARK,
                upstreamColors("grove", "light"), upstreamColors("grove", "dark")));
        themes.put("ocean", new Theme("ocean", "Ocean",
                new Seeds(hex(SEED_OCEAN_LIGHT_CANVAS), hex(SEED_OCEAN_LIGHT_ACCENT)),
                new Seeds(hex(SEED_OCEAN_DARK_CANVAS), hex(SEED_OCEAN_DARK_ACCENT)),
                STAGE_ART_OCEAN_LIGHT,
                STAGE_ART_OCEAN_DARK,
                upstreamColors("ocean", "light"), upstreamColors("ocean", "dark")));
        themes.put("ember", new Theme("ember", "Ember",
                new Seeds(hex(SEED_EMBER_LIGHT_CANVAS), hex(SEED_EMBER_LIGHT_ACCENT)),
                new Seeds(hex(SEED_EMBER_DARK_CANVAS), hex(SEED_EMBER_DARK_ACCENT)),
                STAGE_ART_EMBER_LIGHT,
                STAGE_ART_EMBER_DARK,
                upstreamColors("ember", "light"), upstreamColors("ember", "dark")));
        themes.put("iris", new Theme("iris", "Iris",
                new Seeds(hex(SEED_IRIS_LIGHT_CANVAS), hex(SEED_IRIS_LIGHT_ACCENT)),
                new Seeds(hex(SEED_IRIS_DARK_CANVAS), hex(SEED_IRIS_DARK_ACCENT)),
                STAGE_ART_IRIS_LIGHT,
                STAGE_ART_IRIS_DARK,
                upstreamColors("iris", "light"), upstreamColors("iris", "dark")));
        themes.put("jhin", new Theme("jhin", "Jhin",
                new Seeds("#16161e", "#7E57C2"), new Seeds("#16161e", "#7E57C2"),
                STAGE_ART_ROOT_LIGHT, STAGE_ART_ROOT_DARK,
                PaletteGen.generate("light", "#16161e", "#7E57C2"),
                PaletteGen.generate("dark", "#16161e", "#7E57C2")));
        return Collections.unmodifiableMap(themes);
    }

    /**
     * The explicit colour map of one built-in theme under one mode: every
     * {@link UiTokens#COLOR_KEYS} name bound through {@link #COLOR_ROLE} to
     * the verbatim {@link ThemePalettes} role, plus the seven
     * theme-independent {@code light-dark()} tokens.
     */
    private static Map<String, String> upstreamColors(String id, String mode) {
        Map<String, String> roles = ThemePalettes.get(id, mode);
        boolean dark = "dark".equals(mode);
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : COLOR_ROLE.entrySet()) {
            out.put(entry.getKey(), roles.get(entry.getValue()));
        }
        out.put("info", INFO);
        out.put("info-foreground", dark ? INFO_FOREGROUND_DARK : INFO_FOREGROUND_LIGHT);
        out.put("success", SUCCESS);
        out.put("success-foreground", dark ? SUCCESS_FOREGROUND_DARK : SUCCESS_FOREGROUND_LIGHT);
        out.put("diff-addition", DIFF_ADDITION);
        out.put("diff-addition-foreground",
                dark ? DIFF_ADDITION_FOREGROUND_DARK : DIFF_ADDITION_FOREGROUND_LIGHT);
        out.put("diff-deletion-foreground",
                dark ? DIFF_DELETION_FOREGROUND_DARK : DIFF_DELETION_FOREGROUND_LIGHT);
        return Collections.unmodifiableMap(out);
    }

    /** Converts one verbatim triple to the 8-bit hex the palette engine consumes. */
    private static String hex(Oklch.Lch color) {
        return Oklch.toHex(Oklch.toRgb(color));
    }

    private static Map<String, String> stageArt(Map<String, String> values) {
        return Map.copyOf(values);
    }
}
