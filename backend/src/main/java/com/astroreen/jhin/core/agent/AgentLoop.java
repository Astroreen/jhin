package com.astroreen.jhin.core.agent;

import com.astroreen.jhin.core.agent.spi.PluginVetoException;
import com.astroreen.jhin.core.agent.spi.PromptContext;
import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.events.Event;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.events.EventTypes;
import com.astroreen.jhin.core.tools.ToolRegistry;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.chat.response.StreamingChatResponseHandler;
import dev.langchain4j.model.output.TokenUsage;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * LLM↔тулы цикл одного run'а (plain class, вызывается из {@link RunService}).
 *
 * <p>Поток исполнения:
 * <ol>
 *   <li>сборка system prompt ({@link SystemPromptBuilder}); {@link PluginVetoException}
 *   или RuntimeException → run ERROR ({@code error} «veto: reason», {@code run_end});</li>
 *   <li>пересборка контекста из event-лога ({@link ConversationBuilder}, полный replay);
 *   сборка &gt; {@link #CONTEXT_CHAR_LIMIT} символов → ERROR «context overflow — start a new
 *   session» (компакшен/бранчинга нет);</li>
 *   <li>событие {@code run_start};</li>
 *   <li>цикл ≤ {@link #MAX_ITERATIONS} LLM-туров: {@code message_start} → стрим
 *   ({@link StreamingChatModel} через {@link StreamingChatResponseHandler}, иначе
 *   {@link ChatModel#chat} одним {@code text_delta}) → {@code message_end} → на каждый
 *   tool call: {@code tool_use}, стриминг-{@code tool_result} (streaming=true) из
 *   {@code ToolContext.setOnUpdate}, финальный {@code tool_result} (streaming=false);
 *   без tool calls — конец цикла (DONE);</li>
 *   <li>агрегация {@link TokenUsage} всех туров в {@code usage_json};</li>
 *   <li>финиш: {@code run_end} + UPDATE {@code runs} (status, usage_json, error, ended_at).
 *   Каждый путь (включая finally) оставляет строку run'а не в RUNNING.</li>
 * </ol>
 *
 * <p>Отмена: {@link RunContext#isCancelled()} проверяется между турами, между тулами и
 * внутри колбэков стрима (после отмены события не дописываются). Прерывание открытого
 * сокета LLM — best-effort: цикл перестаёт ждать колбэки и сразу финиширует CANCELLED,
 * поздние колбэки глушатся флагом.
 */
public class AgentLoop {

    /** Максимум LLM-итераций на run; больше — ERROR «too many iterations». */
    static final int MAX_ITERATIONS = 50;

    /** Лимит символов собранного контекста (system + сообщения); больше — ERROR overflow. */
    static final int CONTEXT_CHAR_LIMIT = 200_000;

    private static final Logger log = LoggerFactory.getLogger(AgentLoop.class);
    private static final long CANCEL_POLL_MILLIS = 200;
    private static final long STREAM_TIMEOUT_MINUTES = 10;
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    private final SystemPromptBuilder systemPromptBuilder;
    private final ToolRegistry toolRegistry;
    private final EventLogService eventLog;
    private final WriteQueue writeQueue;
    private final JdbcClient jdbcClient;

    public AgentLoop(
            SystemPromptBuilder systemPromptBuilder,
            ToolRegistry toolRegistry,
            EventLogService eventLog,
            WriteQueue writeQueue,
            JdbcClient jdbcClient) {
        this.systemPromptBuilder = systemPromptBuilder;
        this.toolRegistry = toolRegistry;
        this.eventLog = eventLog;
        this.writeQueue = writeQueue;
        this.jdbcClient = jdbcClient;
    }

    /**
     * Исполняет run от сборки промпта до финиша. Никогда не бросает: любой сбой уходит
     * в {@code error}-событие и строку {@code runs} (status + ended_at).
     *
     * <p>Модель — {@code Object}: в LC4j 1.20.1 {@link ChatModel} и {@link StreamingChatModel}
     * несовместимы (одновременно реализовать нельзя), а {@code buildChatModel} возвращает
     * {@link ChatModel}. Ветвление: {@code model instanceof StreamingChatModel} → стриминг
     * через {@link StreamingChatResponseHandler}, иначе {@link ChatModel} → один text_delta.
     */
    public void run(RunContext ctx, Object model) {
        RunExecution exec = new RunExecution(ctx);
        try {
            runInternal(exec, model);
        } catch (Throwable t) {
            log.warn("Run {} failed unexpectedly", ctx.runId(), t);
            exec.fail(message(t), message(t));
        } finally {
            exec.ensureFinalized();
        }
    }

    /** Финиш run'а, не дошедшего до цикла (например, не собралась модель): ERROR + события. */
    public void failRun(RunContext ctx, String message) {
        new RunExecution(ctx).fail(message, message);
    }

    private void runInternal(RunExecution exec, Object model) {
        RunContext ctx = exec.ctx;

        String systemPrompt;
        try {
            PromptContext promptCtx = systemPromptBuilder.build(
                    ctx.workdir().toString(), ctx.sessionId(), ctx.runId(), toolRegistry.all());
            systemPrompt = promptCtx.systemPrompt();
        } catch (PluginVetoException e) {
            exec.fail("veto: " + e.getReason(), e.getReason());
            return;
        } catch (RuntimeException e) {
            exec.fail(message(e), message(e));
            return;
        }

        List<Event> events = eventLog.readRange(ctx.sessionId(), 1);
        List<ChatMessage> messages = ConversationBuilder.rebuild(systemPrompt, events);
        if (charCount(messages) > CONTEXT_CHAR_LIMIT) {
            exec.fail("context overflow — start a new session", "context overflow — start a new session");
            return;
        }

        Map<String, Object> runStart = new LinkedHashMap<>();
        runStart.put("runId", ctx.runId());
        runStart.put("sessionId", ctx.sessionId());
        runStart.put("model", ctx.model());
        runStart.put("providerId", ctx.providerId());
        exec.append(EventTypes.RUN_START, runStart);

        List<ToolSpecification> toolSpecs = toolSpecifications();
        Usage usage = new Usage();
        boolean done = false;
        String turnError = null;

        for (int turn = 0; turn < MAX_ITERATIONS; turn++) {
            if (ctx.isCancelled()) {
                exec.finish("CANCELLED", usage, null);
                return;
            }
            String messageId = ctx.runId() + "-" + turn;
            Map<String, Object> start = new LinkedHashMap<>();
            start.put("runId", ctx.runId());
            start.put("messageId", messageId);
            exec.append(EventTypes.MESSAGE_START, start);

            StringBuilder text = new StringBuilder();
            TurnOutcome outcome = callModel(exec, model, messages, toolSpecs, text);
            if (outcome.cancelled()) {
                exec.finish("CANCELLED", usage, null);
                return;
            }
            if (outcome.error() != null) {
                turnError = outcome.error();
                break;
            }
            ChatResponse response = outcome.response();
            if (response == null) {
                turnError = "llm returned no response";
                break;
            }
            addUsage(usage, response.tokenUsage());

            String messageText = text.toString();
            AiMessage aiMessage = response.aiMessage();
            if (messageText.isEmpty() && aiMessage != null && aiMessage.text() != null) {
                messageText = aiMessage.text();
            }

            Map<String, Object> end = new LinkedHashMap<>();
            end.put("runId", ctx.runId());
            end.put("messageId", messageId);
            end.put("text", messageText);
            exec.append(EventTypes.MESSAGE_END, end);

            List<ToolExecutionRequest> requests =
                    aiMessage != null ? aiMessage.toolExecutionRequests() : null;
            boolean hasTools = requests != null && !requests.isEmpty();
            if (hasTools) {
                messages.add(new AiMessage(
                        messageText.isEmpty() ? null : messageText, requests));
                for (int i = 0; i < requests.size(); i++) {
                    if (ctx.isCancelled()) {
                        exec.finish("CANCELLED", usage, null);
                        return;
                    }
                    executeToolCall(exec, ctx, requests.get(i), turn, i, messages);
                }
            } else {
                messages.add(new AiMessage(messageText));
                done = true;
                break;
            }
        }

        if (turnError != null) {
            exec.fail(turnError, turnError);
            return;
        }
        if (!done) {
            if (ctx.isCancelled()) {
                exec.finish("CANCELLED", usage, null);
            } else {
                exec.fail("too many iterations", "too many iterations");
            }
            return;
        }
        if (ctx.isCancelled()) {
            exec.finish("CANCELLED", usage, null);
            return;
        }
        exec.finish("DONE", usage, null);
    }

    private void executeToolCall(
            RunExecution exec,
            RunContext ctx,
            ToolExecutionRequest request,
            int turn,
            int index,
            List<ChatMessage> messages) {
        String callId = request.id() != null && !request.id().isBlank()
                ? request.id()
                : ctx.runId() + "-call-" + turn + "-" + index;
        String toolName = request.name();
        Map<String, Object> arguments = parseArguments(request.arguments());

        Map<String, Object> use = new LinkedHashMap<>();
        use.put("runId", ctx.runId());
        use.put("callId", callId);
        use.put("toolName", toolName);
        use.put("arguments", arguments);
        exec.append(EventTypes.TOOL_USE, use);

        ctx.toolContext().setOnUpdate(update -> {
            if (ctx.isCancelled()) {
                return;
            }
            Map<String, Object> chunk = new LinkedHashMap<>();
            chunk.put("runId", ctx.runId());
            chunk.put("callId", callId);
            chunk.put("toolName", toolName);
            chunk.put("content", update.chunk());
            chunk.put("error", false);
            chunk.put("truncated", false);
            chunk.put("structured", null);
            chunk.put("meta", Map.of());
            chunk.put("streaming", true);
            exec.append(EventTypes.TOOL_RESULT, chunk);
        });

        ToolResult result;
        try {
            result = toolRegistry.execute(toolName, arguments, ctx.toolContext());
        } finally {
            ctx.toolContext().setOnUpdate(null);
        }

        Map<String, Object> done = new LinkedHashMap<>();
        done.put("runId", ctx.runId());
        done.put("callId", callId);
        done.put("toolName", toolName);
        done.put("content", result.content());
        done.put("error", result.error());
        done.put("truncated", result.truncated());
        done.put("structured", result.structured());
        done.put("meta", result.meta());
        done.put("streaming", false);
        exec.append(EventTypes.TOOL_RESULT, done);

        messages.add(ToolExecutionResultMessage.builder()
                .id(callId)
                .toolName(toolName)
                .text(result.content())
                .isError(result.error())
                .build());
    }

    private TurnOutcome callModel(
            RunExecution exec,
            Object model,
            List<ChatMessage> messages,
            List<ToolSpecification> toolSpecs,
            StringBuilder textOut) {
        ChatRequest request = ChatRequest.builder()
                .messages(messages)
                .toolSpecifications(toolSpecs)
                .build();
        RunContext ctx = exec.ctx;
        if (model instanceof StreamingChatModel streamingModel) {
            return streamTurn(exec, streamingModel, request, textOut);
        }
        if (!(model instanceof ChatModel chatModel)) {
            return TurnOutcome.failed("unsupported llm model: " + model);
        }
        ChatResponse response;
        try {
            response = chatModel.chat(request);
        } catch (RuntimeException e) {
            return TurnOutcome.failed(message(e));
        }
        if (ctx.isCancelled()) {
            return TurnOutcome.aborted();
        }
        if (response != null && response.aiMessage() != null && response.aiMessage().text() != null
                && !response.aiMessage().text().isEmpty()) {
            textOut.append(response.aiMessage().text());
            Map<String, Object> delta = new LinkedHashMap<>();
            delta.put("runId", ctx.runId());
            delta.put("text", response.aiMessage().text());
            exec.append(EventTypes.TEXT_DELTA, delta);
        }
        return TurnOutcome.completed(response);
    }

    /**
     * Стриминг одного тура: {@link StreamingChatResponseHandler#onPartialResponse} шлёт
     * {@code text_delta} (после отмены — тишина, флаг-гард). Ожидание колбэков опрашивает
     * флаг отмены каждые {@link #CANCEL_POLL_MILLIS} мс — после отмены цикл сразу выходит
     * (разрыв сокета LLM не реализован, документировано как best-effort).
     */
    private TurnOutcome streamTurn(
            RunExecution exec,
            StreamingChatModel model,
            ChatRequest request,
            StringBuilder textOut) {
        RunContext ctx = exec.ctx;
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<ChatResponse> responseRef = new AtomicReference<>();
        AtomicReference<Throwable> errorRef = new AtomicReference<>();

        StreamingChatResponseHandler handler = new StreamingChatResponseHandler() {
            @Override
            public void onPartialResponse(String delta) {
                if (delta == null || delta.isEmpty() || ctx.isCancelled()) {
                    return;
                }
                textOut.append(delta);
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("runId", ctx.runId());
                payload.put("text", delta);
                exec.append(EventTypes.TEXT_DELTA, payload);
            }

            @Override
            public void onCompleteResponse(ChatResponse response) {
                responseRef.set(response);
                latch.countDown();
            }

            @Override
            public void onError(Throwable error) {
                errorRef.set(error);
                latch.countDown();
            }
        };

        model.chat(request, handler);

        long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(STREAM_TIMEOUT_MINUTES);
        try {
            while (!latch.await(CANCEL_POLL_MILLIS, TimeUnit.MILLISECONDS)) {
                if (ctx.isCancelled()) {
                    return TurnOutcome.aborted();
                }
                if (System.nanoTime() > deadline) {
                    return TurnOutcome.failed("llm response timeout");
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return TurnOutcome.failed("interrupted while waiting for llm");
        }
        if (ctx.isCancelled()) {
            return TurnOutcome.aborted();
        }
        if (errorRef.get() != null) {
            return TurnOutcome.failed(message(errorRef.get()));
        }
        return TurnOutcome.completed(responseRef.get());
    }

    private List<ToolSpecification> toolSpecifications() {
        List<ToolSpecification> specs = new ArrayList<>();
        for (var definition : toolRegistry.all()) {
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("name", definition.name());
            node.put("description", definition.description() == null ? "" : definition.description());
            Map<String, Object> schema = definition.parametersSchema();
            node.put("parameters", schema == null ? Map.of("type", "object") : schema);
            try {
                specs.add(ToolSpecification.fromJson(MAPPER.writeValueAsString(node)));
            } catch (Exception e) {
                log.warn("Tool '{}' has an unparseable parameters schema, exposing without parameters",
                        definition.name(), e);
                specs.add(ToolSpecification.builder()
                        .name(definition.name())
                        .description(definition.description())
                        .build());
            }
        }
        return specs;
    }

    private static Map<String, Object> parseArguments(String argumentsJson) {
        if (argumentsJson == null || argumentsJson.isBlank()) {
            return Map.of();
        }
        try {
            Map<String, Object> parsed = MAPPER.readValue(argumentsJson, MAP_TYPE);
            return parsed == null ? Map.of() : parsed;
        } catch (Exception e) {
            log.warn("Failed to parse tool arguments: {}", argumentsJson, e);
            return Map.of();
        }
    }

    private static void addUsage(Usage usage, TokenUsage tokenUsage) {
        if (tokenUsage == null) {
            return;
        }
        usage.input += tokenUsage.inputTokenCount() == null ? 0 : tokenUsage.inputTokenCount();
        usage.output += tokenUsage.outputTokenCount() == null ? 0 : tokenUsage.outputTokenCount();
        usage.total += tokenUsage.totalTokenCount() == null ? 0 : tokenUsage.totalTokenCount();
    }

    private static int charCount(List<ChatMessage> messages) {
        int total = 0;
        for (ChatMessage message : messages) {
            if (message instanceof SystemMessage system) {
                total += len(system.text());
            } else if (message instanceof UserMessage user) {
                total += len(user.singleText());
            } else if (message instanceof AiMessage ai) {
                total += len(ai.text());
                if (ai.toolExecutionRequests() != null) {
                    for (ToolExecutionRequest request : ai.toolExecutionRequests()) {
                        total += len(request.arguments());
                    }
                }
            } else if (message instanceof ToolExecutionResultMessage result) {
                total += len(result.text());
            }
        }
        return total;
    }

    private static int len(String s) {
        return s == null ? 0 : s.length();
    }

    private static String message(Throwable t) {
        return t.getMessage() != null ? t.getMessage() : t.toString();
    }

    private static final class Usage {

        long input;
        long output;
        long total;

        String toJson() {
            try {
                Map<String, Object> node = new LinkedHashMap<>();
                node.put("inputTokens", input);
                node.put("outputTokens", output);
                node.put("totalTokens", total);
                return MAPPER.writeValueAsString(node);
            } catch (Exception e) {
                return "{\"inputTokens\":0,\"outputTokens\":0,\"totalTokens\":0}";
            }
        }
    }

    private record TurnOutcome(ChatResponse response, String error, boolean cancelled) {

        static TurnOutcome completed(ChatResponse response) {
            return new TurnOutcome(response, null, false);
        }

        static TurnOutcome failed(String error) {
            return new TurnOutcome(null, error, false);
        }

        static TurnOutcome aborted() {
            return new TurnOutcome(null, null, true);
        }
    }

    /** Финализация одного run'а: события + UPDATE {@code runs}; ровно один раз на run. */
    private final class RunExecution {

        private final RunContext ctx;
        private final AtomicBoolean finalized = new AtomicBoolean(false);

        RunExecution(RunContext ctx) {
            this.ctx = ctx;
        }

        void append(String type, Map<String, Object> payload) {
            eventLog.append(ctx.sessionId(), type, payload).join();
        }

        /** ERROR-финиш: {@code error} «message», {@code run_end} ERROR, runs.error = runError. */
        void fail(String message, String runError) {
            if (!finalized.compareAndSet(false, true)) {
                return;
            }
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("runId", ctx.runId());
            error.put("message", message);
            append(EventTypes.ERROR, error);
            Map<String, Object> end = new LinkedHashMap<>();
            end.put("runId", ctx.runId());
            end.put("status", "ERROR");
            append(EventTypes.RUN_END, end);
            updateRun("ERROR", null, runError);
        }

        /** Финиш DONE/CANCELLED: {@code run_end} + UPDATE (status, usage_json, error=null). */
        void finish(String status, Usage usage, String error) {
            if (!finalized.compareAndSet(false, true)) {
                return;
            }
            Map<String, Object> end = new LinkedHashMap<>();
            end.put("runId", ctx.runId());
            end.put("status", status);
            append(EventTypes.RUN_END, end);
            updateRun(status, usage == null ? null : usage.toJson(), error);
        }

        void ensureFinalized() {
            if (!finalized.get()) {
                fail("run ended unexpectedly", "run ended unexpectedly");
            }
        }

        private void updateRun(String status, String usageJson, String error) {
            String endedAt = java.time.Instant.now().toString();
            writeQueue.submit(() -> jdbcClient
                            .sql("UPDATE runs SET status = ?, usage_json = ?, error = ?, ended_at = ? WHERE id = ?")
                            .param(status)
                            .param(usageJson)
                            .param(error)
                            .param(endedAt)
                            .param(ctx.runId())
                            .update())
                    .join();
        }
    }
}
