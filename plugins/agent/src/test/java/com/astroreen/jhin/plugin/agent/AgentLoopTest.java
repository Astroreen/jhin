/**
 * The T33 QA matrix over one agent run: the exact happy-path event sequence
 * with a fake {@code ChatModel} and a fake tool, the guard-blocked tool
 * result, the prompt-interceptor veto (single {@code error} event, zero model
 * calls), the observable guard/transformer chains and the
 * {@code resolvePath} workspace escape.
 */
package com.astroreen.jhin.plugin.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.agent.api.PluginVetoException;
import com.astroreen.jhin.plugin.agent.api.PromptContext;
import com.astroreen.jhin.plugin.agent.api.PromptInterceptor;
import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolCallDecision;
import com.astroreen.jhin.plugin.agent.api.ToolCallGuard;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.agent.api.ToolResultTransformer;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.sdk.json.Json;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

class AgentLoopTest {

    @TempDir
    Path work;

    private FakeEventLog events;
    private RecordingStreamRegistry streams;
    private FakeChatModel model;
    private List<ToolCallGuard> guards;
    private List<ToolResultTransformer> transformers;
    private List<PromptInterceptor> interceptors;
    private final List<ToolCall> executedCalls = new CopyOnWriteArrayList<>();
    private AgentLoop loop;
    private Session session;

    @BeforeEach
    void setUp() {
        events = new FakeEventLog();
        streams = new RecordingStreamRegistry();
        model = new FakeChatModel();
        guards = new ArrayList<>();
        transformers = new ArrayList<>();
        interceptors = new ArrayList<>();
        executedCalls.clear();
        ToolInvoker invoker = new ToolInvoker(
                () -> List.of(echoProvider()),
                () -> guards,
                () -> transformers,
                LoggerFactory.getLogger("test"));
        SystemPromptBuilder prompts = new SystemPromptBuilder(
                () -> List.copyOf(invoker.resolveTools().values()),
                () -> interceptors);
        loop = new AgentLoop(events, prompts, new ConversationBuilder(events), invoker,
                new FakeProviderRegistry(model), LoggerFactory.getLogger("test"));
        session = new Session("s1", "local", "test session", work.toString(),
                "test-model", "p1", "active", 1L, 1L);
    }

    @Test
    void fullRunEmitsTheEventSequenceInOrder() {
        model.script(
                AiMessage.from("Let me look.",
                        List.of(request("call-1", "{\"text\":\"hi\"}"))),
                AiMessage.from("Done."));

        String failure = loop.run(runContext("please echo"));

        assertThat(failure).isNull();
        assertThat(events.types("s1")).containsExactly(
                EventType.RUN_START,
                EventType.MESSAGE_START,
                EventType.TEXT_DELTA,
                EventType.TOOL_USE,
                EventType.TOOL_RESULT,
                EventType.MESSAGE_START,
                EventType.TEXT_DELTA,
                EventType.MESSAGE_END,
                EventType.RUN_END);
        assertThat(executedCalls).hasSize(1);
        Map<String, Object> toolResult = payloadAt(EventType.TOOL_RESULT);
        assertThat(toolResult).containsEntry("name", "echo")
                .containsEntry("error", false)
                .containsEntry("id", "call-1");
        assertThat(String.valueOf(toolResult.get("content"))).isEqualTo("echoed: hi");
        Map<String, Object> messageEnd = payloadAt(EventType.MESSAGE_END);
        assertThat(messageEnd).containsEntry("text", "Done.");
        List<ChatMessage> secondTurn = model.requests().get(1).messages();
        assertThat(secondTurn).anyMatch(ToolExecutionResultMessage.class::isInstance);
    }

    @Test
    void promptCompositionReachesTheModel() {
        model.script(AiMessage.from("Done."));

        loop.run(runContext("hello"));

        ChatMessage system = model.requests().get(0).messages().get(0);
        assertThat(system).isInstanceOf(dev.langchain4j.data.message.SystemMessage.class);
        String prompt = ((dev.langchain4j.data.message.SystemMessage) system).text();
        assertThat(prompt).contains("You are Jhin").contains("## Echo (echo)")
                .contains("use this to echo").contains("always echo");
    }

    @Test
    void replaysCompletedPriorTurnsIntoTheConversation() {
        events.append("s1", EventType.USER_MESSAGE, Json.write(Map.of("text", "old question")));
        events.append("s1", EventType.MESSAGE_START, Json.write(Map.of("role", "assistant")));
        events.append("s1", EventType.TEXT_DELTA, Json.write(Map.of("text", "old")));
        events.append("s1", EventType.MESSAGE_END, Json.write(Map.of("text", "old answer")));
        events.append("s1", EventType.RUN_START, Json.write(Map.of("runId", "r0")));
        model.script(AiMessage.from("Done."));

        loop.run(runContext("current question"));

        List<ChatMessage> sent = model.requests().get(0).messages();
        assertThat(sent).hasSize(4);
        assertThat(((dev.langchain4j.data.message.UserMessage) sent.get(1)).singleText())
                .isEqualTo("old question");
        assertThat(((AiMessage) sent.get(2)).text()).isEqualTo("old answer");
        assertThat(((dev.langchain4j.data.message.UserMessage) sent.get(3)).singleText())
                .isEqualTo("current question");
    }

    @Test
    void guardBlockYieldsBlockedToolResult() {
        guards.add(call -> ToolCallDecision.block("policy says no"));
        model.script(
                AiMessage.from(List.of(request("call-1", "{}"))),
                AiMessage.from("Done."));

        String failure = loop.run(runContext("please echo"));

        assertThat(failure).isNull();
        Map<String, Object> toolResult = payloadAt(EventType.TOOL_RESULT);
        assertThat(toolResult).containsEntry("error", true);
        assertThat(String.valueOf(toolResult.get("content")))
                .startsWith("Blocked: ")
                .isEqualTo("Blocked: policy says no");
        assertThat(executedCalls).isEmpty();
    }

    @Test
    void guardExceptionBlocksTheCall() {
        guards.add(call -> {
            throw new IllegalStateException("guard exploded");
        });
        model.script(
                AiMessage.from(List.of(request("call-1", "{}"))),
                AiMessage.from("Done."));

        loop.run(runContext("please echo"));

        Map<String, Object> toolResult = payloadAt(EventType.TOOL_RESULT);
        assertThat(toolResult).containsEntry("error", true);
        assertThat(String.valueOf(toolResult.get("content")))
                .startsWith("Blocked: ")
                .isEqualTo("Blocked: guard exploded");
        assertThat(executedCalls).isEmpty();
    }

    @Test
    void promptInterceptorVetoEmitsSingleErrorAndSkipsTheModel() {
        interceptors.add(ctx -> {
            throw new PluginVetoException("not allowed today");
        });
        model.script(AiMessage.from("Done."));

        String failure = loop.run(runContext("hello"));

        assertThat(failure).isEqualTo("not allowed today");
        assertThat(model.callCount()).isZero();
        assertThat(events.types("s1")).containsExactly(EventType.RUN_START, EventType.ERROR);
        assertThat(events.types("s1")).filteredOn(type -> type == EventType.ERROR).hasSize(1);
        assertThat(payloadAt(EventType.ERROR)).containsEntry("message", "not allowed today");
    }

    @Test
    void nullReturningInterceptorAbortsTheRun() {
        interceptors.add(new PromptInterceptor() {
            @Override
            public PromptContext intercept(PromptContext ctx) {
                return null;
            }
        });
        model.script(AiMessage.from("Done."));

        String failure = loop.run(runContext("hello"));

        assertThat(failure).contains("vetoed the run");
        assertThat(model.callCount()).isZero();
        assertThat(events.types("s1")).containsExactly(EventType.RUN_START, EventType.ERROR);
    }

    @Test
    void throwingTransformerIsSkippedAndResultSurvives() {
        AtomicBoolean throwingRan = new AtomicBoolean();
        transformers.add(result -> {
            throwingRan.set(true);
            throw new IllegalStateException("transformer exploded");
        });
        transformers.add(result -> ToolResult.ok("rewritten: " + result.content()));
        model.script(
                AiMessage.from(List.of(request("call-1", "{\"text\":\"hi\"}"))),
                AiMessage.from("Done."));

        loop.run(runContext("please echo"));

        assertThat(throwingRan.get()).isTrue();
        Map<String, Object> toolResult = payloadAt(EventType.TOOL_RESULT);
        assertThat(String.valueOf(toolResult.get("content"))).isEqualTo("rewritten: echoed: hi");
        assertThat(toolResult).containsEntry("error", false);
    }

    @Test
    void loneThrowingTransformerLeavesTheResultUnchanged() {
        transformers.add(result -> {
            throw new IllegalStateException("transformer exploded");
        });
        model.script(
                AiMessage.from(List.of(request("call-1", "{\"text\":\"hi\"}"))),
                AiMessage.from("Done."));

        loop.run(runContext("please echo"));

        Map<String, Object> toolResult = payloadAt(EventType.TOOL_RESULT);
        assertThat(String.valueOf(toolResult.get("content"))).isEqualTo("echoed: hi");
    }

    @Test
    void resolvePathRejectsEscape() {
        ToolContext ctx = new ToolContextImpl(work, "s1", "r1", "local", streams);

        assertThatThrownBy(() -> ctx.resolvePath("../../etc/passwd"))
                .isInstanceOf(ToolException.class)
                .hasMessage("Path goes outside of workspace");
    }

    @Test
    void resolvePathRejectsSymlinkEscape() throws Exception {
        Path outside = Files.createTempDirectory("jhin-outside");
        Path target = outside.resolve("secret.txt");
        Files.writeString(target, "secret");
        Path link = work.resolve("escape.txt");
        Files.createSymbolicLink(link, target);
        ToolContext ctx = new ToolContextImpl(work, "s1", "r1", "local", streams);

        assertThatThrownBy(() -> ctx.resolvePath("escape.txt"))
                .isInstanceOf(ToolException.class)
                .hasMessage("Path goes outside of workspace");
    }

    @Test
    void resolvePathConfinesInsideTheWorkspace() throws Exception {
        Files.createDirectories(work.resolve("src"));
        ToolContext ctx = new ToolContextImpl(work, "s1", "r1", "local", streams);

        assertThat(ctx.resolvePath("src/main.java"))
                .isEqualTo(work.toRealPath().resolve("src").resolve("main.java"));
    }

    private RunContext runContext(String text) {
        return new RunContext("r1", session, text,
                new ToolContextImpl(work, "s1", "r1", "local", streams));
    }

    private ToolExecutionRequest request(String id, String arguments) {
        return ToolExecutionRequest.builder().id(id).name("echo").arguments(arguments).build();
    }

    private Map<String, Object> payloadAt(EventType type) {
        return events.list("s1", 0).stream()
                .filter(record -> record.type() == type)
                .findFirst()
                .map(record -> Json.readMap(record.payload()))
                .orElseThrow();
    }

    private ToolProvider echoProvider() {
        return () -> List.of(echoTool());
    }

    private ToolDefinition echoTool() {
        return new ToolDefinition() {
            @Override
            public String name() {
                return "echo";
            }

            @Override
            public String label() {
                return "Echo";
            }

            @Override
            public String description() {
                return "Echoes the given text back";
            }

            @Override
            public String parametersSchema() {
                return "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},"
                        + "\"required\":[\"text\"]}";
            }

            @Override
            public String promptSnippet() {
                return "use this to echo";
            }

            @Override
            public String promptGuidelines() {
                return "always echo";
            }

            @Override
            public ToolResult execute(ToolCall call, ToolContext ctx) {
                executedCalls.add(call);
                Map<String, Object> args = Json.readMap(call.arguments());
                return ToolResult.ok("echoed: " + args.get("text"));
            }
        };
    }
}
