/**
 * Token-reference value helpers for the builder: every helper emits the
 * {@code $token} wire string of docs/sdui.md section 2.2 — resolution happens
 * client-side only, the server never expands tokens (plan section 9). The
 * namespaces mirror the bootstrap {@code tokens} block plus {@code color},
 * {@code size} and {@code font}.
 */
package com.astroreen.jhin.plugin.uikit;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class UiTokens {

    private UiTokens() {
    }

    /** {@code $spacing.*} — the spacing scale (logical px). */
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

    /** {@code $color.*} — the theme palette names. */
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

    /** {@code $radius.*} — the corner-radius scale. */
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

    /** {@code $motion.*} — the motion durations (ms). */
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

    /** {@code $elevation.*} — the elevation scale. */
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

    /** {@code $size.*} — the layout constants. */
    public static final class size {

        private size() {
        }

        /** {@code $size.sidebar} */
        public static String sidebar() {
            return "$size.sidebar";
        }
    }

    /** {@code $font.*} — the font families. */
    public static final class font {

        private font() {
        }

        /** {@code $font.mono} */
        public static String mono() {
            return "$font.mono";
        }
    }

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

    /**
     * A {@code borderRadius} token reference.
     *
     * @param token the {@code $radius} token
     * @return the token unchanged
     */
    public static String radius(String token) {
        return token;
    }
}
