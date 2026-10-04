/**
 * Translation of session events into SDUI stream frames (the frame shapes of
 * the streams contract) and into one-line summaries for server-side snapshots.
 *
 * <p><b>Frame model.</b> Each event becomes exactly one frame:
 * <ul>
 *   <li>{@code user_message} — a bold {@code text} node with the message;</li>
 *   <li>{@code message_start} — the small {@code text} node that holds the
 *       assistant message being streamed ({@code id} {@code msg-<seq>});</li>
 *   <li>{@code text_delta} — grows that node in place ({@code patch} with the
 *       accumulated text; the first delta of a mid-stream join opens the node
 *       itself);</li>
 *   <li>{@code message_end} — finalizes the streamed text ({@code patch} with
 *       the complete message);</li>
 *   <li>{@code run_start} / {@code run_end} — small caption {@code text}
 *       nodes;</li>
 *   <li>{@code tool_use} — a {@code card} node titled after the tool;</li>
 *   <li>{@code tool_result} — a {@code card} node built from the
 *       {@code structured} payload when present ({@code {kind:"card", title,
 *       rows:[{label, value}]}} and {@code {kind:"image", …}}), else from the
 *       text content;</li>
 *   <li>{@code session_updated} — the sidebar-row {@code patch} frame
 *       {@code {"patch":{"id":"session-row:<sessionId>","props":{…}}}} whose
 *       props carry the title and the lifecycle fields of the row;</li>
 *   <li>{@code error} — a danger-styled {@code card} node (red text child).</li>
 * </ul>
 *
 * <p><b>State.</b> The growing-message frames need the id and the accumulated
 * text of the open message, so translation is stateful per stream. The
 * forwarder that feeds live frames to every listener seeds its state by
 * absorbing the persisted history first, so its frames match the replayed ones
 * event for event.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventRecord;
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

    /** The danger color of error text. */
    private static final String DANGER = "#E53935";

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
                case "user_message" -> node(textNode("ev-" + seq, textOf(payload), "body", true, null));
                case "message_start" -> openMessage(seq);
                case "text_delta" -> growMessage(payload, seq);
                case "message_end" -> endMessage(payload, seq);
                case "run_start" -> node(textNode("ev-" + seq, "Run started", "caption", false, null));
                case "run_end" -> node(textNode("ev-" + seq, "Run finished", "caption", false, null));
                case "tool_use" -> node(toolUseNode(payload, seq));
                case "tool_result" -> node(toolResultNode(payload, seq));
                case "session_updated" -> sessionUpdatedFrame(payloadJson);
                case "error" -> node(errorNode(payload, seq));
                default -> node(textNode("ev-" + seq, "Event: " + wireType, "caption", false, null));
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
            messageId = "msg-" + seq;
            accumulated = "";
            return node(textNode(messageId, "", "body", false, null));
        }

        private Map<String, Object> growMessage(Map<String, Object> payload, long seq) {
            String delta = textOf(payload);
            if (messageId == null) {
                messageId = "msg-" + seq;
                accumulated = delta;
                return node(textNode(messageId, accumulated, "body", false, null));
            }
            accumulated += delta;
            return patch(messageId, Map.of("text", accumulated));
        }

        private Map<String, Object> endMessage(Map<String, Object> payload, long seq) {
            String finalText = payload.containsKey("text") ? textOf(payload) : accumulated;
            if (messageId == null) {
                return node(textNode("msg-" + seq, finalText, "body", false, null));
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

    private static UiNode textNode(String id, String text, String style, boolean bold, String color) {
        Ui.TextBuilder builder = Ui.text(text).id(id).style(style);
        if (bold) {
            builder.bold(true);
        }
        if (color != null) {
            builder.color(color);
        }
        return builder.build();
    }

    private static UiNode toolUseNode(Map<String, Object> payload, long seq) {
        String name = String.valueOf(payload.getOrDefault("name", "tool"));
        Ui.CardBuilder card = Ui.card().id("ev-" + seq).title(name);
        Object arguments = payload.get("arguments");
        if (arguments != null && !String.valueOf(arguments).isBlank()) {
            card.child(textNode("ev-" + seq + "-args", String.valueOf(arguments), "mono", false, null));
        }
        return card.build();
    }

    private static UiNode toolResultNode(Map<String, Object> payload, long seq) {
        String name = String.valueOf(payload.getOrDefault("name", "tool"));
        Object structured = payload.get("structured");
        if (structured instanceof String text && !text.isBlank()) {
            UiNode card = structuredNode(text, name, "ev-" + seq);
            if (card != null) {
                return card;
            }
        }
        Ui.CardBuilder card = Ui.card().id("ev-" + seq).title(name);
        Object content = payload.get("content");
        boolean error = Boolean.TRUE.equals(payload.get("error"));
        if (content != null && !String.valueOf(content).isBlank()) {
            card.child(textNode("ev-" + seq + "-content", String.valueOf(content), "body", false,
                    error ? DANGER : null));
        }
        return card.build();
    }

    /**
     * Builds the card of a {@code structured} payload (the documented family:
     * {@code card} and {@code image} kinds); {@code null} when the payload is
     * not a member of that family and the caller should fall back to the text
     * content.
     */
    private static UiNode structuredNode(String structured, String fallbackTitle, String id) {
        Map<String, Object> payload;
        try {
            payload = Json.readMap(structured);
        } catch (RuntimeException e) {
            return null;
        }
        String kind = String.valueOf(payload.getOrDefault("kind", ""));
        String title = String.valueOf(payload.getOrDefault("title", fallbackTitle));
        if ("card".equals(kind)) {
            Ui.CardBuilder card = Ui.card().id(id).title(title);
            Object rows = payload.get("rows");
            if (rows instanceof List<?> list) {
                int index = 0;
                for (Object row : list) {
                    if (row instanceof Map<?, ?> map) {
                        String label = String.valueOf(map.get("label") == null ? "" : map.get("label"));
                        String value = String.valueOf(map.get("value") == null ? "" : map.get("value"));
                        card.child(textNode(id + "-r" + index++, label + ": " + value, "body", false, null));
                    }
                }
            }
            return card.build();
        }
        if ("image".equals(kind)) {
            String mime = String.valueOf(payload.getOrDefault("mimeType", "image/png"));
            Object data = payload.get("data");
            Ui.ImageBuilder image = Ui.image().id(id + "-img");
            if (data != null) {
                image.dataUri("data:" + mime + ";base64," + data);
            }
            return Ui.card().id(id).title(title).child(image.build()).build();
        }
        return null;
    }

    private static UiNode errorNode(Map<String, Object> payload, long seq) {
        Object reported = payload.get("message");
        String message = (reported != null) ? String.valueOf(reported) : textOf(payload);
        UiNode text = textNode("ev-" + seq + "-msg", message, "body", false, DANGER);
        return Ui.card().id("ev-" + seq).title("Error").child(text).build();
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
