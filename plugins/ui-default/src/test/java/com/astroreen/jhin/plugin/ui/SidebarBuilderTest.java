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
import java.time.ZoneId;
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
                .containsKey("status")
                .containsKey("pinned")
                .containsKey("settledAt")
                .containsKey("snoozedUntil");
    }

    // --- T97: header + footer blocks ---

    @Test
    void listCarriesTheHeaderFooterAndSearchSpec() {
        Map<String, Object> list = castMap(SidebarBuilder.build(List.of(), NOW, false)
                .toJson().get("first"));

        assertThat(list).containsEntry("type", "list");
        assertThat(castMap(list.get("header"))).containsEntry("id", "sidebar-header");
        assertThat(castMap(list.get("footer"))).containsEntry("id", "sidebar-footer");
        assertThat(castMap(list.get("search"))).containsEntry("key", "sidebarSearch")
                .containsEntry("fields", List.of("title", "subtitle"));
    }

    @Test
    void headerCarriesWordmarkSearchInputNewThreadAndChevron() {
        Map<String, Object> header = castMap(SidebarBuilder.build(List.of(), NOW, false)
                .toJson().get("first"));
        header = castMap(header.get("header"));
        List<Map<String, Object>> children = castList(header.get("children"))
                .stream().map(SidebarBuilderTest::castMap).toList();

        // Brand row: the bold wordmark and the demo-marked chevron.
        Map<String, Object> brand = children.get(0);
        assertThat(brand).containsEntry("id", "sidebar-brand");
        Map<String, Object> wordmark = castMap(castList(brand.get("children")).get(0));
        assertThat(wordmark).containsEntry("type", "text")
                .containsEntry("text", "Jhin")
                .containsEntry("bold", true);
        Map<String, Object> chevron = castMap(castList(brand.get("children")).get(2));
        assertThat(chevron).containsEntry("type", "icon_button")
                .containsEntry("icon", "chevron_right")
                .containsEntry("demo", true);

        // Search row: the "Search threads" input and the New thread button.
        Map<String, Object> search = children.get(1);
        assertThat(search).containsEntry("id", "sidebar-search");
        Map<String, Object> input = castMap(castList(search.get("children")).get(0));
        assertThat(input).containsEntry("type", "input")
                .containsEntry("id", "sidebarSearch")
                .containsEntry("placeholder", "Search threads");
        Map<String, Object> button = castMap(castList(search.get("children")).get(1));
        assertThat(button).containsEntry("type", "button")
                .containsEntry("label", "New thread")
                .containsEntry("style", "primary");
        Map<String, Object> action = castMap(button.get("action"));
        assertThat(action).containsEntry("op", "dialog");
        assertThat(action).doesNotContainKey("node");
        assertThat(String.valueOf(action.get("html"))).contains("new-thread-dialog");
    }

    @Test
    void newThreadDialogSubmitsTheRealCreateSessionAction() {
        UiNode json = SidebarBuilder.build(List.of(), NOW, false);
        String dialog = newThreadDialogHtmlOf(json);

        assertThat(dialog).contains("data-jhin-type=\"form\"")
                .contains("Create thread");
        assertThat(dialog).contains("create-session")
                .contains("newThreadTitle")
                .contains("newThreadWorkdir");
    }

    @Test
    void footerCarriesConnectionDotAccountChipSettingsAndProfiles() {
        Map<String, Object> footer = castMap(SidebarBuilder.build(List.of(), NOW, false,
                "octocat").toJson().get("first"));
        footer = castMap(footer.get("footer"));
        assertThat(footer).containsEntry("id", "sidebar-footer");
        List<Map<String, Object>> children = castList(footer.get("children"))
                .stream().map(SidebarBuilderTest::castMap).toList();

        // The connection dot with the Online label.
        Map<String, Object> connection = children.get(0);
        assertThat(connection).containsEntry("id", "sidebar-status-dot")
                .containsEntry("tooltip", "Online");
        Map<String, Object> dot = castMap(castList(connection.get("children")).get(0));
        assertThat(dot).containsEntry("type", "box")
                .containsEntry("shape", "circle")
                .containsEntry("color", "$color.success");

        // The account chip: initials avatar + handle text.
        Map<String, Object> avatar = children.get(1);
        assertThat(avatar).containsEntry("type", "avatar")
                .containsEntry("initials", "OC");
        Map<String, Object> handle = children.get(2);
        assertThat(handle).containsEntry("type", "text").containsEntry("text", "octocat");

        // Settings navigates; the profile button opens the client surface.
        Map<String, Object> settings = children.get(3);
        assertThat(settings).containsEntry("type", "icon_button")
                .containsEntry("icon", "settings")
                .containsEntry("tooltip", "Settings");
        assertThat(castMap(settings.get("action"))).containsEntry("op", "navigate")
                .containsEntry("screen", "settings");
        Map<String, Object> profiles = children.get(4);
        assertThat(castMap(profiles.get("action"))).containsEntry("op", "openProfiles");
    }

    @Test
    void initialsTakeTheFirstTwoCharactersUppercased() {
        assertThat(SidebarBuilder.initialsOf("octocat")).isEqualTo("OC");
        assertThat(SidebarBuilder.initialsOf("a")).isEqualTo("A");
        assertThat(SidebarBuilder.initialsOf("")).isEqualTo("?");
    }

    // --- T97: row anatomy ---

    @Test
    void rowTitleIsTheHoverCardOverTheSemiboldTruncatedText() {
        Map<String, Object> row = rowOf("demo");

        // T98: the title slot is the hover preview card; the trigger is the
        // semibold truncated title text.
        Map<String, Object> card = castMap(row.get("title"));
        assertThat(card).containsEntry("type", "hover_card")
                .containsEntry("delay", 500)
                .containsEntry("placement", "right");
        Map<String, Object> trigger = castMap(card.get("trigger"));
        assertThat(trigger).containsEntry("type", "text")
                .containsEntry("text", "demo")
                .containsEntry("fontSize", 14)
                .containsEntry("fontWeight", 600)
                .containsEntry("maxLines", 1)
                .containsEntry("ellipsis", true);
        Map<String, Object> content = castMap(card.get("content"));
        assertThat(content).containsEntry("id", "thread-hover-card");
        List<Object> children = castList(content.get("children"));
        assertThat(castMap(children.get(0))).containsEntry("text", "demo")
                .containsEntry("fontSize", 12)
                .containsEntry("fontWeight", 500);
        Map<String, Object> workdirRow = castMap(children.get(1));
        assertThat(castMap(castList(workdirRow.get("children")).get(0)))
                .containsEntry("icon", "folder");
        // T302: the hover-card workdir is the path chip (full path tooltip).
        Map<String, Object> hoverWorkdir = castMap(castList(workdirRow.get("children")).get(1));
        assertThat(hoverWorkdir)
                .containsEntry("type", "chip")
                .containsEntry("kind", "file")
                .containsEntry("label", "/tmp/demo")
                .containsEntry("tooltip", "/tmp/demo");
    }

    @Test
    void rowSubtitleCarriesTheMutedWorkdirAndTheProjectChip() {
        Map<String, Object> row = rowOf("demo");

        Map<String, Object> subtitle = castMap(row.get("subtitle"));
        assertThat(subtitle).containsEntry("type", "row");
        // T302: the subtitle workdir is the path chip (full path tooltip).
        Map<String, Object> muted = castMap(castList(subtitle.get("children")).get(0));
        assertThat(muted)
                .containsEntry("type", "chip")
                .containsEntry("kind", "file")
                .containsEntry("label", "/tmp/demo")
                .containsEntry("tooltip", "/tmp/demo");
        Map<String, Object> chip = castMap(castList(subtitle.get("children")).get(1));
        assertThat(chip).containsEntry("id", "thread-context-chip")
                .containsEntry("tooltip", "Project: /tmp/demo");
        Map<String, Object> chipLabel = castMap(chip.get("child"));
        assertThat(chipLabel).containsEntry("text", "demo")
                .containsEntry("fontSize", 12);
    }

    @Test
    void rowTrailingCarriesTheMenuAndTheHoverRevealSearchMatch() {
        Map<String, Object> row = rowOf("demo");

        assertThat(row).containsEntry("hoverReveal", true);
        assertThat(castMap(row.get("searchMatch")))
                .containsEntry("key", "sidebarSearch")
                .containsEntry("minChars", 2);
        assertThat(castMap(row.get("trailing"))).containsEntry("type", "menu");
    }

    @Test
    void statusKindsMapTheSessionStateOntoTheTenKindSet() {
        assertThat(kindsOf(session("w", NOW - 10, "working"))).containsExactly("working");
        assertThat(kindsOf(session("m", NOW - 10, "monitoring"))).containsExactly("monitoring");
        assertThat(kindsOf(session("a", NOW - 10, "needs-approval")))
                .containsExactly("needs-approval");
        assertThat(kindsOf(session("q", NOW - 10, "needs-answer"))).containsExactly("needs-answer");
        assertThat(kindsOf(session("f", NOW - 10, "failed"))).containsExactly("failed");
        assertThat(kindsOf(session("l", NOW - 10, "limited"))).containsExactly("limited");
        assertThat(kindsOf(session("i", NOW - 10, "active"))).containsExactly("idle");
        assertThat(kindsOf(session("b", NOW - 10, ""))).containsExactly("idle");
        assertThat(kindsOf(session("s", NOW - 10, patch().settledAt(NOW - 5))))
                .containsExactly("settled");
        assertThat(kindsOf(session("z", NOW - 10, patch().snoozedUntil(NOW + 60_000))))
                .containsExactly("snoozed");
        // An expired snooze falls through to the status kind (the same rule
        // the section partition applies).
        assertThat(kindsOf(session("ze", NOW - 10, patch().snoozedUntil(NOW - 1))))
                .containsExactly("idle");
        assertThat(kindsOf(session("p", NOW - 10, patch().pinned(true).pinnedOrder(1))))
                .containsExactly("idle", "pinned");
        assertThat(kindsOf(session("pw", NOW - 10, "working",
                patch().pinned(true).pinnedOrder(1)))).containsExactly("working", "pinned");
    }

    @Test
    void unknownStatusFallsBackToIdleInTheTree() {
        Map<String, Object> row = rowOf("bogus-session", "bogus-status");

        assertThat(row.get("status")).isEqualTo("bogus-status");
        assertThat(row.get("statusIndicators")).isEqualTo(List.of("idle"));
    }

    // --- T98: thread action menu ---

    /** The items of one row's overflow menu. */
    private static List<Map<String, Object>> menuItemsOf(String id) {
        return menuItemsOf(id, "active", false);
    }

    private static List<Map<String, Object>> menuItemsOf(String id, PatchBuilder patch) {
        Map<String, Object> row = rowsOf(SidebarBuilder.build(
                List.of(session(id, NOW - 10, patch)), NOW, false)).get(0);
        return castList(castMap(row.get("trailing")).get("items")).stream()
                .map(SidebarBuilderTest::castMap)
                .toList();
    }

    private static List<Map<String, Object>> menuItemsOf(String id, String status,
                                                         boolean arrange) {
        Map<String, Object> row = rowsOf(SidebarBuilder.build(
                List.of(session(id, NOW - 10, status)), NOW, arrange)).get(0);
        return castList(castMap(row.get("trailing")).get("items")).stream()
                .map(SidebarBuilderTest::castMap)
                .toList();
    }

    /** The labels of one item list, in order. */
    private static List<String> labelsOfItems(List<Map<String, Object>> items) {
        return items.stream().map(item -> String.valueOf(item.get("label"))).toList();
    }

    @Test
    void menuCarriesTheUpstreamItemSetInOrder() {
        assertThat(labelsOfItems(menuItemsOf("demo"))).containsExactly(
                "Pin thread", "Settle thread", "Snooze", "Regenerate title",
                "Auto-settle behavior", "Arrange threads", "Archive thread",
                "Delete");
    }

    @Test
    void pinAndUnpinAreConditionalWithTheUpstreamLabelsAndIcons() {
        Map<String, Object> pin = menuItemsOf("demo").get(0);
        assertThat(pin).containsEntry("label", "Pin thread")
                .containsEntry("icon", "keep");
        assertThat(castMap(pin.get("action")))
                .containsEntry("name", "pin")
                .containsEntry("path", "/ui/action/pin");
        assertThat(castMap(pin.get("action")).get("payload"))
                .isEqualTo(Map.of("id", "demo"));

        Map<String, Object> unpin = menuItemsOf("pinned", patch().pinned(true).pinnedOrder(1))
                .get(0);
        assertThat(unpin).containsEntry("label", "Unpin thread")
                .containsEntry("icon", "keep_off");
        assertThat(castMap(unpin.get("action"))).containsEntry("name", "unpin");
    }

    @Test
    void settleAndUnsettleAreConditionalWithTheUpstreamLabels() {
        Map<String, Object> settle = menuItemsOf("demo").get(1);
        assertThat(settle).containsEntry("label", "Settle thread")
                .containsEntry("icon", "check_circle");
        assertThat(castMap(settle.get("action"))).containsEntry("name", "settle");

        Map<String, Object> unsettled = menuItemsOf("settled", patch().settledAt(NOW - 5))
                .get(1);
        assertThat(unsettled).containsEntry("label", "Un-settle thread")
                .containsEntry("icon", "check_circle");
        assertThat(castMap(unsettled.get("action"))).containsEntry("name", "unsettle");
    }

    @Test
    void snoozeCarriesTheUpstreamPresetSubmenuPlusCustom() {
        Map<String, Object> snooze = menuItemsOf("demo").get(2);
        assertThat(snooze).containsEntry("label", "Snooze")
                .containsEntry("icon", "schedule");
        List<Map<String, Object>> children = castList(snooze.get("children")).stream()
                .map(SidebarBuilderTest::castMap)
                .toList();
        // The upstream preset labels carry the whenLabel time column
        // (threadActionMenu.logic.ts:148-151); the exact clock depends on
        // the host zone, so only the shape is asserted here.
        assertThat(children.size()).isGreaterThanOrEqualTo(4);
        assertThat(String.valueOf(children.get(0).get("label")))
                .startsWith("In 1 hour (").endsWith(")");
        assertThat(String.valueOf(children.get(1).get("label")))
                .startsWith("In 3 hours (").endsWith(")");
        // Every preset dispatches the real snooze action with a future
        // `until`.
        for (int i = 0; i < children.size() - 1; i++) {
            Map<String, Object> action = castMap(children.get(i).get("action"));
            assertThat(action).containsEntry("name", "snooze");
            assertThat(((Number) castMap(action.get("payload")).get("until")).longValue())
                    .isGreaterThan(NOW);
        }
        // Custom… opens the decorative picker dialog.
        Map<String, Object> custom = children.get(children.size() - 1);
        assertThat(custom).containsEntry("label", "Custom…")
                .containsEntry("separatorBefore", true);
        assertThat(castMap(custom.get("action"))).containsEntry("op", "dialog");
    }

    @Test
    void snoozedRowsShowWakeInsteadOfTheSubmenu() {
        Map<String, Object> wake = menuItemsOf("snoozed",
                patch().snoozedUntil(NOW + 60_000)).get(2);
        assertThat(wake).containsEntry("label", "Wake thread")
                .containsEntry("icon", "schedule");
        assertThat(castMap(wake.get("action"))).containsEntry("name", "wake");
        assertThat(wake).doesNotContainKey("children");
    }

    @Test
    void snoozePresetsFollowTheUpstreamCalendarRules() {
        ZoneId utc = ZoneId.of("UTC");
        // 1970-01-12T00:16:40Z is a Monday 00:16: This evening (18:00) is
        // offered, Next week lands on next Monday 09:00, distinct from
        // Tomorrow.
        List<SidebarBuilder.SnoozePreset> presets =
                SidebarBuilder.snoozePresets(NOW, utc);
        assertThat(presets.stream().map(SidebarBuilder.SnoozePreset::label))
                .containsExactly("In 1 hour", "In 3 hours", "This evening",
                        "Tomorrow", "Next week");
        assertThat(presets.get(0).whenLabel()).isEqualTo("1:16 AM");
        assertThat(presets.get(2).whenLabel()).isEqualTo("6:00 PM");
        assertThat(presets.get(3).whenLabel()).isEqualTo("9:00 AM");
        assertThat(presets.get(4).whenLabel()).isEqualTo("Mon 9:00 AM");

        // A Sunday 09:30 (1970-01-04): This evening is offered, and Next
        // week collapses onto Tomorrow (both Monday 09:00).
        long sundayMorning = 3 * 86_400_000L + 9 * 3_600_000L + 1_800_000L;
        List<SidebarBuilder.SnoozePreset> sunday =
                SidebarBuilder.snoozePresets(sundayMorning, utc);
        assertThat(sunday.stream().map(SidebarBuilder.SnoozePreset::label))
                .containsExactly("In 1 hour", "In 3 hours", "This evening",
                        "Tomorrow");

        // A Tuesday 19:30 (1970-01-06): This evening is within the past —
        // dropped; Next week (Monday 09:00) is distinct from Tomorrow.
        long tuesdayEvening = 5 * 86_400_000L + 19 * 3_600_000L + 1_800_000L;
        assertThat(SidebarBuilder.snoozePresets(tuesdayEvening, utc)
                .stream().map(SidebarBuilder.SnoozePreset::label))
                .containsExactly("In 1 hour", "In 3 hours", "Tomorrow",
                        "Next week");
    }

    @Test
    void regenerateTitleCarriesTheGroupSeparator() {
        Map<String, Object> regenerate = menuItemsOf("demo").get(3);
        assertThat(regenerate).containsEntry("label", "Regenerate title")
                .containsEntry("icon", "refresh")
                .containsEntry("separatorBefore", true);
        assertThat(castMap(regenerate.get("action")))
                .containsEntry("name", "regenerate-title");
    }

    @Test
    void autoSettleSubmenuCarriesTheCheckedRadioEntries() {
        Map<String, Object> autoSettle = menuItemsOf("demo").get(4);
        assertThat(autoSettle).containsEntry("label", "Auto-settle behavior")
                .containsEntry("icon", "timer");
        List<Map<String, Object>> children = castList(autoSettle.get("children")).stream()
                .map(SidebarBuilderTest::castMap)
                .toList();
        assertThat(labelsOfItems(children)).containsExactly("Enabled", "Disabled");
        assertThat(children.get(0)).containsEntry("checked", true);
        assertThat(children.get(1)).containsEntry("checked", false);
        assertThat(castMap(children.get(0).get("action")))
                .containsEntry("name", "auto-settle");
        assertThat(castMap(children.get(0).get("action")).get("payload"))
                .isEqualTo(Map.of("id", "demo", "enabled", true));
        assertThat(castMap(children.get(1).get("action")).get("payload"))
                .isEqualTo(Map.of("id", "demo", "enabled", false));
    }

    @Test
    void archiveSitsAboveTheSeparatorAndDeleteIsDestructive() {
        List<Map<String, Object>> items = menuItemsOf("demo");
        Map<String, Object> archive = items.get(6);
        assertThat(archive).containsEntry("label", "Archive thread")
                .containsEntry("icon", "archive")
                .containsEntry("separatorBefore", true)
                .containsEntry("confirm", "Archive this thread?");
        assertThat(castMap(archive.get("action"))).containsEntry("name", "archive");

        Map<String, Object> delete = items.get(7);
        assertThat(delete).containsEntry("label", "Delete")
                .containsEntry("icon", "delete")
                .containsEntry("danger", true)
                .containsEntry("confirm", "Delete this thread? This cannot be undone.");
        assertThat(castMap(delete.get("action"))).containsEntry("name", "delete-session");
    }

    @Test
    void arrangeModeAddsTheMoveEntriesBeforeArchive() {
        Map<String, Object> row = rowsOf(SidebarBuilder.build(
                List.of(session("first", NOW - 20), session("demo", NOW - 10)),
                NOW, true)).stream()
                .filter(r -> "session-row:demo".equals(r.get("id")))
                .findFirst().orElseThrow();
        List<Map<String, Object>> items = castList(
                castMap(row.get("trailing")).get("items")).stream()
                .map(SidebarBuilderTest::castMap)
                .toList();
        assertThat(labelsOfItems(items)).containsExactly(
                "Pin thread", "Settle thread", "Snooze", "Regenerate title",
                "Auto-settle behavior", "Arrange threads", "Move up", "Move down",
                "Archive thread", "Delete");
        Map<String, Object> up = items.get(6);
        assertThat(castMap(up.get("action"))).containsEntry("name", "reorder");
        // The demo row sorts first in the section (updatedAt DESC), so the
        // move-up entry is disabled and the move-down one is not.
        assertThat(up).containsEntry("disabled", true);
        Map<String, Object> down = items.get(7);
        assertThat(castMap(down.get("action"))).containsEntry("name", "reorder");
        assertThat(down).containsEntry("disabled", false);
    }

    // --- T99: the drag choreography ---

    @Test
    void rowsOutsideTheWorkingShelfAreDraggable() {
        List<Session> sessions = List.of(
                session("active", NOW - 40),
                session("working", NOW - 30, "working"),
                session("pinned", NOW - 20, patch().pinned(true).pinnedOrder(1)),
                session("snoozed", NOW - 10, patch().snoozedUntil(NOW + 60_000)),
                session("settled", NOW - 5, patch().settledAt(NOW - 5)));
        Map<String, Map<String, Object>> rows = new LinkedHashMap<>();
        for (Map<String, Object> row : rowsOf(SidebarBuilder.build(sessions, NOW, false))) {
            rows.put(String.valueOf(row.get("id")).substring("session-row:".length()), row);
        }

        assertThat(rows.get("active")).containsEntry("draggable", true);
        assertThat(rows.get("pinned")).containsEntry("draggable", true);
        assertThat(rows.get("snoozed")).containsEntry("draggable", true);
        assertThat(rows.get("settled")).containsEntry("draggable", true);
        assertThat(rows.get("working")).doesNotContainKey("draggable");
    }

    @Test
    void dropVerbPortsTheUpstreamResolveSidebarDropVerb() {
        // The Working and Snoozed shelves are never destinations; a drop
        // inside the source section maps to no verb.
        assertThat(SidebarBuilder.dropVerb(SidebarBuilder.ACTIVE, SidebarBuilder.ACTIVE))
                .isNull();
        assertThat(SidebarBuilder.dropVerb(SidebarBuilder.ACTIVE, SidebarBuilder.WORKING))
                .isNull();
        assertThat(SidebarBuilder.dropVerb(SidebarBuilder.ACTIVE, SidebarBuilder.SNOOZED))
                .isNull();
        assertThat(SidebarBuilder.dropVerb(SidebarBuilder.ACTIVE, null)).isNull();
        // Onto Pinned pins, onto Settled settles.
        assertThat(SidebarBuilder.dropVerb(SidebarBuilder.ACTIVE, SidebarBuilder.PINNED))
                .isEqualTo("pin");
        assertThat(SidebarBuilder.dropVerb(SidebarBuilder.PINNED, SidebarBuilder.SETTLED))
                .isEqualTo("settle");
        // Out of Pinned unpins, out of Settled un-settles, otherwise wakes.
        assertThat(SidebarBuilder.dropVerb(SidebarBuilder.PINNED, SidebarBuilder.ACTIVE))
                .isEqualTo("unpin");
        assertThat(SidebarBuilder.dropVerb(SidebarBuilder.SETTLED, SidebarBuilder.ACTIVE))
                .isEqualTo("unsettle");
        assertThat(SidebarBuilder.dropVerb(SidebarBuilder.SNOOZED, SidebarBuilder.ACTIVE))
                .isEqualTo("wake");
    }

    @Test
    void dropTargetsCarryTheBadgeWordAndTheLifecycleActionPerDestination() {
        Map<String, Object> active = rowOf("active");
        List<Map<String, Object>> activeTargets = castList(active.get("dropTargets"))
                .stream().map(SidebarBuilderTest::castMap).toList();
        assertThat(activeTargets).hasSize(2);
        assertThat(activeTargets.get(0)).containsEntry("id", "section-pinned")
                .containsEntry("label", "Pin")
                .containsEntry("accentWhenHovered", true);
        assertThat(castMap(activeTargets.get(0).get("action")))
                .containsEntry("name", "pin")
                .containsEntry("path", "/ui/action/pin");
        assertThat(castMap(castMap(activeTargets.get(0).get("action")).get("payload")))
                .containsEntry("id", "active");
        assertThat(activeTargets.get(1)).containsEntry("id", "section-settled")
                .containsEntry("label", "Settle");
        assertThat(castMap(activeTargets.get(1).get("action"))).containsEntry("name", "settle");

        Map<String, Object> pinned = rowsOf(SidebarBuilder.build(
                List.of(session("pinned", NOW - 10, patch().pinned(true).pinnedOrder(1))),
                NOW, false)).get(0);
        List<Map<String, Object>> pinnedTargets = castList(pinned.get("dropTargets"))
                .stream().map(SidebarBuilderTest::castMap).toList();
        assertThat(pinnedTargets.get(0)).containsEntry("id", "section-active")
                .containsEntry("label", "Unpin");
        assertThat(castMap(pinnedTargets.get(0).get("action"))).containsEntry("name", "unpin");
        assertThat(pinnedTargets.get(1)).containsEntry("id", "section-settled")
                .containsEntry("label", "Settle");

        Map<String, Object> settled = rowsOf(SidebarBuilder.build(
                List.of(session("settled", NOW - 10, patch().settledAt(NOW - 5))),
                NOW, false)).stream()
                .filter(r -> "session-row:settled".equals(r.get("id")))
                .findFirst().orElseThrow();
        List<Map<String, Object>> settledTargets = castList(settled.get("dropTargets"))
                .stream().map(SidebarBuilderTest::castMap).toList();
        assertThat(settledTargets.get(0)).containsEntry("id", "section-pinned")
                .containsEntry("label", "Pin");
        assertThat(castMap(settledTargets.get(0).get("action"))).containsEntry("name", "pin");
        assertThat(settledTargets.get(1)).containsEntry("id", "section-active")
                .containsEntry("label", "Un-settle");
        assertThat(castMap(settledTargets.get(1).get("action"))).containsEntry("name", "unsettle");

        Map<String, Object> snoozed = rowsOf(SidebarBuilder.build(
                List.of(session("snoozed", NOW - 10, patch().snoozedUntil(NOW + 60_000))),
                NOW, false)).get(0);
        List<Map<String, Object>> snoozedTargets = castList(snoozed.get("dropTargets"))
                .stream().map(SidebarBuilderTest::castMap).toList();
        assertThat(snoozedTargets.get(0)).containsEntry("id", "section-pinned")
                .containsEntry("label", "Pin");
        assertThat(castMap(snoozedTargets.get(0).get("action"))).containsEntry("name", "pin");
        assertThat(snoozedTargets.get(1)).containsEntry("id", "section-active")
                .containsEntry("label", "Wake");
        assertThat(castMap(snoozedTargets.get(1).get("action"))).containsEntry("name", "wake");
        assertThat(snoozedTargets.get(2)).containsEntry("id", "section-settled")
                .containsEntry("label", "Settle");
    }

    @Test
    void badgeWordsAndIconsFollowTheUpstreamDropVerbBadge() {
        assertThat(SidebarBuilder.badgeWord("pin")).isEqualTo("Pin");
        assertThat(SidebarBuilder.badgeWord("unpin")).isEqualTo("Unpin");
        assertThat(SidebarBuilder.badgeWord("settle")).isEqualTo("Settle");
        assertThat(SidebarBuilder.badgeWord("unsettle")).isEqualTo("Un-settle");
        assertThat(SidebarBuilder.badgeWord("wake")).isEqualTo("Wake");
        assertThat(SidebarBuilder.badgeIcon("pin")).isEqualTo("push_pin");
        assertThat(SidebarBuilder.badgeIcon("unpin")).isEqualTo("highlight_off");
        assertThat(SidebarBuilder.badgeIcon("settle")).isEqualTo("check_circle");
        assertThat(SidebarBuilder.badgeIcon("unsettle")).isEqualTo("undo");
        assertThat(SidebarBuilder.badgeIcon("wake")).isEqualTo("alarm_off");
    }

    @Test
    void dragLabelIsTheChipTemplateOfTheFirstTarget() {
        Map<String, Object> label = castMap(rowOf("active").get("dragLabel"));
        assertThat(label).containsEntry("id", "drag-label");
        List<Map<String, Object>> children = castList(label.get("children"))
                .stream().map(SidebarBuilderTest::castMap).toList();
        assertThat(children).hasSize(2);
        assertThat(children.get(0)).containsEntry("type", "icon")
                .containsEntry("icon", "push_pin");
        assertThat(children.get(1)).containsEntry("type", "text")
                .containsEntry("text", "Pin");
    }

    @Test
    void pinnedAndActiveSectionsCarryTheBoundaryLabels() {
        List<Map<String, Object>> sections = sectionsOf(SidebarBuilder.build(
                List.of(session("demo", NOW - 10)), NOW, false));
        assertThat(sectionOf(sections, "Pinned")).containsEntry("boundaryLabel", "Pinned");
        assertThat(sectionOf(sections, "Active")).containsEntry("boundaryLabel", "Active");
        for (String label : List.of("Working", "Snoozed", "Settled")) {
            assertThat(sectionOf(sections, label)).doesNotContainKey("boundaryLabel");
        }
    }

    @Test
    void arrangeThreadsOpensTheDecorativeSheet() {
        Map<String, Object> item = menuItemsOf("demo").stream()
                .filter(entry -> "Arrange threads".equals(entry.get("label")))
                .findFirst().orElseThrow();
        assertThat(item).containsEntry("icon", "drag_handle");
        Map<String, Object> action = castMap(item.get("action"));
        assertThat(action).containsEntry("op", "dialog").containsEntry("kind", "sheet");
        assertThat(action).doesNotContainKey("node");

        String sheet = String.valueOf(action.get("html"));
        assertThat(sheet).contains("data-jhin-type=\"sheet\"")
                .contains("Arrange threads")
                .contains("arrange-sheet-body");
        assertThat(sheet).contains("data-jhin-type=\"list_row\"");
        assertThat(sheet).contains("Done").contains("dismissDialog");
    }

    @Test
    void arrangeSheetListsTheArrangeableThreadsWithHandles() {
        UiNode sheet = SidebarBuilder.arrangeSheet(List.of("First", "Second"));
        Map<String, Object> json = sheet.toJson();
        assertThat(json).containsEntry("demo", true);
        assertThat(stringsIn(json)).contains("First", "Second", "Done");
    }

    @Test
    void customSnoozeDialogIsTheDemoShell() {
        UiNode dialog = SidebarBuilder.customSnoozeDialog("demo");
        Map<String, Object> json = dialog.toJson();
        assertThat(json).containsEntry("id", "custom-snooze-dialog")
                .containsEntry("demo", true);
        Map<String, Object> form = castMap(castList(json.get("children")).get(1));
        Map<String, Object> submit = castMap(form.get("submit"));
        assertThat(submit).containsEntry("label", "Confirm");
        assertThat(castMap(submit.get("action"))).containsEntry("name", "demo-snooze");
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

    /** The first row of the Active section of a one-session sidebar. */
    private static Map<String, Object> rowOf(String id) {
        return rowOf(id, "active");
    }

    /** The first row of the Active section, with an explicit status. */
    private static Map<String, Object> rowOf(String id, String status) {
        return rowsOf(SidebarBuilder.build(
                List.of(session(id, NOW - 10, status)), NOW, false)).get(0);
    }

    /** The statusIndicators list of one fixture session's row. */
    private static List<String> kindsOf(Session session) {
        Map<String, Object> row = rowsOf(SidebarBuilder.build(List.of(session), NOW, false))
                .get(0);
        return castList(row.get("statusIndicators")).stream()
                .map(String::valueOf).toList();
    }

    /** The new-thread dialog HTML of one sidebar tree (the button's dialog fragment). */
    private static String newThreadDialogHtmlOf(UiNode split) {
        Map<String, Object> header = castMap(castMap(split.toJson().get("first")).get("header"));
        Map<String, Object> search = castMap(castList(header.get("children")).get(1));
        Map<String, Object> button = castMap(castList(search.get("children")).get(1));
        return String.valueOf(castMap(button.get("action")).get("html"));
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