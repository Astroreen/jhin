/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html;

import com.astroreen.jhin.plugin.uikit.Oklch;
import com.astroreen.jhin.plugin.uikit.PaletteGen;
import com.astroreen.jhin.plugin.uikit.UiTokens;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * The token &rarr; CSS emitter of docs/sdui.md section 9.4: turns the
 * bootstrap {@code theme}/{@code tokens}/{@code density} payload into the
 * raw CSS text a {@code <style>} element carries. The client runtime injects
 * the result verbatim — there is no client-side token parsing and no
 * {@code parseCssLength}/{@code parseCssDuration} on the other side.
 *
 * <p>{@link #root(Map, Map, String)} returns <strong>raw CSS</strong> (the
 * content of a {@code <style>} element, not the element itself) in exactly
 * two layers plus the appearance and density selectors:
 *
 * <ol>
 *   <li><strong>palette layer</strong> — {@code --accent},
 *       {@code --background}, {@code --card}, &hellip; generated server-side
 *       by {@link PaletteGen}/{@link Oklch} from
 *       {@code {appearance, canvas, accent}}, with {@code theme.colors}
 *       overrides winning last, plus the {@code --contrast-*} indirection
 *       variables carrying the user contrast boost;</li>
 *   <li><strong>alias layer</strong> — {@code --color-accent: var(--accent)},
 *       {@code --radius-base: 0.625rem}, {@code --text-sm-size: 0.875rem},
 *       {@code --font-sans: &hellip;},
 *       {@code --motion-ease-drawer: cubic-bezier(&hellip;)},
 *       {@code --space-workspace-gutter-base}/{@code -sm}, the level-2
 *       namespaces of section 2.2, and the {@code {light, dark}} families
 *       ({@code glass.blur}, {@code shadow.composer}, &hellip;) emitted under
 *       {@code @media (prefers-color-scheme: light|dark)} plus a
 *       {@code [data-appearance]} override so an explicit theme choice beats
 *       the OS preference.</li>
 * </ol>
 *
 * <p>Token values of {@link UiTokens} are already verbatim CSS and are
 * emitted directly; plain numbers get their unit back (px lengths and the
 * {@code motion.panel} duration — see {@link #tokenValue}), booleans become
 * {@code 1}/{@code 0}. A {@code $family.key} wire reference becomes
 * {@code var(--family-key)} with dots and camelCase folded to hyphens
 * ({@link #resolveReference}); unknown keys are rejected at build time by
 * {@link UiTokens} and a raw unknown reference renders as the literal string
 * (section 2.4).
 *
 * <p><strong>Injection rule.</strong> Token values are trusted server-side
 * vocabulary, but {@code theme.colors} overrides are user-influenced, so
 * every emitted name and value has {@code <}, {@code ;}, {@code {@} and
 * {@code }} replaced by CSS hex escapes ({@code \00003c} and friends). The
 * output therefore contains no {@code <} at all and cannot break out of a
 * surrounding {@code <style>} block.
 *
 * <p>Density is an attribute, not a recomputation: the {@code [data-density]}
 * selectors on {@code <html>} scale the spacing families through
 * {@code calc()} at 0.75 / 1.0 / 1.25, and the {@code density} argument
 * seeds the {@code :root} default scale the same way (so a client that sets
 * no attribute still renders at the server's density).
 *
 * <p>This class is stateless and thread-safe.
 */
public final class TokenCss {

    /** The bootstrap theme fallbacks when the block is absent or malformed. */
    private static final String DEFAULT_CANVAS = "#16161e";
    private static final String DEFAULT_ACCENT = "#7E57C2";

    /** The eleven token-surface families, in bootstrap order. */
    private static final List<String> FAMILIES = List.of(
            "color", "radius", "text", "font", "space", "layout", "glass",
            "motion", "shadow", "scroll", "z");

    /** Level-2 color names outside the surface vocabulary (section 2.2). */
    private static final Set<String> LEVEL2_COLOR = Set.of(
            "accentHover", "accentMuted", "canvas", "onAccent", "onCanvas",
            "outline", "shadow", "surface");

    /** The namespaces every {@code $family.key} wire reference may name. */
    private static final Map<String, Set<String>> NAMESPACE_KEYS = Map.ofEntries(
            Map.entry("color", union(UiTokens.COLOR_KEYS, LEVEL2_COLOR)),
            Map.entry("radius", union(UiTokens.RADIUS_KEYS, Set.of("full"))),
            Map.entry("text", UiTokens.TEXT_KEYS),
            Map.entry("font", UiTokens.FONT_KEYS),
            Map.entry("space", UiTokens.SPACE_KEYS),
            Map.entry("layout", UiTokens.LAYOUT_KEYS),
            Map.entry("glass", UiTokens.GLASS_KEYS),
            Map.entry("motion", union(UiTokens.MOTION_KEYS, Set.of("instant", "fast", "normal", "slow"))),
            Map.entry("shadow", UiTokens.SHADOW_KEYS),
            Map.entry("scroll", UiTokens.SCROLL_KEYS),
            Map.entry("z", UiTokens.Z_KEYS),
            Map.entry("spacing", Set.of("xs", "sm", "md", "lg", "xl", "xxl")),
            Map.entry("elevation", Set.of("none", "sm", "md", "lg")),
            Map.entry("size", Set.of("sidebar", "chart", "streamList")));

    /** Level-2 spacing scale (section 1), logical px. */
    private static final Map<String, String> LEVEL2_SPACING = Map.of(
            "xs", "4px", "sm", "8px", "md", "12px", "lg", "16px",
            "xl", "24px", "xxl", "32px");

    /** Level-2 elevation scale (section 1), logical px. */
    private static final Map<String, String> LEVEL2_ELEVATION = Map.of(
            "none", "0px", "sm", "1px", "md", "4px", "lg", "8px");

    /** Level-2 layout constants (section 2.2 {@code $size.*}), logical px. */
    private static final Map<String, String> LEVEL2_SIZE = Map.of(
            "sidebar", "280px", "chart", "160px", "streamList", "240px");

    /** Level-2 motion durations (section 1), milliseconds. */
    private static final Map<String, String> LEVEL2_MOTION = Map.of(
            "instant", "0ms", "fast", "120ms", "normal", "200ms", "slow", "320ms");

    /** One emitted declaration. */
    private record Decl(String name, String value) {
    }

    /** One {@code {light, dark}} family entry, deferred to the appearance blocks. */
    private record Appearance(String name, String light, String dark) {
    }

    private TokenCss() {
    }

    // --- entry point ------------------------------------------------------

    /**
     * Emits the raw CSS of the two {@code :root} layers plus the appearance
     * and density selectors.
     *
     * @param theme   the bootstrap {@code theme} block ({@code appearance},
     *                {@code canvas}, {@code accent}, {@code colors}); missing
     *                or malformed fields fall back to the built-in seeds
     * @param tokens  the bootstrap {@code tokens} block (the eleven
     *                families); overrides merge key-by-key and unknown keys
     *                are ignored, never thrown on
     * @param density the selected control density
     *                ({@code compact}/{@code comfortable}/{@code spacious});
     *                unknown or absent degrades to {@code comfortable}
     * @return the CSS text of a {@code <style>} payload (no element wrapper)
     */
    public static String root(Map<String, Object> theme, Map<String, Object> tokens, String density) {
        Map<String, Object> themeMap = theme == null ? Map.of() : theme;
        String appearance = appearance(themeMap.get("appearance"));
        String canvas = seed(themeMap.get("canvas"), DEFAULT_CANVAS);
        String accent = seed(themeMap.get("accent"), DEFAULT_ACCENT);
        Map<String, Object> colors = themeMap.get("colors") instanceof Map<?, ?> map
                ? stringMap(map) : Map.of();

        Map<String, Map<String, Object>> families = mergeFamilies(tokens);
        List<Appearance> appearanceVars = new ArrayList<>();
        List<Decl> spaceDecls = new ArrayList<>();

        StringBuilder css = new StringBuilder();

        // Layer 1 — palette.
        css.append("/* palette */\n:root {\n");
        for (Map.Entry<String, String> entry : palette(appearance, canvas, accent, colors).entrySet()) {
            css.append("  ").append(varName(entry.getKey())).append(": ")
                    .append(safe(entry.getValue())).append(";\n");
        }
        for (Map.Entry<String, Object> entry : contrastOf(families).entrySet()) {
            css.append("  ").append(varName("contrast-" + kebab(entry.getKey()))).append(": ")
                    .append(tokenValue("color", "contrast", entry.getValue())).append(";\n");
        }
        css.append("}\n");

        // Layer 2 — alias.
        css.append("/* alias */\n:root {\n");
        for (String family : FAMILIES) {
            emitFamily(css, family, families.get(family), appearanceVars, spaceDecls, density);
        }
        emitLevel2(css, spaceDecls, density);
        css.append("}\n");

        emitAppearance(css, appearanceVars);
        emitDensity(css, spaceDecls, density);
        return css.toString();
    }

    /**
     * Resolves one wire token reference (docs/sdui.md section 2.2): a known
     * {@code $family.key} (or {@code $color.contrast.key}) becomes
     * {@code var(--family-key)} with the dot and any camelCase boundary
     * folded to hyphens, so the CSS cascade resolves the value per theme.
     * An unknown or malformed reference returns the input unchanged — the
     * literal-string degradation of section 2.4.
     *
     * @param value the prop value
     * @return the resolved {@code var(&hellip;)} or the literal value
     */
    public static String resolveReference(String value) {
        if (value == null || !value.startsWith("$")) {
            return value;
        }
        String[] parts = value.substring(1).split("\\.", -1);
        if (parts.length == 3
                && "color".equals(parts[0])
                && "contrast".equals(parts[1])
                && UiTokens.CONTRAST_KEYS.contains(parts[2])) {
            return "var(" + cssVar("color", "contrast", parts[2]) + ")";
        }
        if (parts.length == 2) {
            Set<String> keys = NAMESPACE_KEYS.get(parts[0]);
            if (keys != null && keys.contains(parts[1])) {
                return "var(" + cssVar(parts[0], parts[1]) + ")";
            }
        }
        return value;
    }

    /**
     * The CSS custom-property name of one token: {@code --family-key} with
     * camelCase folded to hyphens ({@code $motion.easeDrawer} &rarr;
     * {@code --motion-ease-drawer}). The single naming authority shared by
     * the alias layer and {@link UniversalProps}.
     *
     * @param family the token family
     * @param key    the family key
     * @return the {@code --&hellip;} variable name
     */
    public static String cssVar(String family, String key) {
        return "--" + family + "-" + kebab(key);
    }

    /**
     * The CSS custom-property name of one flattened composite entry:
     * {@code --family-key-sub} ({@code text.sm.size} &rarr;
     * {@code --text-sm-size}).
     *
     * @param family the token family
     * @param key    the family key
     * @param sub    the composite sub-key
     * @return the {@code --&hellip;} variable name
     */
    public static String cssVar(String family, String key, String sub) {
        return cssVar(family, key) + "-" + kebab(sub);
    }

    // --- palette layer ----------------------------------------------------

    /**
     * The palette map, in sorted name order: the generated colours, the
     * {@code theme.colors} overrides winning last, and the seed-derived
     * level-2 trio ({@code canvas}/{@code on-canvas}/{@code on-accent}) when
     * no override names them.
     */
    private static Map<String, String> palette(String appearance, String canvas, String accent,
            Map<String, Object> colors) {
        Map<String, String> palette = new TreeMap<>(generate(appearance, canvas, accent));
        for (Map.Entry<String, Object> entry : colors.entrySet()) {
            String name = safe(kebab(entry.getKey()));
            if (!name.isEmpty()) {
                palette.put(name, String.valueOf(entry.getValue()));
            }
        }
        palette.putIfAbsent("canvas", canvas);
        palette.putIfAbsent("on-canvas", readableOn(canvas));
        palette.putIfAbsent("on-accent", readableOn(accent));
        return palette;
    }

    /** {@link PaletteGen#generate}, degrading to the built-in seeds on any failure. */
    private static Map<String, String> generate(String appearance, String canvas, String accent) {
        try {
            return PaletteGen.generate(appearance, canvas, accent);
        } catch (RuntimeException failure) {
            return PaletteGen.generate("system", DEFAULT_CANVAS, DEFAULT_ACCENT);
        }
    }

    /** The readable on-color of a seed: black on light, white on dark (level-3 rule). */
    private static String readableOn(String hex) {
        try {
            return Oklch.relativeLuminance(Oklch.parseHex(hex)) > 0.5 ? "#000000" : "#ffffff";
        } catch (RuntimeException failure) {
            return "#ffffff";
        }
    }

    private static Map<String, Object> contrastOf(Map<String, Map<String, Object>> families) {
        Object contrast = families.get("color").get("contrast");
        return contrast instanceof Map<?, ?> map ? stringMap(map) : Map.of();
    }

    // --- alias layer ------------------------------------------------------

    /** Emits one family's alias declarations, collecting the deferred sets. */
    private static void emitFamily(StringBuilder css, String family, Map<String, Object> values,
            List<Appearance> appearanceVars, List<Decl> spaceDecls, String density) {
        for (Map.Entry<String, Object> entry : values.entrySet()) {
            String key = entry.getKey();
            Object value = entry.getValue();
            if (value instanceof Map<?, ?> map) {
                if (map.containsKey("light") && map.containsKey("dark")) {
                    appearanceVars.add(new Appearance(cssVar(family, key),
                            tokenValue(family, key, map.get("light")),
                            tokenValue(family, key, map.get("dark"))));
                    continue;
                }
                for (Map.Entry<?, ?> sub : map.entrySet()) {
                    String name = cssVar(family, key, String.valueOf(sub.getKey()));
                    emitDecl(css, family, name, tokenValue(family, key, sub.getValue()),
                            spaceDecls, density);
                }
                continue;
            }
            emitDecl(css, family, cssVar(family, key), tokenValue(family, key, value),
                    spaceDecls, density);
        }
    }

    private static void emitDecl(StringBuilder css, String family, String name, String value,
            List<Decl> spaceDecls, String density) {
        boolean spacing = "space".equals(family);
        css.append("  ").append(name).append(": ")
                .append(spacing ? scale(value, densityFactor(density)) : value).append(";\n");
        if (spacing) {
            spaceDecls.add(new Decl(name, value));
        }
    }

    /** The level-2 namespaces of section 2.2, so every known reference resolves. */
    private static void emitLevel2(StringBuilder css, List<Decl> spaceDecls, String density) {
        for (Map.Entry<String, String> entry : new TreeMap<>(LEVEL2_SPACING).entrySet()) {
            String name = cssVar("spacing", entry.getKey());
            css.append("  ").append(name).append(": ")
                    .append(scale(entry.getValue(), densityFactor(density))).append(";\n");
            spaceDecls.add(new Decl(name, entry.getValue()));
        }
        for (Map.Entry<String, String> entry : new TreeMap<>(LEVEL2_ELEVATION).entrySet()) {
            css.append("  ").append(cssVar("elevation", entry.getKey()))
                    .append(": ").append(entry.getValue()).append(";\n");
        }
        for (Map.Entry<String, String> entry : new TreeMap<>(LEVEL2_SIZE).entrySet()) {
            css.append("  ").append(cssVar("size", entry.getKey()))
                    .append(": ").append(entry.getValue()).append(";\n");
        }
        css.append("  ").append(cssVar("radius", "full")).append(": 9999px;\n");
        for (Map.Entry<String, String> entry : new TreeMap<>(LEVEL2_MOTION).entrySet()) {
            css.append("  ").append(cssVar("motion", entry.getKey()))
                    .append(": ").append(entry.getValue()).append(";\n");
        }
        for (String name : new java.util.TreeSet<>(LEVEL2_COLOR)) {
            css.append("  ").append(cssVar("color", name))
                    .append(": var(").append(varName(kebab(name))).append(");\n");
        }
    }

    // --- appearance and density blocks ------------------------------------

    private static void emitAppearance(StringBuilder css, List<Appearance> vars) {
        if (vars.isEmpty()) {
            return;
        }
        for (String side : List.of("light", "dark")) {
            css.append("@media (prefers-color-scheme: ").append(side).append(") {\n  :root {\n");
            for (Appearance entry : vars) {
                css.append("    ").append(entry.name()).append(": ")
                        .append("light".equals(side) ? entry.light() : entry.dark()).append(";\n");
            }
            css.append("  }\n}\n");
        }
        for (String side : List.of("light", "dark")) {
            css.append("[data-appearance=\"").append(side).append("\"] {\n");
            for (Appearance entry : vars) {
                css.append("  ").append(entry.name()).append(": ")
                        .append("light".equals(side) ? entry.light() : entry.dark()).append(";\n");
            }
            css.append("}\n");
        }
    }

    private static void emitDensity(StringBuilder css, List<Decl> spaceDecls, String density) {
        for (String scale : List.of("compact", "comfortable", "spacious")) {
            css.append("[data-density=\"").append(scale).append("\"] {\n");
            String factor = densityFactor(scale);
            for (Decl decl : spaceDecls) {
                css.append("  ").append(decl.name()).append(": ")
                        .append(scale(decl.value(), factor)).append(";\n");
            }
            css.append("}\n");
        }
    }

    /** A spacing value scaled by one density factor through {@code calc()}. */
    private static String scale(String value, String factor) {
        return "calc(" + value + " * " + factor + ")";
    }

    /** The spacing scale of one density; unknown names degrade to comfortable. */
    private static String densityFactor(String density) {
        if ("compact".equals(density)) {
            return "0.75";
        }
        if ("spacious".equals(density)) {
            return "1.25";
        }
        return "1";
    }

    // --- token vocabulary -------------------------------------------------

    /** Merges the bootstrap {@code tokens} block over the built-in defaults. */
    private static Map<String, Map<String, Object>> mergeFamilies(Map<String, Object> tokens) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        for (String family : FAMILIES) {
            Map<String, Object> merged = defaultsOf(family);
            Object incoming = tokens == null ? null : tokens.get(family);
            if (incoming instanceof Map<?, ?> overrides) {
                for (Map.Entry<?, ?> entry : overrides.entrySet()) {
                    String key = String.valueOf(entry.getKey());
                    if (!merged.containsKey(key)) {
                        continue;
                    }
                    if (entry.getValue() instanceof Map<?, ?> sub && merged.get(key) instanceof Map<?, ?> base) {
                        Map<String, Object> mergedSub = new LinkedHashMap<>(stringMap(base));
                        for (Map.Entry<?, ?> subEntry : sub.entrySet()) {
                            String subKey = String.valueOf(subEntry.getKey());
                            if (mergedSub.containsKey(subKey)) {
                                mergedSub.put(subKey, subEntry.getValue());
                            }
                        }
                        merged.put(key, mergedSub);
                    } else {
                        merged.put(key, entry.getValue());
                    }
                }
            }
            out.put(family, merged);
        }
        return out;
    }

    private static Map<String, Object> defaultsOf(String family) {
        Map<String, Object> base = new LinkedHashMap<>(switch (family) {
            case "color" -> UiTokens.COLOR_VALUES;
            case "radius" -> UiTokens.RADIUS_VALUES;
            case "text" -> UiTokens.TEXT_VALUES;
            case "font" -> UiTokens.FONT_VALUES;
            case "space" -> UiTokens.SPACE_VALUES;
            case "layout" -> UiTokens.LAYOUT_VALUES;
            case "glass" -> UiTokens.GLASS_VALUES;
            case "motion" -> UiTokens.MOTION_VALUES;
            case "shadow" -> UiTokens.SHADOW_VALUES;
            case "scroll" -> UiTokens.SCROLL_VALUES;
            case "z" -> UiTokens.Z_VALUES;
            default -> Map.of();
        });
        if ("color".equals(family)) {
            base.put("contrast", new LinkedHashMap<>(UiTokens.CONTRAST_VALUES));
        }
        if ("motion".equals(family)) {
            // The panel duration is configurable (the jhin.ui settings store)
            // and arrives through the tokens block; it is not part of the
            // UiTokens fallback map, so its default is declared here.
            base.put("panel", 0);
        }
        return base;
    }

    /**
     * One token value as CSS: strings are verbatim, plain numbers get their
     * unit back (the px lengths of the surface plus the {@code motion.panel}
     * milliseconds; {@code glass.saturation} and {@code z} are unitless) and
     * booleans become {@code 1}/{@code 0}. Everything is {@link #safe(String)}.
     */
    private static String tokenValue(String family, String key, Object value) {
        if (value instanceof Number number) {
            String rendered = format(number);
            if ("motion".equals(family) && "panel".equals(key)) {
                return rendered + "ms";
            }
            if ("z".equals(family) || ("glass".equals(family) && "saturation".equals(key))) {
                return rendered;
            }
            return rendered + "px";
        }
        if (value instanceof Boolean flag) {
            return flag ? "1" : "0";
        }
        return safe(String.valueOf(value));
    }

    // --- shared naming and safety ----------------------------------------

    /** The raw {@code --name} form of a (possibly dashed) variable name. */
    private static String varName(String name) {
        return "--" + name;
    }

    /** Folds camelCase to kebab-case; dashed and digit names pass through. */
    private static String kebab(String name) {
        StringBuilder out = new StringBuilder(name.length() + 8);
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (i > 0 && Character.isUpperCase(c)) {
                out.append('-');
            }
            out.append(Character.toLowerCase(c));
        }
        return out.toString();
    }

    /**
     * Replaces the CSS block/comment breakers ({@code <}, {@code ;},
     * {@code {@}, {@code }}) with CSS hex escapes, so no emitted name or
     * value can break out of its declaration — or of a surrounding
     * {@code <style>} block.
     */
    private static String safe(String value) {
        StringBuilder out = null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            String escape = switch (c) {
                case '<' -> "\\00003c";
                case ';' -> "\\00003b";
                case '{' -> "\\00007b";
                case '}' -> "\\00007d";
                default -> null;
            };
            if (escape != null) {
                if (out == null) {
                    out = new StringBuilder(value.length() + 16).append(value, 0, i);
                }
                out.append(escape);
            } else if (out != null) {
                out.append(c);
            }
        }
        return out == null ? value : out.toString();
    }

    private static Map<String, Object> stringMap(Map<?, ?> map) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            out.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return out;
    }

    private static String appearance(Object value) {
        String text = value == null ? "" : String.valueOf(value);
        return switch (text) {
            case "light", "dark", "system" -> text;
            default -> "system";
        };
    }

    private static String seed(Object value, String fallback) {
        if (value == null) {
            return fallback;
        }
        String text = String.valueOf(value);
        return text.isEmpty() ? fallback : text;
    }

    private static String format(Number value) {
        double number = value.doubleValue();
        if (number == Math.floor(number) && !Double.isInfinite(number) && Math.abs(number) < 1e15) {
            return Long.toString((long) number);
        }
        return Double.toString(number);
    }

    private static Set<String> union(Set<String> first, Set<String> second) {
        java.util.HashSet<String> out = new java.util.HashSet<>(first);
        out.addAll(second);
        return java.util.Collections.unmodifiableSet(out);
    }
}
