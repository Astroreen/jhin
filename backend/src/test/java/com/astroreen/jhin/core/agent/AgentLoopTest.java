package com.astroreen.jhin.core.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.agent.AgentTestEnv.ScriptedChatModel;
import com.astroreen.jhin.core.agent.AgentTestEnv.ScriptedStreamingModel;
import com.astroreen.jhin.core.agent.spi.PluginVetoException;
import com.astroreen.jhin.core.agent.spi.PromptInterceptor;
import com.astroreen.jhin.core.events.Event;
import com.astroreen.jhin.core.events.EventTypes;
import com.astroreen.jhin.core.tools.spi.ToolCallDecision;
import com.astroreen.jhin.core.tools.spi.ToolCallGuard;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AgentLoopTest {

    private static final long AWAIT_MILLIS = 10_000;

    @TempDir
    Path jhinHome;

    @TempDir
    Path workdir;

    private AgentTestEnv env;
    private ScriptedStreamingModel streamingModel;
    private ScriptedChatModel chatModel;

    @AfterEach
    void tearDown() {
        if (env != null) {
            env.close();
        }
    }

    /** Streaming-модель через шов resolveModel (LC4j: ChatModel/StreamingChatModel несовместимы). */
    private ScriptedStreamingModel openStreaming() throws Exception {
        env = new AgentTestEnv(jhinHome, workdir, List.of(), List.of());
        streamingModel = new ScriptedStreamingModel();
        env.modelOverride.set(streamingModel);
        return streamingModel;
    }

    private ScriptedStreamingModel openStreaming(List<ToolCallGuard> guards, List<PromptInterceptor> interceptors)
            throws Exception {
        env = new AgentTestEnv(jhinHome, workdir, guards, interceptors);
        streamingModel = new ScriptedStreamingModel();
        env.modelOverride.set(streamingModel);
        return streamingModel;
    }

    /** Не-стриминг модель через реальный путь buildChatModel → factory.create. */
    private ScriptedChatModel openChat() throws Exception {
        env = new AgentTestEnv(jhinHome, workdir, List.of(), List.of());
        chatModel = new ScriptedChatModel();
        env.factoryModel.set(chatModel);
        return chatModel;
    }

    @Test
    void textOnlyRunStreamsDeltasAndFinishesDone() throws Exception {
        openStreaming().enqueue(AgentTestEnv.textTurn("Hello", "Hel", "lo"));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("DONE");

        assertThat(env.eventTypes())
                .containsExactly(
                        EventTypes.USER_MESSAGE,
                        EventTypes.RUN_START,
                        EventTypes.MESSAGE_START,
                        EventTypes.TEXT_DELTA,
                        EventTypes.TEXT_DELTA,
                        EventTypes.MESSAGE_END,
                        EventTypes.RUN_END);
        assertThat(env.events().get(3).payloadAsMap()).containsEntry("text", "Hel");
        assertThat(env.events().get(4).payloadAsMap()).containsEntry("text", "lo");
        assertThat(env.events().get(5).payloadAsMap())
                .containsEntry("messageId", runId + "-0")
                .containsEntry("text", "Hello");

        Map<String, Object> run = env.runRow(runId);
        assertThat(run.get("status")).isEqualTo("DONE");
        assertThat(run.get("usage_json")).isEqualTo("{\"inputTokens\":3,\"outputTokens\":5,\"totalTokens\":8}");
        assertThat(run.get("error")).isNull();
        assertThat(run.get("ended_at")).isNotNull();

        assertThat(env.lastEvent(EventTypes.RUN_START).payloadAsMap())
                .containsEntry("runId", runId)
                .containsEntry("sessionId", AgentTestEnv.SESSION_ID)
                .containsEntry("model", "mock-model")
                .containsEntry("providerId", env.providerId);
        assertThat(env.lastEvent(EventTypes.RUN_END).payloadAsMap()).containsEntry("status", "DONE");
    }

    @Test
    void toolCallRoundtripExecutesToolAndFeedsResultBack() throws Exception {
        openChat()
                .enqueue(AgentTestEnv.chatTools(
                        AgentTestEnv.toolRequest("call-1", AgentTestEnv.STUB_TOOL, "{\"x\":1}")));
        chatModel.enqueue(AgentTestEnv.chatText("done"));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("DONE");

        assertThat(env.eventTypes())
                .containsExactly(
                        EventTypes.USER_MESSAGE,
                        EventTypes.RUN_START,
                        EventTypes.MESSAGE_START,
                        EventTypes.MESSAGE_END,
                        EventTypes.TOOL_USE,
                        EventTypes.TOOL_RESULT,
                        EventTypes.MESSAGE_START,
                        EventTypes.TEXT_DELTA,
                        EventTypes.MESSAGE_END,
                        EventTypes.RUN_END);

        assertThat(env.events().get(4).payloadAsMap())
                .containsEntry("callId", "call-1")
                .containsEntry("toolName", AgentTestEnv.STUB_TOOL)
                .containsEntry("arguments", Map.of("x", 1));
        Map<String, Object> toolResult = env.events().get(5).payloadAsMap();
        assertThat(toolResult)
                .containsEntry("callId", "call-1")
                .containsEntry("toolName", AgentTestEnv.STUB_TOOL)
                .containsEntry("content", "result-of-stub-tool")
                .containsEntry("error", false)
                .containsEntry("truncated", false)
                .containsEntry("streaming", false)
                .containsKey("structured")
                .containsKey("meta");

        assertThat(env.stubTool.calls).hasSize(1);
        assertThat(env.stubTool.calls.get(0).arguments()).containsEntry("x", 1);

        assertThat(chatModel.requests).hasSize(2);
        List<ChatMessage> second = chatModel.requests.get(1).messages();
        ChatMessage last = second.get(second.size() - 1);
        assertThat(last).isInstanceOf(ToolExecutionResultMessage.class);
        ToolExecutionResultMessage resultMessage = (ToolExecutionResultMessage) last;
        assertThat(resultMessage.id()).isEqualTo("call-1");
        assertThat(resultMessage.toolName()).isEqualTo(AgentTestEnv.STUB_TOOL);
        assertThat(resultMessage.text()).isEqualTo("result-of-stub-tool");
        assertThat(resultMessage.isError()).isFalse();
    }

    @Test
    void guardBlockedToolYieldsErrorResultAndRunContinues() throws Exception {
        ToolCallGuard blocker =
                call -> AgentTestEnv.STUB_TOOL.equals(call.toolName())
                        ? ToolCallDecision.block("denied by policy")
                        : ToolCallDecision.allow();
        env = new AgentTestEnv(jhinHome, workdir, List.of(blocker), List.of());
        chatModel = new ScriptedChatModel();
        env.factoryModel.set(chatModel);
        chatModel.enqueue(AgentTestEnv.chatTools(
                AgentTestEnv.toolRequest("call-1", AgentTestEnv.STUB_TOOL, "{}")));
        chatModel.enqueue(AgentTestEnv.chatText("done"));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("DONE");

        Map<String, Object> toolResult = env.lastEvent(EventTypes.TOOL_RESULT).payloadAsMap();
        assertThat(toolResult).containsEntry("error", true);
        assertThat(String.valueOf(toolResult.get("content"))).contains("Blocked");
        assertThat(env.stubTool.calls).isEmpty();

        List<ChatMessage> second = chatModel.requests.get(1).messages();
        ToolExecutionResultMessage resultMessage =
                (ToolExecutionResultMessage) second.get(second.size() - 1);
        assertThat(resultMessage.isError()).isTrue();
        assertThat(resultMessage.text()).contains("Blocked");
    }

    @Test
    void cancelDuringStreamFinishesCancelled() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        openStreaming().enqueue(AgentTestEnv.blockingTextTurn(started, release, "late", "la", "te"));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(started.await(AWAIT_MILLIS, TimeUnit.MILLISECONDS)).isTrue();
        env.runService.cancel(runId);
        release.countDown();

        assertThat(env.awaitTerminal(runId, 5_000)).isEqualTo("CANCELLED");
        assertThat(env.lastEvent(EventTypes.RUN_END).payloadAsMap()).containsEntry("status", "CANCELLED");
        assertThat(env.eventTypes()).doesNotContain(EventTypes.TEXT_DELTA);
        assertThat(env.eventTypes()).doesNotContain(EventTypes.MESSAGE_END);
        assertThat(env.runRow(runId).get("ended_at")).isNotNull();
    }

    @Test
    void cancelBetweenToolsFinishesCancelledAndSkipsRemainingTools() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        openChat();
        env.stubTool.blockStarted = started;
        env.stubTool.blockRelease = release;
        env.stubTool.blockAtCallNumber = 1;
        chatModel.enqueue(AgentTestEnv.chatTools(
                AgentTestEnv.toolRequest("call-1", AgentTestEnv.STUB_TOOL, "{}"),
                AgentTestEnv.toolRequest("call-2", AgentTestEnv.STUB_TOOL, "{}")));
        chatModel.enqueue(AgentTestEnv.chatText("done"));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(started.await(AWAIT_MILLIS, TimeUnit.MILLISECONDS)).isTrue();
        env.runService.cancel(runId);
        release.countDown();

        assertThat(env.awaitTerminal(runId, 5_000)).isEqualTo("CANCELLED");
        assertThat(env.stubTool.calls).hasSize(1);
        List<Event> toolResults = env.events().stream()
                .filter(e -> EventTypes.TOOL_RESULT.equals(e.type()))
                .toList();
        assertThat(toolResults).hasSize(1);
        assertThat(toolResults.get(0).payloadAsMap()).containsEntry("callId", "call-1");
        assertThat(env.lastEvent(EventTypes.RUN_END).payloadAsMap()).containsEntry("status", "CANCELLED");
    }

    @Test
    void promptVetoFinishesErrorWithReason() throws Exception {
        openStreaming(List.of(), List.of(ctx -> {
            throw new PluginVetoException("policy denied");
        }));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("ERROR");

        assertThat(env.lastEvent(EventTypes.ERROR).payloadAsMap())
                .containsEntry("runId", runId)
                .containsEntry("message", "veto: policy denied");
        assertThat(env.lastEvent(EventTypes.RUN_END).payloadAsMap()).containsEntry("status", "ERROR");
        assertThat(env.runRow(runId).get("error")).isEqualTo("policy denied");
        assertThat(streamingModel.requests).isEmpty();
    }

    @Test
    void contextOverflowFinishesError() throws Exception {
        openChat().enqueue(AgentTestEnv.chatText("never"));
        String huge = "x".repeat(205_000);

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, huge);
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("ERROR");

        assertThat(env.lastEvent(EventTypes.ERROR).payloadAsMap())
                .containsEntry("message", "context overflow — start a new session");
        assertThat(env.runRow(runId).get("error")).isEqualTo("context overflow — start a new session");
        assertThat(chatModel.requests).isEmpty();
    }

    @Test
    void nonStreamingModelEmitsSingleDeltaAndZeroUsageWhenAbsent() throws Exception {
        openChat().enqueue(AgentTestEnv.response(AiMessage.from("Hello")));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("DONE");

        List<Event> deltas = env.events().stream()
                .filter(e -> EventTypes.TEXT_DELTA.equals(e.type()))
                .toList();
        assertThat(deltas).hasSize(1);
        assertThat(deltas.get(0).payloadAsMap()).containsEntry("text", "Hello");
        assertThat(env.runRow(runId).get("usage_json"))
                .isEqualTo("{\"inputTokens\":0,\"outputTokens\":0,\"totalTokens\":0}");
    }

    @Test
    void tooManyIterationsFinishesError() throws Exception {
        openChat();
        for (int i = 0; i < AgentLoop.MAX_ITERATIONS; i++) {
            chatModel.enqueue(AgentTestEnv.chatTools(
                    AgentTestEnv.toolRequest("call-" + i, AgentTestEnv.STUB_TOOL, "{}")));
        }

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("ERROR");

        assertThat(env.lastEvent(EventTypes.ERROR).payloadAsMap()).containsEntry("message", "too many iterations");
        assertThat(env.runRow(runId).get("error")).isEqualTo("too many iterations");
        assertThat(env.stubTool.calls).hasSize(AgentLoop.MAX_ITERATIONS);
    }

    @Test
    void toolUpdateChunksAreStreamedAsToolResultEvents() throws Exception {
        openChat();
        env.stubTool.updateChunks = List.of("line-1", "line-2");
        chatModel.enqueue(AgentTestEnv.chatTools(
                AgentTestEnv.toolRequest("call-1", AgentTestEnv.STUB_TOOL, "{}")));
        chatModel.enqueue(AgentTestEnv.chatText("done"));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("DONE");

        List<Event> toolResults = env.events().stream()
                .filter(e -> EventTypes.TOOL_RESULT.equals(e.type()))
                .toList();
        assertThat(toolResults).hasSize(3);
        assertThat(toolResults.get(0).payloadAsMap())
                .containsEntry("content", "line-1")
                .containsEntry("streaming", true)
                .containsEntry("callId", "call-1");
        assertThat(toolResults.get(1).payloadAsMap()).containsEntry("content", "line-2");
        assertThat(toolResults.get(2).payloadAsMap())
                .containsEntry("content", "result-of-stub-tool")
                .containsEntry("streaming", false);
    }

    @Test
    void conversationRebuildIncludesPriorTurns() throws Exception {
        openChat()
                .enqueue(AgentTestEnv.chatTools(
                        AgentTestEnv.toolRequest("call-1", AgentTestEnv.STUB_TOOL, "{\"x\":1}")));
        chatModel.enqueue(AgentTestEnv.chatText("done"));
        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("DONE");

        chatModel.enqueue(AgentTestEnv.chatText("again"));
        String secondRunId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "more");
        assertThat(env.awaitTerminal(secondRunId, AWAIT_MILLIS)).isEqualTo("DONE");

        assertThat(chatModel.requests).hasSize(3);
        List<ChatMessage> third = chatModel.requests.get(2).messages();
        assertThat(third.get(0)).isInstanceOf(SystemMessage.class);
        assertThat(third.get(1)).isInstanceOf(UserMessage.class);
        assertThat(((UserMessage) third.get(1)).singleText()).isEqualTo("hi");
        assertThat(third.get(2)).isInstanceOf(AiMessage.class);
        assertThat(((AiMessage) third.get(2)).toolExecutionRequests()).hasSize(1);
        assertThat(third.get(3)).isInstanceOf(ToolExecutionResultMessage.class);
        assertThat(third.get(4)).isInstanceOf(AiMessage.class);
        assertThat(((AiMessage) third.get(4)).text()).isEqualTo("done");
        assertThat(third.get(5)).isInstanceOf(UserMessage.class);
        assertThat(((UserMessage) third.get(5)).singleText()).isEqualTo("more");
    }

    @Test
    void llmOnErrorFinishesErrorWithMessage() throws Exception {
        openStreaming().enqueue(AgentTestEnv.errorTurn("llm exploded"));

        String runId = env.runService.startRun(AgentTestEnv.SESSION_ID, env.accountId, "hi");
        assertThat(env.awaitTerminal(runId, AWAIT_MILLIS)).isEqualTo("ERROR");

        assertThat(env.lastEvent(EventTypes.ERROR).payloadAsMap())
                .containsEntry("runId", runId)
                .containsEntry("message", "llm exploded");
        assertThat(env.runRow(runId).get("error")).isEqualTo("llm exploded");
    }
}
