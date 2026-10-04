/**
 * Built-in design-token defaults of the level-2 bootstrap {@code tokens}
 * block (docs/sdui.md section 1). Every value here mirrors the client's own
 * built-in default exactly, so a level-2 client is fully styled even before
 * any screen is authored; the {@code motion.panel} duration is the one
 * configurable value — it comes from the {@code jhin.ui} settings store
 * ({@code panelMotionMs}, see {@link UiSettings}) and is passed in per
 * bootstrap.
 */
package com.astroreen.jhin.plugin.ui;

import java.util.LinkedHashMap;
import java.util.Map;

final class TokenDefaults {

    /** The panel-animation duration (ms) default: instant. */
    static final int DEFAULT_PANEL_MS = 0;

    private TokenDefaults() {
    }

    /**
     * The full {@code tokens} block: {@code spacing/radius/typography/elevation/motion}.
     *
     * @param panelMs the persisted {@code motion.panel} duration (0–400)
     * @return the tokens block
     */
    static Map<String, Object> tokens(int panelMs) {
        Map<String, Object> tokens = new LinkedHashMap<>();
        tokens.put("spacing", spacing());
        tokens.put("radius", radius());
        tokens.put("typography", typography());
        tokens.put("elevation", elevation());
        tokens.put("motion", motion(panelMs));
        return tokens;
    }

    /** {@code tokens.spacing}: the logical-px spacing scale. */
    private static Map<String, Object> spacing() {
        Map<String, Object> spacing = new LinkedHashMap<>();
        spacing.put("xs", 4);
        spacing.put("sm", 8);
        spacing.put("md", 12);
        spacing.put("lg", 16);
        spacing.put("xl", 24);
        spacing.put("xxl", 32);
        return spacing;
    }

    /** {@code tokens.radius}: the corner-radius scale. */
    private static Map<String, Object> radius() {
        Map<String, Object> radius = new LinkedHashMap<>();
        radius.put("sm", 6);
        radius.put("md", 10);
        radius.put("lg", 14);
        radius.put("full", 9999);
        return radius;
    }

    /** {@code tokens.typography}: the six named text styles. */
    private static Map<String, Object> typography() {
        Map<String, Object> typography = new LinkedHashMap<>();
        typography.put("h1", textStyle(28, 1.25, 700, null));
        typography.put("h2", textStyle(22, 1.30, 700, null));
        typography.put("h3", textStyle(18, 1.35, 600, null));
        typography.put("body", textStyle(14, 1.50, 400, null));
        typography.put("small", textStyle(12, 1.45, 400, null));
        typography.put("mono", textStyle(13, 1.55, 400, "monospace"));
        return typography;
    }

    /** One {@code typography.*} entry: {@code size/height/weight} and an optional {@code font}. */
    private static Map<String, Object> textStyle(int size, double height, int weight, String font) {
        Map<String, Object> style = new LinkedHashMap<>();
        style.put("size", size);
        style.put("height", height);
        style.put("weight", weight);
        if (font != null) {
            style.put("font", font);
        }
        return style;
    }

    /** {@code tokens.elevation}: the shadow-depth scale. */
    private static Map<String, Object> elevation() {
        Map<String, Object> elevation = new LinkedHashMap<>();
        elevation.put("none", 0);
        elevation.put("sm", 1);
        elevation.put("md", 4);
        elevation.put("lg", 8);
        return elevation;
    }

    /** {@code tokens.motion}: the duration scale, {@code panel} configurable. */
    private static Map<String, Object> motion(int panelMs) {
        Map<String, Object> motion = new LinkedHashMap<>();
        motion.put("instant", 0);
        motion.put("fast", 120);
        motion.put("normal", 200);
        motion.put("slow", 320);
        motion.put("panel", panelMs);
        return motion;
    }
}
