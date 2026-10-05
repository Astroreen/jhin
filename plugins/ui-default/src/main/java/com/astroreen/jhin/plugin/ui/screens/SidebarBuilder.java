/**
 * The thread sidebar of the {@code sessions} shell (T96): a resizable
 * {@code split} container — the five collapsible thread sections in the
 * first pane, the chat content placeholder in the second — over the grouped
 * {@code list} primitive. Each row carries the {@code session-row:<id>}
 * identity the {@code session_updated} patch frames target and an overflow
 * {@code menu} of lifecycle actions.
 *
 * <p><b>Split metrics</b> are the upstream thread-sidebar numbers (t3code
 * {@code apps/web/src/components/threadSidebarWidth.ts}, commit {@code
 * 37de6cb}): the persisted width key {@code chat_thread_sidebar_width}
 * ({@code threadSidebarWidth.ts:1}), the default 16&times;16&nbsp;=&nbsp;256
 * ({@code :2}), the minimum 13&times;16&nbsp;=&nbsp;208 ({@code :3}) and the
 * main-content minimum 40&times;16&nbsp;=&nbsp;640 ({@code :4}) as the
 * {@code minSecond} clamp. The divider position persists client-side under
 * the {@code persistKey} (the T90 split seam).
 *
 * <p><b>Section membership</b> is a total partition of the sessions one
 * caller may see, in render order Pinned / Active / Working / Snoozed /
 * Settled:
 * <ul>
 *   <li>archived sessions appear nowhere;</li>
 *   <li>{@code Pinned} — {@code pinned=1} in any other state (a session that
 *       is both pinned and settled appears only here), ordered by
 *       {@code pinned_order} ASC with the nulls last;</li>
 *   <li>{@code Settled} — {@code settled_at} set, ordered by
 *       {@code settled_at} DESC (the settlement-time shelf, upstream
 *       {@code docs/user/thread-sidebar.md} "The settled shelf continues to
 *       use settlement time"), rendered as a collapsed shelf;</li>
 *   <li>{@code Snoozed} — {@code snoozed_until} strictly in the future,
 *       ordered by {@code snoozed_until} ASC (an expired snooze falls through
 *       to Active), rendered as a collapsed shelf;</li>
 *   <li>{@code Working} — the opt-in shelf: {@code status} is {@code working}
 *       or {@code monitoring} (upstream "threads that are working or
 *       monitoring"), ordered by {@code updated_at} DESC; the section carries
 *       the {@code when: "workingSection != false"} gate the
 *       {@code settings:general} {@code workingSection} switch drives
 *       client-side (a {@code setState} away, no round-trip);</li>
 *   <li>{@code Active} — everything else, ordered by the arranged
 *       {@code sort_order} ASC with the nulls last (upstream
 *       {@code threadSort.ts:343-373}: the manual order wins) and the
 *       unordered tail by recency — {@code updated_at} DESC.</li>
 * </ul>
 *
 * <p><b>Section chrome.</b> Every section renders an uppercase header (the
 * client applies the {@code uppercase} transform, the weight is the small
 * semibold step), a count badge ({@code count} + the {@code badgeStyle}
 * {@code sidebar-control-surface} token, the rounded-full pill) and a
 * chevron. All five sections are collapsible; the collapse state persists
 * client-side under the section's {@code storeKey}
 * ({@code sidebar.section.<name>.collapsed}). Defaults: Pinned, Active and
 * Working expanded; Snoozed and Settled collapsed (the upstream shelves start
 * collapsed, {@code Sidebar.tsx:290-294}). Empty sections still render their
 * header (upstream labels empty sections); when the whole sidebar is empty
 * the list carries an empty-state node.
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
import java.util.Set;

public final class SidebarBuilder {

    /** The five sidebar sections, in render order. */
    public static final String PINNED = "Pinned";
    public static final String ACTIVE = "Active";
    public static final String WORKING = "Working";
    public static final String SNOOZED = "Snoozed";
    public static final String SETTLED = "Settled";

    /** The split container id. */
    public static final String SPLIT_ID = "sidebar-split";

    /** The grouped section list id. */
    public static final String SECTIONS_ID = "sidebar-sections";

    /** The persisted sidebar width key (upstream threadSidebarWidth.ts:1). */
    public static final String PERSIST_KEY = "chat_thread_sidebar_width";

    /** The default sidebar width: upstream 16&times;16 (threadSidebarWidth.ts:2). */
    public static final int INITIAL_WIDTH = 256;

    /** The minimum sidebar width: upstream 13&times;16 (threadSidebarWidth.ts:3). */
    public static final int MIN_WIDTH = 208;

    /** The main-content minimum: upstream 40&times;16 (threadSidebarWidth.ts:4). */
    public static final int MIN_SECOND_WIDTH = 640;

    /**
     * The Working opt-in gate: the {@code settings:general}
     * {@code workingSection} switch writes the state key client-side; the
     * section hides when it is explicitly {@code false} (an unset key keeps
     * the section visible — the plan's default tree carries Working).
     */
    public static final String WORKING_WHEN = "workingSection != false";

    /** The session statuses the Working shelf holds (upstream: working or monitoring). */
    private static final Set<String> WORKING_STATUSES = Set.of("working", "monitoring");

    /** The count-badge surface token (the rounded-full pill background). */
    static final String BADGE_STYLE = "sidebar-control-surface";

    /** The empty-state node shown when the whole sidebar has no threads. */
    static final String EMPTY_STATE = "No threads yet.";

    /** The content-pane placeholder card (the chat area lands in T100). */
    static final String SELECT_THREAD_TITLE = "Select a thread";
    static final String SELECT_THREAD_BODY =
            "Choose a thread from the sidebar to open the conversation.";

    private SidebarBuilder() {
    }

    /**
     * Builds the sidebar node: the resizable {@code split} of the five
     * thread sections (first pane) and the chat content placeholder (second).
     *
     * @param sessions the sessions one caller may see (archived ones are
     *                 dropped here)
     * @param now      the wall clock, epoch milliseconds (snooze expiry)
     * @param arrange  whether the reorder mode is on (drag handles and the
     *                 Move up / Move down menu entries)
     * @return the sidebar split node
     */
    public static UiNode build(List<Session> sessions, long now, boolean arrange) {
        return Ui.split()
                .id(SPLIT_ID)
                .first(sectionsList(sessions, now, arrange))
                .second(contentPane())
                .initial(INITIAL_WIDTH)
                .min(MIN_WIDTH)
                .minSecond(MIN_SECOND_WIDTH)
                .persistKey(PERSIST_KEY)
                .build();
    }

    /** The first pane: the grouped {@code list} of the five thread sections. */
    private static UiNode sectionsList(List<Session> sessions, long now, boolean arrange) {
        Map<String, List<Session>> sections = partition(sessions, now);
        List<Object> wire = new ArrayList<>();
        wire.add(section(PINNED, "section-pinned", false, sections.get(PINNED), arrange));
        wire.add(section(ACTIVE, "section-active", false, sections.get(ACTIVE), arrange));
        wire.add(section(WORKING, "section-working", false, sections.get(WORKING), arrange));
        wire.add(section(SNOOZED, "section-snoozed", true, sections.get(SNOOZED), arrange));
        wire.add(section(SETTLED, "section-settled", true, sections.get(SETTLED), arrange));
        Ui.ListBuilder list = Ui.list().id(SECTIONS_ID).sections(wire);
        boolean empty = sections.values().stream().allMatch(List::isEmpty);
        if (empty) {
            list.empty(Ui.text(EMPTY_STATE).style("caption").build());
        }
        return list.build();
    }

    /** The second pane: the chat content placeholder until T100 lands. */
    static UiNode contentPane() {
        return Ui.card()
                .title(SELECT_THREAD_TITLE)
                .child(Ui.text(SELECT_THREAD_BODY).style("caption").build())
                .build();
    }

    /**
     * The section membership of every visible session: Pinned, Active,
     * Working, Snoozed and Settled in render order, each already sorted.
     *
     * @param sessions the sessions one caller may see
     * @param now      the wall clock, epoch milliseconds
     * @return section label to its ordered sessions
     */
    static Map<String, List<Session>> partition(List<Session> sessions, long now) {
        List<Session> pinned = new ArrayList<>();
        List<Session> active = new ArrayList<>();
        List<Session> working = new ArrayList<>();
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
            } else if (WORKING_STATUSES.contains(session.status())) {
                working.add(session);
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
                .thenComparing(Session::updatedAt, Comparator.reverseOrder())
                .thenComparing(Session::id));
        working.sort(Comparator
                .comparing(Session::updatedAt, Comparator.reverseOrder())
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
        sections.put(WORKING, List.copyOf(working));
        sections.put(SNOOZED, List.copyOf(snoozed));
        sections.put(SETTLED, List.copyOf(settled));
        return sections;
    }

    /**
     * One section spec: the uppercase header contract (label, count badge,
     * chevron via {@code collapsible}), the collapse default and its
     * {@code storeKey}, and the rows.
     */
    private static Map<String, Object> section(String label, String id, boolean collapsed,
                                               List<Session> sessions, boolean arrange) {
        Map<String, Object> section = new LinkedHashMap<>();
        section.put("label", label);
        section.put("id", id);
        section.put("collapsible", true);
        section.put("collapsed", collapsed);
        section.put("count", sessions.size());
        section.put("badgeStyle", BADGE_STYLE);
        section.put("uppercase", true);
        section.put("storeKey", "sidebar.section." + id.substring("section-".length())
                + ".collapsed");
        if (WORKING.equals(label)) {
            section.put("when", WORKING_WHEN);
        }
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
