/**
 * The T78 settings actions of {@code POST /ui/action/{name}}:
 * {@code save-appearance} persists the Appearance card and answers with a
 * {@code reloadBootstrap} so the next bootstrap carries the new
 * {@code theme}/{@code density}/{@code tokens.motion.panel} values, and
 * {@code save-thread-behavior} persists the Thread-behavior card and answers
 * with a {@code refresh} of the settings screen.
 *
 * <p>Validation happens server-side as well as client-side (the fields carry
 * {@code pattern}/{@code errorText} for the client's zero-round-trip check):
 * an invalid hex color, an out-of-range value or an unknown {@code themeId}
 * is never persisted. The answer patches the offending input's
 * {@code errorText} (both the flat prop and the {@code decoration} map the
 * client renders from) and toasts the message, so a raw dispatch — a QA
 * curl, a stale client — still shows why nothing was saved.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.ThemeCatalog;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class SettingsActions {

    /** The hex-color validation message of the canvas/accent fields. */
    static final String HEX_ERROR = "Use #RRGGBB or #AARRGGBB";

    /** The client-side hex pattern of the canvas/accent fields. */
    static final String HEX_PATTERN = "^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$";

    /** The theme-id validation message of the theme grid (T85). */
    static final String THEME_ERROR = "Choose a theme from the catalogue";

    private SettingsActions() {
    }

    /**
     * {@code save-appearance}: validate and persist the Appearance card.
     *
     * <p>When the payload carries a {@code themeId} (T85) it must name a
     * {@link ThemeCatalog} theme — the appearance modes {@code system},
     * {@code light} and {@code dark} are reserved and rejected — and the
     * canvas/accent seeds are re-derived from the catalogue for the saved
     * appearance ({@code system} resolves to the light pair), so a raw
     * dispatch cannot desynchronize a theme from its seeds. Without a
     * {@code themeId} the save is the legacy T78 seed save: the payload's
     * hex colors are validated and persisted as-is and the selected theme
     * stays untouched.
     *
     * @param settings the settings store to persist into
     * @return the handler answering {@code [toast, reloadBootstrap]} on
     *         success or the inline error directives on a validation failure
     */
    static ActionRoute.ActionHandler saveAppearance(UiSettings settings) {
        return (HttpRequest req, Map<String, Object> payload) -> {
            String appearance = ActionSupport.text(payload, UiSettings.KEY_APPEARANCE);
            String themeId = ActionSupport.text(payload, UiSettings.KEY_THEME_ID);
            String canvas = ActionSupport.text(payload, UiSettings.KEY_CANVAS);
            String accent = ActionSupport.text(payload, UiSettings.KEY_ACCENT);
            String density = ActionSupport.text(payload, UiSettings.KEY_DENSITY);
            Number panelRaw = number(payload, UiSettings.KEY_PANEL_MOTION_MS);

            String appearanceValue =
                    appearance == null ? null : normalized(appearance, "system", "light", "dark");
            if (appearanceValue == null) {
                return invalid(UiSettings.KEY_APPEARANCE, "Choose System, Light or Dark");
            }
            String themeIdValue = null;
            String canvasValue = canvas;
            String accentValue = accent;
            if (themeId != null) {
                if (!ThemeCatalog.isThemeId(themeId)) {
                    return invalid(UiSettings.KEY_THEME_ID, THEME_ERROR);
                }
                themeIdValue = themeId;
                ThemeCatalog.Seeds seeds =
                        ThemeCatalog.get(themeId).seeds(appearanceValue);
                canvasValue = seeds.canvas();
                accentValue = seeds.accent();
            }
            if (canvasValue == null || !UiSettings.isHex(canvasValue)) {
                return invalid(UiSettings.KEY_CANVAS, HEX_ERROR);
            }
            if (accentValue == null || !UiSettings.isHex(accentValue)) {
                return invalid(UiSettings.KEY_ACCENT, HEX_ERROR);
            }
            String densityValue =
                    density == null ? null : normalized(density, "compact", "comfortable", "spacious");
            if (densityValue == null) {
                return invalid(UiSettings.KEY_DENSITY, "Choose Compact, Comfortable or Spacious");
            }
            if (panelRaw == null) {
                return invalid(UiSettings.KEY_PANEL_MOTION_MS, "Panel animations must be 0–400 ms");
            }
            int panelMotionMs = (int) Math.round(panelRaw.doubleValue());
            if (panelMotionMs < UiSettings.MIN_PANEL_MOTION_MS
                    || panelMotionMs > UiSettings.MAX_PANEL_MOTION_MS) {
                return invalid(UiSettings.KEY_PANEL_MOTION_MS, "Panel animations must be 0–400 ms");
            }

            settings.saveAppearance(appearanceValue, themeIdValue, canvasValue, accentValue,
                    densityValue, panelMotionMs);
            return List.of(
                    Directives.toast("Appearance saved", null),
                    Directives.reloadBootstrap());
        };
    }

    /**
     * {@code save-thread-behavior}: validate and persist the Thread-behavior
     * card. The disabled "settle on PR merged" switch is never read — PR
     * linking is not enabled.
     *
     * @param settings the settings store to persist into
     * @return the handler answering {@code [toast, refresh]} on success or
     *         the inline error directives on a validation failure
     */
    static ActionRoute.ActionHandler saveThreadBehavior(UiSettings settings) {
        return (HttpRequest req, Map<String, Object> payload) -> {
            Object autoRaw = payload.get(UiSettings.KEY_AUTO_SETTLE_DEFAULT);
            if (autoRaw != null && !(autoRaw instanceof Boolean)) {
                return invalid(UiSettings.KEY_AUTO_SETTLE_DEFAULT, "Auto-settle must be on or off");
            }
            boolean autoSettleDefault = autoRaw == null || (Boolean) autoRaw;
            Number daysRaw = number(payload, UiSettings.KEY_INACTIVITY_DAYS);
            if (daysRaw == null) {
                return invalid(UiSettings.KEY_INACTIVITY_DAYS,
                        "Inactivity must be " + UiSettings.MIN_INACTIVITY_DAYS + "–"
                                + UiSettings.MAX_INACTIVITY_DAYS + " days");
            }
            int inactivityDays = (int) Math.round(daysRaw.doubleValue());
            if (inactivityDays < UiSettings.MIN_INACTIVITY_DAYS
                    || inactivityDays > UiSettings.MAX_INACTIVITY_DAYS) {
                return invalid(UiSettings.KEY_INACTIVITY_DAYS,
                        "Inactivity must be " + UiSettings.MIN_INACTIVITY_DAYS + "–"
                                + UiSettings.MAX_INACTIVITY_DAYS + " days");
            }

            settings.saveThreadBehavior(autoSettleDefault, inactivityDays);
            return List.of(
                    Directives.toast("Thread behavior saved", null),
                    Directives.refresh());
        };
    }

    /**
     * The validation-failure answer: an inline {@code errorText} on the
     * offending field plus an error toast. Nothing is persisted.
     *
     * @param field   the failing input id
     * @param message the message to show
     * @return the directive list
     */
    private static List<Map<String, Object>> invalid(String field, String message) {
        Map<String, Object> decoration = new LinkedHashMap<>();
        decoration.put("errorText", message);
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("errorText", message);
        props.put("decoration", decoration);
        List<Map<String, Object>> ops = new ArrayList<>();
        ops.add(Directives.patch(field, props));
        ops.add(Directives.toast(message, "error"));
        return ops;
    }

    /** One payload field as a number; {@code null} when absent or not numeric. */
    private static Number number(Map<String, Object> payload, String key) {
        Object value = payload.get(key);
        if (value instanceof Number number) {
            return number;
        }
        if (value instanceof String text) {
            try {
                return Double.parseDouble(text.trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }

    /** The lower-cased value when it is one of {@code allowed}, else {@code null}. */
    private static String normalized(String value, String... allowed) {
        String candidate = value.trim().toLowerCase(Locale.ROOT);
        for (String option : allowed) {
            if (option.equals(candidate)) {
                return candidate;
            }
        }
        return null;
    }
}