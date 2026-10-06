/**
 * The right panel of the chat screen (T105): the tab strip with per-tab
 * close buttons over the {@code ThreadDetailsPanel} shell.
 *
 * <p><b>Chrome.</b> The panel is a {@code positioned} overlay docked to the
 * right edge of the chat frame, layered above the content (the upstream
 * {@code --z-sheet} 46, index.css:115). It is gated by the chat header's
 * {@code setState} toggle ({@link ChatScreen#STATE_RIGHT_PANEL}): the slot
 * carries {@code when: chat_right_panel == true}, so the toggle opens it and
 * closing the last tab hides it again. The panel paints the sidebar surface
 * ({@code $color.sidebar}) with the {@code border-l} hairline
 * ({@code $color.sidebar-border}) at the upstream
 * {@code --thread-details-panel-width} 17.5rem (index.css:129, the
 * {@code layout.threadDetailsPanelWidth} token value).
 *
 * <p><b>Tab bar.</b> The six upstream tab kinds — {@code Details},
 * {@code Diff}, {@code Files}, {@code Preview}, {@code Pull Requests},
 * {@code Usage} — are a {@code tabs} node with {@code hasClose: true}: each
 * item carries an icon, a label and a close {@code X} (the upstream
 * {@code PanelTabCloseButton}, {@code size-4} = 16&nbsp;px hit target,
 * {@code components/ui/panel-tab-close-button.tsx:20-27}). The active tab
 * uses {@code sidebar-row-active}, the inactive label
 * {@code sidebar-muted-foreground}, gap 1 and the {@code px-3 py-2} inset
 * (the upstream {@code gap-1 ... pr-2 pl-1.5 text-xs} row,
 * {@code RightPanelTabs.tsx:1109-1114}). Closing a tab is a client-side
 * {@code patch} on the tabs node's {@code id}; the last close runs the node
 * {@code closeAction} (the panel {@code setState} off). A tab marked
 * {@code closable: false} is a no-op (the pinned case).
 *
 * <p><b>Details tab.</b> The {@code ThreadDetailsPanel} shell (T105.2): the
 * thread title with its status indicator, the model / effort / provider
 * label rows, the created / updated / settled timing rows, the decorative
 * {@code ThreadRelationshipsControl} (parent / child rows) and the
 * decorative {@code ThreadDetailsPrRows} with the {@code Link to thread}
 * menu entries. Every interactive node is {@code demo}-marked and dispatches
 * inline directives only (never a database write, plan section 14.10). The
 * other five tabs mount an empty state until their phase-E/F owners fill
 * them.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class RightPanelBuilder {

    /** The positioned overlay slot id (the {@code when} carrier). */
    public static final String SLOT_ID = "right-panel-slot";

    /** The panel surface id (the width / background / border carrier). */
    public static final String PANEL_ID = "right-panel";

    /** The tabs node id (the patch target of a tab close). */
    public static final String TABS_ID = "right-panel-tabs";

    /** The Details tab body id. */
    public static final String DETAILS_ID = "right-panel-details";

    /** The Details tab status badge id. */
    public static final String STATUS_ID = "right-panel-status";

    /** The relationships section id (the decorative control shell). */
    public static final String RELATIONSHIPS_ID = "right-panel-relationships";

    /** The pull-requests section id (the decorative PR rows shell). */
    public static final String PRS_ID = "right-panel-prs";

    /**
     * The panel width: the upstream {@code --thread-details-panel-width}
     * default (17.5rem, index.css:129; the {@code layout.threadDetailsPanelWidth}
     * token value). The client parses the length against its interface
     * font-size rem base (the {@code container.panelWidth} prop).
     */
    public static final String PANEL_WIDTH = "17.5rem";

    /** The timestamp label format (the upstream panel's local clock). */
    private static final DateTimeFormatter TIMESTAMP =
            DateTimeFormatter.ofPattern("MMM d, h:mm a", Locale.ROOT);

    private RightPanelBuilder() {
    }

    /**
     * Builds the right-panel overlay of one chat session.
     *
     * @param session the session the chat screen is opened for
     * @param status  the run status label ({@link MessageCardBuilder#STATUS_IDLE},
     *                {@link MessageCardBuilder#STATUS_RUNNING} or
     *                {@link MessageCardBuilder#STATUS_LIMITED})
     * @return the positioned overlay slot carrying the panel
     */
    public static UiNode build(Session session, String status) {
        return Ui.positioned()
                .id(SLOT_ID)
                .top(0)
                .right(0)
                .bottom(0)
                .when(ChatScreen.STATE_RIGHT_PANEL + " == true")
                .child(panel(session, status))
                .build();
    }

    /** The panel surface: the sidebar fill, the left hairline and the tab strip. */
    private static UiNode panel(Session session, String status) {
        return Ui.container()
                .id(PANEL_ID)
                .direction("column")
                .gap(0)
                .set("panelWidth", PANEL_WIDTH)
                .color("$color.sidebar")
                .border("$color.sidebar-border")
                .borderWidth(1)
                .child(tabStrip(session, status))
                .build();
    }

    /**
     * The tab strip: the six upstream panel tabs with close buttons. The
     * node's {@code closeAction} runs when the last closable tab closes,
     * flipping the panel's {@code when} condition off (the panel close).
     */
    private static UiNode tabStrip(Session session, String status) {
        return Ui.tabs()
                .id(TABS_ID)
                .activeIndex(0)
                .hasClose(true)
                .closeAction(Directives.setState(ChatScreen.STATE_RIGHT_PANEL, false))
                .set("demo", true)
                .item(Ui.tabItem("Details").icon("info").panel(details(session, status)))
                .item(emptyTab("Diff", "difference", "No changes yet."))
                .item(emptyTab("Files", "folder", "No changed files."))
                .item(emptyTab("Preview", "public",
                        "Preview is not available in this build."))
                .item(emptyTab("Pull Requests", "call_merge", "No linked pull requests."))
                .item(emptyTab("Usage", "bar_chart", "No usage recorded."))
                .build();
    }

    /** One not-yet-implemented tab: the icon plus the empty-state body. */
    private static Ui.TabItemBuilder emptyTab(String label, String icon, String message) {
        return Ui.tabItem(label).icon(icon).panel(emptyState(message));
    }

    /** The empty-state body of a tab whose phase-E/F owner has not landed. */
    private static UiNode emptyState(String message) {
        return Ui.column()
                .padding(12)
                .child(Ui.text(message)
                        .fontSize(12)
                        .color("$color.sidebar-muted-foreground")
                        .build())
                .build();
    }

    /** The Details tab body: the {@code ThreadDetailsPanel} shell. */
    private static UiNode details(Session session, String status) {
        return Ui.column()
                .id(DETAILS_ID)
                .gap(12)
                .padding(12)
                .child(detailsHeader(session, status))
                .child(labelRows(session))
                .child(timingRows(session))
                .child(relationships())
                .child(pullRequests())
                .build();
    }

    /** The title + status indicator row of the Details panel. */
    private static UiNode detailsHeader(Session session, String status) {
        Ui.BadgeBuilder badge = Ui.badge().id(STATUS_ID).label(status);
        String color = statusColor(status);
        if (color != null) {
            badge.color(color);
        }
        return Ui.row()
                .id("right-panel-header")
                .align("center")
                .gap(8)
                .child(Ui.text(session.title())
                        .fontSize(14)
                        .fontWeight(600)
                        .maxLines(1)
                        .ellipsis(true)
                        .flex(1)
                        .build())
                .child(badge.build())
                .build();
    }

    /** The model / effort / provider label rows. */
    private static UiNode labelRows(Session session) {
        return Ui.column()
                .gap(4)
                .child(infoRow("right-panel-model", "Model",
                        valueOrDash(session.model())))
                .child(infoRow("right-panel-effort", "Effort", "Med"))
                .child(infoRow("right-panel-provider", "Provider",
                        valueOrDash(session.providerId())))
                .build();
    }

    /** The created / updated / settled timing rows. */
    private static UiNode timingRows(Session session) {
        return Ui.column()
                .gap(4)
                .child(infoRow("right-panel-created", "Created",
                        timestamp(session.createdAt())))
                .child(infoRow("right-panel-updated", "Updated",
                        timestamp(session.updatedAt())))
                .child(infoRow("right-panel-settled", "Settled",
                        session.settledAt() == null ? "\u2014"
                                : timestamp(session.settledAt())))
                .build();
    }

    /** One label / value row: the muted label leading, the value trailing. */
    private static UiNode infoRow(String id, String label, String value) {
        return Ui.row()
                .id(id)
                .align("center")
                .gap(8)
                .child(Ui.text(label)
                        .fontSize(12)
                        .color("$color.sidebar-muted-foreground")
                        .build())
                .child(Ui.spacer().build())
                .child(Ui.text(value)
                        .fontSize(12)
                        .maxLines(1)
                        .ellipsis(true)
                        .build())
                .build();
    }

    /**
     * The decorative {@code ThreadRelationshipsControl} shell: the parent
     * and child rows. Each row is a {@code demo} button whose tap toasts the
     * preview notice — the real relationship graph does not exist in this
     * build (plan section 14.1).
     */
    private static UiNode relationships() {
        return Ui.column()
                .id(RELATIONSHIPS_ID)
                .gap(4)
                .child(sectionHeading("Relationships"))
                .child(relationshipRow("Parent thread", "corner_left_up",
                        "Fix the login bug"))
                .child(relationshipRow("Fork", "call_split",
                        "Add OAuth callback"))
                .build();
    }

    /** One decorative relationship row (parent / fork). */
    private static UiNode relationshipRow(String label, String icon, String title) {
        return Ui.button(title)
                .id("right-panel-rel-" + icon)
                .icon(icon)
                .style("text")
                .action(Directives.client(List.of(
                        Directives.toast(label + ": " + title + " (preview only)"))))
                .set("demo", true)
                .build();
    }

    /**
     * The decorative {@code ThreadDetailsPrRows} shell: the pull-request rows
     * with the {@code Link to thread} menu entries that only toast.
     */
    private static UiNode pullRequests() {
        return Ui.column()
                .id(PRS_ID)
                .gap(4)
                .child(sectionHeading("Pull requests"))
                .child(prRow("#142", "Add OAuth callback"))
                .child(prRow("#139", "Drop the legacy importer"))
                .build();
    }

    /** One decorative pull-request row with its link menu. */
    private static UiNode prRow(String number, String title) {
        return Ui.row()
                .id("right-panel-pr-" + number.substring(1))
                .align("center")
                .gap(8)
                .child(Ui.icon()
                        .icon("call_merge")
                        .size(16)
                        .color("$color.sidebar-muted-foreground")
                        .build())
                .child(Ui.text(number + ": " + title)
                        .fontSize(12)
                        .maxLines(1)
                        .ellipsis(true)
                        .flex(1)
                        .build())
                .child(linkMenu(number))
                .build();
    }

    /** The {@code Link to thread} menu of one PR row (toast-only entries). */
    private static UiNode linkMenu(String number) {
        return Ui.menu()
                .id("right-panel-pr-menu-" + number.substring(1))
                .trigger(Ui.iconButton()
                        .icon("more_horiz")
                        .tooltip("Pull request actions")
                        .build())
                .item(Ui.menuItem("Link to thread")
                        .icon("link")
                        .action(Directives.client(List.of(
                                Directives.toast("Linked " + number
                                        + " to this thread (preview only)"))))
                        .build())
                .item(Ui.menuItem("Unlink from thread")
                        .icon("link_off")
                        .action(Directives.client(List.of(
                                Directives.toast("Unlinked " + number
                                        + " (preview only)"))))
                        .build())
                .set("demo", true)
                .build();
    }

    /** One section heading (the muted uppercase-free label row). */
    private static UiNode sectionHeading(String title) {
        return Ui.text(title)
                .fontSize(12)
                .fontWeight(600)
                .color("$color.sidebar-muted-foreground")
                .padding(List.of(0, 0, 4, 0))
                .build();
    }

    /** The run-status badge colour, {@code null} for the default. */
    private static String statusColor(String status) {
        return switch (status) {
            case MessageCardBuilder.STATUS_RUNNING -> "$color.accent";
            case MessageCardBuilder.STATUS_LIMITED -> MessageCardBuilder.DANGER;
            default -> null;
        };
    }

    /** A nullable string as-is, an em dash when absent. */
    private static String valueOrDash(String value) {
        return value == null || value.isBlank() ? "\u2014" : value;
    }

    /** One epoch-millisecond timestamp as the panel's local clock label. */
    private static String timestamp(long epochMillis) {
        return TIMESTAMP.format(Instant.ofEpochMilli(epochMillis)
                .atZone(ZoneId.systemDefault()));
    }

    /** The list of tab labels, in render order (the QA assertion source). */
    public static List<String> tabLabels() {
        return new ArrayList<>(List.of(
                "Details", "Diff", "Files", "Preview", "Pull Requests", "Usage"));
    }
}
