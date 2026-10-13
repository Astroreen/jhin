package com.astroreen.jhin.plugin.toolsbuiltin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.toolsbuiltin.api.QuestionBridge;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import org.junit.jupiter.api.Test;

/**
 * Contract tests of the {@link QuestionBridge}: answer completion, the
 * idempotent rejection of double answers, session-scoped cancellation and the
 * isolation between sessions and calls.
 */
class QuestionBridgeTest {

    private final QuestionBridge bridge = new QuestionBridgeImpl();

    @Test
    void askThenAnswerCompletesWithTheAnswerText() {
        CompletionStage<String> asked = bridge.ask("s1", "c1", "Proceed?", List.of("yes", "no"));

        bridge.answer("s1", "c1", "yes");

        assertThat(asked.toCompletableFuture()).isCompletedWithValue("yes");
    }

    @Test
    void doubleAnswerIsRejected() {
        CompletionStage<String> asked = bridge.ask("s1", "c1", "Proceed?", List.of("yes", "no"));
        bridge.answer("s1", "c1", "yes");

        assertThatThrownBy(() -> bridge.answer("s1", "c1", "no"))
                .isInstanceOf(IllegalStateException.class);

        assertThat(asked.toCompletableFuture()).isCompletedWithValue("yes");
    }

    @Test
    void answerWithoutPendingQuestionIsRejected() {
        assertThatThrownBy(() -> bridge.answer("s1", "c1", "yes"))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void cancelAllFailsPendingWithCancellationException() {
        CompletionStage<String> asked = bridge.ask("s1", "c1", "Proceed?", List.of("yes", "no"));

        bridge.cancelAll("s1");

        CompletableFuture<String> future = asked.toCompletableFuture();
        assertThat(future).isCompletedExceptionally();
        // CompletableFuture.join() surfaces a CancellationException as-is,
        // unlike other failures which arrive wrapped in CompletionException.
        assertThatThrownBy(future::join).isInstanceOf(CancellationException.class);
    }

    @Test
    void cancelAllLeavesOtherSessionsPending() {
        CompletionStage<String> mine = bridge.ask("s1", "c1", "Proceed?", List.of());
        CompletionStage<String> other = bridge.ask("s2", "c1", "Proceed?", List.of());

        bridge.cancelAll("s1");

        assertThat(mine.toCompletableFuture()).isCompletedExceptionally();
        assertThat(other.toCompletableFuture()).isNotDone();

        bridge.answer("s2", "c1", "later");
        assertThat(other.toCompletableFuture()).isCompletedWithValue("later");
    }

    @Test
    void independentSessionsAndCallsDoNotCrossComplete() {
        CompletionStage<String> first = bridge.ask("s1", "c1", "One?", List.of());
        CompletionStage<String> second = bridge.ask("s1", "c2", "Two?", List.of());
        CompletionStage<String> foreign = bridge.ask("s2", "c1", "Other?", List.of());

        bridge.answer("s2", "c1", "foreign");

        assertThat(foreign.toCompletableFuture()).isCompletedWithValue("foreign");
        assertThat(first.toCompletableFuture()).isNotDone();
        assertThat(second.toCompletableFuture()).isNotDone();

        bridge.answer("s1", "c2", "second");
        assertThat(second.toCompletableFuture()).isCompletedWithValue("second");
        assertThat(first.toCompletableFuture()).isNotDone();
    }

    @Test
    void secondAskForTheSameCallReplacesAndFailsThePreviousFuture() {
        CompletionStage<String> previous = bridge.ask("s1", "c1", "First?", List.of());
        CompletionStage<String> current = bridge.ask("s1", "c1", "Second?", List.of());

        CompletableFuture<String> replaced = previous.toCompletableFuture();
        assertThat(replaced).isCompletedExceptionally();
        assertThatThrownBy(replaced::join)
                .isInstanceOf(CompletionException.class)
                .hasCauseInstanceOf(IllegalStateException.class);

        bridge.answer("s1", "c1", "current");
        assertThat(current.toCompletableFuture()).isCompletedWithValue("current");
    }
}
