/**
 * The question bridge: the pending-question seam published to the
 * cross-plugin service registry so a tool that needs the user's answer can
 * pause its call and resume when the answer arrives, without owning any HTTP,
 * UI or session concern itself.
 *
 * <p>One pending question per tool call: {@link #ask} registers the question
 * for one {@code (sessionId, callId)} pair and returns the future of its
 * answer; {@link #answer} completes it; {@link #cancelAll} fails every
 * pending question of a session when that session goes away.
 *
 * <p>The question text and the options are the caller's payload - the asker
 * renders them to the user; this bridge routes the answer text back only.
 */
package com.astroreen.jhin.plugin.toolsbuiltin.api;

import java.util.List;
import java.util.concurrent.CompletionStage;

public interface QuestionBridge {

    /**
     * Registers a pending question and returns the future of its answer.
     *
     * <p>NO timeout: the returned future stays pending until {@link #answer}
     * completes it or {@link #cancelAll} fails it - it never completes on its
     * own, so a question may wait as long as the user needs. When a question
     * is already pending for the same call, this ask <em>replaces</em> it and
     * the previous future is completed exceptionally with
     * {@link IllegalStateException} (deterministic last-wins, so no future is
     * ever left hanging).
     *
     * @param sessionId the session the question belongs to
     * @param callId    the id of the tool call asking the question; unique per
     *                  call inside the session
     * @param question  the question text shown to the user
     * @param options   the predefined answers, empty for a free-text question;
     *                  never {@code null}
     * @return the future completing with the answer text
     * @throws IllegalArgumentException when {@code sessionId}, {@code callId}
     *                                  or {@code question} is null or blank or
     *                                  {@code options} is {@code null}
     */
    CompletionStage<String> ask(String sessionId, String callId, String question, List<String> options);

    /**
     * Completes the pending question of one call with the answer text.
     *
     * <p>Rejection is idempotent: a call with no pending question any more
     * (already answered, cancelled or never asked) is rejected with
     * {@link IllegalStateException} by this and every further {@code answer},
     * and every rejection leaves the state unchanged - a delivered answer can
     * never be overwritten by a double answer.
     *
     * @param sessionId the session the question belongs to
     * @param callId    the id of the tool call asking the question
     * @param answer    the answer text
     * @throws IllegalArgumentException when {@code sessionId}, {@code callId}
     *                                  or {@code answer} is null or blank
     * @throws IllegalStateException    when no question is pending for the
     *                                  call (already answered, cancelled or
     *                                  never asked)
     */
    void answer(String sessionId, String callId, String answer);

    /**
     * Fails every pending question of one session with
     * {@link java.util.concurrent.CancellationException}. Called when the
     * session goes away while questions are still open. A session without
     * pending questions is a no-op; questions of other sessions are untouched.
     *
     * @param sessionId the session whose questions are cancelled
     * @throws IllegalArgumentException when {@code sessionId} is null or blank
     */
    void cancelAll(String sessionId);
}
