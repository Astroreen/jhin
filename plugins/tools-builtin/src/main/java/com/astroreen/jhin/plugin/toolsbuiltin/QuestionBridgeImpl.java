/**
 * In-memory {@link QuestionBridge} over a {@link ConcurrentHashMap} of
 * pending answer futures keyed by the {@code (sessionId, callId)} pair.
 *
 * <p>Thread safety: every operation is one atomic map step, so concurrent
 * asks, answers and cancels on different calls never interfere. The key is a
 * small record (not a concatenated string) so a slash inside a session id can
 * never alias another session's call.
 *
 * <p>Deterministic conflict rules, mirrored from the interface contract:
 * {@link #ask} on an already-pending call <em>replaces</em> the question and
 * fails the previous future with {@link IllegalStateException} (last-wins,
 * no future left hanging); {@link #answer} removes the entry before
 * completing it, so a second answer finds no pending question and is
 * rejected with {@link IllegalStateException} - a delivered answer can never
 * be overwritten.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.toolsbuiltin.api.QuestionBridge;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

final class QuestionBridgeImpl implements QuestionBridge {

    private final ConcurrentMap<Key, CompletableFuture<String>> pending = new ConcurrentHashMap<>();

    @Override
    public CompletionStage<String> ask(String sessionId, String callId, String question, List<String> options) {
        requireText(sessionId, "sessionId");
        requireText(callId, "callId");
        requireText(question, "question");
        if (options == null) {
            throw new IllegalArgumentException("options must not be null");
        }
        CompletableFuture<String> future = new CompletableFuture<>();
        CompletableFuture<String> previous = pending.put(new Key(sessionId, callId), future);
        if (previous != null) {
            previous.completeExceptionally(new IllegalStateException(
                    "question replaced by a new ask for " + sessionId + "/" + callId));
        }
        return future;
    }

    @Override
    public void answer(String sessionId, String callId, String answer) {
        requireText(sessionId, "sessionId");
        requireText(callId, "callId");
        requireText(answer, "answer");
        CompletableFuture<String> future = pending.remove(new Key(sessionId, callId));
        if (future == null) {
            throw new IllegalStateException("no pending question for " + sessionId + "/" + callId
                    + " (already answered, cancelled or never asked)");
        }
        future.complete(answer);
    }

    @Override
    public void cancelAll(String sessionId) {
        requireText(sessionId, "sessionId");
        for (Map.Entry<Key, CompletableFuture<String>> entry : pending.entrySet()) {
            if (entry.getKey().sessionId().equals(sessionId)) {
                // Two-arg remove: never touch a future a concurrent ask just
                // installed for the same key.
                if (pending.remove(entry.getKey(), entry.getValue())) {
                    entry.getValue().completeExceptionally(new CancellationException(
                            "session " + sessionId + " cancelled with a pending question"));
                }
            }
        }
    }

    private static void requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be null or blank");
        }
    }

    /**
     * The pending-question key: one tool call of one session. A record so
     * {@code sessionId}/{@code callId} values containing separators cannot
     * collide across pairs.
     */
    private record Key(String sessionId, String callId) {
    }
}
