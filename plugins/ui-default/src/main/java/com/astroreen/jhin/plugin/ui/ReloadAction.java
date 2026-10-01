/**
 * The {@code reload} action: asks the client to drop its cached bootstrap and
 * screens and to fetch them again ({@code reloadBootstrap}). The plugin
 * restart itself belongs to the reload plugin ({@code POST /admin/reload} and
 * the restart loop of {@code deploy/run.sh}); this action is the SDUI
 * instruction the reload button carries while that plugin is loaded.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;

final class ReloadAction {

    private ReloadAction() {
    }

    /**
     * Asks for a bootstrap reload.
     *
     * @param req     the request that carried the action
     * @param payload the merged payload (unused)
     * @return {@code [toast, reloadBootstrap]}
     */
    static List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        return List.of(
                Directives.toast("Reloading the server surface."),
                Directives.reloadBootstrap());
    }
}
