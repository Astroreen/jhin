/**
 * Translation of session events into SDUI stream frames (the frame shapes of
 * the streams contract) and into one-line summaries for server-side snapshots.
 *
 * <p><b>Frame model.</b> Each event becomes exactly one frame, and every
 * timeline frame is a T101 row node built by {@link MessageCardBuilder}
 * (the frame → row mapping):
 * <ul>
 *   <li>{@code user_message} — the {@code message:user} bubble row;</li>
 *   <li>{@code message_start} — the {@code message:assistant} row whose
 *       markdown child carries the {@code id} {@code msg-<seq>};</li>
 *   <li>{@code text_delta} — grows that text node in place ({@code patch}
 *       with the accumulated text; the first delta of a mid-stream join opens
 *       the node itself);</li>
 *   <li>{@code message_end} — finalizes the streamed text ({@code patch}
 *       with the complete message);</li>
 *   <li>{@code run_start} — the {@code working} spinner row (the live
 *       "agent is working" indicator);</li>
 *   <li>{@code run_end} — the {@code remove} frame dropping the open working
 *       row; with no tracked row (a mid-stream join) it falls back to the
 *       run-status badge patch;</li>
 *   <li>{@code tool_use} — the {@code work:log} row with the collapsible
 *       arguments section;</li>
 *   <li>{@code tool_result} — the {@code work:log} row with the collapsible
 *       result section (a malformed or unknown {@code structured} payload
 *       degrades to the plain text detail); a {@code structured} payload
 *       whose {@code type} names one of the 16 T102 event kinds renders
 *       that event card instead (docs/sdui.md section 5);</li>
 *   <li>{@code session_updated} — the sidebar-row {@code patch} frame
 *       {@code {"patch":{"id":"session-row:<sessionId>","props":{…}}}} whose
 *       props carry the title and the lifecycle fields of the row;</li>
 *   <li>{@code error} — the {@code event:error} row (the danger tone);</li>
 *   <li>anything else — the {@code unknown} placeholder row (never a
 *       throw).</li>
 * </ul>
 *
 * <p><b>State.</b> The growing-message frames need the id and the accumulated
 * text of the open message, and the {@code run_end} remove needs the working
 * row id, so translation is stateful per stream. The forwarder that feeds
 * live frames to every listener seeds its state by absorbing the persisted
 * history first, so its frames match the replayed ones event for event; a
 * replay that starts mid-message ({@code fromSeq}) seeds the same way before
 * emitting its window.
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
     * One stream's translation state: the open assistant message and the
     * open working row, if any.
     */
    static final class Translator {

        private String messageId;
        private String accumulated = "";
        private String workingRowId;

        /**
         * Translates one event into its frame.
         *
         * @param wireType    the event kind wire name
         * @param payloadJson the event payload as JSON text (may be blank)
         * @param seq         the event sequence number (drives the node ids)
         * @return the frame map, exactly one of {@code {node:…}},
         *         {@code {patch:…}} or {@code {remove:…}}
         */
        Map<String, Object> frame(String wireType, String payloadJson, long seq) {
            Map<String, Object> payload = parse(payloadJson);
            return switch (wireType) {
                case "user_message" -> node(MessageCardBuilder.userMessageRow(
                        textOf(payload), seq));
                case "message_start" -> openMessage(seq);
                case "text_delta" -> growMessage(payload, seq);
                case "message_end" -> endMessage(payload, seq);
                case "run_start" -> {
                    workingRowId = MessageCardBuilder.eventId(seq);
                    yield node(MessageCardBuilder.workingRow(seq));
                }
                case "run_end" -> endRun(payload, seq);
                case "tool_use" -> node(MessageCardBuilder.workRow(
                        seq,
                        toolLabel(payload) + " " + argumentsOf(payload),
                        List.of(MessageCardBuilder.toolArgumentsNode(
                                argumentsOf(payload), seq))));
                case "tool_result" -> node(toolResultFrame(payload, seq));
                case "session_updated" -> sessionUpdatedFrame(payloadJson);
                case "error" -> node(MessageCardBuilder.dispatchEventRow(
                        "error", payload, seq));
                default -> node(MessageCardBuilder.unknownRow(seq, wireType));
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
            return node(MessageCardBuilder.assistantMessageRow(seq, ""));
        }

        private Map<String, Object> growMessage(Map<String, Object> payload, long seq) {
            String delta = textOf(payload);
            if (messageId == null) {
                messageId = MessageCardBuilder.messageId(seq);
                accumulated = delta;
                return node(MessageCardBuilder.assistantMessageRow(seq, accumulated));
            }
            accumulated += delta;
            return patch(messageId, Map.of("text", accumulated));
        }

        private Map<String, Object> endMessage(Map<String, Object> payload, long seq) {
            String finalText = payload.containsKey("text") ? textOf(payload) : accumulated;
            if (messageId == null) {
                return node(MessageCardBuilder.assistantMessageRow(seq, finalText));
            }
            Map<String, Object> frame = patch(messageId, Map.of("text", finalText));
            messageId = null;
            accumulated = "";
            return frame;
        }

        /**
         * The {@code run_end} frame: the {@code remove} of the open working
         * row; with no tracked row (a mid-stream join) it falls back to the
         * run-status badge patch so the composer status line still settles.
         */
        private Map<String, Object> endRun(Map<String, Object> payload, long seq) {
            if (workingRowId == null) {
                return patch(MessageCardBuilder.STATUS_ID,
                        MessageCardBuilder.statusProps(MessageCardBuilder.STATUS_IDLE, null));
            }
            Map<String, Object> frame = remove(workingRowId);
            workingRowId = null;
            return frame;
        }

        /**
         * The {@code tool_result} row: a {@code structured} payload whose
         * {@code type} names one of the 16 T102 event kinds renders that
         * event card (docs/sdui.md section 5 — the structured payload is the
         * UI card the tool produced); anything else degrades to the T101
         * work row with the plain content detail.
         */
        private UiNode toolResultFrame(Map<String, Object> payload, long seq) {
            Map<String, Object> structured = parseObjectOf(payload.get("structured"));
            if (structured != null
                    && MessageCardBuilder.isEventKind(stringOf(structured.get("type")))) {
                return MessageCardBuilder.dispatchEventRow(
                        stringOf(structured.get("type")), structured, seq);
            }
            return MessageCardBuilder.workRow(
                    seq,
                    toolLabel(payload) + " result",
                    List.of(MessageCardBuilder.toolResultNode(
                            contentOf(payload),
                            Boolean.TRUE.equals(payload.get("error")), seq)));
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

    /** The {@code {remove:…}} frame wrapper. */
    private static Map<String, Object> remove(String id) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("remove", id);
        return frame;
    }

    /** The tool label of a {@code tool_use}/{@code tool_result} payload. */
    private static String toolLabel(Map<String, Object> payload) {
        Object name = payload.get("name");
        return (name == null || String.valueOf(name).isBlank())
                ? "tool" : String.valueOf(name);
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

    /** The string value of a payload field, or {@code null} when absent. */
    private static String stringOf(Object value) {
        return (value == null) ? null : String.valueOf(value);
    }

    /** The parsed {@code structured} payload map; {@code null} when absent or malformed. */
    private static Map<String, Object> parseObjectOf(Object structured) {
        if (structured instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            return typed;
        }
        if (structured instanceof String text) {
            return MessageCardBuilder.parseObject(text);
        }
        return null;
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
