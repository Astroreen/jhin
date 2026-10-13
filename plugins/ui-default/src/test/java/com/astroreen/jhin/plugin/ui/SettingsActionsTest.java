/**
 * T78 + T85: the settings actions and the settings-driven bootstrap. The
 * {@code save-appearance} round-trip must show up in the next bootstrap
 * ({@code theme.id/appearance/canvas/accent}, {@code density},
 * {@code tokens.motion.panel}), an invalid hex color or an unknown theme id
 * must be blocked without persisting anything, a theme save re-derives the
 * seeds from the catalogue, the thread-behavior save must persist its proxy
 * keys, and the disabled "settle on PR merged" switch must carry its tooltip.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.ui.screens.SettingsScreen;
import com.astroreen.jhin.plugin.uikit.ThemeCatalog;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SettingsActionsTest {

    /** Client declaring every capability the tailoring looks at. */
    private static final ClientInfo FULL_CAPS =
            new ClientInfo(4, "0.4.0", 5, Set.of("sse", "open_url", "secure_storage", "multi_profile"));

    private static final EventLog NO_EVENTS = new EventLog() {
        @Override
        public EventRecord append(String sessionId, EventType type, String payload) {
            throw new UnsupportedOperationException("not used by this suite");
        }

        @Override
        public List<EventRecord> list(String sessionId, long afterSeq) {
            return List.of();
        }
    };

    @TempDir
    Path tmp;

    @Test
    void appearanceSaveRoundTripsThroughTheNextBootstrap() {
        UiSettings settings = UiSettings.open(tmp);
        List<Map<String, Object>> ops = SettingsActions.saveAppearance(settings)
                .handle(request(), Map.of(
                        "appearance", "dark",
                        "canvas", "#101018",
                        "accent", "#ff0000",
                        "density", "compact",
                        "panelMotionMs", 200.0));

        assertThat(ops.stream().map(op -> op.get("op")))
                .containsExactly("toast", "reloadBootstrap");

        Map<String, Object> payload = bootstrap(settings);
        Map<String, Object> theme = castMap(payload.get("theme"));
        assertThat(theme).containsEntry("appearance", "dark");
        assertThat(theme).containsEntry("mode", "dark");
        assertThat(theme).containsEntry("canvas", "#101018");
        assertThat(theme).containsEntry("accent", "#ff0000");
        assertThat(payload).containsEntry("density", "compact");
        Map<String, Object> tokens = castMap(payload.get("tokens"));
        assertThat(castMap(tokens.get("motion"))).containsEntry("panel", 200);
    }

    @Test
    void invalidHexIsBlockedAndNotPersisted() {
        UiSettings settings = UiSettings.open(tmp);
        settings.saveAppearance("light", null, "#101018", "#00ff00", "spacious", 120);

        List<Map<String, Object>> ops = SettingsActions.saveAppearance(settings)
                .handle(request(), Map.of(
                        "appearance", "dark",
                        "canvas", "#101018",
                        "accent", "not-a-color",
                        "density", "compact",
                        "panelMotionMs", 200.0));

        assertThat(ops.stream().map(op -> op.get("op")))
                .containsExactly("patch", "toast");
        Map<String, Object> patch = castMap(ops.get(0));
        assertThat(patch).containsEntry("id", "accent");
        assertThat(patch).doesNotContainKey("props");
        assertThat(String.valueOf(patch.get("html"))).contains("#RRGGBB");
        assertThat(String.valueOf(ops.get(1))).contains("#RRGGBB");

        // Nothing was persisted: the previous save still answers.
        UiSettings.Snapshot snapshot = settings.current();
        assertThat(snapshot.appearance()).isEqualTo("light");
        assertThat(snapshot.accent()).isEqualTo("#00ff00");
        assertThat(snapshot.density()).isEqualTo("spacious");
        assertThat(snapshot.panelMotionMs()).isEqualTo(120);

        Map<String, Object> payload = bootstrap(settings);
        assertThat(castMap(payload.get("theme"))).containsEntry("appearance", "light");
    }

    @Test
    void invalidCanvasHexIsBlockedToo() {
        UiSettings settings = UiSettings.open(tmp);

        List<Map<String, Object>> ops = SettingsActions.saveAppearance(settings)
                .handle(request(), Map.of(
                        "appearance", "dark",
                        "canvas", "#12",
                        "accent", "#ff0000",
                        "density", "compact",
                        "panelMotionMs", 200.0));

        assertThat(ops.stream().map(op -> op.get("op")))
                .containsExactly("patch", "toast");
        assertThat(castMap(ops.get(0))).containsEntry("id", "canvas");
        assertThat(settings.current().appearance()).isEqualTo("system");
    }

    @Test
    void outOfRangePanelMotionIsBlocked() {
        UiSettings settings = UiSettings.open(tmp);

        List<Map<String, Object>> ops = SettingsActions.saveAppearance(settings)
                .handle(request(), Map.of(
                        "appearance", "dark",
                        "canvas", "#101018",
                        "accent", "#ff0000",
                        "density", "compact",
                        "panelMotionMs", 401.0));

        assertThat(ops.stream().map(op -> op.get("op")))
                .containsExactly("patch", "toast");
        assertThat(castMap(ops.get(0))).containsEntry("id", "panelMotionMs");
        assertThat(settings.current().panelMotionMs()).isZero();
    }

    @Test
    void threadBehaviorSaveRoundTrips() {
        UiSettings settings = UiSettings.open(tmp);

        List<Map<String, Object>> ops = SettingsActions.saveThreadBehavior(settings)
                .handle(request(), Map.of(
                        "autoSettleDefault", false,
                        "inactivityDays", 14.0));

        assertThat(ops.stream().map(op -> op.get("op")))
                .containsExactly("toast", "refresh");
        UiSettings.Snapshot snapshot = settings.current();
        assertThat(snapshot.autoSettleDefault()).isFalse();
        assertThat(snapshot.inactivityDays()).isEqualTo(14);
    }

    @Test
    void outOfRangeInactivityDaysIsBlocked() {
        UiSettings settings = UiSettings.open(tmp);

        List<Map<String, Object>> ops = SettingsActions.saveThreadBehavior(settings)
                .handle(request(), Map.of(
                        "autoSettleDefault", false,
                        "inactivityDays", 31.0));

        assertThat(ops.stream().map(op -> op.get("op")))
                .containsExactly("patch", "toast");
        assertThat(castMap(ops.get(0))).containsEntry("id", "inactivityDays");
        assertThat(settings.current().inactivityDays()).isEqualTo(3);
    }

    @Test
    void prMergedControlIsDisabledWithItsTooltip() {
        Map<String, Object> json = SettingsScreen.render(
                Optional.empty(), false, false,
                List.of(Map.of("key", "mod+enter", "command", "composer.send")),
                Map.of(), UiSettings.Snapshot.defaults()).toJson();

        Map<String, Object> toggle = nodeWithId(json, "settleOnPrMerged");
        assertThat(toggle).as("the settle-on-PR-merged switch").isNotEmpty();
        assertThat(toggle.get("type")).isEqualTo("switch");
        assertThat(toggle.get("enabled")).isEqualTo(false);
        assertThat(toggle.get("tooltip")).isEqualTo("PR linking is not enabled");
    }

    @Test
    void settingsScreenRendersTheThreeSectionsWithTheCurrentValues() {
        UiSettings settings = UiSettings.open(tmp);
        settings.saveAppearance("dark", null, "#101018", "#ff0000", "spacious", 200);
        settings.saveThreadBehavior(false, 14);

        Map<String, Object> json = SettingsScreen.render(
                Optional.empty(), false, false,
                List.of(Map.of("key", "mod+enter", "command", "composer.send")),
                Map.of(), settings.current()).toJson();

        assertThat(labelsIn(json)).contains("General", "Appearance", "Thread behavior", "Keyboard");
        // The T96 Working opt-in switch: the decorative toggle whose state
        // key the sidebar's Working section gate reads (demo-marked).
        Map<String, Object> working = nodeWithId(json, "workingSection");
        assertThat(working).containsEntry("type", "switch").containsEntry("value", true);
        assertThat(working).containsEntry("demo", true);
        assertThat(nodeWithId(json, "appearance").get("value")).isEqualTo("dark");
        assertThat(nodeWithId(json, "canvas").get("value")).isEqualTo("#101018");
        assertThat(nodeWithId(json, "accent").get("value")).isEqualTo("#ff0000");
        assertThat(nodeWithId(json, "density").get("value")).isEqualTo("spacious");
        assertThat(nodeWithId(json, "panelMotionMs").get("value")).isEqualTo(200.0);
        assertThat(nodeWithId(json, "autoSettleDefault").get("value")).isEqualTo(false);
        assertThat(nodeWithId(json, "inactivityDays").get("value")).isEqualTo(14.0);
    }

    @Test
    void appearanceSaveActionIncludesTheSixFieldIds() {
        Map<String, Object> json = SettingsScreen.render(
                Optional.empty(), false, false,
                List.of(Map.of("key", "mod+enter", "command", "composer.send")),
                Map.of(), UiSettings.Snapshot.defaults()).toJson();

        Map<String, Object> save = buttonTitled(json, "Save");
        Map<String, Object> action = castMap(save.get("action"));
        assertThat(action).containsEntry("name", "save-appearance");
        assertThat(castList(action.get("include")))
                .containsExactly("appearance", "themeId", "canvas", "accent", "density", "panelMotionMs");
    }

    // --- T85: the theme catalogue ---

    @Test
    void themeSaveReDerivesTheSeedsFromTheCatalogue() {
        UiSettings settings = UiSettings.open(tmp);

        List<Map<String, Object>> ops = SettingsActions.saveAppearance(settings)
                .handle(request(), Map.of(
                        "appearance", "light",
                        "themeId", "ocean",
                        "density", "comfortable",
                        "panelMotionMs", 0.0));

        assertThat(ops.stream().map(op -> op.get("op")))
                .containsExactly("toast", "reloadBootstrap");
        UiSettings.Snapshot snapshot = settings.current();
        assertThat(snapshot.themeId()).isEqualTo("ocean");
        ThemeCatalog.Theme ocean = ThemeCatalog.get("ocean");
        assertThat(snapshot.canvas()).isEqualTo(ocean.light().canvas());
        assertThat(snapshot.accent()).isEqualTo(ocean.light().accent());

        Map<String, Object> payload = bootstrap(settings);
        Map<String, Object> theme = castMap(payload.get("theme"));
        assertThat(theme).containsEntry("id", "ocean");
        assertThat(theme).containsEntry("accent", ocean.light().accent());
    }

    @Test
    void themeSaveUnderDarkAppearanceUsesTheDarkPair() {
        UiSettings settings = UiSettings.open(tmp);

        SettingsActions.saveAppearance(settings).handle(request(), Map.of(
                "appearance", "dark",
                "themeId", "ocean",
                "density", "comfortable",
                "panelMotionMs", 0.0));

        UiSettings.Snapshot snapshot = settings.current();
        ThemeCatalog.Theme ocean = ThemeCatalog.get("ocean");
        assertThat(snapshot.canvas()).isEqualTo(ocean.dark().canvas());
        assertThat(snapshot.accent()).isEqualTo(ocean.dark().accent());
    }

    @Test
    void themeSaveUnderSystemAppearanceResolvesToTheLightPair() {
        UiSettings settings = UiSettings.open(tmp);

        SettingsActions.saveAppearance(settings).handle(request(), Map.of(
                "appearance", "system",
                "themeId", "grove",
                "density", "comfortable",
                "panelMotionMs", 0.0));

        UiSettings.Snapshot snapshot = settings.current();
        ThemeCatalog.Theme grove = ThemeCatalog.get("grove");
        assertThat(snapshot.canvas()).isEqualTo(grove.light().canvas());
        assertThat(snapshot.accent()).isEqualTo(grove.light().accent());
    }

    @Test
    void jhinThemeReproducesThePrePlanPalette() {
        UiSettings settings = UiSettings.open(tmp);

        SettingsActions.saveAppearance(settings).handle(request(), Map.of(
                "appearance", "dark",
                "themeId", "jhin",
                "density", "comfortable",
                "panelMotionMs", 0.0));

        UiSettings.Snapshot snapshot = settings.current();
        assertThat(snapshot.canvas()).isEqualTo("#16161e");
        assertThat(snapshot.accent()).isEqualTo("#7E57C2");
    }

    @Test
    void unknownThemeIdIsBlockedAndNotPersisted() {
        UiSettings settings = UiSettings.open(tmp);
        settings.saveAppearance("light", null, "#101018", "#00ff00", "spacious", 120);

        List<Map<String, Object>> ops = SettingsActions.saveAppearance(settings)
                .handle(request(), Map.of(
                        "appearance", "light",
                        "themeId", "nope",
                        "density", "comfortable",
                        "panelMotionMs", 0.0));

        assertThat(ops.stream().map(op -> op.get("op")))
                .containsExactly("patch", "toast");
        Map<String, Object> patch = castMap(ops.get(0));
        assertThat(patch).containsEntry("id", "themeId");
        assertThat(patch).doesNotContainKey("props");
        assertThat(String.valueOf(patch.get("html"))).contains(SettingsActions.THEME_ERROR);
        assertThat(String.valueOf(ops.get(1))).contains("error");

        // Nothing was persisted: the previous save still answers.
        UiSettings.Snapshot snapshot = settings.current();
        assertThat(snapshot.themeId()).isEqualTo("t3-chat");
        assertThat(snapshot.accent()).isEqualTo("#00ff00");
    }

    @Test
    void reservedAppearanceModesAreRejectedAsThemeIds() {
        UiSettings settings = UiSettings.open(tmp);

        for (String reserved : List.of("system", "light", "dark")) {
            List<Map<String, Object>> ops = SettingsActions.saveAppearance(settings)
                    .handle(request(), Map.of(
                            "appearance", "light",
                            "themeId", reserved,
                            "density", "comfortable",
                            "panelMotionMs", 0.0));
            assertThat(ops.stream().map(op -> op.get("op")))
                    .as("themeId " + reserved)
                    .containsExactly("patch", "toast");
        }
        assertThat(settings.current().themeId()).isEqualTo("t3-chat");
    }

    @Test
    void legacySeedSaveWithoutThemeIdKeepsTheSelectedTheme() {
        UiSettings settings = UiSettings.open(tmp);
        SettingsActions.saveAppearance(settings).handle(request(), Map.of(
                "appearance", "light",
                "themeId", "ocean",
                "density", "comfortable",
                "panelMotionMs", 0.0));

        // A raw T78-style save without themeId: the seeds persist as sent,
        // the theme selection stays.
        List<Map<String, Object>> ops = SettingsActions.saveAppearance(settings)
                .handle(request(), Map.of(
                        "appearance", "dark",
                        "canvas", "#101018",
                        "accent", "#ff0000",
                        "density", "compact",
                        "panelMotionMs", 200.0));

        assertThat(ops.stream().map(op -> op.get("op")))
                .containsExactly("toast", "reloadBootstrap");
        UiSettings.Snapshot snapshot = settings.current();
        assertThat(snapshot.themeId()).isEqualTo("ocean");
        assertThat(snapshot.canvas()).isEqualTo("#101018");
        assertThat(snapshot.accent()).isEqualTo("#ff0000");
    }

    @Test
    void settingsScreenRendersTheSixThemeCards() {
        Map<String, Object> json = SettingsScreen.render(
                Optional.empty(), false, false,
                List.of(Map.of("key", "mod+enter", "command", "composer.send")),
                Map.of(), UiSettings.Snapshot.defaults()).toJson();

        for (String id : ThemeCatalog.ids()) {
            Map<String, Object> card = nodeWithId(json, "theme-" + id);
            assertThat(card).as("the " + id + " theme card").isNotEmpty();
            assertThat(card.get("type")).isEqualTo("box");
            assertThat(card.get("onTap")).isNotNull();
        }
        // The active theme's card is outlined in the primary color.
        Map<String, Object> active = nodeWithId(json, "theme-t3-chat");
        assertThat(active.get("border")).isEqualTo("$color.primary");
        // The card labels are the catalogue labels.
        assertThat(labelsIn(json)).contains("T3 Chat", "Grove", "Ocean", "Ember", "Iris", "Jhin");
        // Each card carries the light and dark preview chips.
        Map<String, Object> ocean = nodeWithId(json, "theme-ocean");
        List<String> chipLabels = new ArrayList<>();
        walk(ocean, map -> {
            if ("chip".equals(map.get("type")) && map.get("label") instanceof String label) {
                chipLabels.add(label);
            }
        });
        assertThat(chipLabels).containsExactly("Light", "Dark");
    }

    @Test
    void favoriteModelsDefaultToEmpty() {
        UiSettings settings = UiSettings.open(tmp);

        assertThat(settings.favoriteModels()).isEmpty();
    }

    @Test
    void favoriteModelsSaveRoundTripsAcrossAStoreReopen() {
        UiSettings settings = UiSettings.open(tmp);
        settings.setFavoriteModels(List.of("anthropic/claude-sonnet-4-5", "openai/gpt-4o"));

        // The saved list survives a re-open of the store.
        assertThat(UiSettings.open(tmp).favoriteModels())
                .containsExactly("anthropic/claude-sonnet-4-5", "openai/gpt-4o");

        // Toggling an entry present removes it; toggling one absent adds it.
        settings.toggleFavoriteModel("anthropic/claude-sonnet-4-5");
        settings.toggleFavoriteModel("google/gemini-2.5-pro");

        assertThat(UiSettings.open(tmp).favoriteModels())
                .containsExactly("openai/gpt-4o", "google/gemini-2.5-pro");
    }

    @Test
    void unparsableFavoriteModelsValueFallsBackToEmptyWithoutBreakingOtherKeys() throws Exception {
        // A JSON array carrying a non-string entry is unparsable for the key.
        Files.writeString(tmp.resolve(UiSettings.FILE_NAME),
                "{\"composer.favoriteModels\":[\"openai/gpt-4o\",7],\"appearance\":\"dark\"}");

        UiSettings settings = UiSettings.open(tmp);
        assertThat(settings.favoriteModels()).isEmpty();
        assertThat(settings.current().appearance()).isEqualTo("dark");

        // A value that is no array at all is ignored the same way.
        Files.writeString(tmp.resolve(UiSettings.FILE_NAME),
                "{\"composer.favoriteModels\":\"openai/gpt-4o\",\"appearance\":\"light\"}");

        assertThat(UiSettings.open(tmp).favoriteModels()).isEmpty();
        assertThat(settings.current().appearance()).isEqualTo("light");
    }

    // --- helpers ---

    /** Runs the bootstrap route over one settings store: the payload map. */
    private Map<String, Object> bootstrap(UiSettings settings) {
        ScreenRegistry registry = (account, overrides) -> Map.of();
        CapabilityTailor tailor = new CapabilityTailor(NO_EVENTS);
        BootstrapRoute route = new BootstrapRoute(registry, false, tailor, settings);
        HttpResponse response = route.handle(request());
        assertThat(response.status()).isEqualTo(200);
        return Json.readMap(new String(response.body()));
    }

    private static HttpRequest request() {
        return new FakeHttpRequest("POST", "/ui/action/save-appearance",
                Map.of("name", "save-appearance"), Map.of(), "", FULL_CAPS, Map.of());
    }

    /** The first node carrying the given {@code id}; empty map when absent. */
    private static Map<String, Object> nodeWithId(Object fragment, String id) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (id.equals(map.get("id")) && map.containsKey("type")) {
                found.add(map);
            }
        });
        return found.isEmpty() ? Map.of() : found.get(0);
    }

    /** The first button node with the given label. */
    private static Map<String, Object> buttonTitled(Object fragment, String label) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if ("button".equals(map.get("type")) && label.equals(map.get("label"))) {
                found.add(map);
            }
        });
        assertThat(found).as("a button labelled " + label).isNotEmpty();
        return found.get(0);
    }

    /** Every {@code label}, {@code title} or {@code text} string in the tree. */
    private static List<String> labelsIn(Object fragment) {
        List<String> labels = new ArrayList<>();
        walk(fragment, map -> {
            for (String key : List.of("label", "title", "text")) {
                if (map.get(key) instanceof String value) {
                    labels.add(value);
                }
            }
        });
        return labels;
    }

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            seen.accept(typed);
            for (Object nested : map.values()) {
                walk(nested, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                walk(nested, seen);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}