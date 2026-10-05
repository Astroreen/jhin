/**
 * The {@code sessions} screen: the t3code-shaped thread shell built by
 * {@link ShellScreen} (T95) — the workspace top bar, the page header row and
 * the stage-art backdrop over the four-section sidebar of
 * {@link SidebarBuilder}. Kept as the route target so the screen id and the
 * test seams stay stable; the chrome composition lives in {@code
 * ShellScreen}.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.Optional;

public final class SessionsScreen {

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
        return ShellScreen.render(store, account, providersLink, arrange);
    }
}
