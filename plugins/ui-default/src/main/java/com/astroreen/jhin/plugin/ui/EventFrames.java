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
 *   <li>{@code tool_use} — the {@code work-live:log} running tool card
 *       ({@code node}); the 2nd+ consecutive same-name call folds the run
 *       into one {@code work:group} header ({@code replace} of the first
 *       call's row);</li>
 *   <li>{@code tool_result} — matched by its {@code id} to the open call:
 *       the {@code replace} of the live row with the done tool card (the
 *       envelope id {@code ev-<useSeq>}, the row root {@code ev-<resultSeq>}),
 *       or of the group header with the settled count (flipping to the
 *       aggregate status — error &gt; cancelled &gt; success — when the
 *       last call settles). An unmatched result keeps the {@code work:log}
 *       fallback row: a malformed or unknown {@code structured} payload
 *       degrades to the plain text detail, a {@code structured} payload
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
 * text of the open message, the {@code run_end} remove needs the working
 * row id, and the tool rows need the open calls of the run — the call id to
 * the use sequence/name and whether the call sits inside a folded group,
 * plus the group state ({@code name}, {@code firstSeq}, {@code count},
 * {@code pending}) — so translation is stateful per stream. The forwarder
 * that feeds live frames to every listener seeds its state by absorbing the
 * persisted history first, so its frames continue the replayed ones
 * seamlessly; a replay that starts mid-message ({@code fromSeq}) seeds the
 * same way before emitting its window. Absorbing advances the text state
 * only — it never marks a batch dirty — so a seeded stream flushes live
 * text, never a re-render of what the preamble already wrote; the tool
 * state advances identically on both paths (absorb mirrors the same
 * matching and folding logic without emitting frames).
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.screens.MessageCardBuilder;
import com.astroreen.jhin.plugin.ui.screens.RunSummaryBuilder;
import com.astroreen.jhin.plugin.ui.screens.SidebarBuilder;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.text.PathDisplay;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
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

    /** The open-call status word of a live tool row or group header. */
    private static final String RUNNING = "running";

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
     * working row, the open tool calls of the run and the delta batch, if
     * any.
     */
    static final class Translator {

        private final DeltaBatcher batcher;

        /** One open {@code tool_use} awaiting its {@code tool_result}. */
        private static final class OpenCall {
            final long useSeq;
            final String name;
            boolean folded;
            Group group;

            OpenCall(long useSeq, String name) {
                this.useSeq = useSeq;
                this.name = name;
            }
        }

        /**
         * The state of one folded run of same-named tool calls: {@code count}
         * calls fold under the row of {@code firstSeq}, {@code pending} of
         * them still await their result, {@code worst} aggregates the settled
         * statuses (error &gt; cancelled &gt; success).
         */
        private static final class Group {
            final String name;
            final long firstSeq;
            int count;
            int pending;
            String worst = "success";

            Group(String name, long firstSeq) {
                this.name = name;
                this.firstSeq = firstSeq;
            }
        }

        private String messageId;
        private String workingRowId;
        private final Map<String, OpenCall> openCalls = new LinkedHashMap<>();
        private String chainName;
        private OpenCall chainFirst;
        private Group chainGroup;
        private final LongSupplier clock;
        /** The seq of the run whose lifecycle row is open, or -1. */
        private long lifecycleSeq = -1;
        /** Whether the open lifecycle row already settled as failed. */
        private boolean lifecycleFailed;
        /** The clock reading at the open run's start (done duration). */
        private long runStartMillis;

        /** The run's changed-files summary (T310), reset per opened run. */
        private RunSummaryBuilder runSummary = new RunSummaryBuilder();

        /** The session these frames belong to (the {@code open-diff} payload). */
        private final String sessionId;

        /** Creates a translator for one session on the system clock. */
        Translator(String sessionId) {
            this(sessionId, System::currentTimeMillis);
        }

        /**
         * Creates a translator for one session on the given clock (tests
         * drive the flush window deterministically; production uses the
         * system clock).
         *
         * @param sessionId the session the translated events belong to
         * @param clock     the wall clock in epoch milliseconds
         */
        Translator(String sessionId, LongSupplier clock) {
            this.sessionId = sessionId;
            this.clock = clock;
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
            if (!"tool_use".equals(wireType)) {
                breakChain();
            }
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
            if (!"tool_use".equals(wireType)) {
                breakChain();
            }
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
                case "run_start" -> {
                    workingRowId = MessageCardBuilder.eventId(seq);
                    openRun(seq);
                }
                case "run_end" -> {
                    workingRowId = null;
                    closeRun();
                    openCalls.clear();
                }
                case "tool_use" -> useTool(payload, seq);
                case "tool_result" -> settleTool(payload, seq);
                case "error" -> failRun();
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
                    openRun(seq);
                    yield List.of(
                            StreamFrames.node(MessageCardBuilder.workingRow(seq)),
                            StreamFrames.node(MessageCardBuilder.lifecycleRow(
                                    seq, "running", "Run", "")));
                }
                case "run_end" -> endRunFrames(payload, seq);
                case "tool_use" -> List.of(useTool(payload, seq));
                case "tool_result" -> List.of(settleTool(payload, seq));
                case "session_updated" -> List.of(sessionUpdatedFrame(payload));
                case "error" -> {
                    List<Map<String, Object>> out = new ArrayList<>();
                    out.add(StreamFrames.node(MessageCardBuilder.dispatchEventRow(
                            "error", payload, seq)));
                    if (lifecycleSeq >= 0 && !lifecycleFailed) {
                        failRun();
                        out.add(StreamFrames.replace(
                                MessageCardBuilder.eventId(lifecycleSeq) + "-lifecycle",
                                MessageCardBuilder.lifecycleRow(
                                        lifecycleSeq, "failed", "Run", "")));
                    }
                    yield out;
                }
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
         * The {@code run_end} frames: the {@code replace} of the run's
         * lifecycle row to its done state (the duration of the run, the
         * success glyph — a row already settled as failed keeps its danger
         * tone) and the {@code remove} of the open working row; with no
         * tracked row (a mid-stream join) the strip removal falls back to a
         * {@code replace} of the run-status badge so the composer status
         * line still settles (the badge colour is an attribute — a patch
         * cannot carry it, docs/sdui.md section 5).
         */
        private List<Map<String, Object>> endRunFrames(Map<String, Object> payload, long seq) {
            List<Map<String, Object>> out = new ArrayList<>();
            if (lifecycleSeq >= 0 && !lifecycleFailed) {
                out.add(StreamFrames.replace(lifecycleId(),
                        MessageCardBuilder.lifecycleRow(lifecycleSeq, "done", "Run",
                                formatDuration(clock.getAsLong() - runStartMillis))));
            }
            closeRun();
            if (workingRowId == null) {
                out.add(StreamFrames.replace(MessageCardBuilder.STATUS_ID,
                        MessageCardBuilder.runBadge(MessageCardBuilder.STATUS_IDLE, null)));
                out.add(summaryFrame(seq));
                return out;
            }
            out.add(StreamFrames.remove(workingRowId));
            workingRowId = null;
            out.add(summaryFrame(seq));
            return out;
        }

        /**
         * The {@code run_end} summary frame: the changed-files card of the
         * run (T310) — the {@link RunSummaryBuilder} rows folded from the
         * run's {@code write}/{@code edit} {@code tool_use} payloads, or the
         * empty card when the run changed no files.
         */
        private Map<String, Object> summaryFrame(long seq) {
            return StreamFrames.node(runSummary.isEmpty()
                    ? MessageCardBuilder.emptyRunSummaryCard(seq)
                    : MessageCardBuilder.runSummaryCard(seq, sessionId, runSummary.files()));
        }

        /** Opens the run lifecycle state at {@code run_start}. */
        private void openRun(long seq) {
            lifecycleSeq = seq;
            lifecycleFailed = false;
            runStartMillis = clock.getAsLong();
            runSummary = new RunSummaryBuilder();
        }

        /** Marks the open lifecycle row as failed (sticky until the run closes). */
        private void failRun() {
            if (lifecycleSeq >= 0) {
                lifecycleFailed = true;
            }
        }

        /** Closes the run lifecycle state at {@code run_end}. */
        private void closeRun() {
            lifecycleSeq = -1;
            lifecycleFailed = false;
        }

        /** The row id of the open lifecycle row. */
        private String lifecycleId() {
            return MessageCardBuilder.eventId(lifecycleSeq) + "-lifecycle";
        }

        /** The settled run duration label, e.g. {@code "1.4s"}. */
        private static String formatDuration(long millis) {
            if (millis < 0) {
                return "";
            }
            return String.format(Locale.ROOT, "%.1fs", millis / 1000.0);
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
         * work row with the plain content detail. A {@code subagent} payload
         * with no meaningful field (only the {@code type} marker) carries no
         * bar and falls through to the same work row.
         */
        private UiNode toolResultFrame(Map<String, Object> payload, long seq) {
            Map<String, Object> structured = parseObjectOf(payload.get("structured"));
            String type = (structured == null) ? null : stringOf(structured.get("type"));
            if (structured != null
                    && MessageCardBuilder.isEventKind(type)
                    && !(MessageCardBuilder.EVENT_SUBAGENT.equals(type)
                            && MessageCardBuilder.isSubagentPayloadEmpty(structured))) {
                return MessageCardBuilder.dispatchEventRow(type, structured, seq);
            }
            return MessageCardBuilder.workRow(
                    seq,
                    toolLabel(payload) + " result",
                    List.of(MessageCardBuilder.toolResultNode(
                            contentOf(payload),
                            Boolean.TRUE.equals(payload.get("error")), seq)));
        }

        /**
         * The {@code tool_use} translation: the {@code node} of the live
         * tool card for a new chain, the {@code replace} of the group
         * header when the call is the 2nd+ adjacent same-name one (the
         * header stays anchored on {@code ev-<firstSeq>}). Every call is
         * registered open by its {@code id} for its {@code tool_result};
         * {@link #absorb} runs the same state and discards the frame.
         *
         * @param payload the {@code tool_use} payload
         * @param seq     the event sequence number (drives the node ids)
         * @return the frame
         */
        private Map<String, Object> useTool(Map<String, Object> payload, long seq) {
            String name = toolLabel(payload);
            runSummary.record(name, parseObjectOf(payload.get("arguments")));
            OpenCall call = new OpenCall(seq, name);
            String callId = stringOf(payload.get("id"));
            if (callId != null && !callId.isBlank()) {
                openCalls.put(callId, call);
            }
            if (name.equals(chainName) && chainFirst != null) {
                if (chainGroup == null) {
                    chainGroup = new Group(name, chainFirst.useSeq);
                    chainGroup.count = 1;
                    chainGroup.pending = 1;
                    chainFirst.folded = true;
                    chainFirst.group = chainGroup;
                }
                chainGroup.count++;
                chainGroup.pending++;
                call.folded = true;
                call.group = chainGroup;
                return StreamFrames.replace(MessageCardBuilder.eventId(chainGroup.firstSeq),
                        MessageCardBuilder.workGroupRow(chainGroup.firstSeq, chainGroup.name,
                                chainGroup.count, RUNNING));
            }
            chainName = name;
            chainFirst = call;
            chainGroup = null;
            return StreamFrames.node(MessageCardBuilder.workLiveToolRow(seq, name,
                    PathDisplay.middleTruncate(argumentsOf(payload), PathDisplay.DEFAULT_MAX)));
        }

        /**
         * The {@code tool_result} translation: the {@code replace} of the
         * matched live row with the done card (the envelope id
         * {@code ev-<useSeq>}, the row root {@code ev-<resultSeq>}), or of
         * the group header with the settled count — the aggregate status
         * (error &gt; cancelled &gt; success) once the last call settles.
         * An unmatched result keeps the {@code node} fallback row of
         * {@link #toolResultFrame}; {@link #absorb} runs the same state and
         * discards the frame.
         *
         * @param payload the {@code tool_result} payload
         * @param seq     the event sequence number (drives the node ids)
         * @return the frame
         */
        private Map<String, Object> settleTool(Map<String, Object> payload, long seq) {
            String callId = stringOf(payload.get("id"));
            OpenCall call = (callId == null || callId.isBlank()) ? null : openCalls.remove(callId);
            if (call == null) {
                return StreamFrames.node(toolResultFrame(payload, seq));
            }
            String status = resultStatus(payload);
            if (call.folded && call.group != null) {
                Group group = call.group;
                group.pending--;
                if (statusRank(status) > statusRank(group.worst)) {
                    group.worst = status;
                }
                return StreamFrames.replace(MessageCardBuilder.eventId(group.firstSeq),
                        MessageCardBuilder.workGroupRow(group.firstSeq, group.name,
                                group.count, group.pending > 0 ? RUNNING : group.worst));
            }
            return StreamFrames.replace(MessageCardBuilder.eventId(call.useSeq),
                    MessageCardBuilder.workDoneToolRow(seq, call.name, status,
                            contentOf(payload), isFailure(payload.get("error"))));
        }

        /**
         * Breaks the consecutive {@code tool_use} chain: only adjacent
         * same-name calls fold into one group, so every other event kind
         * starts a fresh chain on the next call.
         */
        private void breakChain() {
            chainName = null;
            chainFirst = null;
            chainGroup = null;
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

    /**
     * The terminal status of a {@code tool_result}: its {@code status}
     * normalized to the {@code success}|{@code error}|{@code cancelled}
     * contract (the upstream lifecycle synonyms collapse here), or the
     * {@code error} flag when no status is given.
     */
    private static String resultStatus(Map<String, Object> payload) {
        String status = stringOf(payload.get("status"));
        if (status != null && !status.isBlank()) {
            return switch (status.trim().toLowerCase(java.util.Locale.ROOT)) {
                case "completed", "done", "success" -> "success";
                case "failed", "error" -> "error";
                case "canceled", "stopped", "cancelled" -> "cancelled";
                default -> status.trim();
            };
        }
        return isFailure(payload.get("error")) ? "error" : "success";
    }

    /**
     * The failure flag of a {@code tool_result}: any truthy {@code error}
     * value (the empty and {@code false} strings are falsey).
     */
    private static boolean isFailure(Object error) {
        return error != null && !Boolean.FALSE.equals(error)
                && !String.valueOf(error).isBlank()
                && !"false".equalsIgnoreCase(String.valueOf(error));
    }

    /** The aggregate severity rank of a settled status: error &gt; cancelled &gt; success. */
    private static int statusRank(String status) {
        return switch (status) {
            case "error" -> 3;
            case "cancelled" -> 2;
            default -> 1;
        };
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
