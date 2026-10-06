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

    private static final SettingsScreen.Facts FACTS = new SettingsScreen.Facts(
            "0.2.0", 3, "0.3.0", 4, "/home/jhin", "/home/jhin/data", "/home/jhin/plugins",
            List.of(new com.astroreen.jhin.sdk.KernelInfo.Loaded(
                    "jhin.ui", "0.2.0", "Default UI", List.of())),
            2, 1, 0, 3, 4096L);

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
    void theGeneralPanelCarriesTheUpstreamFields() {
        Map<String, Object> general = route("settings:general");

        assertThat(cardTitles(general)).contains("General", "Thread behavior", "Confirmations");
        for (String id : List.of("sendShortcut", "followUpBehavior", "autoResumeLimitedThreads",
                "snoozeLimitedThreads", "workingSection", "autoSettleRules", "autoSettleDefault",
                "inactivityDays", "settleOnPrMerged", "confirmQuit")) {
            assertThat(nodesWithId(general, id)).as(id).hasSize(1);
        }
        assertThat(opsIn(general)).contains("save-thread-behavior");
    }

    @Test
    void theGeneralPanelMarksOnlyTheDecorativeControlsDemo() {
        Map<String, Object> general = route("settings:general");

        for (String id : List.of("sendShortcut", "followUpBehavior", "autoResumeLimitedThreads",
                "snoozeLimitedThreads", "workingSection", "autoSettleRules", "confirmQuit")) {
            assertThat(nodesWithId(general, id).get(0)).as(id).containsEntry("demo", true);
        }
        for (String id : List.of("autoSettleDefault", "inactivityDays", "settleOnPrMerged")) {
            assertThat(nodesWithId(general, id).get(0)).as(id).doesNotContainKey("demo");
        }
    }

    @Test
    void theAppearancePanelCarriesTheUpstreamFields() {
        Map<String, Object> appearance = route("settings:appearance");

        assertThat(cardTitles(appearance))
                .contains("Appearance", "Interface", "Typography", "Motion");
        for (String id : List.of("appearance", "canvas", "accent", "density", "panelMotionMs",
                "contrastBoost", "chatWidth", "diffColorScheme", "fontSizeInterface",
                "fontSizePrompt", "fontSizeCode", "fontFamilySans", "fontFamilyCode",
                "fontFamilyComposer", "reducedMotionNote")) {
            assertThat(nodesWithId(appearance, id)).as(id).hasSize(1);
        }
        assertThat(nodesWithId(appearance, "theme-t3-chat")).hasSize(1);
        assertThat(opsIn(appearance)).contains("save-appearance");
    }

    @Test
    void theAppearancePanelMarksOnlyTheDecorativeControlsDemo() {
        Map<String, Object> appearance = route("settings:appearance");

        for (String id : List.of("contrastBoost", "chatWidth", "diffColorScheme",
                "fontSizeInterface", "fontSizePrompt", "fontSizeCode", "fontFamilySans",
                "fontFamilyCode", "fontFamilyComposer")) {
            assertThat(nodesWithId(appearance, id).get(0)).as(id).containsEntry("demo", true);
        }
        for (String id : List.of("appearance", "canvas", "accent", "density", "panelMotionMs")) {
            assertThat(nodesWithId(appearance, id).get(0)).as(id).doesNotContainKey("demo");
        }
    }

    @Test
    void theFoldedSectionsToggleThroughSetState() {
        Map<String, Object> general = route("settings:general");

        Map<String, Object> closed = nodesWithId(general, "section-general-toggle").get(0);
        assertThat(closed).containsEntry("when", "fold_general != true");
        assertThat(castMap(closed.get("onTap"))).containsEntry("op", "setState")
                .containsEntry("id", "fold_general").containsEntry("value", true);
        Map<String, Object> open = nodesWithId(general, "section-general-toggle-open").get(0);
        assertThat(open).containsEntry("when", "fold_general == true");
        assertThat(castMap(open.get("onTap"))).containsEntry("value", false);
        Map<String, Object> body = nodesWithId(general, "section-general-body").get(0);
        assertThat(body).containsEntry("when", "fold_general == true");
    }

    @Test
    void theSaveIncludeListsAreUnchanged() {
        Map<String, Object> general = route("settings:general");
        assertThat(actionNamed(general, "save-thread-behavior").get("include"))
                .isEqualTo(List.of("autoSettleDefault", "inactivityDays"));

        Map<String, Object> appearance = route("settings:appearance");
        assertThat(actionNamed(appearance, "save-appearance").get("include"))
                .isEqualTo(List.of("appearance", "themeId", "canvas", "accent", "density",
                        "panelMotionMs"));
    }

    @Test
    void theKeybindingsPanelRendersTheCatalogTable() {
        Map<String, Object> keybindings = route("settings:keybindings");

        assertThat(cardTitles(keybindings)).contains("Keyboard");
        assertThat(nodesOfType(keybindings, "table")).hasSize(5);
        assertThat(nodesOfType(keybindings, "kbd")).isNotEmpty();
        assertThat(opsIn(keybindings)).contains("keybind-edit", "keybind-restore");
        assertThat(labels(keybindings)).contains("Change", "Restore defaults");
        for (String id : List.of("composer.send", "composer.sendAlternate", "thread.jump9",
                "palette.open", "nav.back", "appearance.cycle", "modelPicker.toggle")) {
            assertThat(nodesWithId(keybindings, "keybind-" + id)).as(id).hasSize(1);
        }
        for (String id : List.of("composer.sendBackground", "composer.sendAndNewThread",
                "composer.cycleHost", "thread.steerQueuedMessage", "rightPanel.toggle")) {
            assertThat(nodesWithId(keybindings, "keybind-" + id)).as(id).hasSize(1);
        }
        assertThat(stringsIn(keybindings)).contains(
                "Composer: Opposite Queue or Steer Action",
                "Composer: Start in Background",
                "Composer: Send and Start New Thread",
                "Queue: Send First Queued Message as Steer",
                "Composer: Cycle Host");
    }

    @Test
    void theKeybindingsPanelMarksOnlyUpstreamAdditionsDemo() {
        Map<String, Object> keybindings = route("settings:keybindings");

        assertThat(changeButtonFor(keybindings, "composer.send")).doesNotContainKey("demo");
        assertThat(changeButtonFor(keybindings, "composer.sendBackground"))
                .containsEntry("demo", true);
        assertThat(changeButtonFor(keybindings, "thread.steerQueuedMessage"))
                .containsEntry("demo", true);
    }

    @Test
    void theKeybindingsPanelShowsTheClientOverrideChord() {
        Map<String, Object> keybindings = SettingsScreen.renderRoute(
                "settings:keybindings", Optional.of("acc-1"), true, false, KEYMAP,
                Map.of("composer.send", "mod+shift+k"), UiSettings.Snapshot.defaults(), FACTS)
                .toJson();

        assertThat(stringsIn(keybindings)).contains("mod+shift+k");
    }

    @Test
    void theDiagnosticsPanelReflectsTheHost() {
        Map<String, Object> diagnostics = route("settings:diagnostics");

        assertThat(stringsIn(diagnostics)).contains("0.2.0", "0.3.0", "/home/jhin/data",
                "jhin.ui", "Default UI");
        Map<String, Object> report = nodesWithId(diagnostics, "diagnosticsReport").get(0);
        assertThat(report).containsEntry("type", "code_block").containsEntry("copyable", true);
        assertThat(stringsIn(report)).anyMatch(text -> text.contains("kernel: 0.2.0"));
        assertThat(button(diagnostics, "Export")).containsEntry("demo", true);
    }

    @Test
    void theStoragePanelShowsCountsAndTheArchiveShortcut() {
        Map<String, Object> storage = route("settings:storage");

        assertThat(stringsIn(storage)).contains("Active", "Settled", "Snoozed", "Archived",
                "4.00 KB");
        Map<String, Object> archive = nodesWithId(storage, "openArchive").get(0);
        assertThat(castMap(archive.get("action"))).containsEntry("op", "navigate")
                .containsEntry("screen", "settings:archived");
        assertThat(button(storage, "Clear cache")).containsEntry("demo", true);
    }

    private static Map<String, Object> button(Object fragment, String label) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if ("button".equals(map.get("type")) && label.equals(map.get("label"))) {
                found.add(map);
            }
        });
        assertThat(found).as("button " + label).hasSize(1);
        return found.get(0);
    }

    /** The Change button whose keybind-edit payload names {@code command}. */
    private static Map<String, Object> changeButtonFor(Object fragment, String command) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (!"button".equals(map.get("type")) || !"Change".equals(map.get("label"))) {
                return;
            }
            Object action = map.get("action");
            if (action instanceof Map<?, ?> descriptor
                    && descriptor.get("payload") instanceof Map<?, ?> payload
                    && command.equals(payload.get("command"))) {
                found.add(map);
            }
        });
        assertThat(found).as("Change button for " + command).hasSize(1);
        return found.get(0);
    }

    @Test
    void anUnknownSubRouteIsRejected() {
        assertThatThrownBy(() -> SettingsScreen.renderRoute(
                "settings:nope", Optional.empty(), true, false, KEYMAP, Map.of(),
                UiSettings.Snapshot.defaults(), FACTS))
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
                UiSettings.Snapshot.defaults(), FACTS).toJson();
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

    /** The first action descriptor with the given {@code name}. */
    private static Map<String, Object> actionNamed(Object fragment, String name) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (name.equals(map.get("name"))) {
                found.add(map);
            }
        });
        assertThat(found).as("action " + name).isNotEmpty();
        return found.get(0);
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
