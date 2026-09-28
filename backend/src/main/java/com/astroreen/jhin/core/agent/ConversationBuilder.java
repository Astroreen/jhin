package com.astroreen.jhin.core.agent;

import com.astroreen.jhin.core.events.Event;
import com.astroreen.jhin.core.events.EventTypes;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Пересборка истории сообщений LLM из event-лога сессии (полный replay с seq=1).
 *
 * <p>Правила пересборки (порядок событий в логе: {@code message_start}, {@code text_delta}*,
 * {@code message_end}, затем по каждому тул-вызову пара {@code tool_use} / {@code tool_result}*):
 * <ul>
 *   <li>{@code SystemMessage(systemPrompt)} — всегда первый, system prompt собирается заново
 *   на каждый run (свежие AGENTS.md и интерцепторы);</li>
 *   <li>{@code user_message} → {@code UserMessage(text)};</li>
 *   <li>{@code message_end} → начало «хода ассистента»: буферизуется text хода; далее
 *   {@code tool_use} этого хода собираются как {@link ToolExecutionRequest}
 *   (id=callId, name=toolName, arguments=JSON из map'а аргументов);</li>
 *   <li>{@code tool_result} с {@code streaming=false} → {@link ToolExecutionResultMessage}
 *   (id=callId, isError=error); прогресс-стриминги ({@code streaming=true}) пропускаются —
 *   они дублируют финальный результат;</li>
 *   <li>ход сливается в лог при следующем {@code message_end}/{@code user_message}/конце лога:
 *   сначала {@code AiMessage(text, toolExecutionRequests)} (без запросов — {@code AiMessage(text)}),
 *   затем все {@link ToolExecutionResultMessage} хода (так LC4j требует порядок
 *   AiMessage → результаты);</li>
 *   <li>прочие типы ({@code message_start}, {@code text_delta}, {@code run_*}, {@code error},
 *   {@code session_meta}, {@code ui}) игнорируются; осиротевшие {@code tool_use}/{@code tool_result}
 *   без хода (повреждённый лог) отбрасываются.</li>
 * </ul>
 */
public final class ConversationBuilder {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ConversationBuilder() {}

    /** Полный список сообщений: SystemMessage + ходы из лога в порядке seq. */
    public static List<ChatMessage> rebuild(String systemPrompt, List<Event> events) {
        List<ChatMessage> messages = new ArrayList<>();
        messages.add(new SystemMessage(systemPrompt));
        PendingTurn pending = null;
        for (Event event : events) {
            Map<String, Object> payload = event.payloadAsMap();
            switch (event.type()) {
                case EventTypes.USER_MESSAGE -> {
                    flush(messages, pending);
                    pending = null;
                    messages.add(new UserMessage(str(payload, "text")));
                }
                case EventTypes.MESSAGE_END -> {
                    flush(messages, pending);
                    pending = new PendingTurn(str(payload, "text"));
                }
                case EventTypes.TOOL_USE -> {
                    if (pending != null) {
                        pending.requests.add(toRequest(payload));
                    }
                }
                case EventTypes.TOOL_RESULT -> {
                    if (pending != null && !bool(payload, "streaming")) {
                        pending.results.add(toResultMessage(payload));
                    }
                }
                default -> {
                    // прочие события не входят в контекст LLM
                }
            }
        }
        flush(messages, pending);
        return messages;
    }

    private static void flush(List<ChatMessage> messages, PendingTurn pending) {
        if (pending == null) {
            return;
        }
        String text = pending.text == null || pending.text.isEmpty() ? null : pending.text;
        if (pending.requests.isEmpty()) {
            messages.add(new AiMessage(pending.text == null ? "" : pending.text));
        } else {
            messages.add(new AiMessage(text, pending.requests));
        }
        messages.addAll(pending.results);
    }

    private static ToolExecutionRequest toRequest(Map<String, Object> payload) {
        Object arguments = payload.get("arguments");
        String json;
        if (arguments == null) {
            json = "{}";
        } else if (arguments instanceof String s) {
            json = s;
        } else {
            try {
                json = MAPPER.writeValueAsString(arguments);
            } catch (Exception e) {
                json = "{}";
            }
        }
        return ToolExecutionRequest.builder()
                .id(str(payload, "callId"))
                .name(str(payload, "toolName"))
                .arguments(json)
                .build();
    }

    private static ToolExecutionResultMessage toResultMessage(Map<String, Object> payload) {
        return ToolExecutionResultMessage.builder()
                .id(str(payload, "callId"))
                .toolName(str(payload, "toolName"))
                .text(str(payload, "content"))
                .isError(bool(payload, "error"))
                .build();
    }

    private static String str(Map<String, Object> payload, String key) {
        Object value = payload == null ? null : payload.get(key);
        return value == null ? "" : String.valueOf(value);
    }

    private static boolean bool(Map<String, Object> payload, String key) {
        Object value = payload == null ? null : payload.get(key);
        return value instanceof Boolean b && b;
    }

    private static final class PendingTurn {

        final String text;
        final List<ToolExecutionRequest> requests = new ArrayList<>();
        final List<ToolExecutionResultMessage> results = new ArrayList<>();

        PendingTurn(String text) {
            this.text = text;
        }
    }
}
