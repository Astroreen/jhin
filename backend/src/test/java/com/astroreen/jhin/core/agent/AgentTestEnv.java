package com.astroreen.jhin.core.agent;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.agent.spi.PromptInterceptor;
import com.astroreen.jhin.core.db.DatabaseConfig;
import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.events.Event;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.llm.LlmProviderFactory;
import com.astroreen.jhin.core.llm.ProviderConfig;
import com.astroreen.jhin.core.llm.ProviderRegistry;
import com.astroreen.jhin.core.llm.ProviderRegistry.ProviderRecord;
import com.astroreen.jhin.core.tools.ToolRegistry;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolCallGuard;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolProvider;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.astroreen.jhin.core.tools.spi.ToolUpdate;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.chat.response.StreamingChatResponseHandler;
import dev.langchain4j.model.output.TokenUsage;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * Wiring для тестов агент-цикла: реальный SQLite (temp), EventLogService, ProviderRegistry
 * с mock-фабрикой (формат {@code mock} отдаёт {@link #factoryModel}), ToolRegistry со
 * stub-тулом, RunService/RunRecovery. Сессия {@link #SESSION_ID} и провайдер создаются сразу.
 *
 * <p>Два контура подсадки модели: {@link #factoryModel} (реальный путь
 * {@code buildChatModel → factory.create → ChatModel}) и {@link #modelOverride} (шов
 * {@code RunService.resolveModel} для streaming-моков — в LC4j 1.20.1 {@code ChatModel} и
 * {@code StreamingChatModel} несовместимы, streaming-only объект не пройдёт через фабрику).
 */
final class AgentTestEnv implements AutoCloseable {

    static final String SESSION_ID = "session-1";
    static final String ACCOUNT_NAME = "alice";
    static final String STUB_TOOL = "stub-tool";

    final ObjectMapper mapper = new ObjectMapper();
    final WriteQueue writeQueue;
    final javax.sql.DataSource dataSource;
    final JdbcClient jdbc;
    final EventLogService eventLog;
    final ProviderRegistry providerRegistry;
    final ToolRegistry toolRegistry;
    final SystemPromptBuilder promptBuilder;
    final RunService runService;
    final StubTool stubTool = new StubTool();
    /** Модель реального пути (factory.create → ChatModel). */
    final AtomicReference<ChatModel> factoryModel = new AtomicReference<>();
    /** Подмена модели мимо фабрики (streaming-моки и пр.). */
    final AtomicReference<Object> modelOverride = new AtomicReference<>();
    final String accountId;
    final String providerId;

    AgentTestEnv(Path jhinHome, Path workdir, List<ToolCallGuard> guards,
            List<PromptInterceptor> interceptors) throws Exception {
        dataSource = DatabaseConfig.createDataSource(jhinHome);
        new MigrationRunner(dataSource).migrate();
        writeQueue = new WriteQueue();
        jdbc = JdbcClient.create(dataSource);
        eventLog = new EventLogService(jdbc, writeQueue, mapper);
        LlmProviderFactory mockFactory = new LlmProviderFactory() {
            @Override
            public String format() {
                return "mock";
            }

            @Override
            public ChatModel create(ProviderConfig cfg) {
                ChatModel configured = factoryModel.get();
                if (configured == null) {
                    throw new IllegalStateException("no mock model configured");
                }
                return configured;
            }
        };
        providerRegistry = new ProviderRegistry(jdbc, writeQueue, List.of(mockFactory));
        toolRegistry = new ToolRegistry(List.of(provider(stubTool)), guards, List.of());
        promptBuilder = new SystemPromptBuilder(interceptors);
        runService = new RunService(jdbc, writeQueue, eventLog, promptBuilder, toolRegistry, providerRegistry) {
            @Override
            protected Object resolveModel(RunContext ctx) {
                Object override = modelOverride.get();
                return override != null ? override : super.resolveModel(ctx);
            }
        };

        accountId = new AccountService(jdbc, writeQueue).createAccount(ACCOUNT_NAME);
        ProviderRecord record = providerRegistry
                .create(accountId, "mock-provider", "mock", "test-key", "mock-model", null, true)
                .join();
        providerId = record.id();
        jdbc.sql("INSERT INTO sessions (id, account_id, title, workdir, model, provider_id, created_at, updated_at)"
                        + " VALUES (?, ?, 'test', ?, 'mock-model', ?, ?, ?)")
                .param(SESSION_ID)
                .param(accountId)
                .param(workdir.toAbsolutePath().normalize().toString())
                .param(providerId)
                .param(Instant.now().toString())
                .param(Instant.now().toString())
                .update();
    }

    @Override
    public void close() {
        runService.shutdown();
        writeQueue.close();
    }

    List<Event> events() {
        return eventLog.readRange(SESSION_ID, 1);
    }

    List<String> eventTypes() {
        return events().stream().map(Event::type).toList();
    }

    /** Ждёт, пока run не выйдет из RUNNING (терминальный статус), возвращает его. */
    String awaitTerminal(String runId, long timeoutMillis) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (System.currentTimeMillis() < deadline) {
            String status = runService.findRun(runId).map(RunRecord::status).orElse(null);
            if (status != null && !"RUNNING".equals(status)) {
                return status;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("run " + runId + " did not finish in " + timeoutMillis + "ms");
    }

    Map<String, Object> runRow(String runId) {
        return jdbc.sql("SELECT id, session_id, status, model, provider_id, usage_json, error, started_at, ended_at"
                        + " FROM runs WHERE id = ?")
                .param(runId)
                .query((rs, rowNum) -> {
                    Map<String, Object> row = new java.util.LinkedHashMap<>();
                    row.put("id", rs.getString("id"));
                    row.put("session_id", rs.getString("session_id"));
                    row.put("status", rs.getString("status"));
                    row.put("model", rs.getString("model"));
                    row.put("provider_id", rs.getString("provider_id"));
                    row.put("usage_json", rs.getString("usage_json"));
                    row.put("error", rs.getString("error"));
                    row.put("started_at", rs.getString("started_at"));
                    row.put("ended_at", rs.getString("ended_at"));
                    return row;
                })
                .single();
    }

    /** Последнее событие указанного типа (или null). */
    Event lastEvent(String type) {
        List<Event> events = events();
        for (int i = events.size() - 1; i >= 0; i--) {
            if (events.get(i).type().equals(type)) {
                return events.get(i);
            }
        }
        return null;
    }

    private static ToolProvider provider(ToolDefinition... defs) {
        return () -> List.of(defs);
    }

    // ---------------------------------------------------------------- mock models

    /**
     * Скриптованный streaming-модель (реальный {@link StreamingChatModel}): очередь туров,
     * каждый — Consumer хендлера. Подсаживается через {@link #modelOverride}.
     */
    static final class ScriptedStreamingModel implements StreamingChatModel {

        final BlockingQueue<Consumer<StreamingChatResponseHandler>> script = new LinkedBlockingQueue<>();
        final List<ChatRequest> requests = new CopyOnWriteArrayList<>();

        void enqueue(Consumer<StreamingChatResponseHandler> turn) {
            script.add(turn);
        }

        @Override
        public void doChat(ChatRequest request, StreamingChatResponseHandler handler) {
            requests.add(request);
            Consumer<StreamingChatResponseHandler> turn = script.poll();
            if (turn == null) {
                handler.onError(new IllegalStateException("script exhausted"));
                return;
            }
            turn.accept(handler);
        }
    }

    /** Скриптованный не-стриминг модель: очередь готовых ChatResponse. */
    static final class ScriptedChatModel implements ChatModel {

        final BlockingQueue<ChatResponse> script = new LinkedBlockingQueue<>();
        final List<ChatRequest> requests = new CopyOnWriteArrayList<>();

        void enqueue(ChatResponse response) {
            script.add(response);
        }

        @Override
        public ChatResponse doChat(ChatRequest request) {
            requests.add(request);
            ChatResponse response = script.poll();
            if (response == null) {
                throw new IllegalStateException("script exhausted");
            }
            return response;
        }
    }

    static ChatResponse response(AiMessage aiMessage, TokenUsage usage) {
        return ChatResponse.builder().aiMessage(aiMessage).tokenUsage(usage).build();
    }

    static ChatResponse response(AiMessage aiMessage) {
        return response(aiMessage, null);
    }

    static TokenUsage usage(int input, int output) {
        return new TokenUsage(input, output, input + output);
    }

    /** Ход «текст»: дельты + complete с финальным текстом. */
    static Consumer<StreamingChatResponseHandler> textTurn(String finalText, String... deltas) {
        return handler -> {
            for (String delta : deltas) {
                handler.onPartialResponse(delta);
            }
            handler.onCompleteResponse(response(AiMessage.from(finalText), usage(3, 5)));
        };
    }

    /** Ход «тул-коллы»: complete с AiMessage с toolExecutionRequests. */
    static Consumer<StreamingChatResponseHandler> toolTurn(ToolExecutionRequest... requests) {
        return handler -> handler.onCompleteResponse(
                response(AiMessage.from(List.of(requests)), usage(3, 5)));
    }

    /** Ход «ошибка LLM». */
    static Consumer<StreamingChatResponseHandler> errorTurn(String message) {
        return handler -> handler.onError(new RuntimeException(message));
    }

    /** Ответ не-стриминг модели: текст одним куском. */
    static ChatResponse chatText(String text) {
        return response(AiMessage.from(text), usage(3, 5));
    }

    /** Ответ не-стриминг модели: тул-коллы. */
    static ChatResponse chatTools(ToolExecutionRequest... requests) {
        return response(AiMessage.from(List.of(requests)), usage(3, 5));
    }

    /**
     * Блокирующийся ход: сигналит {@code started}, ждёт {@code release} (max 5s), потом
     * эмитит дельты и complete (используется в cancel-тестах).
     */
    static Consumer<StreamingChatResponseHandler> blockingTextTurn(
            CountDownLatch started, CountDownLatch release, String finalText, String... deltas) {
        return handler -> {
            started.countDown();
            try {
                release.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            for (String delta : deltas) {
                handler.onPartialResponse(delta);
            }
            handler.onCompleteResponse(response(AiMessage.from(finalText), usage(3, 5)));
        };
    }

    static ToolExecutionRequest toolRequest(String id, String name, String argumentsJson) {
        return ToolExecutionRequest.builder()
                .id(id)
                .name(name)
                .arguments(argumentsJson)
                .build();
    }

    // ---------------------------------------------------------------- stub tool

    /**
     * Stub-тул: считает вызовы, опционально блокируется на N-м вызове (latch'и) и/или
     * публикует {@link ToolUpdate}-стриминг.
     */
    static final class StubTool implements ToolDefinition {

        final List<ToolCall> calls = new CopyOnWriteArrayList<>();
        volatile CountDownLatch blockStarted;
        volatile CountDownLatch blockRelease;
        volatile int blockAtCallNumber = -1;
        volatile List<String> updateChunks = List.of();

        @Override
        public String name() {
            return STUB_TOOL;
        }

        @Override
        public String label() {
            return "stub";
        }

        @Override
        public String description() {
            return "stub tool for tests";
        }

        @Override
        public Map<String, Object> parametersSchema() {
            return Map.of("type", "object", "properties", Map.of());
        }

        @Override
        public String promptSnippet() {
            return "use stub-tool";
        }

        @Override
        public List<String> promptGuidelines() {
            return List.of();
        }

        @Override
        public ToolResult execute(ToolCall call, ToolContext ctx) {
            calls.add(call);
            for (String chunk : updateChunks) {
                ctx.publish(new ToolUpdate(name(), chunk, true));
            }
            if (blockAtCallNumber == calls.size() && blockStarted != null) {
                blockStarted.countDown();
                try {
                    if (blockRelease != null) {
                        blockRelease.await(5, TimeUnit.SECONDS);
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            return ToolResult.ok("result-of-" + name());
        }
    }
}
