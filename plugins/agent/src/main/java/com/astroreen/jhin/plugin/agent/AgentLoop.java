/**
 * One agent run: prompt &rarr; model &rarr; tools &rarr; model &rarr; final
 * answer, with every step emitted as a session event.
 *
 * <p>Event sequence of a run (the payload shapes designed for the UI stream
 * route; every payload is a JSON object):
 * <ul>
 *   <li>{@code run_start} {@code {"runId"}}</li>
 *   <li>per model call: {@code message_start} {@code {"role":"assistant"}}
 *       &rarr; zero or more {@code text_delta} {@code {"text"}} (the delta
 *       text) &rarr; then either the tool branch or the final branch</li>
 *   <li>tool branch, per requested call: {@code tool_use}
 *       {@code {"id","name","arguments"}} (arguments as raw JSON text) &rarr;
 *       {@code tool_result} {@code {"id","name","content","error"}} plus
 *       {@code "structured"} when the tool produced a structured payload;
 *       the loop then starts the next model call</li>
 *   <li>final branch: {@code message_end} {@code {"text"}} (the full text of
 *       the finished assistant message) &rarr; {@code run_end}
 *       {@code {"runId"}}</li>
 *   <li>failure branch (prompt veto, model error, cancellation, turn cap):
 *       one {@code error} {@code {"message"}} instead of {@code run_end};
 *       no model call happens after a prompt veto</li>
 * </ul>
 *
 * <p>One-shot model responses (the {@code ChatModel} contract) surface as a
 * single {@code text_delta} carrying the whole text; the event shape already
 * supports multiple deltas for future streaming models. The loop is capped at
 * {@link #MAX_MODEL_TURNS} model calls per run and returns the failure text
 * (already emitted as an {@code error} event) or {@code null} on success.
 *
 * <p>Public (like {@link AgentPlugin}) so the export-boundary scratch fixture
 * can reference the type at compile time; still non-exported — the manifest
 * publishes only {@code com.astroreen.jhin.plugin.agent.api}, so other plugins
 * fail to load it with the production {@code ClassNotFoundException}.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.agent.api.PluginVetoException;
import com.astroreen.jhin.plugin.agent.api.PromptContext;
import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.sdk.json.Json;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;

public final class AgentLoop {

    static final int MAX_MODEL_TURNS = 25;

    private final EventLog events;
    private final SystemPromptBuilder prompts;
    private final ConversationBuilder conversations;
    private final ToolInvoker invoker;
    private final ProviderRegistry providers;
    private final Logger log;

    AgentLoop(EventLog events, SystemPromptBuilder prompts, ConversationBuilder conversations,
              ToolInvoker invoker, ProviderRegistry providers, Logger log) {
        this.events = events;
        this.prompts = prompts;
        this.conversations = conversations;
        this.invoker = invoker;
        this.providers = providers;
        this.log = log;
    }

    /**
     * Runs one agent run to completion on the calling thread. Emits every
     * session event of the run and returns the failure text of a failed run
     * (already emitted as an {@code error} event) or {@code null} when the run
     * finished with {@code run_end}.
     *
     * @param ctx the run state, including the triggering user message
     * @return the failure text, or {@code null} on success
     */
    String run(RunContext ctx) {
        String sessionId = ctx.session().id();
        append(sessionId, EventType.RUN_START, Map.of("runId", ctx.runId()));
        try {
            PromptContext prompt = prompts.build(ctx.session());
            ChatModel model = modelFor(ctx.session());
            List<ToolSpecification> specs = toolSpecs();
            List<ChatMessage> messages = new ArrayList<>();
            messages.add(SystemMessage.from(prompt.systemPrompt()));
            messages.addAll(conversations.build(sessionId));
            messages.add(UserMessage.from(ctx.text()));
            for (int turn = 1; turn <= MAX_MODEL_TURNS; turn++) {
                if (ctx.isCancelled()) {
                    return fail(sessionId, "cancelled");
                }
                append(sessionId, EventType.MESSAGE_START, Map.of("role", "assistant"));
                ChatResponse response = model.chat(request(messages, specs));
                AiMessage answer = response.aiMessage();
                messages.add(answer);
                if (answer.hasToolExecutionRequests()) {
                    String accompanying = answer.text();
                    if (accompanying != null && !accompanying.isBlank()) {
                        append(sessionId, EventType.TEXT_DELTA, Map.of("text", accompanying));
                    }
                    if (executeTools(ctx, messages, answer.toolExecutionRequests())) {
                        return fail(sessionId, "cancelled");
                    }
                    continue;
                }
                String text = (answer.text() == null) ? "" : answer.text();
                append(sessionId, EventType.TEXT_DELTA, Map.of("text", text));
                append(sessionId, EventType.MESSAGE_END, Map.of("text", text));
                append(sessionId, EventType.RUN_END, Map.of("runId", ctx.runId()));
                return null;
            }
            return fail(sessionId, "model turn limit exceeded (" + MAX_MODEL_TURNS + ")");
        } catch (PluginVetoException veto) {
            return fail(sessionId, veto.getMessage());
        } catch (Exception e) {
            log.warn("agent run {} failed", ctx.runId(), e);
            return fail(sessionId, messageOf(e));
        }
    }

    /**
     * Executes the tool calls of one model turn, emitting the
     * {@code tool_use} / {@code tool_result} pair per call and appending both
     * message kinds to the live conversation.
     *
     * @return {@code true} when cancellation was observed mid-turn
     */
    private boolean executeTools(RunContext ctx, List<ChatMessage> messages,
                                 List<ToolExecutionRequest> requests) {
        String sessionId = ctx.session().id();
        List<ToolExecutionResultMessage> results = new ArrayList<>();
        for (ToolExecutionRequest request : requests) {
            if (ctx.isCancelled()) {
                return true;
            }
            ToolCall call = new ToolCall(request.id(), request.name(), request.arguments());
            Map<String, Object> use = new LinkedHashMap<>();
            use.put("id", call.id());
            use.put("name", call.name());
            use.put("arguments", call.arguments());
            append(sessionId, EventType.TOOL_USE, use);
            ToolResult result = invoker.invoke(call, ctx.toolContext());
            Map<String, Object> done = new LinkedHashMap<>();
            done.put("id", call.id());
            done.put("name", call.name());
            done.put("content", result.content());
            if (result.structured() != null) {
                done.put("structured", result.structured());
            }
            done.put("error", result.error());
            append(sessionId, EventType.TOOL_RESULT, done);
            results.add(ToolExecutionResultMessage.builder()
                    .id(request.id())
                    .toolName(request.name())
                    .text(result.content())
                    .isError(result.error())
                    .build());
        }
        messages.addAll(results);
        return false;
    }

    private ChatModel modelFor(com.astroreen.jhin.plugin.sessions.api.Session session) {
        String providerId = session.providerId();
        if (providerId == null || providerId.isBlank()) {
            throw new IllegalStateException("session has no provider configured");
        }
        return providers.modelFor(session.accountId(), providerId);
    }

    private ChatRequest request(List<ChatMessage> messages, List<ToolSpecification> specs) {
        ChatRequest.Builder builder = ChatRequest.builder().messages(messages);
        if (!specs.isEmpty()) {
            builder.toolSpecifications(specs);
        }
        return builder.build();
    }

    private List<ToolSpecification> toolSpecs() {
        List<ToolSpecification> specs = new ArrayList<>();
        for (ToolDefinition tool : invoker.resolveTools().values()) {
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("name", tool.name());
            json.put("description", tool.description());
            String schema = tool.parametersSchema();
            if (schema != null && !schema.isBlank()) {
                try {
                    json.put("parameters", Json.readMap(schema));
                } catch (RuntimeException e) {
                    log.warn("tool '{}' has an unparsable parameters schema; exposing it without"
                            + " parameters", tool.name(), e);
                }
            }
            try {
                specs.add(ToolSpecification.fromJson(Json.write(json)));
            } catch (RuntimeException e) {
                log.warn("tool '{}' cannot be exposed to the model; skipped", tool.name(), e);
            }
        }
        return specs;
    }

    private String fail(String sessionId, String message) {
        append(sessionId, EventType.ERROR, Map.of("message", message));
        return message;
    }

    private void append(String sessionId, EventType type, Map<String, Object> payload) {
        events.append(sessionId, type, Json.write(payload));
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
