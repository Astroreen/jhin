/**
 * The T113 {@code pull-requests} screen: the shell chrome, the pull-request
 * list (number, title, branch chip, status badge), the detail card (the
 * summary header, the Summary / Timeline / Code tabs over the decorative
 * {@code diff_view}, the Link-to-thread menu and the Unlink action) and the
 * empty-fixture empty state. Every interactive node carries {@code demo:
 * true} (plan section 14.10).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.ui.screens.PullRequestsScreen;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PullRequestsScreenTest {

    @Test
    void theScreenIsAShellWithThePullRequestsHeader() {
        Map<String, Object> json = PullRequestsScreen.render().toJson();

        assertThat(typesIn(json)).contains("screen", "shell");
        Map<String, Object> shell = nodesOfType(json, "shell").get(0);
        assertThat(shell).containsEntry("id", PullRequestsScreen.SHELL_ID)
                .containsEntry("breakpoint", PullRequestsScreen.BREAKPOINT);
        assertThat(stringsIn(json)).contains("Pull Requests", "Jhin");
        assertThat(nodesWithId(json, "pull-requests-page-header")).hasSize(1);
    }

    @Test
    void theListRendersTheFourFixturePullRequests() {
        Map<String, Object> json = PullRequestsScreen.render().toJson();

        assertThat(cardTitles(json)).contains("Pull Requests");
        for (int number : List.of(482, 479, 471, 468)) {
            assertThat(nodesWithId(json, "pull-request-" + number)).as("pr " + number).hasSize(1);
        }
        assertThat(stringsIn(json)).contains(
                "#482 Add usage meter to the settings panel",
                "#479 Draft: pull request detail shell",
                "#471 Cache the bootstrap payload",
                "#468 Drop the legacy v1 backend");
    }

    @Test
    void theRowsCarryTheBranchChipAndTheStatusBadge() {
        Map<String, Object> json = PullRequestsScreen.render().toJson();

        assertThat(stringsIn(json)).contains("feat/usage-meter", "feat/pr-detail",
                "perf/bootstrap-cache", "chore/drop-v1", "\u2192 main");
        assertThat(stringsIn(json)).contains("Open", "Draft", "Merged", "Closed");
        assertThat(nodesOfType(json, "chip")).isNotEmpty();
        assertThat(nodesOfType(json, "badge")).isNotEmpty();
    }

    @Test
    void theDetailCardCarriesTheSummaryTabsAndDiff() {
        Map<String, Object> json = PullRequestsScreen.render().toJson();

        assertThat(nodesWithId(json, PullRequestsScreen.DETAIL_ID)).hasSize(1);
        assertThat(nodesWithId(json, PullRequestsScreen.DETAIL_TABS_ID)).hasSize(1);
        assertThat(stringsIn(json)).contains("Summary", "Timeline", "Code");
        assertThat(nodesWithId(json, "pull-request-summary-panel")).hasSize(1);
        assertThat(nodesWithId(json, "pull-request-diff")).hasSize(1);
        Map<String, Object> diff = nodesWithId(json, "pull-request-diff").get(0);
        assertThat(diff).containsEntry("type", "diff_view").containsEntry("demo", true);
        assertThat(castList(diff.get("hunks"))).hasSize(2);
    }

    @Test
    void theDetailCarriesTheLinkMenuAndTheUnlinkAction() {
        Map<String, Object> json = PullRequestsScreen.render().toJson();

        assertThat(nodesWithId(json, PullRequestsScreen.LINK_MENU_ID)).hasSize(1);
        assertThat(stringsIn(json)).contains("Link to thread", "Link to this thread",
                "Unlink from this thread", "Unlink");
        Map<String, Object> menu = nodesWithId(json, PullRequestsScreen.LINK_MENU_ID).get(0);
        assertThat(menu).containsEntry("demo", true);
    }

    @Test
    void theEmptyFixtureRendersTheEmptyStateNotABlankScreen() {
        Map<String, Object> json = PullRequestsScreen.render(List.of()).toJson();

        assertThat(nodesWithId(json, PullRequestsScreen.EMPTY_ID)).hasSize(1);
        assertThat(stringsIn(json)).contains("No pull requests",
                "Pull requests from every project in this workspace appear here.");
        assertThat(nodesWithId(json, PullRequestsScreen.DETAIL_ID)).isEmpty();
    }

    @Test
    void everyInteractiveNodeCarriesTheDemoMarker() {
        Map<String, Object> json = PullRequestsScreen.render().toJson();

        List<Map<String, Object>> interactive = new ArrayList<>();
        walk(json, map -> {
            String type = String.valueOf(map.get("type"));
            if ("button".equals(type) || "icon_button".equals(type) || "switch".equals(type)
                    || "segmented".equals(type) || "list_row".equals(type)
                    || "tabs".equals(type) || "menu".equals(type)) {
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
