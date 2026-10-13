/**
 * The {@code cancel} action: cancels the active run of one session with the
 * semantics of {@code POST /sessions/{id}/cancel} and fails the session's
 * pending {@code ask_user} questions with it. The cancellation flag is
 * flipped asynchronously, so the action answers with a toast either way —
 * "Run cancelled." when a run was flagged, the failure message (for example
 * {@code no_active_run}) otherwise.
 *
 * <p>Registered only while the agent plugin is loaded and published its
 * {@code RunService}. The question-cancel seam is presence-guarded: it is
 * the {@code QuestionBridge::cancelAll} call of jhin.tools-builtin, supplied
 * as a lambda only while that plugin is loaded, so nothing here names its
 * API class.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.agent.api.RunService;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Consumer;

final class CancelAction {

    private final RunService runs;

    /** The {@code QuestionBridge::cancelAll} seam, empty when tools-builtin is absent. */
    private final Optional<Consumer<String>> cancelQuestions;

    CancelAction(RunService runs, Optional<Consumer<String>> cancelQuestions) {
        this.runs = runs;
        this.cancelQuestions = cancelQuestions;
    }

    /**
     * Cancels the active run of the payload's session and its pending
     * {@code ask_user} questions.
     *
     * @param req     the request that carried the action
     * @param payload the merged payload: {@code sessionId}
     * @return exactly one toast describing the outcome
     */
    List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        String sessionId = ActionSupport.text(payload, "sessionId");
        if (sessionId == null) {
            return ActionSupport.error("A session id is required.");
        }
        try {
            runs.cancel(sessionId);
            if (cancelQuestions.isPresent()) {
                cancelQuestions.orElseThrow().accept(sessionId);
            }
            return ActionSupport.toast("Run cancelled.");
        } catch (RuntimeException e) {
            return ActionSupport.error(messageOf(e));
        }
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
