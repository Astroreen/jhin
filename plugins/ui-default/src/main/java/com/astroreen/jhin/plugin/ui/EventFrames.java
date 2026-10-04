/**
 * Translation of session events into SDUI stream frames (the frame shapes of
 * the streams contract) and into one-line summaries for server-side snapshots.
 *
 * <p><b>Frame model.</b> Each event becomes exactly one frame:
 * <ul>
 *   <li>{@code user_message} — the tinted {@code card} bubble of
 *       {@link MessageCardBuilder#userBubble};</li>
 *   <li>{@code message_start} — the empty assistant {@code card} bubble whose
 *       markdown child carries the {@code id} {@code msg-<seq>};</li>
 *   <li>{@code text_delta} — grows that text node in place ({@code patch} with
 *       the accumulated text; the first delta of a mid-stream join opens the
 *       node itself);</li>
 *   <li>{@code message_end} — finalizes the streamed text ({@code patch} with
 *       the complete message);</li>
 *   <li>{@code run_start} / {@code run_end} — {@code patch} frames against the
 *       run status badge ({@code runStatus}) of the surrounding screen, so the
 *       composer status line flips live;</li>
 *   <li>{@code tool_use} — the compact {@code code_block} node with the raw
 *       tool arguments JSON;</li>
 *   <li>{@code tool_result} — the collapsed {@code card} node built from the
 *       {@code structured} payload when present (the {@code card}/{@code image}
 *       family inside a collapsible list section), else a plain card with the
 *       text content; a malformed payload degrades to that same plain card;</li>
 *   <li>{@code session_updated} — the sidebar-row {@code patch} frame
 *       {@code {"patch":{"id":"session-row:<sessionId>","props":{…}}}} whose
 *       props carry the title and the lifecycle fields of the row;</li>
 *   <li>{@code error} — the danger {@code banner} node.</li>
 * </ul>
 *
 * <p><b>State.</b> The growing-message frames need the id and the accumulated
 * text of the open message, so translation is stateful per stream. The
 * forwarder that feeds live frames to every listener seeds its state by
 * absorbing the persisted history first, so its frames match the replayed ones
 * event for event; a replay that starts mid-message ({@code fromSeq}) seeds
 * the same way before emitting its window.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.ui.screens.MessageCardBuilder;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class EventFrames {

    /** The SSE event name every translated frame is written under. */
    static final String FRAME_EVENT = "frame";

    private EventFrames() {
    }

    /**
     * One stream's translation state: the open assistant message, if any.
     */
    static final class Translator {

        private String messageId;
        private String accumulated = "";

        /**
         * Translates one event into its frame.
         *
         * @param wireType    the event kind wire name
         * @param payloadJson the event payload as JSON text (may be blank)
         * @param seq         the event sequence number (drives the node ids)
         * @return the frame map, exactly one of {@code {node:…}} or
         *         {@code {patch:…}}
         */
        Map<String, Object> frame(String wireType, String payloadJson, long seq) {
            Map<String, Object> payload = parse(payloadJson);
            return switch (wireType) {
                case "user_message" -> node(MessageCardBuilder.userBubble(textOf(payload), seq));
                case "message_start" -> openMessage(seq);
                case "text_delta" -> growMessage(payload, seq);
                case "message_end" -> endMessage(payload, seq);
                case "run_start" -> patch(MessageCardBuilder.STATUS_ID,
                        MessageCardBuilder.statusProps(MessageCardBuilder.STATUS_RUNNING, "$color.accent"));
                case "run_end" -> patch(MessageCardBuilder.STATUS_ID,
                        MessageCardBuilder.statusProps(MessageCardBuilder.STATUS_IDLE, null));
                case "tool_use" -> node(MessageCardBuilder.toolUse(
                        String.valueOf(payload.getOrDefault("name", "tool")),
                        argumentsOf(payload), seq));
                case "tool_result" -> node(MessageCardBuilder.toolResult(
                        String.valueOf(payload.getOrDefault("name", "tool")),
                        contentOf(payload), jsonOf(payload.get("structured")),
                        Boolean.TRUE.equals(payload.get("error")), seq));
                case "session_updated" -> sessionUpdatedFrame(payloadJson);
                case "error" -> node(MessageCardBuilder.errorBanner(errorMessageOf(payload), seq));
                default -> node(Ui.text("Event: " + wireType).id("ev-" + seq)
                        .style("caption").build());
            };
        }

        /**
         * Advances the translation state from one event without producing a
         * frame. Called while the live forwarder seeds its state from the
         * persisted history.
         *
         * @param wireType    the event kind wire name
         * @param payloadJson the event payload as JSON text
         * @param seq         the event sequence number
         */
        void absorb(String wireType, String payloadJson, long seq) {
            frame(wireType, payloadJson, seq);
        }

        private Map<String, Object> openMessage(long seq) {
            messageId = MessageCardBuilder.messageId(seq);
            accumulated = "";
            return node(MessageCardBuilder.assistantBubble(seq, ""));
        }

        private Map<String, Object> growMessage(Map<String, Object> payload, long seq) {
            String delta = textOf(payload);
            if (messageId == null) {
                messageId = MessageCardBuilder.messageId(seq);
                accumulated = delta;
                return node(MessageCardBuilder.assistantBubble(seq, accumulated));
            }
            accumulated += delta;
            return patch(messageId, Map.of("text", accumulated));
        }

        private Map<String, Object> endMessage(Map<String, Object> payload, long seq) {
            String finalText = payload.containsKey("text") ? textOf(payload) : accumulated;
            if (messageId == null) {
                return node(MessageCardBuilder.assistantBubble(seq, finalText));
            }
            Map<String, Object> frame = patch(messageId, Map.of("text", finalText));
            messageId = null;
            accumulated = "";
            return frame;
        }
    }

    /**
     * One-line summaries of the tail of one session, for the server-side
     * snapshot a client without the {@code sse} capability renders instead of
     * a stream view.
     *
     * @param records the events to summarize, in sequence order
     * @param limit   how many summaries to keep (the newest ones)
     * @return the summary lines
     */
    static List<Object> snapshotItems(List<EventRecord> records, int limit) {
        List<Object> items = new ArrayList<>();
        for (EventRecord record : records) {
            String line = summary(record.type().wire(), record.payload());
            if (line != null && !line.isBlank()) {
                items.add(line);
            }
        }
        if (limit > 0 && items.size() > limit) {
            items = new ArrayList<>(items.subList(items.size() - limit, items.size()));
        }
        return List.copyOf(items);
    }

    /**
     * The one-line summary of one event; {@code null} when the event carries
     * nothing worth showing in a snapshot.
     */
    private static String summary(String wireType, String payloadJson) {
        Map<String, Object> payload = parse(payloadJson);
        return switch (wireType) {
            case "user_message" -> "You: " + textOf(payload);
            case "text_delta" -> textOf(payload);
            case "message_end" -> "Assistant: " + textOf(payload);
            case "run_start" -> "Run started";
            case "run_end" -> "Run finished";
            case "tool_use" -> "Tool: " + payload.getOrDefault("name", "?");
            case "tool_result" -> "Result: " + payload.getOrDefault("name", "?");
            case "session_updated" -> "Session updated";
            case "error" -> "Error: " + payload.getOrDefault("message", "");
            default -> null;
        };
    }

    /** The session fields a sidebar row renders and orders itself by. */
    private static final List<String> ROW_PROPS = List.of(
            "title", "workdir", "status", "pinned", "pinnedOrder",
            "settledAt", "snoozedUntil", "archivedAt", "settledReason", "sortOrder");

    /**
     * The sidebar-row id one {@code session_updated} frame patches.
     *
     * @param sessionId the updated session id
     * @return {@code session-row:<sessionId>}
     */
    static String sessionRowId(String sessionId) {
        return "session-row:" + sessionId;
    }

    /**
     * The {@code session_updated} frame: a {@code patch} against the sidebar
     * row of the updated session, carrying the title and lifecycle props of
     * {@link #ROW_PROPS} (absent fields become {@code null}, so cleared
     * lifecycle state resets the row).
     *
     * @param payloadJson the {@code session_updated} payload: the updated
     *                    session as JSON
     * @return the {@code {patch:…}} frame
     */
    static Map<String, Object> sessionUpdatedFrame(String payloadJson) {
        Map<String, Object> payload = parse(payloadJson);
        Map<String, Object> props = new LinkedHashMap<>();
        for (String key : ROW_PROPS) {
            props.put(key, payload.get(key));
        }
        return patch(sessionRowId(String.valueOf(payload.getOrDefault("id", ""))), props);
    }

    /** The {@code {node:…}} frame wrapper. */
    private static Map<String, Object> node(UiNode node) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("node", node.toJson());
        return frame;
    }

    /** The {@code {patch:…}} frame wrapper. */
    private static Map<String, Object> patch(String id, Map<String, Object> props) {
        Map<String, Object> patch = new LinkedHashMap<>();
        patch.put("id", id);
        patch.put("props", props);
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("patch", patch);
        return frame;
    }

    /** The raw tool arguments of a {@code tool_use} payload. */
    private static String argumentsOf(Map<String, Object> payload) {
        return jsonOf(payload.get("arguments"));
    }

    /** The plain content of a {@code tool_result} payload. */
    private static String contentOf(Map<String, Object> payload) {
        Object content = payload.get("content");
        return (content != null) ? String.valueOf(content) : textOf(payload);
    }

    /** The error message of an {@code error} payload. */
    private static String errorMessageOf(Map<String, Object> payload) {
        Object reported = payload.get("message");
        return (reported != null) ? String.valueOf(reported) : textOf(payload);
    }

    /** The raw JSON text of a payload field: strings pass through, objects re-serialize. */
    private static String jsonOf(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof String text) {
            return text;
        }
        try {
            return Json.write(value);
        } catch (RuntimeException e) {
            return String.valueOf(value);
        }
    }

    /** Parses a payload JSON object; blank text yields the empty map. */
    private static Map<String, Object> parse(String payloadJson) {
        if (payloadJson == null || payloadJson.isBlank()) {
            return Map.of();
        }
        try {
            return Json.readMap(payloadJson);
        } catch (RuntimeException e) {
            return Map.of("text", payloadJson);
        }
    }

    /** The {@code text} field of a payload, empty when absent. */
    private static String textOf(Map<String, Object> payload) {
        Object text = payload.get("text");
        return (text == null) ? "" : String.valueOf(text);
    }
}
