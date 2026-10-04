/**
 * The {@code send} action: posts one user message into a session with the
 * semantics of {@code POST /sessions/{id}/messages} — the run starts
 * asynchronously and every step lands in the session event log, so the chat
 * screen's stream view picks the answer up without further directives.
 *
 * <p>The background-send flow (T68): the action enqueues the run through
 * {@link RunService#start} and answers immediately — the HTTP response is
 * the enqueue acknowledgement, the run continues on its own and its events
 * flow over the existing session streams.
 *
 * <p>Registered only while the agent plugin is loaded and published its
 * {@code RunService}. The message text arrives as {@code messageInput} (the
 * input id the Send button includes). A session without a provider is still
 * posted — the run records the failure as an {@code error} event the stream
 * renders — and the action additionally answers with an error toast naming
 * the missing configuration.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.agent.api.RunService;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class SendAction {

    /** The toast text when the session carries no provider. */
    static final String NO_PROVIDER =
            "This session has no provider configured. Add one on the providers screen"
                    + " and attach it to the session.";

    private final SessionStore store;
    private final RunService runs;

    SendAction(SessionStore store, RunService runs) {
        this.store = store;
        this.runs = runs;
    }

    /**
     * Starts one run for the message of the payload.
     *
     * @param req     the request that carried the action
     * @param payload the merged payload: {@code sessionId}, {@code messageInput}
     * @return empty on success, one toast when the message cannot run
     */
    List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        String sessionId = ActionSupport.text(payload, "sessionId");
        String message = message(payload);
        if (sessionId == null || message == null) {
            return ActionSupport.error("A session and a message are required.");
        }
        Session session = lookup(req, sessionId);
        if (session == null) {
            return ActionSupport.error("Session not found: " + sessionId);
        }
        List<Map<String, Object>> ops = new ArrayList<>();
        if (session.providerId() == null || session.providerId().isBlank()) {
            ops.add(Directives.toast(NO_PROVIDER, "error"));
        }
        try {
            runs.start(session, message);
        } catch (RuntimeException e) {
            return ActionSupport.error(messageOf(e));
        }
        return List.copyOf(ops);
    }

    /** The message text: {@code messageInput}, falling back to {@code text}. */
    private static String message(Map<String, Object> payload) {
        String text = ActionSupport.text(payload, "messageInput");
        return (text != null) ? text : ActionSupport.text(payload, "text");
    }

    private Session lookup(HttpRequest req, String sessionId) {
        Optional<String> account = ActionSupport.account(req);
        return account
                .map(owner -> store.get(owner, sessionId))
                .orElseGet(() -> store.get(sessionId))
                .orElse(null);
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
