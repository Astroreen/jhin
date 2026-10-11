/**
 * The T76 thread shell (T96 tree): the sidebar section membership rules
 * (Pinned, Active, Working, Snoozed, Settled with the pinned+settled
 * priority and the expired-snooze fallback), the {@code session-row:<id>}
 * row identity and frame props, the overflow-menu action names, the
 * {@code Snooze\u2026} sheet and the Arrange toggle (Move up / Move down plus
 * the visual drag handles).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.ui.screens.SessionsScreen;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionsScreenTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private SessionLifecycleService lifecycle;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        store = services.find(SessionStore.class).orElseThrow();
        lifecycle = services.find(SessionLifecycleService.class).orElseThrow();
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void eightSeededSessionsPartitionIntoTheFiveSections() {
        long now = System.currentTimeMillis();
        seed("pin-1", patch().pinned(true).pinnedOrder(1).build());
        seed("pin-2-settled", patch().pinned(true).pinnedOrder(2)
                .settledAt(now - 5_000).settledReason("manual").build());
        seed("act-1", patch().build());
        seed("act-2", patch().sortOrder(3).build());
        seed("act-3-expired-snooze", patch().snoozedUntil(now - 1_000).build());
        seed("snoozed-1", patch().snoozedUntil(now + 3_600_000).build());
        seed("settled-1", patch().settledAt(now - 1_000).settledReason("manual").build());
        seed("settled-2", patch().settledAt(now - 500).settledReason("manual").build());

        Map<String, List<String>> sections = sectionsOf(render(false));

        assertThat(sections.get("Pinned")).hasSize(2);
        assertThat(sections.get("Active")).hasSize(3);
        assertThat(sections.get("Working")).isEmpty();
        assertThat(sections.get("Snoozed")).hasSize(1);
        assertThat(sections.get("Settled")).hasSize(2);
    }

    @Test
    void pinnedAndSettledAppearsOnlyInPinned() {
        Session both = seed("both", patch().pinned(true).pinnedOrder(1)
                .settledAt(System.currentTimeMillis()).settledReason("manual").build());

        Map<String, List<String>> sections = sectionsOf(render(false));

        assertThat(sections.get("Pinned")).containsExactly(both.id());
        assertThat(sections.get("Settled")).isEmpty();
    }

    @Test
    void expiredSnoozeFallsBackToActive() {
        Session expired = seed("expired", patch()
                .snoozedUntil(System.currentTimeMillis() - 1_000).build());

        Map<String, List<String>> sections = sectionsOf(render(false));

        assertThat(sections.get("Active")).containsExactly(expired.id());
        assertThat(sections.get("Snoozed")).isEmpty();
    }

    @Test
    void archivedSessionsAppearNowhere() {
        seed("archived", patch().archivedAt(System.currentTimeMillis()).build());

        Map<String, List<String>> sections = sectionsOf(render(false));

        assertThat(sections.values().stream().mapToInt(List::size).sum()).isZero();
    }

    @Test
    void emptySectionsStillShowTheirLabels() {
        seed("only", patch().build());

        Map<String, Object> json = render(false);

        assertThat(labelsOf(json)).containsExactly(
                "Pinned", "Active", "Working", "Snoozed", "Settled");
    }

    @Test
    void wholeEmptySidebarCarriesTheEmptyState() {
        Map<String, Object> empty = render(false);
        assertThat(stringsIn(empty)).contains("No threads yet.");

        seed("only", patch().build());
        assertThat(stringsIn(render(false))).doesNotContain("No threads yet.");
    }

    @Test
    void settledAndSnoozedShelvesAreCollapsibleAndCollapsedByDefault() {
        Map<String, Object> json = render(false);

        assertThat(sectionOf(json, "Settled"))
                .containsEntry("collapsible", true).containsEntry("collapsed", true);
        assertThat(sectionOf(json, "Snoozed"))
                .containsEntry("collapsible", true).containsEntry("collapsed", true);
        assertThat(sectionOf(json, "Active")).containsEntry("collapsed", false);
        assertThat(sectionOf(json, "Working")).containsEntry("collapsed", false);
    }

    @Test
    void rowsCarryTheSessionRowIdsAndTheFrameProps() {
        Session session = seed("demo", patch().build());

        Map<String, Object> row = rowOf(render(false), session.id());

        assertThat(row).containsEntry("id", "session-row:" + session.id())
                .containsEntry("type", "list_row")
                .containsEntry("workdir", "/tmp/demo")
                .containsEntry("status", "active")
                .containsEntry("pinned", false)
                .containsKey("pinnedOrder")
                .containsKey("settledAt")
                .containsKey("snoozedUntil")
                .containsKey("archivedAt")
                .containsKey("settledReason")
                .containsKey("sortOrder");
        // The T97 row anatomy: the title slot is the T98 hover preview card
        // over the semibold truncated text node.
        Map<String, Object> card = castMap(row.get("title"));
        assertThat(card).containsEntry("type", "hover_card");
        assertThat(castMap(card.get("trigger"))).containsEntry("type", "text")
                .containsEntry("text", "demo")
                .containsEntry("fontSize", 14)
                .containsEntry("fontWeight", 600);
    }

    @Test
    void menuItemsDispatchTheLifecycleActionNames() {
        Session pinned = seed("pinned", patch().pinned(true).build());
        Session settled = seed("settled", patch()
                .settledAt(System.currentTimeMillis()).settledReason("manual").build());

        List<String> pinnedNames = menuActionNamesOf(rowOf(render(false), pinned.id()));
        List<String> settledNames = menuActionNamesOf(rowOf(render(false), settled.id()));

        // The submenu parents (Snooze, Auto-settle behavior) carry no direct
        // action — their children dispatch.
        assertThat(pinnedNames).containsExactly(
                "unpin", "settle", "regenerate-title", "archive", "delete-session");
        assertThat(settledNames).containsExactly(
                "pin", "unsettle", "regenerate-title", "archive", "delete-session");
    }

    @Test
    void destructiveMenuItemsCarryConfirmPrompts() {
        Session session = seed("demo", patch().build());

        List<Map<String, Object>> items = menuItemsOf(rowOf(render(false), session.id()));

        assertThat(items).filteredOn(item -> "Delete".equals(item.get("label")))
                .allSatisfy(item -> assertThat(item).containsEntry("danger", true));
        assertThat(items).filteredOn(item -> item.containsKey("confirm"))
                .extracting(item -> item.get("label"))
                .containsExactly("Archive thread", "Delete");
    }

    @Test
    void arrangeToggleAddsMoveUpDownAndVisualHandles() {
        Session session = seed("demo", patch().build());

        Map<String, Object> plain = rowOf(render(false), session.id());
        Map<String, Object> arranged = rowOf(render(true), session.id());

        assertThat(plain).containsEntry("dragHandle", false);
        assertThat(menuActionNamesOf(plain))
                .doesNotContain("reorder")
                .contains("delete-session");
        assertThat(arranged).containsEntry("dragHandle", true);
        assertThat(menuLabelsOf(arranged)).contains("Move up", "Move down");
    }

    @Test
    void moveUpDownDispatchReorderWithThePostMoveOrder() {
        Session first = seed("first", patch().sortOrder(1).build());
        Session second = seed("second", patch().sortOrder(2).build());

        Map<String, Object> row = rowOf(render(true), second.id());
        Map<String, Object> moveUp = menuItemsOf(row).stream()
                .filter(item -> "Move up".equals(item.get("label")))
                .findFirst()
                .orElseThrow();
        Map<String, Object> action = castMap(moveUp.get("action"));

        assertThat(action).containsEntry("name", "reorder")
                .containsEntry("path", "/ui/action/reorder");
        assertThat(castMap(action.get("payload")).get("ids"))
                .isEqualTo(List.of(second.id(), first.id()));
    }

    @Test
    void arrangeToggleActionRendersTheFlippedShell() {
        seed("demo", patch().build());

        List<Map<String, Object>> ops = SessionActions.arrangeToggle(store, () -> false)
                .handle(request(), Map.of("arrange", true));

        assertThat(ops).hasSize(1);
        Map<String, Object> directive = ops.get(0);
        assertThat(directive).containsEntry("op", "setScreen")
                .containsEntry("id", "sessions");
        assertThat(directive).doesNotContainKey("node");
        assertThat(String.valueOf(directive.get("html"))).contains("Done arranging");
    }

    @Test
    void snoozeActionWithoutDurationOpensTheSheet() {
        Session session = seed("demo", patch().build());

        List<Map<String, Object>> ops = SessionActions.snooze(lifecycle)
                .handle(request(), Map.of("id", session.id()));

        assertThat(ops).hasSize(1);
        Map<String, Object> directive = ops.get(0);
        assertThat(directive).containsEntry("op", "dialog").containsEntry("kind", "sheet");
        assertThat(directive).doesNotContainKey("node");
        String html = String.valueOf(directive.get("html"));
        assertThat(html).contains("15 minutes", "1 hour", "4 hours",
                "Tomorrow", "Next week");
        assertThat(html.split("data-jhin-type=\"button\"", -1)).hasSize(7);
        assertThat(html).contains("snooze").contains(session.id()).contains("900000");
    }

    private static FakeHttpRequest request() {
        return new FakeHttpRequest("POST", "/ui/action/test", Map.of(), Map.of(), "");
    }

    // --- seeding ---

    private Session seed(String title, SessionStore.Patch patch) {
        Session created = store.create(title, "/tmp/" + title);
        return store.patch(created.id(), patch);
    }

    private static PatchBuilder patch() {
        return new PatchBuilder();
    }

    /** Builds the full {@link SessionStore.Patch} with only the set fields. */
    private static final class PatchBuilder {
        private Boolean pinned;
        private Integer pinnedOrder;
        private Long settledAt;
        private Long snoozedUntil;
        private Long archivedAt;
        private Integer sortOrder;
        private String settledReason;

        PatchBuilder pinned(boolean value) {
            this.pinned = value;
            return this;
        }

        PatchBuilder pinnedOrder(int value) {
            this.pinnedOrder = value;
            return this;
        }

        PatchBuilder settledAt(long value) {
            this.settledAt = value;
            return this;
        }

        PatchBuilder snoozedUntil(long value) {
            this.snoozedUntil = value;
            return this;
        }

        PatchBuilder archivedAt(long value) {
            this.archivedAt = value;
            return this;
        }

        PatchBuilder sortOrder(int value) {
            this.sortOrder = value;
            return this;
        }

        PatchBuilder settledReason(String value) {
            this.settledReason = value;
            return this;
        }

        SessionStore.Patch build() {
            return new SessionStore.Patch(null, null, null, null, null,
                    pinned, pinnedOrder, settledAt, snoozedUntil, archivedAt,
                    null, sortOrder, settledReason, null);
        }
    }

    // --- node walking helpers over the JSON wire shape ---

    private Map<String, Object> render(boolean arrange) {
        return SessionsScreen.render(store, Optional.empty(), false, arrange).toJson();
    }

    /** The section label to its row session ids, in render order. */
    private static Map<String, List<String>> sectionsOf(Map<String, Object> screen) {
        Map<String, List<String>> sections = new LinkedHashMap<>();
        for (Map<String, Object> section : sectionNodesOf(screen)) {
            List<String> ids = new ArrayList<>();
            for (Map<String, Object> row : nodesOfType(section.get("items"), "list_row")) {
                // Since T99 a row's menu may embed the arrange sheet, whose
                // decorative handle rows are list_rows without the
                // session-row identity — only session rows count.
                String id = String.valueOf(row.get("id"));
                if (id.startsWith("session-row:")) {
                    ids.add(id.substring("session-row:".length()));
                }
            }
            sections.put(String.valueOf(section.get("label")), ids);
        }
        return sections;
    }

    private static List<String> labelsOf(Map<String, Object> screen) {
        return sectionNodesOf(screen).stream()
                .map(section -> String.valueOf(section.get("label")))
                .toList();
    }

    private static Map<String, Object> sectionOf(Map<String, Object> screen, String label) {
        return sectionNodesOf(screen).stream()
                .filter(section -> label.equals(section.get("label")))
                .findFirst()
                .orElseThrow();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> sectionNodesOf(Map<String, Object> screen) {
        Map<String, Object> shell = nodesOfType(screen, "shell").get(0);
        Map<String, Object> split = castMap(shell.get("body"));
        Map<String, Object> sidebar = castMap(split.get("first"));
        return (List<Map<String, Object>>) (List<?>) castList(sidebar.get("sections"));
    }

    private static Map<String, Object> rowOf(Map<String, Object> screen, String sessionId) {
        return nodesOfType(screen, "list_row").stream()
                .filter(row -> ("session-row:" + sessionId).equals(row.get("id")))
                .findFirst()
                .orElseThrow();
    }

    private static List<Map<String, Object>> menuItemsOf(Map<String, Object> row) {
        Map<String, Object> menu = nodesOfType(row, "menu").get(0);
        return castList(menu.get("items")).stream()
                .map(SessionsScreenTest::castMap)
                .toList();
    }

    private static List<String> menuLabelsOf(Map<String, Object> row) {
        return menuItemsOf(row).stream().map(item -> String.valueOf(item.get("label"))).toList();
    }

    private static List<String> menuActionNamesOf(Map<String, Object> row) {
        List<String> names = new ArrayList<>();
        for (Map<String, Object> item : menuItemsOf(row)) {
            Map<String, Object> action = castMap(item.get("action"));
            // Since T99 the menu also carries directive entries (the
            // Arrange threads sheet) with no action name — they dispatch
            // no lifecycle action.
            if (action != null && action.containsKey("name")) {
                names.add(String.valueOf(action.get("name")));
            }
        }
        return names;
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
            for (Object value : list) {
                collectStrings(value, texts);
            }
        }
    }

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> seen) {
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

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}