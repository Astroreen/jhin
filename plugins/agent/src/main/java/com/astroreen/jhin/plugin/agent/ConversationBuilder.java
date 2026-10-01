/**
 * Replays the session event log into LangChain4j conversation messages.
 *
 * <p>Only completed prior turns are replayed: a turn (one {@code user_message}
 * up to the next one) enters the conversation when its assistant side
 * finished, marked by a {@code message_end} event. A turn that died mid-flight
 * (an {@code error} event, no {@code message_end}) is skipped entirely, and so
 * is the turn currently triggering the run — the caller appends the current
 * user message itself.
 *
 * <p>Event-to-message mapping (the wire names of {@code EventType}):
 * <ul>
 *   <li>{@code user_message} {@code {"text"}} &rarr; {@link UserMessage}</li>
 *   <li>{@code message_start} opens one assistant model turn</li>
 *   <li>{@code text_delta} {@code {"text"}} accumulates the turn's text</li>
 *   <li>{@code tool_use} {@code {"id","name","arguments"}} collects one
 *       {@link ToolExecutionRequest} into the open turn</li>
 *   <li>{@code tool_result} {@code {"id","name","content","error"}} pairs back
 *       to its request by id</li>
 *   <li>{@code message_end} {@code {"text"}} closes the turn as the final
 *       {@link AiMessage} (its payload carries the full text)</li>
 *   <li>{@code run_start}, {@code run_end}, {@code error} carry no
 *       conversation content</li>
 * </ul>
 *
 * <p>Model turns with tool calls are rebuilt as one {@link AiMessage} holding
 * the requests followed by one {@link ToolExecutionResultMessage} per paired
 * result — the shape LangChain4j 1.x tool calling expects. A request whose
 * result never arrived is dropped with its call.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.sdk.json.Json;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ConversationBuilder {

    private final EventLog events;

    ConversationBuilder(EventLog events) {
        this.events = events;
    }

    /**
     * Replays the completed turns of one session into conversation messages,
     * in chronological order. The turn currently triggering the run is not
     * included (it has no {@code message_end} yet).
     *
     * @param sessionId the session to replay
     * @return the messages of every completed turn
     */
    List<ChatMessage> build(String sessionId) {
        List<ChatMessage> out = new ArrayList<>();
        List<ChatMessage> turn = new ArrayList<>();
        Block block = new Block();
        String userText = null;
        boolean completed = false;
        for (EventRecord event : events.list(sessionId, 0)) {
            Map<String, Object> payload = readPayload(event);
            switch (event.type()) {
                case USER_MESSAGE -> {
                    flush(out, turn, block, completed, userText);
                    block = new Block();
                    turn = new ArrayList<>();
                    completed = false;
                    userText = text(payload, "text");
                }
                case MESSAGE_START -> block.flushTo(turn);
                case TEXT_DELTA -> block.append(text(payload, "text"));
                case TOOL_USE -> block.addRequest(
                        text(payload, "id"), text(payload, "name"), text(payload, "arguments"));
                case TOOL_RESULT -> block.attachResult(
                        text(payload, "id"),
                        text(payload, "name"),
                        text(payload, "content"),
                        Boolean.TRUE.equals(payload.get("error")));
                case MESSAGE_END -> {
                    block.flushTo(turn, text(payload, "text"));
                    completed = true;
                }
                default -> {
                }
            }
        }
        flush(out, turn, block, completed, userText);
        return List.copyOf(out);
    }

    private static void flush(List<ChatMessage> out, List<ChatMessage> turn, Block block,
                              boolean completed, String userText) {
        if (!completed || userText == null) {
            return;
        }
        out.add(UserMessage.from(userText));
        out.addAll(turn);
    }

    private static Map<String, Object> readPayload(EventRecord event) {
        String payload = event.payload();
        if (payload == null || payload.isBlank()) {
            return Map.of();
        }
        return Json.readMap(payload);
    }

    private static String text(Map<String, Object> payload, String key) {
        Object value = payload.get(key);
        return (value instanceof String s) ? s : null;
    }

    /**
     * One assistant model turn inside a conversation turn: the text
     * accumulated from {@code text_delta} events and the tool requests with
     * their paired results.
     */
    private static final class Block {

        private final StringBuilder text = new StringBuilder();
        private final Map<String, ToolExecutionRequest> requests = new LinkedHashMap<>();
        private final Map<String, ToolExecutionResultMessage> results = new LinkedHashMap<>();
        private boolean open;

        void append(String delta) {
            open = true;
            if (delta != null) {
                text.append(delta);
            }
        }

        void addRequest(String id, String name, String arguments) {
            open = true;
            if (id == null || name == null) {
                return;
            }
            requests.put(id, ToolExecutionRequest.builder()
                    .id(id)
                    .name(name)
                    .arguments(arguments == null ? "{}" : arguments)
                    .build());
        }

        void attachResult(String id, String name, String content, boolean error) {
            open = true;
            if (id == null || !requests.containsKey(id)) {
                return;
            }
            results.put(id, ToolExecutionResultMessage.builder()
                    .id(id)
                    .toolName(name == null ? requests.get(id).name() : name)
                    .text(content == null ? "" : content)
                    .isError(error)
                    .build());
        }

        void flushTo(List<ChatMessage> turn) {
            flushTo(turn, text.toString());
        }

        void flushTo(List<ChatMessage> turn, String finalText) {
            if (!open) {
                return;
            }
            String messageText = (finalText == null) ? "" : finalText;
            List<ToolExecutionRequest> paired = new ArrayList<>();
            List<ToolExecutionResultMessage> pairedResults = new ArrayList<>();
            for (Map.Entry<String, ToolExecutionRequest> entry : requests.entrySet()) {
                ToolExecutionResultMessage result = results.get(entry.getKey());
                if (result != null) {
                    paired.add(entry.getValue());
                    pairedResults.add(result);
                }
            }
            if (!paired.isEmpty()) {
                turn.add(messageText.isBlank()
                        ? AiMessage.from(paired)
                        : AiMessage.from(messageText, paired));
                turn.addAll(pairedResults);
            } else if (!messageText.isBlank()) {
                turn.add(AiMessage.from(messageText));
            }
            text.setLength(0);
            requests.clear();
            results.clear();
            open = false;
        }
    }
}
