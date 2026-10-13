package com.astroreen.jhin.plugin.toolsbuiltin;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.toolsbuiltin.api.QuestionBridge;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Behaviour tests of the blocking {@code ask_user} tool over the real
 * {@link QuestionBridgeImpl}: the call blocks until {@code answer} arrives and
 * returns the answer text, {@code cancelAll} during the wait yields the
 * cancelled error result, argument validation fails without touching the
 * bridge, and {@code options} pass through to the bridge unchanged.
 */
class AskUserToolTest {

    @TempDir
    Path workdir;

    private final SignalingBridge bridge = new SignalingBridge();

    private ToolContext ctx() {
        return new FakeToolContext(workdir);
    }

    private static ToolCall call(Map<String, Object> arguments) {
        return new ToolCall("c-test", "ask_user", Json.write(arguments));
    }

    @Test
    void executeBlocksUntilAnsweredAndReturnsTheAnswerText() throws Exception {
        AskUserTool tool = new AskUserTool(bridge);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<ToolResult> pending =
                    pool.submit(() -> tool.execute(call(Map.of("question", "Proceed?")), ctx()));

            assertThat(bridge.asked.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(pending.isDone()).isFalse();

            bridge.answer("s-test", "c-test", "42");

            ToolResult result = pending.get(5, TimeUnit.SECONDS);
            assertThat(result.error()).isFalse();
            assertThat(result.content()).isEqualTo("42");
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void cancelAllDuringTheWaitYieldsTheCancelledErrorResult() throws Exception {
        AskUserTool tool = new AskUserTool(bridge);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<ToolResult> pending =
                    pool.submit(() -> tool.execute(call(Map.of("question", "Proceed?")), ctx()));

            assertThat(bridge.asked.await(5, TimeUnit.SECONDS)).isTrue();

            bridge.cancelAll("s-test");

            ToolResult result = pending.get(5, TimeUnit.SECONDS);
            assertThat(result.error()).isTrue();
            assertThat(result.content()).isEqualTo("Question cancelled");
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void missingQuestionFailsWithoutTouchingTheBridge() {
        AskUserTool tool = new AskUserTool(bridge);

        ToolResult result = tool.execute(call(Map.of()), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("question must not be blank");
        assertThat(bridge.askCalls.get()).isZero();
    }

    @Test
    void optionsPassThroughToTheBridge() throws Exception {
        AskUserTool tool = new AskUserTool(bridge);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<ToolResult> pending = pool.submit(() -> tool.execute(
                    call(Map.of("question", "Proceed?", "options", List.of("yes", "no"))), ctx()));

            assertThat(bridge.asked.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(bridge.question).isEqualTo("Proceed?");
            assertThat(bridge.options).containsExactly("yes", "no");

            bridge.answer("s-test", "c-test", "no");

            assertThat(pending.get(5, TimeUnit.SECONDS).content()).isEqualTo("no");
        } finally {
            pool.shutdownNow();
        }
    }

    /**
     * Test double over the real {@link QuestionBridgeImpl}: signals when a
     * question was registered (so the test can act while the tool blocks) and
     * records the question payload for pass-through assertions.
     */
    private static final class SignalingBridge implements QuestionBridge {

        private final QuestionBridgeImpl delegate = new QuestionBridgeImpl();
        private final CountDownLatch asked = new CountDownLatch(1);
        private final AtomicInteger askCalls = new AtomicInteger();
        private volatile String question;
        private volatile List<String> options = List.of();

        @Override
        public CompletionStage<String> ask(String sessionId, String callId, String question, List<String> options) {
            askCalls.incrementAndGet();
            this.question = question;
            this.options = List.copyOf(options);
            CompletionStage<String> future = delegate.ask(sessionId, callId, question, options);
            asked.countDown();
            return future;
        }

        @Override
        public void answer(String sessionId, String callId, String answer) {
            delegate.answer(sessionId, callId, answer);
        }

        @Override
        public void cancelAll(String sessionId) {
            delegate.cancelAll(sessionId);
        }
    }
}
