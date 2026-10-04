/**
 * The thread sidebar of the {@code sessions} shell: four labeled sections
 * (Pinned, Active, Snoozed, Settled) of {@code list_row} thread rows over the
 * grouped {@code list} primitive, each row carrying the
 * {@code session-row:<id>} identity the {@code session_updated} patch frames
 * target and an overflow {@code menu} of lifecycle actions.
 *
 * <p><b>Section membership</b> is a total partition of the sessions one
 * caller may see:
 * <ul>
 *   <li>archived sessions appear nowhere;</li>
 *   <li>{@code Pinned} — {@code pinned=1} in any other state (a session that
 *       is both pinned and settled appears only here), ordered by
 *       {@code pinned_order} ASC with the nulls last;</li>
 *   <li>{@code Settled} — {@code settled_at} set, ordered by
 *       {@code settled_at} DESC;</li>
 *   <li>{@code Snoozed} — {@code snoozed_until} strictly in the future,
 *       ordered by {@code snoozed_until} ASC (an expired snooze falls through
 *       to Active);</li>
 *   <li>{@code Active} — everything else, ordered by {@code sort_order} ASC
 *       with the nulls last, then {@code created_at} DESC.</li>
 * </ul>
 *
 * <p>Empty sections still render their label; when the whole sidebar is empty
 * the list carries an empty-state node. The {@code Settled} shelf is
 * collapsible and starts collapsed.
 *
 * <p><b>Row identity.</b> Every row node is {@code session-row:<id>}, the id
 * the {@code session_updated} frames patch, and its props carry the frame
 * prop names of {@code EventFrames} ({@code title}, {@code workdir},
 * {@code status}, {@code pinned}, {@code pinnedOrder}, {@code settledAt},
 * {@code snoozedUntil}, {@code archivedAt}, {@code settledReason},
 * {@code sortOrder}) so a patch lands on matching keys.
 *
 * <p><b>Arrange mode.</b> With {@code arrange} on, the rows show the visual
 * drag handles (drag reordering itself is forbidden — the affordance is
 * visual only) and the overflow menu adds {@code Move up} / {@code Move down},
 * which dispatch the {@code reorder} action with the full ordered id list of
 * the affected section (the post-move order, computed at render time).
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class SidebarBuilder {

    /** The four sidebar sections, in render order. */
    public static final String PINNED = "Pinned";
    public static final String ACTIVE = "Active";
    public static final String SNOOZED = "Snoozed";
    public static final String SETTLED = "Settled";

    /** The empty-state node shown when the whole sidebar has no threads. */
    static final String EMPTY_STATE = "No threads yet.";

    private SidebarBuilder() {
    }

    /**
     * Builds the sidebar node: the grouped {@code list} of the four thread
     * sections.
     *
     * @param sessions the sessions one caller may see (archived ones are
     *                 dropped here)
     * @param now      the wall clock, epoch milliseconds (snooze expiry)
     * @param arrange  whether the reorder mode is on (drag handles and the
     *                 Move up / Move down menu entries)
     * @return the sidebar node
     */
    public static UiNode build(List<Session> sessions, long now, boolean arrange) {
        Map<String, List<Session>> sections = partition(sessions, now);
        List<Object> wire = new ArrayList<>();
        wire.add(section(PINNED, "section-pinned", false, false,
                sections.get(PINNED), arrange));
        wire.add(section(ACTIVE, "section-active", false, false,
                sections.get(ACTIVE), arrange));
        wire.add(section(SNOOZED, "section-snoozed", false, false,
                sections.get(SNOOZED), arrange));
        wire.add(section(SETTLED, "section-settled", true, true,
                sections.get(SETTLED), arrange));
        Ui.ListBuilder list = Ui.list().sections(wire);
        boolean empty = sections.values().stream().allMatch(List::isEmpty);
        if (empty) {
            list.empty(Ui.text(EMPTY_STATE).style("caption").build());
        }
        return list.build();
    }

    /**
     * The section membership of every visible session: Pinned, Active,
     * Snoozed and Settled in render order, each already sorted.
     *
     * @param sessions the sessions one caller may see
     * @param now      the wall clock, epoch milliseconds
     * @return section label to its ordered sessions
     */
    static Map<String, List<Session>> partition(List<Session> sessions, long now) {
        List<Session> pinned = new ArrayList<>();
        List<Session> active = new ArrayList<>();
        List<Session> snoozed = new ArrayList<>();
        List<Session> settled = new ArrayList<>();
        for (Session session : sessions) {
            if (session.archivedAt() != null) {
                continue;
            }
            if (session.pinned()) {
                pinned.add(session);
            } else if (session.settledAt() != null) {
                settled.add(session);
            } else if (session.snoozedUntil() != null && session.snoozedUntil() > now) {
                snoozed.add(session);
            } else {
                active.add(session);
            }
        }
        pinned.sort(Comparator
                .comparing(Session::pinnedOrder, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparing(Session::createdAt, Comparator.reverseOrder())
                .thenComparing(Session::id));
        active.sort(Comparator
                .comparing(Session::sortOrder, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparing(Session::createdAt, Comparator.reverseOrder())
                .thenComparing(Session::id));
        snoozed.sort(Comparator
                .comparing(Session::snoozedUntil, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparing(Session::id));
        settled.sort(Comparator
                .comparing(Session::settledAt, Comparator.nullsLast(Comparator.reverseOrder()))
                .thenComparing(Session::id));
        Map<String, List<Session>> sections = new LinkedHashMap<>();
        sections.put(PINNED, List.copyOf(pinned));
        sections.put(ACTIVE, List.copyOf(active));
        sections.put(SNOOZED, List.copyOf(snoozed));
        sections.put(SETTLED, List.copyOf(settled));
        return sections;
    }

    /** One {@code list} section spec: label, id, collapse state and rows. */
    private static Map<String, Object> section(String label, String id,
                                               boolean collapsible, boolean collapsed,
                                               List<Session> sessions, boolean arrange) {
        Map<String, Object> section = new LinkedHashMap<>();
        section.put("label", label);
        section.put("id", id);
        section.put("collapsible", collapsible);
        section.put("collapsed", collapsed);
        List<Object> rows = new ArrayList<>();
        List<String> ids = sessions.stream().map(Session::id).toList();
        for (int i = 0; i < sessions.size(); i++) {
            rows.add(row(sessions.get(i), ids, i, arrange));
        }
        section.put("items", rows);
        return section;
    }

    /**
     * One thread row: the {@code session-row:<id>} {@code list_row} with the
     * title, the workdir subtitle, the status badge and the overflow menu.
     */
    private static UiNode row(Session session, List<String> sectionIds,
                              int index, boolean arrange) {
        Ui.ListRowBuilder row = Ui.listRow()
                .id("session-row:" + session.id())
                .title(session.title())
                .subtitle(session.workdir())
                .badge(Ui.badge().label(statusLabel(session)).build())
                .trailing(menu(session, sectionIds, index, arrange))
                .dragHandle(arrange)
                .action(Directives.navigate("chat:" + session.id()));
        // The session_updated frame props (EventFrames.ROW_PROPS): the row
        // carries them under the same names so a patch lands on matching keys.
        row.set("workdir", session.workdir());
        row.set("status", session.status());
        row.set("pinned", session.pinned());
        row.set("pinnedOrder", session.pinnedOrder());
        row.set("settledAt", session.settledAt());
        row.set("snoozedUntil", session.snoozedUntil());
        row.set("archivedAt", session.archivedAt());
        row.set("settledReason", session.settledReason());
        row.set("sortOrder", session.sortOrder());
        return row.build();
    }

    /** The status badge label: the free-form session status. */
    private static String statusLabel(Session session) {
        String status = session.status();
        return status == null || status.isBlank() ? "idle" : status;
    }

    /**
     * The overflow menu of one row: the lifecycle actions of the row's state
     * plus — in arrange mode — the Move up / Move down reorder entries.
     */
    private static UiNode menu(Session session, List<String> sectionIds,
                               int index, boolean arrange) {
        String id = session.id();
        Ui.MenuBuilder menu = Ui.menu()
                .trigger(Ui.iconButton().icon("more_vert")
                        .action(ActionDescriptors.of("noop"))
                        .build());
        if (session.pinned()) {
            menu.item(Ui.menuItem("Unpin")
                    .icon("keep_off")
                    .action(ActionDescriptors.of("unpin", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Pin")
                    .icon("keep")
                    .action(ActionDescriptors.of("pin", Map.of("id", id), null))
                    .build());
        }
        if (session.settledAt() != null) {
            menu.item(Ui.menuItem("Un-settle")
                    .icon("undo")
                    .action(ActionDescriptors.of("unsettle", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Settle")
                    .icon("done")
                    .action(ActionDescriptors.of("settle", Map.of("id", id), null))
                    .build());
        }
        menu.item(Ui.menuItem("Snooze\u2026")
                .icon("snooze")
                .action(ActionDescriptors.of("snooze", Map.of("id", id), null))
                .build());
        menu.item(Ui.menuItem("Wake")
                .icon("notifications")
                .action(ActionDescriptors.of("wake", Map.of("id", id), null))
                .build());
        if (session.archivedAt() != null) {
            menu.item(Ui.menuItem("Restore")
                    .icon("unarchive")
                    .action(ActionDescriptors.of("restore", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Archive")
                    .icon("archive")
                    .action(ActionDescriptors.of("archive", Map.of("id", id), null))
                    .confirm("Archive this thread?")
                    .build());
        }
        menu.item(Ui.menuItem("Regenerate title")
                .icon("title")
                .action(ActionDescriptors.of("regenerate-title", Map.of("id", id), null))
                .build());
        if (arrange) {
            menu.item(Ui.menuItem("Move up")
                    .icon("arrow_upward")
                    .action(ActionDescriptors.of("reorder",
                            Map.of("ids", moved(sectionIds, index, -1)), null))
                    .disabled(index <= 0)
                    .build());
            menu.item(Ui.menuItem("Move down")
                    .icon("arrow_downward")
                    .action(ActionDescriptors.of("reorder",
                            Map.of("ids", moved(sectionIds, index, 1)), null))
                    .disabled(index >= sectionIds.size() - 1)
                    .build());
        }
        menu.item(Ui.menuItem("Delete")
                .icon("delete")
                .action(ActionDescriptors.of("delete-session", Map.of("id", id), null))
                .confirm("Delete this thread? This cannot be undone.")
                .danger(true)
                .build());
        return menu.build();
    }

    /**
     * The post-move id order of one section: the {@code reorder} payload of
     * the Move up / Move down entries. A move past either end answers the
     * unchanged order (the entry is disabled there anyway).
     */
    private static List<String> moved(List<String> ids, int index, int delta) {
        int target = index + delta;
        if (target < 0 || target >= ids.size()) {
            return List.copyOf(ids);
        }
        List<String> moved = new ArrayList<>(ids);
        String id = moved.remove(index);
        moved.add(target, id);
        return List.copyOf(moved);
    }
}