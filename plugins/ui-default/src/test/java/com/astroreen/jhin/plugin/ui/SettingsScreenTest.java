/**
 * The T109 settings shell and its sub-routes: the shell chrome (the settings
 * nav, the breadcrumb page header), the fourteen {@code settings:*} screen
 * ids, the active-route highlight and the three pre-T109 sections on their
 * new homes. The overview keeps the three cards so the T78 contract
 * assertions on {@code /ui/screen/settings} stay green.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.ui.screens.SettingsScreen;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class SettingsScreenTest {

    private static final List<Map<String, Object>> KEYMAP = List.of(
            Map.of("key", "mod+enter", "command", "composer.send"),
            Map.of("key", "ctrl+k", "command", "palette.open"));

    @Test
    void theRouteTableHoldsTheFourteenSubRoutesOfThePlan() {
        assertThat(SettingsScreen.ROUTES).hasSize(14);
        assertThat(SettingsScreen.ROUTES).extracting(SettingsScreen.Route::id)
                .containsExactly(
                        "settings:general", "settings:appearance", "settings:keybindings",
                        "settings:providers", "settings:connections", "settings:integrations",
                        "settings:diagnostics", "settings:storage", "settings:archived",
                        "settings:projects", "settings:scheduled-tasks", "settings:source-control",
                        "settings:snap-shot", "settings:licenses");
        assertThat(SettingsScreen.ROUTES).extracting(SettingsScreen.Route::label)
                .doesNotContainNull();
        assertThat(SettingsScreen.ROUTES).extracting(SettingsScreen.Route::icon)
                .doesNotContainNull();
    }

    @Test
    void theOverviewIsAShellWhoseNavListsEverySubRoute() {
        Map<String, Object> json = overview();

        assertThat(typesIn(json)).contains("screen", "shell", "nav");
        Map<String, Object> shell = nodesOfType(json, "shell").get(0);
        assertThat(shell).containsEntry("id", SettingsScreen.SHELL_ID)
                .containsEntry("breakpoint", SettingsScreen.BREAKPOINT);
        Map<String, Object> nav = nodesOfType(json, "nav").get(0);
        assertThat(nav).containsEntry("id", SettingsScreen.NAV_ID)
                .containsEntry("kind", "sidebar")
                .containsEntry("activeId", "settings:general");
        List<Map<String, Object>> items = castList(nav.get("items")).stream()
                .map(SettingsScreenTest::castMap).toList();
        assertThat(items).hasSize(14);
        assertThat(items).extracting(item -> item.get("id"))
                .containsExactlyElementsOf(
                        SettingsScreen.ROUTES.stream().map(SettingsScreen.Route::id).toList());
        assertThat(items).extracting(item -> item.get("screen"))
                .containsExactlyElementsOf(
                        SettingsScreen.ROUTES.stream().map(SettingsScreen.Route::id).toList());
    }

    @Test
    void everySubRouteRendersAScreenWithTheActiveNavAndTheBreadcrumb() {
        for (SettingsScreen.Route route : SettingsScreen.ROUTES) {
            Map<String, Object> json = route(route.id());

            assertThat(typesIn(json)).contains("screen", "shell", "nav");
            Map<String, Object> nav = nodesOfType(json, "nav").get(0);
            assertThat(nav).containsEntry("activeId", route.id());
            assertThat(stringsIn(json)).contains("Settings", route.label());
        }
    }

    @Test
    void theThreeSectionsLiveOnTheirNewHomes() {
        Map<String, Object> appearance = route("settings:appearance");
        assertThat(cardTitles(appearance)).contains("Appearance");
        assertThat(opsIn(appearance)).contains("save-appearance");

        Map<String, Object> general = route("settings:general");
        assertThat(cardTitles(general)).contains("General", "Thread behavior");
        assertThat(opsIn(general)).contains("save-thread-behavior");

        Map<String, Object> keybindings = route("settings:keybindings");
        assertThat(cardTitles(keybindings)).contains("Keyboard");
        assertThat(opsIn(keybindings)).contains("keybind-edit", "keybind-restore");
        assertThat(labels(keybindings)).contains("Restore defaults");
    }

    @Test
    void theOverviewKeepsTheThreeCardsForTheT78Contract() {
        Map<String, Object> json = overview();

        assertThat(cardTitles(json)).contains("Appearance", "Thread behavior", "Keyboard");
        assertThat(opsIn(json)).contains("save-appearance", "save-thread-behavior", "keybind-edit");
        assertThat(nodesWithId(json, "settleOnPrMerged")).hasSize(1);
    }

    @Test
    void anUnknownSubRouteIsRejected() {
        assertThatThrownBy(() -> SettingsScreen.renderRoute(
                "settings:nope", Optional.empty(), true, false, KEYMAP, Map.of(),
                UiSettings.Snapshot.defaults()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("settings:nope");
        assertThat(SettingsScreen.route("settings:nope")).isEmpty();
    }

    private static Map<String, Object> overview() {
        return SettingsScreen.render(Optional.of("acc-1"), true, false, KEYMAP, Map.of(),
                UiSettings.Snapshot.defaults()).toJson();
    }

    private static Map<String, Object> route(String id) {
        return SettingsScreen.renderRoute(id, Optional.of("acc-1"), true, false, KEYMAP, Map.of(),
                UiSettings.Snapshot.defaults()).toJson();
    }

    // --- node walking helpers over the JSON wire shape ---

    private static List<String> cardTitles(Object fragment) {
        List<String> titles = new ArrayList<>();
        walk(fragment, map -> {
            if ("card".equals(map.get("type")) && map.get("title") != null) {
                titles.add(String.valueOf(map.get("title")));
            }
        });
        return titles;
    }

    private static List<Map<String, Object>> nodesOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static List<Map<String, Object>> nodesWithId(Object fragment, String id) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (id.equals(map.get("id"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static List<String> labels(Object fragment) {
        List<String> labels = new ArrayList<>();
        walk(fragment, map -> {
            if ("button".equals(map.get("type"))) {
                labels.add(String.valueOf(map.get("label")));
            }
        });
        return labels;
    }

    private static java.util.Set<String> typesIn(Object fragment) {
        java.util.Set<String> types = new java.util.HashSet<>();
        walk(fragment, map -> {
            if (map.get("type") != null) {
                types.add(String.valueOf(map.get("type")));
            }
        });
        return types;
    }

    private static java.util.Set<String> opsIn(Object fragment) {
        java.util.Set<String> ops = new java.util.HashSet<>();
        walk(fragment, map -> {
            if (map.get("op") != null) {
                ops.add(String.valueOf(map.get("op")));
            }
            Object action = map.get("action");
            if (action instanceof Map<?, ?> descriptor && descriptor.get("name") != null) {
                ops.add(String.valueOf(descriptor.get("name")));
            }
        });
        return ops;
    }

    private static List<String> stringsIn(Object fragment) {
        List<String> texts = new ArrayList<>();
        collectStrings(fragment, texts);
        return texts;
    }

    private static void collectStrings(Object fragment, List<String> texts) {
        if (fragment instanceof String text) {
            texts.add(text);
        } else if (fragment instanceof Map<?, ?> map) {
            for (Object value : map.values()) {
                collectStrings(value, texts);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                collectStrings(nested, texts);
            }
        }
    }

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                copy.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            seen.accept(copy);
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
