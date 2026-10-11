/**
 * The thread sidebar of the {@code sessions} shell (T96 + T97): a resizable
 * {@code split} container — the five collapsible thread sections in the
 * first pane, the chat content placeholder in the second — over the grouped
 * {@code list} primitive. Each row carries the {@code session-row:<id>}
 * identity the {@code session_updated} patch frames target and an overflow
 * {@code menu} of lifecycle actions. Since T97 the first pane's list carries
 * the sidebar {@code header} block (wordmark, search input, New thread
 * button, collapsed-state chevron) and the {@code footer} block (connection
 * dot, account chip, Settings and profile-switch buttons), and every row
 * wears the full thread-row anatomy: the status indicator cluster, the
 * semibold truncated title, the workdir subtitle with the context chip and
 * the hover-revealed trailing cluster with the search-match marker and the
 * overflow menu.
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
 * <p><b>Header block (T97).</b> The wordmark (the bold product text — the
 * plan's T3Wordmark-style mark; upstream keeps the brand in the titlebar
 * row, {@code sidebar/SidebarChrome.tsx:125-140}, and the sidebar header row
 * holds search + scope + new thread, {@code sidebar/SidebarThreadHeader.tsx:
 * 31-36}), the search input with the plan's {@code "Search threads"}
 * placeholder (upstream's placeholder is {@code "Search"} with the
 * {@code aria-label} {@code "Search threads"},
 * {@code SidebarThreadHeader.tsx:73-74}), the primary {@code New thread}
 * button (upstream renders it as the {@code SquarePenIcon} header icon
 * button with the {@code New thread} tooltip,
 * {@code SidebarThreadHeader.tsx:117-127}) opening the new-thread form
 * dialog whose submit dispatches the real {@code create-session} action, and
 * the collapsed-state chevron — decorative in this build (the split has no
 * collapse mechanism yet), so it carries the {@code demo} marker.
 *
 * <p><b>Footer block (T97).</b> The connection dot with its label (the
 * {@code ConnectionStatusDot} port — upstream maps the connection phases to
 * dot tones, {@code components/ConnectionStatusDot.tsx:12-24}; the
 * server-rendered footer can only state the server-reachable
 * {@code Online} state), the account chip (initials avatar + handle) and the
 * two icon buttons: Settings ({@code navigate settings}, the upstream
 * {@code SidebarUtilityMenu} Settings entry,
 * {@code sidebar/SidebarChrome.tsx:196-201}) and profile switching (the
 * client-owned {@code openProfiles} directive).
 *
 * <p><b>Client-side search (T97).</b> The list carries the {@code search}
 * spec keyed on the header input's state id: as the user types, rows whose
 * title or subtitle match stay and non-matching rows collapse out, a
 * match-count line renders above the sections, and from two characters the
 * rows show the search-match pill (the {@code ThreadSearchMatch} port) in
 * the hover-revealed trailing cluster.
 *
 * <p><b>Row anatomy (T97).</b> Status indicator cluster (the
 * {@code statusIndicators} kinds, rendered by the client's
 * {@code ThreadStatusIndicators}) &rarr; content column (the title
 * {@code text-sm font-semibold truncate} — upstream renders the row title
 * {@code text-sm font-medium truncate},
 * {@code components/Sidebar.tsx:1620-1624}; the plan's semibold wins — and
 * the subtitle row: the muted workdir text plus the context chip pill
 * {@code px-1.5 py-0.5 text-xs} with the {@code Project: …} tooltip, the
 * {@code ThreadContextChip} port) &rarr; the trailing cluster (the
 * search-match marker and the overflow menu, revealed on hover via the
 * {@code hoverReveal} behaviour). Row states: default, hover
 * ({@code sidebar-row-hover}), selected ({@code sidebar-row-active} + ring)
 * and dragging — all client-rendered from the row props.
 *
 * <p><b>Status kinds (T97).</b> The {@code statusIndicators} list maps the
 * session state onto the plan's ten-kind set: the lifecycle state first
 * (settled &rarr; {@code settled}, snoozed &rarr; {@code snoozed}), then the
 * free-form status ({@code working}, {@code monitoring},
 * {@code needs-approval}, {@code needs-answer}, {@code failed},
 * {@code limited}; anything else — including unknown statuses — falls back
 * to {@code idle} and is logged), plus {@code pinned} appended while the
 * session is pinned (upstream keeps the pin glyph visible while pinned,
 * {@code components/Sidebar.tsx:1089-1096}). The icon mapping lives
 * client-side ({@code icon_registry.dart}); the upstream-lucide &rarr;
 * Material table is recorded in {@code evidence/T97/icon-map.json}.
 *
 * <p><b>Row identity.</b> Every row node is {@code session-row:<id>}, the id
 * the {@code session_updated} frames patch, and its props carry the frame
 * prop names of {@code EventFrames} ({@code title}, {@code workdir},
 * {@code status}, {@code pinned}, {@code pinnedOrder}, {@code settledAt},
 * {@code snoozedUntil}, {@code archivedAt}, {@code settledReason},
 * {@code sortOrder}) so a patch lands on matching keys.
 *
 * <p><b>Thread action menu (T98).</b> The overflow menu is the upstream
 * {@code threadActionMenu.logic.ts} item set (commit {@code 37de6cb}) ported
 * to the real lifecycle actions: the conditional {@code Pin thread} /
 * {@code Unpin thread} and {@code Settle thread} / {@code Un-settle thread},
 * the {@code Snooze} preset submenu ({@code In 1 hour}, {@code In 3 hours},
 * {@code This evening}, {@code Tomorrow}, {@code Next week} — the upstream
 * presets of {@code threadSettled.ts:255-303} with their {@code whenLabel}
 * time column — plus the separator-prefixed {@code Custom\u2026} opening the
 * decorative picker dialog whose confirm only toasts), {@code Regenerate
 * title}, the checked {@code Auto-settle behavior} submenu, the separator +
 * {@code Archive thread} and the destructive {@code Delete}. The undoable
 * transitions answer the upstream undo notice (the {@code toast} directive
 * with the {@code undo} action and the 5&nbsp;s window — {@code Settled 1
 * thread,} / {@code Snoozed 1 thread,} / {@code Unpinned 1 thread,} /
 * {@code Archived 1 thread,}, the wording of
 * {@code SidebarThreadUndoNotice.tsx:15,20}); pinning shows no notice
 * (upstream parity). Upstream items with no Jhin backend (branch, rename,
 * mark-unread, project filter, copy, project settings) are dropped, not
 * faked.
 *
 * <p><b>Hover preview (T98).</b> The row title is wrapped in the
 * {@code hover_card} primitive (the {@code ThreadHoverCard} port): the
 * title line over the workdir metadata row, opened after the upstream
 * 500&nbsp;ms hover delay, anchored to the right of the trigger.
 *
 * <p><b>Arrange mode.</b> With {@code arrange} on, the rows show the visual
 * drag handles (drag reordering itself is forbidden — the affordance is
 * visual only) and the overflow menu adds {@code Move up} / {@code Move down},
 * which dispatch the {@code reorder} action with the full ordered id list of
 * the affected section (the post-move order, computed at render time).
 *
 * <p><b>Drag choreography (T99).</b> Every row outside the Working shelf is
 * {@code draggable}: the client lifts it on a long-press and drives the
 * upstream drag choreography (t3code commit {@code 37de6cb}) — the revealed
 * label chip, the accent-coloured drop target, the pinned/active boundary
 * labels and the {@code Escape} cancel. The server resolves the drop verb
 * per (source, destination) pair — the port of {@code
 * resolveSidebarDropVerb} ({@code components/Sidebar.logic.ts:346-357}):
 * onto Pinned {@code pin}, onto Settled {@code settle}, out of Pinned
 * {@code unpin}, out of Settled {@code unsettle}, otherwise {@code wake};
 * the Working and Snoozed shelves are never destinations and a drop inside
 * the source section maps to no verb (the reorder goes through the menu's
 * Move entries). Each row carries:
 * <ul>
 *   <li>{@code dropTargets} — the destination sections with the badge word
 *       per target (the upstream {@code dropVerbBadge} words, {@code
 *       components/Sidebar.tsx:1041-1070}: {@code Pin}, {@code Unpin},
 *       {@code Settle}, {@code Un-settle}, {@code Wake}), the {@code
 *       accentWhenHovered} flag and the lifecycle action the drop
 *       dispatches exactly once;</li>
 *   <li>{@code dragLabel} — the reveal-label chip template (icon + word of
 *       the row's first target) the client swaps per hovered target;</li>
 *   <li>the Pinned and Active sections carry {@code boundaryLabel} (the
 *       upstream zero-height boundary markers, {@code
 *       components/Sidebar.tsx:5261-5280}, labels {@code Pinned} / {@code
 *       Active}) — the client reveals them only while a drag is live.</li>
 * </ul>
 *
 * <p><b>Arrange threads sheet (T99).</b> The overflow menu gains the
 * upstream mobile {@code Arrange threads} entry ({@code
 * docs/user/thread-sidebar.md:85-88}) opening the decorative bottom sheet:
 * the drag-handle rows of the arrangeable sections and the {@code Done}
 * button that closes it. The shell carries the {@code demo} marker — the
 * handles are visual only, nothing reorders from the sheet.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class SidebarBuilder {

    private static final Logger LOG = LoggerFactory.getLogger(SidebarBuilder.class);

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

    /**
     * The status words that map onto their own indicator kind; every other
     * status (including unknown ones) falls back to {@code idle}.
     */
    private static final Set<String> STATUS_KINDS = Set.of(
            "working", "monitoring", "needs-approval", "needs-answer",
            "failed", "limited");

    /**
     * The resting statuses that fall back to {@code idle} silently — the
     * plain session states, not unknown words.
     */
    private static final Set<String> RESTING_STATUSES = Set.of("active", "");

    /** The header search input's state id — the list's search key. */
    public static final String SEARCH_KEY = "sidebarSearch";

    /** The search-match pill threshold: matches highlight from two characters. */
    public static final int SEARCH_MATCH_MIN_CHARS = 2;

    /** The header wordmark text (the T3Wordmark-style bold product text). */
    static final String WORDMARK = "Jhin";

    /** The search input placeholder (the plan's T97 step 1). */
    static final String SEARCH_PLACEHOLDER = "Search threads";

    /** The new-thread button label (the plan's T97 step 1). */
    static final String NEW_THREAD_LABEL = "New thread";

    /** The connection label the server-rendered footer states. */
    static final String CONNECTION_LABEL = "Online";

    /** The count-badge surface token (the rounded-full pill background). */
    static final String BADGE_STYLE = "sidebar-control-surface";

    /** The empty-state node shown when the whole sidebar has no threads. */
    static final String EMPTY_STATE = "No threads yet.";

    /** The content-pane placeholder card (the chat area lands in T100). */
    static final String SELECT_THREAD_TITLE = "Select a thread";
    static final String SELECT_THREAD_BODY =
            "Choose a thread from the sidebar to open the conversation.";

    /**
     * The drop verbs (the upstream {@code SidebarDropVerb} set, {@code
     * components/Sidebar.logic.ts:344}).
     */
    public static final String VERB_PIN = "pin";
    public static final String VERB_UNPIN = "unpin";
    public static final String VERB_SETTLE = "settle";
    public static final String VERB_UNSETTLE = "unsettle";
    public static final String VERB_WAKE = "wake";

    /** The {@code Arrange threads} sheet title (the upstream mobile entry). */
    static final String ARRANGE_SHEET_TITLE = "Arrange threads";

    /** The arrange sheet's close button (the upstream {@code Done}). */
    static final String ARRANGE_DONE_LABEL = "Done";

    private SidebarBuilder() {
    }

    /**
     * The drop verb of one (source, destination) pair — the port of the
     * upstream {@code resolveSidebarDropVerb} ({@code
     * components/Sidebar.logic.ts:346-357}): the Working and Snoozed
     * shelves are never destinations, a drop inside the source section
     * maps to no verb, onto Pinned pins, onto Settled settles, out of
     * Pinned unpins, out of Settled un-settles, otherwise wakes.
     *
     * @param from the source section label
     * @param to   the destination section label, {@code null} for none
     * @return the verb, or {@code null} when the drop maps to no action
     */
    public static String dropVerb(String from, String to) {
        if (to == null || to.equals(from) || WORKING.equals(to) || SNOOZED.equals(to)) {
            return null;
        }
        if (PINNED.equals(to)) {
            return VERB_PIN;
        }
        if (SETTLED.equals(to)) {
            return VERB_SETTLE;
        }
        if (PINNED.equals(from)) {
            return VERB_UNPIN;
        }
        if (SETTLED.equals(from)) {
            return VERB_UNSETTLE;
        }
        return VERB_WAKE;
    }

    /**
     * The badge word of one verb — the upstream {@code dropVerbBadge}
     * labels ({@code components/Sidebar.tsx:1041-1070}).
     */
    public static String badgeWord(String verb) {
        return switch (verb) {
            case VERB_PIN -> "Pin";
            case VERB_UNPIN -> "Unpin";
            case VERB_SETTLE -> "Settle";
            case VERB_UNSETTLE -> "Un-settle";
            case VERB_WAKE -> "Wake";
            default -> throw new IllegalArgumentException("unknown drop verb: " + verb);
        };
    }

    /**
     * The badge icon of one verb — the upstream {@code dropVerbBadge}
     * glyphs ({@code PinIcon}, {@code PinOffIcon}, {@code CircleCheckIcon},
     * {@code Undo2Icon}, {@code AlarmClockOffIcon}) mapped onto the client
     * icon registry; the lucide {@code PinOff} has no Material
     * counterpart, so {@code highlight_off} stands in (the mapping is
     * recorded in {@code evidence/T99/icon-map.json}).
     */
    public static String badgeIcon(String verb) {
        return switch (verb) {
            case VERB_PIN -> "push_pin";
            case VERB_UNPIN -> "highlight_off";
            case VERB_SETTLE -> "check_circle";
            case VERB_UNSETTLE -> "undo";
            case VERB_WAKE -> "alarm_off";
            default -> throw new IllegalArgumentException("unknown drop verb: " + verb);
        };
    }

    /** One resolved drop destination: the section id and the verb. */
    public record DropTarget(String sectionId, String verb) {
    }

    /**
     * The drop destinations of one source section, in render order
     * (Pinned, Active, Settled — the Working and Snoozed shelves are never
     * destinations), each with its resolved verb.
     */
    public static List<DropTarget> dropTargetsOf(String from) {
        List<DropTarget> targets = new ArrayList<>();
        for (String to : List.of(PINNED, ACTIVE, SETTLED)) {
            String verb = dropVerb(from, to);
            if (verb != null) {
                targets.add(new DropTarget(
                        "section-" + to.toLowerCase(Locale.ROOT), verb));
            }
        }
        return List.copyOf(targets);
    }

    /**
     * Builds the sidebar node: the resizable {@code split} of the five
     * thread sections (first pane, with the header and footer blocks) and
     * the chat content placeholder (second).
     *
     * @param sessions the sessions one caller may see (archived ones are
     *                 dropped here)
     * @param now      the wall clock, epoch milliseconds (snooze expiry)
     * @param arrange  whether the reorder mode is on (drag handles and the
     *                 Move up / Move down menu entries)
     * @return the sidebar split node
     */
    public static UiNode build(List<Session> sessions, long now, boolean arrange) {
        return build(sessions, now, arrange, "local");
    }

    /**
     * Builds the sidebar node with an explicit account handle for the footer
     * chip.
     *
     * @param account the caller's account handle (the footer chip), never
     *                null
     * @return the sidebar split node
     */
    public static UiNode build(List<Session> sessions, long now, boolean arrange,
                               String account) {
        return Ui.split()
                .id(SPLIT_ID)
                .first(sectionsList(sessions, now, arrange, account))
                .second(contentPane())
                .initial(INITIAL_WIDTH)
                .min(MIN_WIDTH)
                .minSecond(MIN_SECOND_WIDTH)
                .persistKey(PERSIST_KEY)
                .build();
    }

    /**
     * The {@code session-row:<id>} row of one session, rebuilt for a live
     * {@code session_updated} patch ({@code EventFrames}): the very row the
     * sections list renders, with the neutral live context — no arrange
     * mode (so no Move entries) and the row's own section as the drag
     * source, resolved with the same rules {@link #partition} applies.
     *
     * @param session the updated session record
     * @param now     the wall clock, epoch milliseconds (snooze expiry)
     * @return the row node
     */
    public static UiNode sessionRow(Session session, long now) {
        String section = sectionOf(session, now);
        return row(session, List.of(session.id()), 0, false, now,
                List.of(session.title()), section);
    }

    /**
     * The section one session belongs to, in the {@link #partition} rule
     * order: pinned, settled, snoozed (while the snooze is still the
     * future), working and active.
     */
    private static String sectionOf(Session session, long now) {
        if (session.pinned()) {
            return PINNED;
        }
        if (session.settledAt() != null) {
            return SETTLED;
        }
        if (session.snoozedUntil() != null && session.snoozedUntil() > now) {
            return SNOOZED;
        }
        if (WORKING_STATUSES.contains(session.status())) {
            return WORKING;
        }
        return ACTIVE;
    }

    /**
     * The first pane: the grouped {@code list} of the five thread sections
     * with the T97 header and footer blocks and the client-side search spec.
     */
    private static UiNode sectionsList(List<Session> sessions, long now, boolean arrange,
                                       String account) {
        Map<String, List<Session>> sections = partition(sessions, now);
        // The arrange sheet lists the arrangeable threads (the upstream
        // mobile sheet scopes Pinned and Active,
        // docs/user/thread-sidebar.md:85-88).
        List<String> arrangeTitles = new ArrayList<>();
        for (Session session : sections.get(PINNED)) {
            arrangeTitles.add(session.title());
        }
        for (Session session : sections.get(ACTIVE)) {
            arrangeTitles.add(session.title());
        }
        List<Object> wire = new ArrayList<>();
        wire.add(section(PINNED, "section-pinned", false, sections.get(PINNED), arrange, now,
                arrangeTitles));
        wire.add(section(ACTIVE, "section-active", false, sections.get(ACTIVE), arrange, now,
                arrangeTitles));
        wire.add(section(WORKING, "section-working", false, sections.get(WORKING), arrange, now,
                arrangeTitles));
        wire.add(section(SNOOZED, "section-snoozed", true, sections.get(SNOOZED), arrange, now,
                arrangeTitles));
        wire.add(section(SETTLED, "section-settled", true, sections.get(SETTLED), arrange, now,
                arrangeTitles));
        Ui.ListBuilder list = Ui.list().id(SECTIONS_ID).sections(wire)
                .header(header())
                .footer(footer(account))
                .search(Map.of(
                        "key", SEARCH_KEY,
                        "fields", List.of("title", "subtitle")));
        boolean empty = sections.values().stream().allMatch(List::isEmpty);
        if (empty) {
            list.empty(Ui.text(EMPTY_STATE).style("caption").build());
        }
        return list.build();
    }

    /**
     * The header block: the wordmark row (wordmark + collapsed-state
     * chevron) over the search row (input + New thread button).
     */
    static UiNode header() {
        return Ui.column()
                .id("sidebar-header")
                .gap(8)
                .child(brandRow())
                .child(searchRow())
                .build();
    }

    /** The brand row: the bold wordmark and the collapsed-state chevron. */
    private static UiNode brandRow() {
        return Ui.row()
                .id("sidebar-brand")
                .align("center")
                .child(Ui.text(WORDMARK).style("h3").bold(true).build())
                .child(Ui.spacer().build())
                .child(Ui.iconButton()
                        .icon("chevron_right")
                        // No collapse mechanism behind the split yet: the
                        // chevron is decorative and carries the demo marker.
                        .set("demo", true)
                        .build())
                .build();
    }

    /** The search row: the search input and the New thread button. */
    private static UiNode searchRow() {
        return Ui.row()
                .id("sidebar-search")
                .align("center")
                .gap(8)
                .child(Ui.input(SEARCH_KEY)
                        .placeholder(SEARCH_PLACEHOLDER)
                        .flex(1)
                        .build())
                .child(Ui.button(NEW_THREAD_LABEL)
                        .style("primary")
                        .icon("add")
                        .action(Directives.dialog(newThreadDialog()))
                        .build())
                .build();
    }

    /**
     * The new-thread dialog: the form whose submit dispatches the real
     * {@code create-session} action with the two dialog inputs included
     * (their values ride the UiState ids, so the include survives the
     * dialog overlay).
     */
    static UiNode newThreadDialog() {
        return Ui.column()
                .id("new-thread-dialog")
                .gap(12)
                .child(Ui.text(NEW_THREAD_LABEL).style("h3").build())
                .child(Ui.form()
                        .field(Ui.input("newThreadTitle")
                                .label("Title")
                                .required(true)
                                .errorText("A title is required")
                                .build())
                        .field(Ui.input("newThreadWorkdir")
                                .label("Working directory")
                                .required(true)
                                .errorText("A working directory is required")
                                .build())
                        .submit("Create thread", ActionDescriptors.of(
                                "create-session", null,
                                List.of("newThreadTitle", "newThreadWorkdir")))
                        .build())
                .build();
    }

    /**
     * The footer block: the connection dot with its label, the account chip
     * and the Settings / profile-switch icon buttons.
     */
    static UiNode footer(String account) {
        String handle = account == null || account.isBlank() ? "local" : account;
        return Ui.row()
                .id("sidebar-footer")
                .align("center")
                .gap(8)
                .child(connectionDot())
                .child(Ui.avatar()
                        .initials(initialsOf(handle))
                        .size(20)
                        .shape("circle")
                        .build())
                .child(Ui.text(handle).style("small").flex(1).build())
                .child(Ui.iconButton()
                        .icon("settings")
                        .tooltip("Settings")
                        .action(Directives.navigate("settings"))
                        .build())
                .child(Ui.iconButton()
                        .icon("person")
                        .tooltip("Switch profile")
                        .action(Directives.openProfiles())
                        .build())
                .build();
    }

    /**
     * The connection dot: the success-toned 8 px dot with the
     * {@code Online} label — the {@code ConnectionStatusDot} port. The
     * server-rendered footer states the server-reachable phase; the offline
     * rendering is a client concern this todo does not wire.
     */
    private static UiNode connectionDot() {
        return Ui.row()
                .id("sidebar-status-dot")
                .align("center")
                .gap(4)
                .tooltip(CONNECTION_LABEL)
                .child(Ui.box()
                        .width(8)
                        .height(8)
                        .color("$color.success")
                        .shape("circle")
                        .build())
                .child(Ui.text(CONNECTION_LABEL).style("caption").build())
                .build();
    }

    /** The chip initials of one handle: the first two characters, uppercased. */
    public static String initialsOf(String handle) {
        String trimmed = handle.trim();
        if (trimmed.isEmpty()) {
            return "?";
        }
        return trimmed.substring(0, Math.min(2, trimmed.length())).toUpperCase();
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
     * {@code storeKey}, the T99 {@code boundaryLabel} on the Pinned and
     * Active sections (the upstream zero-height boundary markers) and the
     * rows.
     */
    private static Map<String, Object> section(String label, String id, boolean collapsed,
                                               List<Session> sessions, boolean arrange,
                                               long now, List<String> arrangeTitles) {
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
        if (PINNED.equals(label) || ACTIVE.equals(label)) {
            // The T99 boundary labels (the upstream zero-height markers,
            // components/Sidebar.tsx:5261-5280): revealed only while a
            // drag is live.
            section.put("boundaryLabel", label);
        }
        if (WORKING.equals(label)) {
            section.put("when", WORKING_WHEN);
        }
        List<Object> rows = new ArrayList<>();
        List<String> ids = sessions.stream().map(Session::id).toList();
        for (int i = 0; i < sessions.size(); i++) {
            rows.add(row(sessions.get(i), ids, i, arrange, now, arrangeTitles, label));
        }
        section.put("items", rows);
        return section;
    }

    /**
     * One thread row: the {@code session-row:<id>} {@code list_row} with the
     * T97 anatomy — the status indicator cluster, the semibold truncated
     * title (T98: wrapped in the hover preview card), the workdir subtitle
     * with the context chip, the hover-revealed trailing cluster
     * (search-match marker + overflow menu) and the frame props. Since T99
     * every row outside the Working shelf is {@code draggable} and carries
     * the {@code dropTargets} (the resolved verb per destination with the
     * lifecycle action) and the {@code dragLabel} chip template.
     */
    private static UiNode row(Session session, List<String> sectionIds,
                              int index, boolean arrange, long now,
                              List<String> arrangeTitles, String sectionLabel) {
        Ui.ListRowBuilder row = Ui.listRow()
                .id("session-row:" + session.id())
                .title(hoverCard(session))
                .subtitle(subtitle(session))
                .trailing(menu(session, sectionIds, index, arrange, now, arrangeTitles))
                .statusIndicators(statusKinds(session, now))
                .hoverReveal(true)
                .searchMatch(Map.of(
                        "key", SEARCH_KEY,
                        "minChars", SEARCH_MATCH_MIN_CHARS))
                .dragHandle(arrange)
                .action(Directives.navigate("chat:" + session.id()));
        // The T99 drag affordance: every row outside the Working shelf
        // lifts (the Working shelf is never a destination and its rows
        // stay put — the upstream shelf semantics).
        if (!WORKING.equals(sectionLabel)) {
            List<DropTarget> targets = dropTargetsOf(sectionLabel);
            row.draggable(true)
                    .dragLabel(dragLabelChip(targets.get(0).verb()))
                    .dropTargets(wireTargets(session.id(), targets));
        }
        // The session lifecycle fields, carried under stable names: the
        // session_updated patch re-renders this row live from the same
        // record (see sessionRow).
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

    /**
     * The row title node: {@code text-sm font-semibold truncate} — fontSize
     * 14, weight 600, one line with the ellipsis (the plan's T97 step 2;
     * upstream renders the row title {@code text-sm font-medium truncate},
     * {@code components/Sidebar.tsx:1620-1624}).
     */
    private static UiNode title(String text) {
        return Ui.text(text)
                .fontSize(14)
                .fontWeight(600)
                .maxLines(1)
                .ellipsis(true)
                .build();
    }

    /**
     * The T98 hover preview card over the row title (the
     * {@code ThreadHoverCard} port — upstream wraps the row's title span in
     * the hover card, {@code components/Sidebar.tsx:2296-2317}, with the
     * popup {@code side="right"} {@code :438}): the trigger is the title
     * text, the content the {@code ThreadHoverCard} shape — the title line
     * ({@code text-xs font-medium truncate}, {@code ThreadHoverCard.tsx:27})
     * over the metadata rows ({@code text-xs text-muted-foreground},
     * {@code :30}; Jhin carries the workdir row only) — opened after the
     * upstream 500&nbsp;ms hover delay.
     */
    private static UiNode hoverCard(Session session) {
        return Ui.hoverCard()
                .trigger(title(session.title()))
                .content(Ui.column()
                        .id("thread-hover-card")
                        .gap(6)
                        .child(Ui.text(session.title())
                                .fontSize(12)
                                .fontWeight(500)
                                .maxLines(1)
                                .ellipsis(true)
                                .build())
                        .child(Ui.row()
                                .align("center")
                                .gap(8)
                                .child(Ui.icon().icon("folder").size(12).build())
                                .child(Ui.text(session.workdir() == null
                                                || session.workdir().isBlank()
                                                ? "—" : session.workdir())
                                        .fontSize(12)
                                        .color("$color.sidebar-muted-foreground")
                                        .maxLines(1)
                                        .ellipsis(true)
                                        .build())
                                .build())
                        .build())
                .delay(500)
                .placement("right")
                .build();
    }

    /**
     * The subtitle row: the muted workdir text plus the context chip pill
     * (the {@code ThreadContextChip} port — {@code px-1.5 py-0.5 text-xs}
     * with the {@code Project: …} tooltip). Jhin sessions carry no branch
     * field, so only the Project chip exists.
     */
    private static UiNode subtitle(Session session) {
        String workdir = session.workdir();
        Ui.RowBuilder row = Ui.row()
                .align("center")
                .gap(4)
                .child(Ui.text(workdir == null || workdir.isBlank() ? "—" : workdir)
                        .style("caption")
                        .color("$color.sidebar-muted-foreground")
                        .maxLines(1)
                        .ellipsis(true)
                        .flex(1)
                        .build());
        UiNode chip = contextChip(workdir);
        if (chip != null) {
            row.child(chip);
        }
        return row.build();
    }

    /**
     * The context chip pill: the workdir basename over the bordered pill
     * surface with the {@code Project: <workdir>} tooltip.
     */
    private static UiNode contextChip(String workdir) {
        if (workdir == null || workdir.isBlank()) {
            return null;
        }
        return Ui.box()
                .id("thread-context-chip")
                .padding(Map.of("left", 6, "right", 6, "top", 2, "bottom", 2))
                .border("$color.border")
                .borderRadius("$radius.sm")
                .tooltip("Project: " + workdir)
                .child(Ui.text(basename(workdir))
                        .fontSize(12)
                        .maxLines(1)
                        .ellipsis(true)
                        .build())
                .build();
    }

    /** The last path segment of one workdir (the chip label). */
    static String basename(String workdir) {
        String trimmed = workdir.trim();
        while (trimmed.endsWith("/") && trimmed.length() > 1) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        int slash = trimmed.lastIndexOf('/');
        return slash >= 0 && slash < trimmed.length() - 1
                ? trimmed.substring(slash + 1)
                : trimmed;
    }

    /**
     * The status indicator kinds of one session, in render order: the
     * lifecycle kind (settled / snoozed while the snooze is still in the
     * future — an expired snooze falls through to the status kind, the same
     * rule the section partition applies), the status kind (working,
     * monitoring, needs-approval, needs-answer, failed, limited — anything
     * else falls back to {@code idle} and is logged) and {@code pinned}
     * while pinned.
     */
    static List<String> statusKinds(Session session, long now) {
        List<String> kinds = new ArrayList<>();
        if (session.settledAt() != null) {
            kinds.add("settled");
        } else if (session.snoozedUntil() != null && session.snoozedUntil() > now) {
            kinds.add("snoozed");
        } else {
            kinds.add(statusKind(session.status()));
        }
        if (session.pinned()) {
            kinds.add("pinned");
        }
        return List.copyOf(kinds);
    }

    /**
     * The status word &rarr; indicator kind: the six known words pass
     * through, the resting statuses ({@code active}, blank) fall back to
     * {@code idle} silently, and anything else falls back to {@code idle}
     * with a log line.
     */
    private static String statusKind(String status) {
        if (status != null && STATUS_KINDS.contains(status)) {
            return status;
        }
        if (status == null || !RESTING_STATUSES.contains(status)) {
            LOG.info("sidebar: unknown session status \"{}\" renders the idle fallback indicator",
                    status == null ? "" : status);
        }
        return "idle";
    }

    /**
     * The overflow menu of one row (T98): the upstream
     * {@code threadActionMenu.logic.ts} item set (commit {@code 37de6cb}),
     * ported to the lifecycle actions of {@code jhin.sessions} —
     * <ul>
     *   <li>{@code Pin thread} / {@code Unpin thread} (conditional, upstream
     *       {@code :121-127});</li>
     *   <li>{@code Settle thread} / {@code Un-settle thread} (conditional,
     *       upstream {@code :131-137});</li>
     *   <li>{@code Snooze} with the preset submenu — the upstream presets of
     *       {@code threadSettled.ts:255-303} ({@code In 1 hour}, {@code
     *       In 3 hours}, {@code This evening} while it is meaningfully
     *       before evening, {@code Tomorrow}, {@code Next week} unless it
     *       collapses onto {@code Tomorrow}) plus {@code Custom\u2026}
     *       (upstream {@code :138-156}); while snoozed the entry becomes
     *       {@code Wake thread} (upstream {@code :140-141});</li>
     *   <li>{@code Regenerate title} (upstream {@code :158-167});</li>
     *   <li>{@code Auto-settle behavior} with the checked {@code Enabled} /
     *       {@code Disabled} submenu (upstream {@code :184-204});</li>
     *   <li>the T99 {@code Arrange threads} entry (the upstream mobile
     *       affordance, {@code docs/user/thread-sidebar.md:85-88}) opening
     *       the decorative arrange sheet;</li>
     *   <li>{@code Archive thread} above the separator (upstream
     *       {@code :224-230}) and the destructive {@code Delete} (upstream
     *       {@code :231-236});</li>
     *   <li>in arrange mode the {@code Move up} / {@code Move down} reorder
     *       entries (the T76 port of the upstream drag choreography).</li>
     * </ul>
     *
     * <p>Upstream items with no Jhin backend are dropped, not faked: the
     * branch entry ({@code :112-120} — sessions carry no branch), {@code
     * Rename thread} ({@code :157} — no rename action), {@code Mark unread}
     * ({@code :168} — no unread state), the project filter ({@code :169-179}
     * — no projects), the {@code Copy} submenu ({@code :205-217}) and
     * {@code Project settings} ({@code :218}). The upstream {@code rename}
     * separator moves onto {@code Regenerate title} so the visual group
     * boundary survives. Archive's upstream {@code disabled: isRunning}
     * ({@code :228}) is dropped — Jhin sessions carry no running flag.
     */
    private static UiNode menu(Session session, List<String> sectionIds,
                               int index, boolean arrange, long now,
                               List<String> arrangeTitles) {
        String id = session.id();
        boolean snoozed = session.snoozedUntil() != null && session.snoozedUntil() > now;
        Ui.MenuBuilder menu = Ui.menu()
                .trigger(Ui.iconButton().icon("more_vert")
                        .action(ActionDescriptors.of("noop"))
                        .build());
        if (session.pinned()) {
            menu.item(Ui.menuItem("Unpin thread")
                    .icon("keep_off")
                    .action(ActionDescriptors.of("unpin", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Pin thread")
                    .icon("keep")
                    .action(ActionDescriptors.of("pin", Map.of("id", id), null))
                    .build());
        }
        if (session.settledAt() != null) {
            menu.item(Ui.menuItem("Un-settle thread")
                    .icon("check_circle")
                    .action(ActionDescriptors.of("unsettle", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Settle thread")
                    .icon("check_circle")
                    .action(ActionDescriptors.of("settle", Map.of("id", id), null))
                    .build());
        }
        if (snoozed) {
            menu.item(Ui.menuItem("Wake thread")
                    .icon("schedule")
                    .action(ActionDescriptors.of("wake", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Snooze")
                    .icon("schedule")
                    .children(snoozeChildren(id, now))
                    .build());
        }
        menu.item(Ui.menuItem("Regenerate title")
                .icon("refresh")
                .separatorBefore(true)
                .action(ActionDescriptors.of("regenerate-title", Map.of("id", id), null))
                .build());
        menu.item(Ui.menuItem("Auto-settle behavior")
                .icon("timer")
                .children(autoSettleChildren(id, session.autoSettle()))
                .build());
        // The T99 mobile arrange entry (the upstream
        // docs/user/thread-sidebar.md:85-88 affordance): opens the
        // decorative arrange sheet.
        menu.item(Ui.menuItem("Arrange threads")
                .icon("drag_handle")
                .action(Directives.dialog(arrangeSheet(arrangeTitles), "sheet"))
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
        menu.item(Ui.menuItem("Archive thread")
                .icon("archive")
                .separatorBefore(true)
                .action(ActionDescriptors.of("archive", Map.of("id", id), null))
                .confirm("Archive this thread?")
                .build());
        menu.item(Ui.menuItem("Delete")
                .icon("delete")
                .action(ActionDescriptors.of("delete-session", Map.of("id", id), null))
                .confirm("Delete this thread? This cannot be undone.")
                .danger(true)
                .build());
        return menu.build();
    }

    /**
     * The {@code Snooze} submenu children: one entry per upstream preset —
     * the label {@code <preset> (<when>)} of {@code threadActionMenu.logic.ts:
     * 148-151} dispatching {@code snooze} with the preset's {@code until} —
     * plus the separator-prefixed {@code Custom\u2026} (upstream
     * {@code :152}) opening the decorative picker dialog.
     */
    private static List<Map<String, Object>> snoozeChildren(String id, long now) {
        List<Map<String, Object>> children = new ArrayList<>();
        for (SnoozePreset preset : snoozePresets(now)) {
            children.add(Ui.menuItem(preset.label() + " (" + preset.whenLabel() + ")")
                    .action(ActionDescriptors.of("snooze",
                            Map.of("id", id, "until", preset.until()), null))
                    .build());
        }
        children.add(Ui.menuItem("Custom\u2026")
                .separatorBefore(true)
                .action(Directives.dialog(customSnoozeDialog(id)))
                .build());
        return children;
    }

    /**
     * The {@code Auto-settle behavior} submenu children (upstream
     * {@code threadActionMenu.logic.ts:190-201}): the checked
     * {@code Enabled} / {@code Disabled} radio entries dispatching the
     * {@code auto-settle} action.
     */
    private static List<Map<String, Object>> autoSettleChildren(String id, boolean enabled) {
        return List.of(
                Ui.menuItem("Enabled")
                        .checked(enabled)
                        .action(ActionDescriptors.of("auto-settle",
                                Map.of("id", id, "enabled", true), null))
                        .build(),
                Ui.menuItem("Disabled")
                        .checked(!enabled)
                        .action(ActionDescriptors.of("auto-settle",
                                Map.of("id", id, "enabled", false), null))
                        .build());
    }

    /**
     * The T99 reveal-label chip template of one row: the icon + word of the
     * row's first drop target (the client swaps both per hovered target and
     * paints the primary-tinted pill surface around it — the upstream
     * {@code dropVerbBadge} chip, {@code components/Sidebar.tsx:1586-1592}).
     */
    static UiNode dragLabelChip(String verb) {
        return Ui.row()
                .id("drag-label")
                .gap(4)
                .child(Ui.icon().icon(badgeIcon(verb)).size(12).build())
                .child(Ui.text(badgeWord(verb)).fontSize(12).fontWeight(500).build())
                .build();
    }

    /**
     * The wire shape of one row's drop targets: the destination section id,
     * the badge word, the {@code accentWhenHovered} flag and the lifecycle
     * action the drop dispatches exactly once.
     */
    private static List<Map<String, Object>> wireTargets(String sessionId,
                                                         List<DropTarget> targets) {
        List<Map<String, Object>> wire = new ArrayList<>();
        for (DropTarget target : targets) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("id", target.sectionId());
            entry.put("label", badgeWord(target.verb()));
            entry.put("accentWhenHovered", true);
            entry.put("action", ActionDescriptors.of(target.verb(),
                    Map.of("id", sessionId), null));
            wire.add(entry);
        }
        return List.copyOf(wire);
    }

    /**
     * The decorative arrange sheet (the plan's T99 step 5 — the upstream
     * mobile {@code Arrange threads} affordance, {@code
     * docs/user/thread-sidebar.md:85-88}): the drag-handle rows of the
     * arrangeable sections and the {@code Done} button that closes the
     * sheet. The shell carries the {@code demo} marker — the handles are
     * visual only, nothing reorders from the sheet.
     */
    public static UiNode arrangeSheet(List<String> titles) {
        List<Object> rows = new ArrayList<>();
        for (String title : titles) {
            rows.add(Ui.listRow()
                    .title(title)
                    .dragHandle(true)
                    .build());
        }
        return Ui.sheet()
                .title(ARRANGE_SHEET_TITLE)
                .body(Ui.column()
                        .id("arrange-sheet-body")
                        .gap(4)
                        .children(rows)
                        .build())
                .footer(Ui.row()
                        .align("center")
                        .child(Ui.spacer().build())
                        .child(Ui.button(ARRANGE_DONE_LABEL)
                                .style("primary")
                                .action(Directives.dismissDialog())
                                .build())
                        .build())
                .set("demo", true)
                .build();
    }

    /**
     * The decorative custom-snooze dialog (the plan's T98 step 2): a
     * duration input and a confirm whose {@code demo-snooze} action only
     * closes the dialog and toasts — nothing persists. The whole shell
     * carries the {@code demo} marker.
     */
    public static UiNode customSnoozeDialog(String sessionId) {
        return Ui.column()
                .id("custom-snooze-dialog")
                .gap(12)
                .set("demo", true)
                .child(Ui.text("Custom snooze").style("h3").build())
                .child(Ui.form()
                        .field(Ui.input("customSnoozeHours")
                                .label("Hours from now")
                                .required(true)
                                .errorText("A number of hours is required")
                                .build())
                        .submit("Confirm", ActionDescriptors.of("demo-snooze", null, null))
                        .build())
                .child(Ui.button("Cancel")
                        .style("text")
                        .action(Directives.dismissDialog())
                        .build())
                .build();
    }

    /** One upstream snooze preset ({@code threadSettled.ts:219-225}). */
    public record SnoozePreset(String id, String label, String whenLabel, long until) {
    }

    /**
     * The upstream snooze presets of one instant in the host's default zone
     * (the upstream presets read the browser's local calendar,
     * {@code threadSettled.ts:255-303}).
     */
    static List<SnoozePreset> snoozePresets(long now) {
        return snoozePresets(now, ZoneId.systemDefault());
    }

    /**
     * The upstream snooze presets of one instant in one zone ({@code
     * threadSettled.ts:255-303}): the two fixed offsets, {@code This
     * evening} while it is meaningfully before 18:00, {@code Tomorrow} at
     * 09:00 and {@code Next week} on Monday 09:00 unless it collapses onto
     * the {@code Tomorrow} instant (a Sunday).
     */
    public static List<SnoozePreset> snoozePresets(long now, ZoneId zone) {
        ZonedDateTime base = Instant.ofEpochMilli(now).atZone(zone);
        List<SnoozePreset> presets = new ArrayList<>();
        presets.add(new SnoozePreset("hour", "In 1 hour",
                timeLabel(base.plusHours(1)), now + 3_600_000L));
        presets.add(new SnoozePreset("three-hours", "In 3 hours",
                timeLabel(base.plusHours(3)), now + 3 * 3_600_000L));
        ZonedDateTime evening = base.withHour(18).withMinute(0).withSecond(0).withNano(0);
        if (evening.toInstant().toEpochMilli() - now > 3_600_000L) {
            presets.add(new SnoozePreset("evening", "This evening",
                    timeLabel(evening), evening.toInstant().toEpochMilli()));
        }
        ZonedDateTime tomorrow = base.plusDays(1).withHour(9).withMinute(0)
                .withSecond(0).withNano(0);
        presets.add(new SnoozePreset("tomorrow", "Tomorrow",
                timeLabel(tomorrow), tomorrow.toInstant().toEpochMilli()));
        int daysUntilMonday = (1 - base.getDayOfWeek().getValue() + 7) % 7;
        if (daysUntilMonday == 0) {
            daysUntilMonday = 7;
        }
        ZonedDateTime nextWeek = base.plusDays(daysUntilMonday).withHour(9).withMinute(0)
                .withSecond(0).withNano(0);
        if (!nextWeek.toInstant().equals(tomorrow.toInstant())) {
            presets.add(new SnoozePreset("next-week", "Next week",
                    WEEKDAY_TIME.format(nextWeek), nextWeek.toInstant().toEpochMilli()));
        }
        return List.copyOf(presets);
    }

    /** The clock format of the preset {@code whenLabel} (upstream {@code h:mm a}). */
    private static final DateTimeFormatter TIME_LABEL =
            DateTimeFormatter.ofPattern("h:mm a", Locale.ROOT);

    /** The {@code Next week} label: the short weekday over the clock time. */
    private static final DateTimeFormatter WEEKDAY_TIME =
            DateTimeFormatter.ofPattern("EEE h:mm a", Locale.ROOT);

    /** The {@code h:mm a} label of one zoned instant. */
    private static String timeLabel(ZonedDateTime at) {
        return TIME_LABEL.format(at);
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
