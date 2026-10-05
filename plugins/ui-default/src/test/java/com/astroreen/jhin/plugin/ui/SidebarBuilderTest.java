/**
 * The T96 sidebar container: the resizable {@code split} (the persisted
 * {@code chat_thread_sidebar_width} metrics), the five collapsible sections
 * in render order with their default collapse flags, the section chrome
 * contract (uppercase header, count badge, store key, the Working opt-in
 * gate) and the section membership rules (the Working shelf, the Active
 * recency order, the collapsed Snoozed/Settled shelves, the empty-section
 * headers).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.screens.SidebarBuilder;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class SidebarBuilderTest {

    private static final long NOW = 1_000_000L;

    @Test
    void sidebarIsTheResizableSplitWithTheUpstreamMetrics() {
        Map<String, Object> split = SidebarBuilder.build(List.of(), NOW, false).toJson();

        assertThat(split).containsEntry("type", "split")
                .containsEntry("id", "sidebar-split")
                .containsEntry("persistKey", "chat_thread_sidebar_width")
                .containsEntry("initial", 256)
                .containsEntry("min", 208)
                .containsEntry("minSecond", 640);
        assertThat(castMap(split.get("first"))).containsEntry("type", "list");
        assertThat(castMap(split.get("second"))).containsEntry("type", "card");
        assertThat(stringsIn(split.get("second"))).contains("Select a thread");
    }

    @Test
    void treeHasExactlyFiveSectionsInOrder() {
        List<Map<String, Object>> sections = sectionsOf(SidebarBuilder.build(List.of(), NOW, false));

        assertThat(sections).hasSize(5);
        assertThat(labelsOf(sections)).containsExactly(
                "Pinned", "Active", "Working", "Snoozed", "Settled");
        assertThat(idsOf(sections)).containsExactly(
                "section-pinned", "section-active", "section-working",
                "section-snoozed", "section-settled");
    }

    @Test
    void defaultCollapseFlagsArePinnedActiveWorkingExpandedSnoozedSettledCollapsed() {
        List<Map<String, Object>> sections = sectionsOf(SidebarBuilder.build(List.of(), NOW, false));

        for (Map<String, Object> section : sections) {
            assertThat(section).containsEntry("collapsible", true);
        }
        assertThat(sectionOf(sections, "Pinned")).containsEntry("collapsed", false);
        assertThat(sectionOf(sections, "Active")).containsEntry("collapsed", false);
        assertThat(sectionOf(sections, "Working")).containsEntry("collapsed", false);
        assertThat(sectionOf(sections, "Snoozed")).containsEntry("collapsed", true);
        assertThat(sectionOf(sections, "Settled")).containsEntry("collapsed", true);
    }

    @Test
    void sectionsCarryTheChromeContract() {
        List<Session> sessions = List.of(
                session("a", NOW - 100),
                session("b", NOW - 50));
        List<Map<String, Object>> sections =
                sectionsOf(SidebarBuilder.build(sessions, NOW, false));

        for (Map<String, Object> section : sections) {
            String name = String.valueOf(section.get("id")).substring("section-".length());
            assertThat(section).containsEntry("uppercase", true)
                    .containsEntry("badgeStyle", "sidebar-control-surface")
                    .containsEntry("storeKey", "sidebar.section." + name + ".collapsed");
        }
        assertThat(sectionOf(sections, "Active")).containsEntry("count", 2);
        assertThat(sectionOf(sections, "Working")).containsEntry("count", 0);
    }

    @Test
    void workingSectionCarriesTheOptInGateAndNoOtherSectionDoes() {
        List<Map<String, Object>> sections = sectionsOf(SidebarBuilder.build(List.of(), NOW, false));

        assertThat(sectionOf(sections, "Working")).containsEntry("when", "workingSection != false");
        for (String label : List.of("Pinned", "Active", "Snoozed", "Settled")) {
            assertThat(sectionOf(sections, label)).doesNotContainKey("when");
        }
    }

    @Test
    void workingAndMonitoringStatusesLandInTheWorkingShelf() {
        Session working = session("working", NOW - 100, "working");
        Session monitoring = session("monitoring", NOW - 90, "monitoring");
        Session idle = session("idle", NOW - 80, "active");

        Map<String, List<String>> sections =
                partitionOf(SidebarBuilder.build(List.of(working, monitoring, idle), NOW, false));

        assertThat(sections.get("Working")).containsExactly(monitoring.id(), working.id());
        assertThat(sections.get("Active")).containsExactly(idle.id());
    }

    @Test
    void pinnedAndSettledSessionsStayOutOfTheWorkingShelf() {
        Session pinnedWorking = session("pw", NOW - 100, "working",
                patch().pinned(true).pinnedOrder(1));
        Session settledWorking = session("sw", NOW - 90, "working",
                patch().settledAt(NOW - 10));
        Session snoozedWorking = session("zw", NOW - 80, "working",
                patch().snoozedUntil(NOW + 60_000));

        Map<String, List<String>> sections = partitionOf(SidebarBuilder.build(
                List.of(pinnedWorking, settledWorking, snoozedWorking), NOW, false));

        assertThat(sections.get("Pinned")).containsExactly(pinnedWorking.id());
        assertThat(sections.get("Settled")).containsExactly(settledWorking.id());
        assertThat(sections.get("Snoozed")).containsExactly(snoozedWorking.id());
        assertThat(sections.get("Working")).isEmpty();
    }

    @Test
    void activeIsOrderedByTheArrangedOrderThenRecency() {
        Session arrangedSecond = session("arranged-2", NOW - 300,
                patch().sortOrder(2));
        Session arrangedFirst = session("arranged-1", NOW - 400,
                patch().sortOrder(1));
        Session recent = session("recent", NOW - 10);
        Session older = session("older", NOW - 200);

        Map<String, List<String>> sections = partitionOf(SidebarBuilder.build(
                List.of(arrangedSecond, older, arrangedFirst, recent), NOW, false));

        // The arranged head keeps the manual order; the unordered tail is
        // recency-ordered (updatedAt DESC).
        assertThat(sections.get("Active")).containsExactly(
                arrangedFirst.id(), arrangedSecond.id(), recent.id(), older.id());
    }

    @Test
    void snoozedSessionNeverAppearsUnderActive() {
        Session snoozed = session("snoozed", NOW - 100, patch().snoozedUntil(NOW + 3_600_000));
        Session expired = session("expired", NOW - 90, patch().snoozedUntil(NOW - 1));

        Map<String, List<String>> sections =
                partitionOf(SidebarBuilder.build(List.of(snoozed, expired), NOW, false));

        assertThat(sections.get("Snoozed")).containsExactly(snoozed.id());
        assertThat(sections.get("Active")).containsExactly(expired.id());
    }

    @Test
    void settledShelfIsOrderedBySettlementTimeAndStartsCollapsed() {
        Session older = session("settled-old", NOW - 500, patch().settledAt(NOW - 2_000));
        Session newer = session("settled-new", NOW - 400, patch().settledAt(NOW - 1_000));

        UiNode json = SidebarBuilder.build(List.of(older, newer), NOW, false);
        Map<String, List<String>> sections = partitionOf(json);

        assertThat(sections.get("Settled")).containsExactly(newer.id(), older.id());
        assertThat(sectionOf(sectionsOf(json), "Settled")).containsEntry("collapsed", true);
    }

    @Test
    void emptySectionsStillRenderTheirHeadersAndTheEmptyStateShows() {
        UiNode json = SidebarBuilder.build(List.of(), NOW, false);

        assertThat(labelsOf(sectionsOf(json))).containsExactly(
                "Pinned", "Active", "Working", "Snoozed", "Settled");
        assertThat(stringsIn(json.toJson())).contains("No threads yet.");

        // With any session present the empty state is gone.
        UiNode one = SidebarBuilder.build(
                List.of(session("only", NOW - 10)), NOW, false);
        assertThat(stringsIn(one.toJson())).doesNotContain("No threads yet.");
    }

    @Test
    void rowsKeepTheSessionRowIdentityAndFrameProps() {
        Session session = session("demo", NOW - 10);

        Map<String, Object> row = rowsOf(SidebarBuilder.build(List.of(session), NOW, false))
                .get(0);

        assertThat(row).containsEntry("id", "session-row:" + session.id())
                .containsEntry("type", "list_row")
                .containsEntry("title", "demo")
                .containsKey("status")
                .containsKey("pinned")
                .containsKey("settledAt")
                .containsKey("snoozedUntil");
    }

    // --- fixtures ---

    private static Session session(String id, long updatedAt) {
        return new Session(id, "local", id, "/tmp/" + id, null, null, "active",
                updatedAt - 1_000, updatedAt);
    }

    private static Session session(String id, long updatedAt, String status) {
        return new Session(id, "local", id, "/tmp/" + id, null, null, status,
                updatedAt - 1_000, updatedAt);
    }

    private static Session session(String id, long updatedAt, String status, PatchBuilder patch) {
        return new Session(id, "local", id, "/tmp/" + id, null, null, status,
                updatedAt - 1_000, updatedAt,
                Boolean.TRUE.equals(patch.pinned), patch.pinnedOrder, patch.settledAt,
                patch.snoozedUntil, patch.archivedAt, true, patch.sortOrder,
                patch.settledReason, false);
    }

    private static Session session(String id, long updatedAt, PatchBuilder patch) {
        return new Session(id, "local", id, "/tmp/" + id, null, null, "active",
                updatedAt - 1_000, updatedAt,
                Boolean.TRUE.equals(patch.pinned), patch.pinnedOrder, patch.settledAt,
                patch.snoozedUntil, patch.archivedAt, true, patch.sortOrder,
                patch.settledReason, false);
    }

    /** Builds the lifecycle fields of one fixture session. */
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
    }

    private static PatchBuilder patch() {
        return new PatchBuilder();
    }

    // --- node walking helpers over the JSON wire shape ---

    private static List<Map<String, Object>> sectionsOf(UiNode split) {
        Map<String, Object> list = castMap(split.toJson().get("first"));
        return castList(list.get("sections")).stream()
                .map(SidebarBuilderTest::castMap)
                .toList();
    }

    private static Map<String, List<String>> partitionOf(UiNode split) {
        Map<String, List<String>> sections = new LinkedHashMap<>();
        for (Map<String, Object> section : sectionsOf(split)) {
            List<String> ids = new ArrayList<>();
            for (Object item : castList(section.get("items"))) {
                ids.add(String.valueOf(castMap(item).get("id"))
                        .substring("session-row:".length()));
            }
            sections.put(String.valueOf(section.get("label")), ids);
        }
        return sections;
    }

    private static List<String> labelsOf(List<Map<String, Object>> sections) {
        return sections.stream().map(section -> String.valueOf(section.get("label"))).toList();
    }

    private static List<String> idsOf(List<Map<String, Object>> sections) {
        return sections.stream().map(section -> String.valueOf(section.get("id"))).toList();
    }

    private static Map<String, Object> sectionOf(List<Map<String, Object>> sections, String label) {
        return sections.stream()
                .filter(section -> label.equals(section.get("label")))
                .findFirst()
                .orElseThrow();
    }

    private static List<Map<String, Object>> rowsOf(UiNode split) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> section : sectionsOf(split)) {
            for (Object item : castList(section.get("items"))) {
                rows.add(castMap(item));
            }
        }
        return rows;
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

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}