/**
 * The T113 {@code usage} screen: the shell chrome, the summary, the
 * per-provider meter cards over the fixture's 30-day {@code chart_line}
 * series, the limit-source meters, the per-provider rows, the decorative
 * Add-usage-limit-source dialog and the empty-fixture empty state. Every
 * interactive node carries {@code demo: true} (plan section 14.10).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.ui.screens.UsageScreen;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class UsageScreenTest {

    @Test
    void theScreenIsAShellWithTheUsageHeader() {
        Map<String, Object> json = UsageScreen.render().toJson();

        assertThat(typesIn(json)).contains("screen", "shell");
        Map<String, Object> shell = nodesOfType(json, "shell").get(0);
        assertThat(shell).containsEntry("id", UsageScreen.SHELL_ID)
                .containsEntry("breakpoint", UsageScreen.BREAKPOINT);
        assertThat(stringsIn(json)).contains("Usage", "Jhin");
        assertThat(nodesWithId(json, "usage-page-header")).hasSize(1);
    }

    @Test
    void theSummaryShowsTheFixtureTotals() {
        Map<String, Object> json = UsageScreen.render().toJson();

        assertThat(stringsIn(json)).contains("4.0M", "69 sessions", "Last 30 days");
    }

    @Test
    void theMeterCardsCarryTheThirtyDaySeries() {
        Map<String, Object> json = UsageScreen.render().toJson();

        assertThat(nodesWithId(json, "usage-chart-codex")).hasSize(1);
        assertThat(nodesWithId(json, "usage-chart-claude")).hasSize(1);
        List<Map<String, Object>> charts = nodesOfType(json, "chart_line");
        assertThat(charts).hasSize(2);
        for (Map<String, Object> chart : charts) {
            List<Object> series = castList(chart.get("series"));
            assertThat(series).hasSize(1);
            Map<String, Object> line = castMap(series.get(0));
            assertThat(castList(line.get("values"))).hasSize(30);
        }
        assertThat(stringsIn(json)).contains("Codex", "Claude Code", "$18.75", "$11.40");
    }

    @Test
    void theLimitsCardRendersTheThreeSources() {
        Map<String, Object> json = UsageScreen.render().toJson();

        assertThat(cardTitles(json)).contains("Limits");
        for (String id : List.of("codex-weekly", "claude-5h", "claude-weekly")) {
            assertThat(nodesWithId(json, "limit-" + id)).as(id).hasSize(1);
        }
        assertThat(stringsIn(json)).contains("62% left", "88% left", "41% left",
                "3d 4h", "2h 10m", "5d 1h");
        assertThat(nodesOfType(json, "progress")).hasSize(3);
    }

    @Test
    void theProviderRowsListTheFixtureProviders() {
        Map<String, Object> json = UsageScreen.render().toJson();

        assertThat(cardTitles(json)).contains("Providers");
        assertThat(nodesWithId(json, "usage-provider-codex")).hasSize(1);
        assertThat(nodesWithId(json, "usage-provider-claude")).hasSize(1);
        assertThat(stringsIn(json)).contains("2.5M tokens \u00b7 42 sessions",
                "1.5M tokens \u00b7 27 sessions");
    }

    @Test
    void theAddSourceButtonOpensTheDialogAndIsDemoMarked() {
        Map<String, Object> json = UsageScreen.render().toJson();

        Map<String, Object> button = nodesWithId(json, UsageScreen.ADD_SOURCE_ID).get(0);
        assertThat(button).containsEntry("type", "button").containsEntry("demo", true);
        Map<String, Object> action = castMap(button.get("action"));
        assertThat(action).containsEntry("op", "dialog");
        Map<String, Object> dialog = castMap(action.get("node"));
        assertThat(dialog).containsEntry("id", UsageScreen.ADD_SOURCE_DIALOG_ID);
        assertThat(stringsIn(dialog)).contains("Add usage limit source");
    }

    @Test
    void theEmptyFixtureRendersTheEmptyStateNotABlankScreen() {
        Map<String, Object> json = UsageScreen.render(List.of(), List.of()).toJson();

        assertThat(nodesWithId(json, UsageScreen.EMPTY_ID)).hasSize(1);
        assertThat(stringsIn(json)).contains("No usage yet",
                "Connect a provider to see token usage and limits.");
        assertThat(nodesOfType(json, "chart_line")).isEmpty();
    }

    @Test
    void everyInteractiveNodeCarriesTheDemoMarker() {
        Map<String, Object> json = UsageScreen.render().toJson();

        List<Map<String, Object>> interactive = new ArrayList<>();
        walk(json, map -> {
            String type = String.valueOf(map.get("type"));
            // The dialog's Cancel is a real client dismiss, not a decorative
            // affordance, so it is the one interactive node without the marker.
            if ("button".equals(type) && "Cancel".equals(map.get("label"))) {
                return;
            }
            if ("button".equals(type) || "icon_button".equals(type) || "switch".equals(type)
                    || "segmented".equals(type) || "list_row".equals(type)
                    || "dropdown".equals(type) || "input".equals(type)) {
                interactive.add(map);
            }
        });
        assertThat(interactive).isNotEmpty();
        assertThat(interactive).allSatisfy(node ->
                assertThat(node).containsEntry("demo", true));
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

    private static java.util.Set<String> typesIn(Object fragment) {
        java.util.Set<String> types = new java.util.HashSet<>();
        walk(fragment, map -> {
            if (map.get("type") != null) {
                types.add(String.valueOf(map.get("type")));
            }
        });
        return types;
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
