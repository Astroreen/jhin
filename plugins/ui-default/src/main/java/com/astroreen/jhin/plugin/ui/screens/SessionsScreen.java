/**
 * The {@code sessions} screen: the t3code-shaped thread shell. The sidebar is
 * the four-section thread list of {@link SidebarBuilder} (Pinned, Active,
 * Snoozed, Settled), the header carries the app links and the
 * {@code Arrange threads} toggle, and the body is the chat placeholder until
 * the chat surface moves into this shell (T77).
 *
 * <p>The arrange toggle is a server-side mode: it dispatches the
 * {@code arrange-toggle} action, which answers with a {@code setScreen}
 * directive carrying this screen re-rendered with the flag flipped. Nothing
 * about the mode is persisted client-side; the thread order itself is
 * server-owned through {@code POST /sessions/reorder}.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class SessionsScreen {

    /** The body placeholder of the chat area (the chat redesign is T77). */
    static final String BODY_TITLE = "Select a thread";

    private SessionsScreen() {
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
                        .header(header(providersLink, arrange))
                        .sidebar(sidebar)
                        .body(body())
                        .build())
                .build();
    }

    /** The shell header: the app links and the arrange toggle. */
    private static UiNode header(boolean providersLink, boolean arrange) {
        Ui.NavBuilder links = Ui.nav()
                .kind("tabs")
                .item("Sessions", "sessions")
                .item("Settings", "settings")
                .item("Plugins", "plugins")
                .activeIndex(0);
        if (providersLink) {
            links.item("Providers", "providers");
        }
        Ui.ButtonBuilder arrangeToggle = Ui.button(arrange ? "Done arranging" : "Arrange threads")
                .style("secondary")
                .action(ActionDescriptors.of("arrange-toggle",
                        Map.of("arrange", !arrange), null));
        return Ui.row()
                .align("center")
                .child(links.build())
                .child(Ui.spacer().build())
                .child(arrangeToggle.build())
                .build();
    }

    /** The chat-area placeholder. */
    private static UiNode body() {
        return Ui.card()
                .title(BODY_TITLE)
                .child(Ui.text("Choose a thread from the sidebar to open the conversation.")
                        .style("caption")
                        .build())
                .build();
    }
}