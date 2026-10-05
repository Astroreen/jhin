/**
 * The {@code jhin.ui} settings store: the appearance, density, motion and
 * thread-behavior values the bootstrap payload and the settings screen render
 * from, and the persistence target of the {@code save-appearance} /
 * {@code save-thread-behavior} actions.
 *
 * <p>Resolution order per key: the runtime saves of the settings screen
 * ({@code <dataDir>/settings.json}) → the {@code jhin.ui} config section
 * ({@code config.json} / {@code JHIN_UI_*} environment variables, see
 * {@link com.astroreen.jhin.sdk.ConfigView}) → the built-in default. The
 * saved document wins because a save is the most recent user intent; the
 * config section stays the operator's initial-value layer. A corrupt or
 * unparsable settings file is ignored key-by-key (the config/default layer
 * answers), so a bad write never blocks boot.
 *
 * <p>Keys, all inside one JSON object:
 * <ul>
 *   <li>{@code appearance} — {@code system}|{@code light}|{@code dark}
 *       (default {@code system}); surfaces as {@code theme.appearance} and
 *       the legacy {@code theme.mode} of the next bootstrap;</li>
 *   <li>{@code themeId} — one {@link com.astroreen.jhin.plugin.uikit.ThemeCatalog}
 *       id (default {@code t3-chat}); surfaces as {@code theme.id} of the
 *       next bootstrap. An unknown or reserved id (an appearance mode) falls
 *       back to the default. Picking a theme re-derives the {@code canvas} /
 *       {@code accent} seeds from the catalogue (T85);</li>
 *   <li>{@code canvas} — {@code #RRGGBB} or {@code #AARRGGBB}; surfaces as
 *       {@code theme.canvas}. The default is the resolved theme's seed pair
 *       for the effective appearance (the {@code t3-chat} light canvas,
 *       {@code #fdf7fd}, on a fresh install);</li>
 *   <li>{@code accent} — hex like canvas (default the {@code t3-chat} light
 *       accent, {@code #db2777}); surfaces as {@code theme.accent} and the
 *       level-1 {@code theme.seedColor};</li>
 *   <li>{@code density} — {@code compact}|{@code comfortable}|{@code
 *       spacious} (default {@code comfortable}); surfaces as the top-level
 *       {@code density} of the next bootstrap;</li>
 *   <li>{@code panelMotionMs} — 0–400 (default 0); surfaces as
 *       {@code tokens.motion.panel} of the next bootstrap;</li>
 *   <li>{@code autoSettleDefault} — boolean (default {@code true}); the
 *       thread-behavior auto-settle master switch. <b>jhin.ui-owned proxy
 *       key</b>: jhin.sessions starts every session with auto-settle enabled
 *       and exposes only the per-session flag, so this persists the user's
 *       default preference and is not a live sweep input;</li>
 *   <li>{@code inactivityDays} — 1–30 (default 3); the thread-behavior
 *       inactivity slider. <b>jhin.ui-owned proxy key</b> for
 *       {@code jhin.sessions.inactivityMs} (3 days): the sweep threshold is
 *       operator config read by jhin.sessions at startup and offers no write
 *       service, so this key persists the user preference only and does not
 *       reconfigure the sweep.</li>
 * </ul>
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.ThemeCatalog;
import com.astroreen.jhin.sdk.ConfigView;
import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

public final class UiSettings {

    /** Settings key: theme mode ({@code system}|{@code light}|{@code dark}). */
    public static final String KEY_APPEARANCE = "appearance";

    /** Settings key: the selected catalogue theme id (T85). */
    public static final String KEY_THEME_ID = "themeId";

    /** Settings key: canvas seed color (hex). */
    public static final String KEY_CANVAS = "canvas";

    /** Settings key: accent seed color (hex). */
    public static final String KEY_ACCENT = "accent";

    /** Settings key: control density. */
    public static final String KEY_DENSITY = "density";

    /** Settings key: panel-animation duration in milliseconds. */
    public static final String KEY_PANEL_MOTION_MS = "panelMotionMs";

    /** Settings key: thread-behavior auto-settle master switch. */
    public static final String KEY_AUTO_SETTLE_DEFAULT = "autoSettleDefault";

    /** Settings key: thread-behavior inactivity slider (days). */
    public static final String KEY_INACTIVITY_DAYS = "inactivityDays";

    /** Built-in default theme mode. */
    static final String DEFAULT_APPEARANCE = "system";

    /** Built-in default theme id: the t3code stock theme (T85). */
    static final String DEFAULT_THEME_ID = "t3-chat";

    /**
     * Built-in default canvas seed color: the default theme's light canvas.
     * Derived from the catalogue so the default seeds and the default
     * {@code theme.id} can never drift apart.
     */
    static final String DEFAULT_CANVAS = defaultSeed("canvas");

    /** Built-in default accent seed color: the default theme's light accent. */
    static final String DEFAULT_ACCENT = defaultSeed("accent");

    /** Built-in default control density. */
    static final String DEFAULT_DENSITY = "comfortable";

    /** Built-in default panel-animation duration (ms): instant. */
    static final int DEFAULT_PANEL_MOTION_MS = 0;

    /** Built-in default of the auto-settle master switch. */
    static final boolean DEFAULT_AUTO_SETTLE = true;

    /** Built-in default inactivity window (days): the jhin.sessions sweep default. */
    static final int DEFAULT_INACTIVITY_DAYS = 3;

    /** Inactivity slider bounds (days). */
    public static final int MIN_INACTIVITY_DAYS = 1;

    /** Inactivity slider bounds (days). */
    public static final int MAX_INACTIVITY_DAYS = 30;

    /** Panel-animation slider bounds (ms). */
    public static final int MIN_PANEL_MOTION_MS = 0;

    /** Panel-animation slider bounds (ms). */
    public static final int MAX_PANEL_MOTION_MS = 400;

    /** File name of the runtime saves inside this plugin's data directory. */
    static final String FILE_NAME = "settings.json";

    /** An empty config layer: every key resolves to the caller's default. */
    private static final ConfigView NO_CONFIG = new ConfigView() {

        @Override
        public Optional<String> get(String key) {
            return Optional.empty();
        }

        @Override
        public String get(String key, String def) {
            return def;
        }

        @Override
        public int getInt(String key, int def) {
            return def;
        }

        @Override
        public long getLong(String key, long def) {
            return def;
        }

        @Override
        public boolean getBool(String key, boolean def) {
            return def;
        }

        @Override
        public Map<String, String> all() {
            return Map.of();
        }
    };

    private final ConfigView config;
    private final Path file;

    /**
     * Opens the settings store over one data directory with no config layer
     * (built-in defaults plus the runtime saves).
     *
     * @param dataDir the plugin data directory (runtime saves)
     * @return the settings store
     */
    public static UiSettings open(Path dataDir) {
        return new UiSettings(NO_CONFIG, dataDir);
    }

    /**
     * Opens the settings store of one plugin context.
     *
     * @param config  the {@code jhin.ui} config section (initial values)
     * @param dataDir the plugin data directory (runtime saves)
     */
    public UiSettings(ConfigView config, Path dataDir) {
        this.config = config;
        this.file = dataDir.resolve(FILE_NAME);
    }

    /**
     * The effective settings of this runtime. Called per request so a save is
     * visible to the next bootstrap without a restart.
     *
     * @return the resolved snapshot
     */
    public synchronized Snapshot current() {
        Map<String, Object> saved = load();
        String appearance = enumOf(saved, KEY_APPEARANCE, DEFAULT_APPEARANCE, "system", "light", "dark");
        String themeId = themeIdOf(saved);
        return new Snapshot(
                appearance,
                themeId,
                hexOf(saved, KEY_CANVAS, defaultSeed(themeId, appearance, "canvas")),
                hexOf(saved, KEY_ACCENT, defaultSeed(themeId, appearance, "accent")),
                enumOf(saved, KEY_DENSITY, DEFAULT_DENSITY, "compact", "comfortable", "spacious"),
                intOf(saved, KEY_PANEL_MOTION_MS, DEFAULT_PANEL_MOTION_MS,
                        MIN_PANEL_MOTION_MS, MAX_PANEL_MOTION_MS),
                boolOf(saved, KEY_AUTO_SETTLE_DEFAULT, DEFAULT_AUTO_SETTLE),
                intOf(saved, KEY_INACTIVITY_DAYS, DEFAULT_INACTIVITY_DAYS,
                        MIN_INACTIVITY_DAYS, MAX_INACTIVITY_DAYS));
    }

    /**
     * Persists one appearance save. Only the named keys are written; the
     * thread-behavior keys keep their previous values. A {@code null}
     * {@code themeId} (a legacy save without the theme grid) leaves the
     * previously selected theme in place.
     *
     * @param appearance    {@code system}|{@code light}|{@code dark}
     * @param themeId       the selected catalogue theme id, {@code null} to
     *                      keep the previous selection
     * @param canvas        canvas seed color, {@code #RRGGBB}/{@code #AARRGGBB}
     * @param accent        accent seed color, {@code #RRGGBB}/{@code #AARRGGBB}
     * @param density       {@code compact}|{@code comfortable}|{@code spacious}
     * @param panelMotionMs panel-animation duration, 0–400
     */
    public synchronized void saveAppearance(String appearance, String themeId, String canvas,
                                            String accent, String density, int panelMotionMs) {
        Map<String, Object> saved = load();
        saved.put(KEY_APPEARANCE, appearance);
        if (themeId != null) {
            saved.put(KEY_THEME_ID, themeId);
        }
        saved.put(KEY_CANVAS, canvas);
        saved.put(KEY_ACCENT, accent);
        saved.put(KEY_DENSITY, density);
        saved.put(KEY_PANEL_MOTION_MS, panelMotionMs);
        store(saved);
    }

    /**
     * Persists one thread-behavior save. Only the named keys are written.
     *
     * @param autoSettleDefault the auto-settle master switch
     * @param inactivityDays    the inactivity window, 1–30 days
     */
    public synchronized void saveThreadBehavior(boolean autoSettleDefault, int inactivityDays) {
        Map<String, Object> saved = load();
        saved.put(KEY_AUTO_SETTLE_DEFAULT, autoSettleDefault);
        saved.put(KEY_INACTIVITY_DAYS, inactivityDays);
        store(saved);
    }

    /** The runtime-saved document; empty when absent or unparsable. */
    private Map<String, Object> load() {
        if (!Files.isRegularFile(file)) {
            return new LinkedHashMap<>();
        }
        try {
            String json = Files.readString(file, StandardCharsets.UTF_8);
            Map<String, Object> parsed = Json.readMap(json);
            return parsed == null ? new LinkedHashMap<>() : new LinkedHashMap<>(parsed);
        } catch (IOException | RuntimeException e) {
            return new LinkedHashMap<>();
        }
    }

    /** Writes the runtime-saved document; a failed write is swallowed (next read falls back). */
    private void store(Map<String, Object> saved) {
        try {
            Path parent = file.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            Files.writeString(file, Json.write(saved), StandardCharsets.UTF_8);
        } catch (IOException e) {
            // A failed write degrades to the config/default layer on the next read.
        }
    }

    /** One key: the saved value when present, else the config value, else the default. */
    private String stringOf(Map<String, Object> saved, String key, String def) {
        Object value = saved.get(key);
        if (value instanceof String text && !text.isBlank()) {
            return text;
        }
        return config.get(key, def);
    }

    /** One enum-typed key; an out-of-range value falls back to the default. */
    private String enumOf(Map<String, Object> saved, String key, String def, String... allowed) {
        String value = stringOf(saved, key, def);
        for (String option : allowed) {
            if (option.equals(value)) {
                return value;
            }
        }
        return def;
    }

    /** One hex color key; a non-hex value falls back to the default. */
    private String hexOf(Map<String, Object> saved, String key, String def) {
        String value = stringOf(saved, key, def);
        return isHex(value) ? value : def;
    }

    /**
     * The saved theme id when it names a catalogue theme, else the default.
     * A hand-edited settings file carrying an unknown id or an appearance
     * mode falls back instead of poisoning the bootstrap.
     */
    private String themeIdOf(Map<String, Object> saved) {
        String value = stringOf(saved, KEY_THEME_ID, DEFAULT_THEME_ID);
        return ThemeCatalog.isThemeId(value) ? value : DEFAULT_THEME_ID;
    }

    /** The default theme's seed for the given role ({@code canvas}/{@code accent}). */
    private static String defaultSeed(String role) {
        ThemeCatalog.Theme theme = ThemeCatalog.get(DEFAULT_THEME_ID);
        return "canvas".equals(role) ? theme.light().canvas() : theme.light().accent();
    }

    /**
     * The seed default of the resolved theme for the effective appearance:
     * used only when neither the saved document nor the config layer carries
     * the key, so a saved theme without seeds (a config-layer {@code themeId})
     * still answers a coherent pair. {@code system} resolves to the light
     * pair, exactly like {@link ThemeCatalog.Theme#seeds}.
     */
    private static String defaultSeed(String themeId, String appearance, String role) {
        ThemeCatalog.Seeds seeds = ThemeCatalog.get(themeId).seeds(appearance);
        return "canvas".equals(role) ? seeds.canvas() : seeds.accent();
    }

    /** One int key clamped to {@code [min, max]}; a non-numeric value falls back to the default. */
    private int intOf(Map<String, Object> saved, String key, int def, int min, int max) {
        Object value = saved.get(key);
        Integer parsed = null;
        if (value instanceof Number number) {
            parsed = number.intValue();
        } else if (value instanceof String text) {
            try {
                parsed = (int) Double.parseDouble(text.trim());
            } catch (NumberFormatException e) {
                parsed = null;
            }
        }
        if (parsed == null) {
            parsed = config.getInt(key, def);
        }
        return Math.max(min, Math.min(max, parsed));
    }

    /** One boolean key; a non-boolean value falls back to the default. */
    private boolean boolOf(Map<String, Object> saved, String key, boolean def) {
        Object value = saved.get(key);
        if (value instanceof Boolean flag) {
            return flag;
        }
        if (value instanceof String text) {
            String normalized = text.trim().toLowerCase(Locale.ROOT);
            if (normalized.equals("true") || normalized.equals("false")) {
                return Boolean.parseBoolean(normalized);
            }
        }
        return config.getBool(key, def);
    }

    /**
     * Whether one value is a {@code #RRGGBB} or {@code #AARRGGBB} color.
     *
     * @param value the candidate
     * @return {@code true} when the value is a hex color
     */
    static boolean isHex(String value) {
        return value != null
                && value.matches("^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$");
    }

    /**
     * The effective settings of one runtime, as the screens and the bootstrap
     * payload see them.
     *
     * @param appearance    {@code system}|{@code light}|{@code dark}
     * @param themeId       the selected catalogue theme id
     * @param canvas        canvas seed color
     * @param accent        accent seed color
     * @param density       {@code compact}|{@code comfortable}|{@code spacious}
     * @param panelMotionMs panel-animation duration, 0–400
     * @param autoSettleDefault the thread-behavior auto-settle master switch
     * @param inactivityDays    the thread-behavior inactivity window, 1–30
     */
    public record Snapshot(
            String appearance,
            String themeId,
            String canvas,
            String accent,
            String density,
            int panelMotionMs,
            boolean autoSettleDefault,
            int inactivityDays) {

        /** The snapshot of the built-in defaults (config layer absent). */
        public static Snapshot defaults() {
            return new Snapshot(DEFAULT_APPEARANCE, DEFAULT_THEME_ID, DEFAULT_CANVAS, DEFAULT_ACCENT,
                    DEFAULT_DENSITY, DEFAULT_PANEL_MOTION_MS, DEFAULT_AUTO_SETTLE,
                    DEFAULT_INACTIVITY_DAYS);
        }
    }

    /** The saved document as an optional view; used by the QA evidence dump. */
    Optional<Map<String, Object>> savedDocument() {
        Map<String, Object> saved = load();
        return saved.isEmpty() ? Optional.empty() : Optional.of(saved);
    }
}