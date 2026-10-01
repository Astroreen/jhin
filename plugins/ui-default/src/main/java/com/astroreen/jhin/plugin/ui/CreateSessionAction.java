/**
 * The {@code create-session} action: creates one session for the caller and
 * answers with a navigation to its {@code chat:<id>} screen — the response
 * shape of the "New session" form on the session list.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class CreateSessionAction {

    private final SessionStore store;

    CreateSessionAction(SessionStore store) {
        this.store = store;
    }

    /**
     * Creates the session named by the payload.
     *
     * @param req     the request that carried the action
     * @param payload the merged payload: {@code title}, {@code workdir}
     * @return {@code [navigate chat:<id>]} on success, one error toast otherwise
     */
    List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        String title = ActionSupport.text(payload, "title");
        String workdir = ActionSupport.text(payload, "workdir");
        if (title == null || workdir == null) {
            return ActionSupport.error("A title and a working directory are required.");
        }
        try {
            Optional<String> account = ActionSupport.account(req);
            Session session = account
                    .map(owner -> store.create(owner, title, workdir))
                    .orElseGet(() -> store.create(title, workdir));
            return List.of(Directives.navigate("chat:" + session.id()));
        } catch (IllegalArgumentException e) {
            return ActionSupport.error(messageOf(e));
        }
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
