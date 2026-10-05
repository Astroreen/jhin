/**
 * The shell chrome of the {@code sessions} screen (T95): the t3code app
 * frame every screen lives in — the fixed-height workspace top bar
 * (wordmark, breadcrumb, top-right control cluster), the body row (the
 * resizable sidebar | content split, T96), the page header row (title +
 * actions) and the stage-art backdrop flag behind the sidebar pane.
 *
 * <p>Upstream anchors (t3code {@code apps/web/src}, commit {@code 37de6cb}):
 * the top bar geometry is {@code WorkspacePageHeader} (the
 * {@code --workspace-topbar-height} 52 row with the workspace gutters and
 * the safe-area insets, {@code WorkspacePageHeader.tsx:17-26}), the
 * breadcrumb is {@code WorkspaceBreadcrumb} (the {@code nav > ol} of muted
 * crumbs with the current one in the foreground,
 * {@code WorkspaceBreadcrumb.tsx:11-21}) and the brand mark is the
 * {@code SidebarBrandMark} wordmark row ({@code SidebarChrome.tsx:125-140}).
 * The port is behavioural, not TSX (plan section 14.9): the same slots and
 * metrics authored as SDUI nodes.
 *
 * <p>The top bar carries two variants the client picks by width: {@code
 * topbar} (the full breadcrumb) and {@code topbarCompact} (the breadcrumb
 * condensed to the current title only, below the 768 px breakpoint). The
 * stage backdrop is the {@code stageBackdrop: true} shell prop — the client
 * paints the {@code theme.stageArt} gradient behind the sidebar under the
 * sidebar-stage fade mask.
 *
 * <p>Since T96 the body slot carries the sidebar {@code split} (the
 * resizable sections | content row, {@link SidebarBuilder}): the shell's
 * fixed-width sidebar pane cannot host a draggable divider, so the split
 * owns the whole row and the {@code sidebar} slot stays unset. The
 * {@code stageBackdrop} flag remains part of the contract for the shell
 * surfaces that do carry a sidebar pane.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class ShellScreen {

    /** The workspace crumb: the constant first breadcrumb item. */
    static final String WORKSPACE_CRUMB = "Workspace";

    /** The current-location crumb and the page header title. */
    static final String CURRENT_CRUMB = "Threads";

    /** The wordmark text (the T3Wordmark equivalent: the product name). */
    static final String WORDMARK = "Jhin";

    /** The breadcrumb separator (the upstream "/" crumb). */
    static final String CRUMB_SEPARATOR = "/";

    /** The fixed shell breakpoint (plan T95 step 7): the sidebar overlays below it. */
    static final int BREAKPOINT = 768;

    private ShellScreen() {
    }

    /**
     * Builds the thread shell screen of one caller.
     *
     * @param store         the session store to list from
     * @param account       the caller's account id, empty when unscoped
     * @param providersLink whether the providers screen exists to link at
     * @param arrange       whether the reorder mode is on
     * @return the screen node
     */
    public static UiNode render(SessionStore store, Optional<String> account,
                                boolean providersLink, boolean arrange) {
        List<Session> sessions = account.map(store::list).orElseGet(store::list);
        UiNode sidebar = SidebarBuilder.build(sessions, System.currentTimeMillis(), arrange);
        return Ui.screen()
                .title("Sessions")
                .body(Ui.shell()
                        .id("sessions-shell")
                        .breakpoint(BREAKPOINT)
                        .topbar(topbar(providersLink))
                        .topbarCompact(topbarCompact())
                        .pageHeader(pageHeader(arrange))
                        .stageBackdrop(true)
                        .body(sidebar)
                        .build())
                .build();
    }

    /**
     * The wide top bar: the wordmark, the full breadcrumb (workspace crumb,
     * separator, current location) and the top-right control cluster.
     */
    static UiNode topbar(boolean providersLink) {
        return Ui.row()
                .id("shell-topbar")
                .align("center")
                .child(wordmark())
                .child(breadcrumb())
                .child(Ui.spacer().build())
                .child(controls(providersLink))
                .build();
    }

    /**
     * The compact top bar below the breakpoint: the breadcrumb condensed to
     * the current title only (plan T95 step 7).
     */
    static UiNode topbarCompact() {
        return Ui.row()
                .id("shell-topbar-compact")
                .align("center")
                .child(wordmark())
                .child(Ui.text(CURRENT_CRUMB).style("body").build())
                .child(Ui.spacer().build())
                .build();
    }

    /** The brand mark: the bold product wordmark text. */
    private static UiNode wordmark() {
        return Ui.text(WORDMARK).style("h3").bold(true).build();
    }

    /**
     * The breadcrumb: the muted workspace crumb, the "/" separator and the
     * current location in the foreground — the WorkspaceBreadcrumb shape.
     */
    private static UiNode breadcrumb() {
        return Ui.row()
                .id("shell-breadcrumb")
                .align("center")
                .gap(8)
                .child(Ui.text(WORKSPACE_CRUMB).style("small").build())
                .child(Ui.text(CRUMB_SEPARATOR).style("small").build())
                .child(Ui.text(CURRENT_CRUMB).style("body").bold(true).build())
                .build();
    }

    /** The top-right control cluster: the app navigation tabs. */
    private static UiNode controls(boolean providersLink) {
        Ui.NavBuilder links = Ui.nav()
                .kind("tabs")
                .item("Sessions", "sessions")
                .item("Settings", "settings")
                .item("Plugins", "plugins")
                .activeIndex(0);
        if (providersLink) {
            links.item("Providers", "providers");
        }
        return links.build();
    }

    /**
     * The page header row: the page title plus the actions — the arrange
     * toggle (the server-side mode flipping through {@code arrange-toggle}).
     */
    static UiNode pageHeader(boolean arrange) {
        return Ui.row()
                .id("shell-page-header")
                .align("center")
                .child(Ui.text(CURRENT_CRUMB).style("h3").build())
                .child(Ui.spacer().build())
                .child(Ui.button(arrange ? "Done arranging" : "Arrange threads")
                        .style("secondary")
                        .action(ActionDescriptors.of("arrange-toggle",
                                Map.of("arrange", !arrange), null))
                        .build())
                .build();
    }
}
