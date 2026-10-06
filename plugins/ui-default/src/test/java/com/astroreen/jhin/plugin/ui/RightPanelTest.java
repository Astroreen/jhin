/**
 * T105: the right panel — the {@code tabs} strip with per-tab close buttons
 * over the {@code ThreadDetailsPanel} shell, and the panel chrome (the
 * sidebar fill, the left hairline and the {@code 17.5rem} width).
 *
 * <p>The panel is an overlay of the chat frame, gated by the header's
 * {@code chat_right_panel} {@code setState} toggle; the Details tab carries
 * the model / effort / provider and created / updated / settled rows, the
 * decorative relationship rows and the pull-request rows with the
 * {@code Link to thread} menu entries.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.plugin.ui.screens.MessageCardBuilder;
import com.astroreen.jhin.plugin.ui.screens.RightPanelBuilder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RightPanelTest {

    private static final String SESSION_ID = "s-1";

    @Test
    void thePanelIsAGatedOverlayOfTheSidebarChrome() {
        Map<String, Object> json = render();

        Map<String, Object> slot = node(json, "positioned", RightPanelBuilder.SLOT_ID);
        assertThat(slot).containsEntry("top", 0).containsEntry("right", 0)
                .containsEntry("bottom", 0)
                .containsEntry("when", ChatScreen.STATE_RIGHT_PANEL + " == true");

        Map<String, Object> panel = node(json, "container", RightPanelBuilder.PANEL_ID);
        assertThat(panel).containsEntry("direction", "column")
                .containsEntry("panelWidth", RightPanelBuilder.PANEL_WIDTH)
                .containsEntry("color", "$color.sidebar")
                .containsEntry("border", "$color.sidebar-border")
                .containsEntry("borderWidth", 1);
    }

    @Test
    void theTabStripCarriesSixClosableTabs() {
        Map<String, Object> json = render();

        Map<String, Object> tabs = node(json, "tabs", RightPanelBuilder.TABS_ID);
        assertThat(tabs).containsEntry("hasClose", true).containsEntry("demo", true);
        assertThat(castMap(tabs.get("closeAction")))
                .containsEntry("op", "setState")
                .containsEntry("id", ChatScreen.STATE_RIGHT_PANEL)
                .containsEntry("value", false);

        List<Map<String, Object>> items = itemsOf(tabs);
        assertThat(items).hasSize(6);
        assertThat(items.stream().map(item -> item.get("label")))
                .containsExactlyElementsOf(RightPanelBuilder.tabLabels());
        assertThat(items.stream().map(item -> item.get("icon")).toList())
                .containsExactly("info", "difference", "folder", "public",
                        "call_merge", "bar_chart");
    }

    @Test
    void theDetailsTabCarriesThePanelShell() {
        Map<String, Object> json = render();

        Map<String, Object> tabs = node(json, "tabs", RightPanelBuilder.TABS_ID);
        Map<String, Object> details = castMap(itemsOf(tabs).get(0).get("panel"));
        assertThat(details).containsEntry("type", "column")
                .containsEntry("id", RightPanelBuilder.DETAILS_ID);

        // The label and timing rows.
        assertThat(node(json, "row", "right-panel-model")).isNotNull();
        assertThat(node(json, "row", "right-panel-effort")).isNotNull();
        assertThat(node(json, "row", "right-panel-provider")).isNotNull();
        assertThat(node(json, "row", "right-panel-created")).isNotNull();
        assertThat(node(json, "row", "right-panel-updated")).isNotNull();
        assertThat(node(json, "row", "right-panel-settled")).isNotNull();

        // The status indicator.
        Map<String, Object> status = node(json, "badge", RightPanelBuilder.STATUS_ID);
        assertThat(status).containsEntry("label", MessageCardBuilder.STATUS_IDLE);

        // The decorative relationship rows are demo-marked.
        Map<String, Object> relationships =
                node(json, "column", RightPanelBuilder.RELATIONSHIPS_ID);
        List<Map<String, Object>> relButtons = descendantsOfType(relationships, "button");
        assertThat(relButtons).isNotEmpty();
        assertThat(relButtons).allSatisfy(button ->
                assertThat(button).containsEntry("demo", true));
    }

    @Test
    void thePullRequestRowsCarryTheLinkToThreadMenu() {
        Map<String, Object> json = render();

        Map<String, Object> prs = node(json, "column", RightPanelBuilder.PRS_ID);
        List<Map<String, Object>> menus = descendantsOfType(prs, "menu");
        assertThat(menus).hasSize(2);
        for (Map<String, Object> menu : menus) {
            assertThat(menu).containsEntry("demo", true);
            List<Map<String, Object>> items = itemsOf(menu);
            assertThat(items.stream().map(item -> item.get("label")))
                    .containsExactly("Link to thread", "Unlink from thread");
            // Every entry only toasts: the inline client composite.
            for (Map<String, Object> item : items) {
                Map<String, Object> action = castMap(item.get("action"));
                assertThat(action).containsKey("client");
            }
        }
    }

    // --- fixture and walkers ---

    private static Map<String, Object> render() {
        Session session = new Session(SESSION_ID, "acc-1", "demo", "/tmp/work",
                "Opus 4.6", "anthropic", "active", 0L, 0L, false, null, null,
                null, null, false, null, null, false);
        return ChatScreen.render(session, List.of()).toJson();
    }

    private static Map<String, Object> node(Map<String, Object> tree, String type, String id) {
        return descendantsOfType(tree, type).stream()
                .filter(found -> id.equals(found.get("id")))
                .findFirst()
                .orElseThrow(() -> new AssertionError(
                        "no " + type + " node with id " + id));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> itemsOf(Map<String, Object> node) {
        Object items = node.get("items");
        return items == null ? List.of() : (List<Map<String, Object>>) items;
    }

    private static List<Map<String, Object>> descendantsOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static void walk(Object fragment,
                             java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            seen.accept(typed);
            for (Object value : map.values()) {
                walk(value, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object value : list) {
                walk(value, seen);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
