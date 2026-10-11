/**
 * Translation of session events into SDUI stream frames (the five frame
 * shapes of docs/sdui.md section 5, serialized by {@link StreamFrames}) and
 * into one-line summaries for server-side snapshots.
 *
 * <p><b>Frame model.</b> Every timeline frame is a T101 row node built by
 * {@link MessageCardBuilder} and rendered through the HTML pipeline (the
 * frame &rarr; row mapping):
 * <ul>
 *   <li>{@code user_message} — the {@code message:user} bubble row
 *       ({@code node});</li>
 *   <li>{@code message_start} — the {@code message:assistant} row whose
 *       markdown child carries the {@code id} {@code msg-<seq>} (the
 *       {@code node} the {@code patch} frames grow in place);</li>
 *   <li>{@code text_delta} — grows that text element in place; deltas do
 *       <em>not</em> each become a frame (see delta batching below);</li>
 *   <li>{@code message_end} — finalizes the streamed text with one
 *       {@code patch} carrying the complete message;</li>
 *   <li>{@code run_start} — the {@code working} spinner row (the live
 *       "agent is working" indicator);</li>
 *   <li>{@code run_end} — the {@code remove} frame dropping the open working
 *       row; with no tracked row (a mid-stream join) it falls back to a
 *       {@code replace} of the run-status badge (its colour is an attribute,
 *       not expressible as inner content — docs/sdui.md section 5);</li>
 *   <li>{@code tool_use} — the {@code work:log} row with the collapsible
 *       arguments section;</li>
 *   <li>{@code tool_result} — the {@code work:log} row with the collapsible
 *       result section (a malformed or unknown {@code structured} payload
 *       degrades to the plain text detail); a {@code structured} payload
 *       whose {@code type} names one of the 16 T102 event kinds renders
 *       that event card instead (docs/sdui.md section 5);</li>
 *   <li>{@code session_updated} — the sidebar-row {@code patch} frame
 *       {@code {"patch":{"id":"session-row:<sessionId>","html":…}}} whose
 *       html is the rendered inner content of the
 *       {@code session-row:<id>} row of {@link SidebarBuilder};</li>
 *   <li>{@code error} — the {@code event:error} row (the danger tone);</li>
 *   <li>anything else — the {@code unknown} placeholder row (never a
 *       throw).</li>
 * </ul>
 *
 * <p><b>Delta batching (T205).</b> {@code text_delta} events must not each
 * become a frame: they accumulate in the {@link DeltaBatcher} of the open
 * message and flush as one {@code patch} (the accumulated text re-rendered
 * through {@link MessageCardBuilder#streamedTextHtml(String)}) at most every
 * {@link #DELTA_FLUSH_WINDOW_MILLIS} or when something else must be framed.
 * The batch is flushed before any non-delta frame (so frames never reorder),
 * by {@code message_end} (whose final patch subsumes the flush and carries
 * the complete message), and when the replay window of a stream closes
 * ({@link Translator#flush()}). The batcher is per translation stream — the
 * per-session live forwarder and every connection's replay each own one —
 * and per open message: {@code message_start}/{@code message_end} reset it.
 *
 * <p><b>State.</b> The growing-message frames need the id and the accumulated
 * text of the open message, and the {@code run_end} remove needs the working
 * row id, so translation is stateful per stream. The forwarder that feeds
 * live frames to every listener seeds its state by absorbing the persisted
 * history first, so its frames continue the replayed ones seamlessly; a
 * replay that starts mid-message ({@code fromSeq}) seeds the same way before
 * emitting its window. Absorbing advances the text state only — it never
 * marks a batch dirty — so a seeded stream flushes live text, never a
 * re-render of what the preamble already wrote.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.screens.MessageCardBuilder;
import com.astroreen.jhin.plugin.ui.screens.SidebarBuilder;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

final class EventFrames {

    /** The SSE event name every translated frame is written under. */
    static final String FRAME_EVENT = "frame";

    /**
     * The delta flush window in milliseconds: {@code text_delta} events that
     * arrive inside one window coalesce into a single {@code patch} frame
     * (T205: server-side batching at &le; 60 ms bounds the markdown
     * re-render cost of a token stream).
     */
    static final long DELTA_FLUSH_WINDOW_MILLIS = 60;

    private EventFrames() {
    }

    /**
     * The {@code text_delta} accumulator of one open message: it holds the
     * accumulated text and decides when a flush window has elapsed. Owned by
     * the per-stream {@link Translator} (one per session forwarder and one
     * per connection replay) and reset per open message.
     */
    static final class DeltaBatcher {

        private final LongSupplier clock;
        private String text = "";
        private boolean dirty;
        private long windowStart;

        DeltaBatcher(LongSupplier clock) {
            this.clock = clock;
        }

        /**
         * Starts a new accumulation window with the given text.
         *
         * @param text the initial text (empty for a fresh message)
         */
        void open(String text) {
            this.text = text == null ? "" : text;
            this.dirty = false;
        }

        /**
         * Appends one delta on the emitted path: the text grows and, when
         * this is the first unflushed growth, opens the flush window.
         *
         * @param delta the delta text
         */
        void append(String delta) {
            if (delta == null || delta.isEmpty()) {
                return;
            }
            if (!dirty) {
                dirty = true;
                windowStart = clock.getAsLong();
            }
            text += delta;
        }

        /**
         * Appends one delta on the absorb path (state seeding): the text
         * grows but the batch is <em>not</em> marked dirty — absorbed text
         * was already framed by whoever replayed it, so the live tail only
         * flushes text it accumulated itself.
         *
         * @param delta the delta text
         */
        void appendAbsorbed(String delta) {
            text += delta == null ? "" : delta;
        }

        /** Whether unflushed text is waiting for a {@code patch}. */
        boolean dirty() {
            return dirty;
        }

        /**
         * Whether the flush window of the pending batch has elapsed.
         *
         * @return {@code true} when a flush is due
         */
        boolean windowElapsed() {
            return dirty && clock.getAsLong() - windowStart >= DELTA_FLUSH_WINDOW_MILLIS;
        }

        /** The accumulated text of the open message. */
        String text() {
            return text;
        }

        /** Marks the accumulated text as flushed (or never dirty). */
        void markClean() {
            dirty = false;
        }

        /** Drops the batch state (the message closed or the stream reset). */
        void reset() {
            text = "";
            dirty = false;
        }
    }

    /**
     * One stream's translation state: the open assistant message, the open
     * working row and the delta batch, if any.
     */
    static final class Translator {

        private final DeltaBatcher batcher;

        private String messageId;
        private String workingRowId;

        /** Creates a translator on the system clock. */
        Translator() {
            this(System::currentTimeMillis);
        }

        /**
         * Creates a translator on the given clock (tests drive the flush
         * window deterministically; production uses the system clock).
         *
         * @param clock the wall clock in epoch milliseconds
         */
        Translator(LongSupplier clock) {
            this.batcher = new DeltaBatcher(clock);
        }

        /**
         * Translates one event into its frames: zero frames for a coalesced
         * {@code text_delta}, exactly one for everything else, plus the
         * pending delta flush any non-delta event emits first (frame order
         * preserved).
         *
         * @param wireType    the event kind wire name
         * @param payloadJson the event payload as JSON text (may be blank)
         * @param seq         the event sequence number (drives the node ids)
         * @return the frames, in emission order
         */
        List<Map<String, Object>> frames(String wireType, String payloadJson, long seq) {
            if ("text_delta".equals(wireType)) {
                return growMessage(parse(payloadJson), seq);
            }
            if ("message_end".equals(wireType)) {
                return endMessage(parse(payloadJson), seq);
            }
            List<Map<String, Object>> out = new ArrayList<>(flush());
            out.addAll(eventFrames(wireType, parse(payloadJson), seq));
            return out;
        }

        /**
         * Advances the translation state from one event without producing
         * frames. Called while the live forwarder seeds its state from the
         * persisted history and while a replay absorbs everything before
         * its window. Absorbed deltas grow the accumulated text but never
         * mark the batch dirty (see {@link DeltaBatcher#appendAbsorbed}).
         *
         * @param wireType    the event kind wire name
         * @param payloadJson the event payload as JSON text
         * @param seq         the event sequence number
         */
        void absorb(String wireType, String payloadJson, long seq) {
            Map<String, Object> payload = parse(payloadJson);
            switch (wireType) {
                case "message_start" -> {
                    messageId = MessageCardBuilder.messageId(seq);
                    batcher.open("");
                }
                case "text_delta" -> {
                    if (messageId == null) {
                        messageId = MessageCardBuilder.messageId(seq);
                        batcher.open("");
                    }
                    batcher.appendAbsorbed(textOf(payload));
                }
                case "message_end" -> {
                    messageId = null;
                    batcher.reset();
                }
                case "run_start" -> workingRowId = MessageCardBuilder.eventId(seq);
                case "run_end" -> workingRowId = null;
                default -> {
                    // no translation state on the other kinds
                }
            }
        }

        /**
         * Flushes the pending delta batch as one {@code patch} frame, if
         * any: the accumulated text re-rendered into the open message's
         * text element. Called when the replay window closes (so a message
         * still streaming at disconnect is never lost) and before any
         * non-delta frame (so frames never reorder).
         *
         * @return zero or one frames
         */
        List<Map<String, Object>> flush() {
            if (!batcher.dirty() || messageId == null) {
                return List.of();
            }
            batcher.markClean();
            return List.of(StreamFrames.patch(messageId,
                    MessageCardBuilder.streamedTextHtml(batcher.text())));
        }

        /** The event frames of every kind but {@code text_delta}/{@code message_end}. */
        private List<Map<String, Object>> eventFrames(
                String wireType, Map<String, Object> payload, long seq) {
            return switch (wireType) {
                case "user_message" -> List.of(StreamFrames.node(MessageCardBuilder.userMessageRow(
                        textOf(payload), seq)));
                case "message_start" -> List.of(openMessage(seq));
                case "run_start" -> {
                    workingRowId = MessageCardBuilder.eventId(seq);
                    yield List.of(StreamFrames.node(MessageCardBuilder.workingRow(seq)));
                }
                case "run_end" -> List.of(endRun(payload, seq));
                case "tool_use" -> List.of(StreamFrames.node(MessageCardBuilder.workRow(
                        seq,
                        toolLabel(payload) + " " + argumentsOf(payload),
                        List.of(MessageCardBuilder.toolArgumentsNode(
                                argumentsOf(payload), seq)))));
                case "tool_result" -> List.of(StreamFrames.node(toolResultFrame(payload, seq)));
                case "session_updated" -> List.of(sessionUpdatedFrame(payload));
                case "error" -> List.of(StreamFrames.node(MessageCardBuilder.dispatchEventRow(
                        "error", payload, seq)));
                default -> List.of(StreamFrames.node(MessageCardBuilder.unknownRow(seq, wireType)));
            };
        }

        /** Opens the assistant message row and resets the delta batch. */
        private Map<String, Object> openMessage(long seq) {
            messageId = MessageCardBuilder.messageId(seq);
            batcher.open("");
            return StreamFrames.node(MessageCardBuilder.assistantMessageRow(seq, ""));
        }

        /**
         * The {@code text_delta} frames: the first delta of a mid-stream
         * join (no {@code message_start} in scope) opens the message node
         * itself with its text; every later delta accumulates and flushes
         * only when the window has elapsed.
         */
        private List<Map<String, Object>> growMessage(Map<String, Object> payload, long seq) {
            String delta = textOf(payload);
            if (messageId == null) {
                messageId = MessageCardBuilder.messageId(seq);
                batcher.open(delta);
                return List.of(StreamFrames.node(
                        MessageCardBuilder.assistantMessageRow(seq, batcher.text())));
            }
            batcher.append(delta);
            return flushIfDue();
        }

        /**
         * The {@code message_end} frames: the flush of the pending batch
         * <em>is</em> the final patch — one frame carrying the complete
         * message (the payload's {@code text} when present, the accumulated
         * text otherwise), closing the open message. A message_end seen
         * without a message opens the row itself (the mid-stream join
         * fallback).
         */
        private List<Map<String, Object>> endMessage(Map<String, Object> payload, long seq) {
            String finalText = payload.containsKey("text") ? textOf(payload) : batcher.text();
            if (messageId == null) {
                return List.of(StreamFrames.node(
                        MessageCardBuilder.assistantMessageRow(seq, finalText)));
            }
            Map<String, Object> frame = StreamFrames.patch(messageId,
                    MessageCardBuilder.streamedTextHtml(finalText));
            messageId = null;
            batcher.reset();
            return List.of(frame);
        }

        /**
         * The {@code run_end} frame: the {@code remove} of the open working
         * row; with no tracked row (a mid-stream join) it falls back to a
         * {@code replace} of the run-status badge so the composer status
         * line still settles (the badge colour is an attribute — a patch
         * cannot carry it, docs/sdui.md section 5).
         */
        private Map<String, Object> endRun(Map<String, Object> payload, long seq) {
            if (workingRowId == null) {
                return StreamFrames.replace(MessageCardBuilder.STATUS_ID,
                        MessageCardBuilder.runBadge(MessageCardBuilder.STATUS_IDLE, null));
            }
            Map<String, Object> frame = StreamFrames.remove(workingRowId);
            workingRowId = null;
            return frame;
        }

        /** Flushes the batch when its window has elapsed. */
        private List<Map<String, Object>> flushIfDue() {
            if (batcher.windowElapsed()) {
                return flush();
            }
            return List.of();
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
     * row of the updated session (docs/sdui.md section 5 — the row node of
     * {@link SidebarBuilder} rendered live, so title, subtitle, status and
     * the row menu update in place). The html carries the inner content of
     * the {@code session-row:<id>} element: a patch swaps inner HTML, so the
     * row element itself must not be re-emitted inside itself.
     *
     * @param payload the {@code session_updated} payload: the updated
     *                session record fields
     * @return the {@code {patch:…}} frame
     */
    static Map<String, Object> sessionUpdatedFrame(Map<String, Object> payload) {
        Session session = sessionOf(payload);
        UiNode row = SidebarBuilder.sessionRow(session, System.currentTimeMillis());
        return StreamFrames.patch(sessionRowId(session.id()),
                MessageCardBuilder.innerHtmlOf(row));
    }

    /**
     * The {@code session_updated} frame from raw payload JSON (the
     * {@code sessions/<id>} wire form).
     *
     * @param payloadJson the updated session as JSON
     * @return the {@code {patch:…}} frame
     */
    static Map<String, Object> sessionUpdatedFrame(String payloadJson) {
        return sessionUpdatedFrame(parse(payloadJson));
    }

    /**
     * Rebuilds the session record of a {@code session_updated} payload:
     * lenient like the rest of the translation — absent fields keep their
     * defaults and unknown ones are ignored, so a partial record still
     * renders a row.
     */
    private static Session sessionOf(Map<String, Object> payload) {
        return new Session(
                stringOf(payload.get("id"), ""),
                stringOf(payload.get("accountId"), "local"),
                stringOf(payload.get("title"), ""),
                stringOf(payload.get("workdir"), ""),
                stringOf(payload.get("model"), null),
                stringOf(payload.get("providerId"), null),
                stringOf(payload.get("status"), ""),
                longOf(payload.get("createdAt")),
                longOf(payload.get("updatedAt")),
                Boolean.TRUE.equals(payload.get("pinned")),
                intOf(payload.get("pinnedOrder")),
                nullableLongOf(payload.get("settledAt")),
                nullableLongOf(payload.get("snoozedUntil")),
                nullableLongOf(payload.get("archivedAt")),
                payload.get("autoSettle") == null
                        || Boolean.TRUE.equals(payload.get("autoSettle")),
                intOf(payload.get("sortOrder")),
                stringOf(payload.get("settledReason"), null),
                Boolean.TRUE.equals(payload.get("autoSettleSuppressed")));
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

    /** The string value of a payload field, or the default when absent. */
    private static String stringOf(Object value, String def) {
        return (value == null) ? def : String.valueOf(value);
    }

    /** The {@code long} value of a payload field, {@code 0} when absent or malformed. */
    private static long longOf(Object value) {
        return (value instanceof Number number) ? number.longValue() : 0;
    }

    /** The boxed {@code Long} value of a payload field; {@code null} when absent. */
    private static Long nullableLongOf(Object value) {
        return (value instanceof Number number) ? number.longValue() : null;
    }

    /** The boxed {@code Integer} value of a payload field; {@code null} when absent. */
    private static Integer intOf(Object value) {
        return (value instanceof Number number) ? number.intValue() : null;
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
