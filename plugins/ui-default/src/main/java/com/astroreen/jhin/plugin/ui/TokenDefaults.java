/**
 * The fallback layer of the bootstrap {@code tokens} block (docs/sdui.md
 * section 1): the eleven token families of the {@link UiTokens} surface with
 * their exact upstream values, so a client is fully styled even before any
 * screen is authored. Every value here is the built-in default the Flutter
 * side mirrors; the {@code motion.panel} duration is the one configurable
 * value — it comes from the {@code jhin.ui} settings store ({@code
 * panelMotionMs}, see {@link UiSettings}) and is passed in per bootstrap.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.UiTokens;
import java.util.LinkedHashMap;
import java.util.Map;

final class TokenDefaults {

    /** The panel-animation duration (ms) default: instant. */
    static final int DEFAULT_PANEL_MS = 0;

    private TokenDefaults() {
    }

    /**
     * The full {@code tokens} block: {@code color}, {@code radius},
     * {@code text}, {@code font}, {@code space}, {@code layout}, {@code
     * glass}, {@code motion}, {@code shadow}, {@code scroll} and {@code z}.
     *
     * @param panelMs the persisted {@code motion.panel} duration (0–400)
     * @return the tokens block
     */
    static Map<String, Object> tokens(int panelMs) {
        Map<String, Object> tokens = new LinkedHashMap<>();
        tokens.put("color", color());
        tokens.put("radius", copy(UiTokens.RADIUS_VALUES));
        tokens.put("text", copy(UiTokens.TEXT_VALUES));
        tokens.put("font", copy(UiTokens.FONT_VALUES));
        tokens.put("space", copy(UiTokens.SPACE_VALUES));
        tokens.put("layout", copy(UiTokens.LAYOUT_VALUES));
        tokens.put("glass", copy(UiTokens.GLASS_VALUES));
        tokens.put("motion", motion(panelMs));
        tokens.put("shadow", copy(UiTokens.SHADOW_VALUES));
        tokens.put("scroll", copy(UiTokens.SCROLL_VALUES));
        tokens.put("z", copy(UiTokens.Z_VALUES));
        return tokens;
    }

    /**
     * {@code tokens.color}: the semantic alias names plus the {@code
     * contrast} sub-map of the contrast-resolved foregrounds.
     */
    private static Map<String, Object> color() {
        Map<String, Object> color = copy(UiTokens.COLOR_VALUES);
        color.put("contrast", copy(UiTokens.CONTRAST_VALUES));
        return color;
    }

    /**
     * {@code tokens.motion}: the duty-cycled periods and the drawer curve,
     * with the persisted {@code panel} duration (ms) merged in.
     */
    private static Map<String, Object> motion(int panelMs) {
        Map<String, Object> motion = copy(UiTokens.MOTION_VALUES);
        Map<String, Object> ordered = new LinkedHashMap<>();
        ordered.put("panel", panelMs);
        ordered.putAll(motion);
        return ordered;
    }

    /** A mutable copy of one family's fallback map. */
    private static Map<String, Object> copy(Map<String, Object> values) {
        return new LinkedHashMap<>(values);
    }
}
