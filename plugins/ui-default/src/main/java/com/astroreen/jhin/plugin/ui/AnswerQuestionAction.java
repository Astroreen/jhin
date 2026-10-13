/**
 * The {@code answer-question} action: delivers the user's reply to the one
 * pending {@code ask_user} tool call of a session over the
 * {@code QuestionBridge} of {@code jhin.tools-builtin} and restores the
 * normal composer input.
 *
 * <p>The payload carries the {@code sessionId}, the {@code callId} of the
 * waiting tool call and the {@code answer} text (a predefined option chip or
 * the included {@code answer} reply input of the pending panel). A rejected
 * answer — the question was already answered, cancelled or never asked
 * ({@link IllegalStateException} from the bridge) — surfaces as one honest
 * error toast carrying the bridge's own message, so a stale panel can never
 * silently overwrite a delivered answer.
 *
 * <p>Registered only while the tools plugin is loaded and published its
 * {@code QuestionBridge}.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.toolsbuiltin.api.QuestionBridge;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;

final class AnswerQuestionAction {

    private final QuestionBridge bridge;

    AnswerQuestionAction(QuestionBridge bridge) {
        this.bridge = bridge;
    }

    /**
     * Delivers the answer and swaps the pending question panel out of the
     * composer input region.
     *
     * @param req     the request that carried the action
     * @param payload the merged payload: {@code sessionId}, {@code callId},
     *                {@code answer}
     * @return the composer-input patch on success, or one error toast on a
     *         missing field or a rejected answer
     */
    List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        String sessionId = ActionSupport.text(payload, "sessionId");
        if (sessionId == null) {
            return ActionSupport.error("A session id is required.");
        }
        String callId = ActionSupport.text(payload, "callId");
        if (callId == null) {
            return ActionSupport.error("A call id is required.");
        }
        String answer = ActionSupport.text(payload, "answer");
        if (answer == null) {
            return ActionSupport.error("An answer is required.");
        }
        try {
            bridge.answer(sessionId, callId, answer);
        } catch (RuntimeException e) {
            return ActionSupport.error(messageOf(e));
        }
        return List.of(Directives.patch(ChatScreen.INPUT_ID, ChatScreen.messageInput()));
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
