/**
 * The {@code chat:<session-id>} screen: the chat frame (T100) — the header
 * row, the content lane, the scroll-anchored timeline and the docked
 * composer — around the T77 conversation surface.
 *
 * <p><b>Frame.</b> The body is a column: the chat header row, then the
 * content lane filling the rest. The lane (id {@code chat-lane}) carries
 * the {@code laneWidth} prop — the server-side default {@value #LANE_WIDTH},
 * the upstream {@code --chat-content-max-width} root default (t3code
 * {@code apps/web/src/index.css:128}, commit {@code 37de6cb}); the client
 * resolves the effective width from its {@code chatWidth} switch (T86) the
 * same way upstream sets the variable per {@code data-chat-width} on
 * {@code :root} ({@code __root.tsx:277-280}). Inside the lane the timeline
 * scrolls under a top {@code scroll_fade} (the upstream messages-timeline
 * fade, {@code MessagesTimeline.tsx:1377}), the composer-seam divider
 * paints the {@code --background-image-composer-seam-above} recipe
 * (index.css:207-215 — the 10 px shade hugging the composer's top edge,
 * fading upward) and the composer docks at the bottom on the reserved
 * {@code composer} surface id (the client paints {@code --shadow-composer}
 * and the bottom safe-area inset there, T87).
 *
 * <p><b>Header row.</b> The thread title, the run status badge (the status
 * indicator) and the actions: the right-panel and terminal toggles —
 * inline {@code setState} shells marked {@code demo} (the E-phase panels
 * do not exist yet) — and the thread action menu with the real lifecycle
 * actions (the upstream header menu is the thread action menu,
 * {@code ChatHeader.tsx} + {@code useThreadActionMenu}).
 *
     * <p><b>Message list.</b> The persisted event history renders through
     * {@link MessageCardBuilder} into the T101 timeline rows of a {@code
     * list}: user messages as the {@code message:user} bubble on the message
     * surface, assistant messages as the bordered {@code message:assistant}
     * card with markdown text, collapsible {@code work:log} entries for the
     * tool events, the {@code event:error} row and the {@code working} strip
     * of an open run. Consecutive rows sharing a continuation key close with
     * no gap ({@link MessageCardBuilder#applyContinuation}). The ids ({@code
     * ev-<seq>}, {@code msg-<seq>}) are the same ones {@code EventFrames}
     * emits, so live frames patch the rendered history in place.
 *
 * <p><b>Live tail.</b> The {@code stream_view} ({@code id} {@code stream},
 * {@code itemLimit} {@code 200}, {@code autoScroll}) opens
 * {@code /ui/stream/session/<id>} with {@code fromSeq} set to the last
 * rendered sequence number, so the replay continues after the pre-rendered
 * list instead of duplicating it; patches aimed at a rendered message id fall
 * back to the screen and grow the bubble in place. The client anchors the
 * tail: appended items jump to the bottom while the view follows the end, a
 * patch preserves the position, and the tail reserves the upstream
 * {@code CHAT_TIMELINE_ANCHOR_OFFSET} (24 px,
 * {@code timelineScrollAnchoring.ts:39}) as the end inset.
 *
 * <p><b>Composer.</b> The textarea carries the reserved id {@code messageInput}
 * the Send action and the T68 keyboard layer operate on, and renders at the
 * prompt font size (the upstream {@code --font-size-prompt-touch} floor,
 * index.css:131); Send posts to the {@code send} action ({@code POST
 * /ui/action/send} with {@code sessionId} and the included
 * {@code messageInput}), Cancel (danger) appears only while a run is live
 * and the New {@code icon_button} carries the {@code composer.sendAndNew}
 * command. The status badge reads {@code Running\u2026} while the last
 * {@code run_start} is unpaired, {@code Limited} when the last run closed
 * with an {@code error} and {@code Idle} otherwise.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ChatScreen {

    /** Path prefix of the session stream endpoint the UI plugin serves. */
    private static final String STREAM_TOPIC_PREFIX = "/ui/stream/session/";

    /** The input id the send action and the composer commands include. */
    private static final String MESSAGE_INPUT = "messageInput";

    /** The command the New icon button carries (the T68 send-and-new flow). */
    private static final String SEND_AND_NEW = "composer.sendAndNew";

    /** The content lane id and its server-side default width (T100). */
    public static final String LANE_ID = "chat-lane";

    /**
     * The lane width default: the upstream {@code --chat-content-max-width}
     * root default (index.css:128). The client's {@code chatWidth} switch
     * resolves the effective lane from it (46rem normal / 72rem wide / full).
     */
    public static final String LANE_WIDTH = "46rem";

    /** The chat header row id. */
    public static final String HEADER_ID = "chat-header";

    /** The composer-seam divider id (the painted seam-above recipe). */
    public static final String SEAM_ID = "composer-seam";

    /** The timeline region id (the scroll-fade child). */
    public static final String TIMELINE_ID = "chat-timeline";

    /** UiState ids of the decorative panel toggles (the E-phase panels). */
    public static final String STATE_RIGHT_PANEL = "chat_right_panel";
    public static final String STATE_TERMINAL = "chat_terminal";

    /** The seam shade: the recipe's {@code rgb(0 0 0 / 18%)} as AARRGGBB. */
    private static final String SEAM_SHADE = "#2E000000";

    /** The seam gradient's transparent end. */
    private static final String SEAM_CLEAR = "#00000000";

    private ChatScreen() {
    }

    /**
     * Builds the chat screen of one session.
     *
     * @param session the session the screen is opened for
     * @param history the stored events of the session in sequence order
     * @return the screen node
     */
    public static UiNode render(Session session, List<EventRecord> history) {
        String sessionId = session.id();
        String status = statusOf(history);
        boolean runLive = MessageCardBuilder.STATUS_RUNNING.equals(status);
        return Ui.screen()
                .title(session.title())
                .body(Ui.column()
                        .id("chat-frame")
                        .gap(0)
                        .child(header(session, status))
                        .child(Ui.expanded()
                                .child(lane(sessionId, history, runLive))
                                .build())
                        .build())
                .build();
    }

    /** The run status badge label derived from the run events of the history. */
    static String statusOf(List<EventRecord> history) {
        boolean open = false;
        boolean limited = false;
        for (EventRecord record : history) {
            switch (record.type().wire()) {
                case "run_start" -> open = true;
                case "run_end" -> {
                    open = false;
                    limited = false;
                }
                case "error" -> {
                    open = false;
                    limited = true;
                }
                default -> {
                }
            }
        }
        return open ? MessageCardBuilder.STATUS_RUNNING
                : limited ? MessageCardBuilder.STATUS_LIMITED
                : MessageCardBuilder.STATUS_IDLE;
    }

    private static String statusColor(String status) {
        return switch (status) {
            case MessageCardBuilder.STATUS_RUNNING -> "$color.accent";
            case MessageCardBuilder.STATUS_LIMITED -> MessageCardBuilder.DANGER;
            default -> null;
        };
    }

    /**
     * The chat header row (T100): the thread title, the run status badge and
     * the actions — the two demo-marked panel toggles (inline {@code
     * setState} shells; the E-phase panels do not exist yet) and the thread
     * action menu with the real lifecycle actions.
     */
    private static UiNode header(Session session, String status) {
        return Ui.row()
                .id(HEADER_ID)
                .align("center")
                .gap(8)
                .padding(List.of(12, 16))
                .child(Ui.text(session.title())
                        .fontSize(14)
                        .fontWeight(600)
                        .maxLines(1)
                        .build())
                .child(MessageCardBuilder.runBadge(status, statusColor(status)))
                .child(Ui.spacer().build())
                .child(panelToggle(STATE_RIGHT_PANEL, "view_sidebar"))
                .child(panelToggle(STATE_TERMINAL, "dock"))
                .child(headerMenu(session))
                .build();
    }

    /**
     * One decorative panel toggle: an icon button whose tap runs the inline
     * {@code setState} that the E-phase panel will read. It has no visible
     * effect yet, so it carries the {@code demo} marker (plan section 14.10).
     */
    private static UiNode panelToggle(String stateId, String icon) {
        return Ui.iconButton()
                .id(stateId + "-toggle")
                .icon(icon)
                .action(Directives.setState(stateId, true))
                .tooltip("Toggle panel")
                .set("demo", true)
                .build();
    }

    /**
     * The thread action menu of the header (the upstream header menu is the
     * thread action menu): the real lifecycle actions of this session —
     * pin/unpin, settle/un-settle, the snooze presets (or Wake while
     * snoozed), regenerate title, archive and delete.
     */
    private static UiNode headerMenu(Session session) {
        String id = session.id();
        long now = System.currentTimeMillis();
        boolean snoozed = session.snoozedUntil() != null && session.snoozedUntil() > now;
        Ui.MenuBuilder menu = Ui.menu()
                .trigger(Ui.iconButton().icon("more_vert")
                        .action(ActionDescriptors.of("noop"))
                        .build());
        if (session.pinned()) {
            menu.item(Ui.menuItem("Unpin thread")
                    .icon("keep_off")
                    .action(ActionDescriptors.of("unpin", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Pin thread")
                    .icon("keep")
                    .action(ActionDescriptors.of("pin", Map.of("id", id), null))
                    .build());
        }
        if (session.settledAt() != null) {
            menu.item(Ui.menuItem("Un-settle thread")
                    .icon("check_circle")
                    .action(ActionDescriptors.of("unsettle", Map.of("id", id), null))
                    .build());
        } else {
            menu.item(Ui.menuItem("Settle thread")
                    .icon("check_circle")
                    .action(ActionDescriptors.of("settle", Map.of("id", id), null))
                    .build());
        }
        if (snoozed) {
            menu.item(Ui.menuItem("Wake thread")
                    .icon("schedule")
                    .action(ActionDescriptors.of("wake", Map.of("id", id), null))
                    .build());
        } else {
            List<Map<String, Object>> presets = new ArrayList<>();
            for (SidebarBuilder.SnoozePreset preset : SidebarBuilder.snoozePresets(now)) {
                presets.add(Ui.menuItem(preset.label() + " (" + preset.whenLabel() + ")")
                        .action(ActionDescriptors.of("snooze",
                                Map.of("id", id, "until", preset.until()), null))
                        .build());
            }
            menu.item(Ui.menuItem("Snooze")
                    .icon("schedule")
                    .children(presets)
                    .build());
        }
        menu.item(Ui.menuItem("Regenerate title")
                .icon("refresh")
                .separatorBefore(true)
                .action(ActionDescriptors.of("regenerate-title", Map.of("id", id), null))
                .build());
        menu.item(Ui.menuItem("Archive thread")
                .icon("archive")
                .separatorBefore(true)
                .action(ActionDescriptors.of("archive", Map.of("id", id), null))
                .confirm("Archive this thread?")
                .build());
        menu.item(Ui.menuItem("Delete")
                .icon("delete")
                .action(ActionDescriptors.of("delete-session", Map.of("id", id), null))
                .confirm("Delete this thread? This cannot be undone.")
                .danger(true)
                .build());
        return menu.build();
    }

    /**
     * The content lane (T100): the timeline scrolling under a top scroll
     * fade, the composer-seam divider and the docked composer, all centered
     * at the {@code laneWidth} default the client resolves through its
     * {@code chatWidth} switch.
     */
    private static UiNode lane(String sessionId, List<EventRecord> history, boolean runLive) {
        return Ui.container()
                .id(LANE_ID)
                .direction("column")
                .gap(0)
                .set("laneWidth", LANE_WIDTH)
                // flex 1: inside a container the expanded node needs the
                // explicit flex for the universal Expanded wrap — a plain
                // child of a column gets unbounded height (the scroll_fade
                // and the timeline under it would crash).
                .child(Ui.expanded()
                        .flex(1)
                        .child(Ui.scrollFade()
                                .edge("top")
                                .child(timeline(sessionId, history))
                                .build())
                        .build())
                .child(seam())
                .child(composer(sessionId, runLive))
                .build();
    }

    /**
     * The timeline region: the transcript list filling the height and the
     * live tail below it (the T77 shape; T101 unifies the rows).
     */
    private static UiNode timeline(String sessionId, List<EventRecord> history) {
        return Ui.column()
                .id(TIMELINE_ID)
                .gap(8)
                .child(Ui.expanded()
                        .child(messageList(history))
                        .build())
                .child(liveTail(sessionId, history))
                .build();
    }

    /**
     * The composer-seam divider (T100): the painted port of the upstream
     * {@code --background-image-composer-seam-above} recipe (index.css:207-215)
     * at its default zero attachment overlap — a 10 px band of
     * {@code rgb(0 0 0 / 18%)} hugging the composer's top edge and fading
     * upward. The recipe's second layer (the 1% white fill of the
     * seam-below variant) is imperceptible at this scale and is not
     * painted.
     *
     * <p>The gradient spec is emitted without the {@code type} key: the
     * client defaults a typeless gradient to {@code linear}
     * (docs/sdui.md section 2.1), and a literal {@code "type": "linear"}
     * inside a prop map would read as a node discriminator to every
     * primitive-catalog walker (the section 2.5 guards).
     */
    private static UiNode seam() {
        Map<String, Object> gradient = new LinkedHashMap<>();
        gradient.put("begin", "bottomCenter");
        gradient.put("end", "topCenter");
        gradient.put("colors", List.of(SEAM_SHADE, SEAM_CLEAR));
        return Ui.box()
                .id(SEAM_ID)
                .height(10)
                .alignment("center")
                .child(Ui.sizedBox().build())
                .gradient(gradient)
                .build();
    }

    /**
     * The scrollable timeline: the T101 rows of the persisted history in
     * sequence order — {@code message} bubbles, {@code work} tool entries,
     * the {@code event} error row, the {@code working} strip of an open run
     * — with the continuation gaps baked in (rows sharing a continuation key
     * close with no gap). An open assistant message is flushed as-is.
     */
    private static UiNode messageList(List<EventRecord> history) {
        List<UiNode> rows = new ArrayList<>();
        long openSeq = -1;
        StringBuilder buffer = new StringBuilder();
        Long workingSeq = null;
        for (EventRecord record : history) {
            long seq = record.seq();
            Map<String, Object> payload = parse(record.payload());
            switch (record.type().wire()) {
                case "user_message" -> rows.add(MessageCardBuilder.userMessageRow(
                        textOf(payload, "text"), seq));
                case "message_start" -> {
                    openSeq = seq;
                    buffer.setLength(0);
                }
                case "text_delta" -> {
                    if (openSeq < 0) {
                        openSeq = seq;
                        buffer.setLength(0);
                    }
                    buffer.append(textOf(payload, "text"));
                }
                case "message_end" -> {
                    String text = payload.containsKey("text")
                            ? textOf(payload, "text") : buffer.toString();
                    rows.add(MessageCardBuilder.assistantMessageRow(
                            openSeq >= 0 ? openSeq : seq, text));
                    openSeq = -1;
                    buffer.setLength(0);
                }
                case "tool_use" -> rows.add(MessageCardBuilder.workRow(
                        seq,
                        textOf(payload, "name") + " " + jsonOf(payload.get("arguments")),
                        List.of(MessageCardBuilder.toolArgumentsNode(
                                jsonOf(payload.get("arguments")), seq))));
                case "tool_result" -> rows.add(MessageCardBuilder.workRow(
                        seq,
                        textOf(payload, "name") + " result",
                        List.of(MessageCardBuilder.toolResultNode(
                                textOf(payload, "content"),
                                Boolean.TRUE.equals(payload.get("error")), seq))));
                case "run_start" -> workingSeq = seq;
                case "run_end" -> workingSeq = null;
                case "error" -> rows.add(MessageCardBuilder.dispatchEventRow(
                        "error", payload, seq));
                default -> {
                }
            }
        }
        if (openSeq >= 0) {
            rows.add(MessageCardBuilder.assistantMessageRow(openSeq, buffer.toString()));
        }
        if (workingSeq != null) {
            rows.add(MessageCardBuilder.workingRow(workingSeq));
        }
        Ui.ListBuilder list = Ui.list().id("messages").set("empty", "No messages yet.");
        for (UiNode row : MessageCardBuilder.applyContinuation(rows)) {
            list.item(row);
        }
        return list.build();
    }

    /**
     * The live tail: the session stream continuing after the last rendered
     * sequence number ({@code fromSeq} is an exclusive lower bound), so a
     * replayed history never duplicates the pre-rendered list.
     */
    private static UiNode liveTail(String sessionId, List<EventRecord> history) {
        long lastSeq = 0;
        for (EventRecord record : history) {
            lastSeq = Math.max(lastSeq, record.seq());
        }
        return Ui.streamView("stream", STREAM_TOPIC_PREFIX + sessionId + "?fromSeq=" + lastSeq)
                .mode("append")
                .itemLimit(200)
                .autoScroll(true)
                .build();
    }

    /** The composer: message input, Send, the live-only Cancel and New. */
    private static UiNode composer(String sessionId, boolean runLive) {
        Map<String, Object> runPayload = Map.of("sessionId", sessionId);
        Ui.ContainerBuilder row = Ui.container()
                .id("composer")
                .direction("row")
                .gap(8)
                .align("center")
                .padding(12)
                .child(Ui.textarea(MESSAGE_INPUT)
                        .label("Message")
                        .required(true)
                        .errorText("Write a message first")
                        .minLines(1)
                        .maxLines(8)
                        .autofocus(true)
                        .flex(1)
                        .build())
                .child(Ui.button("Send")
                        .style("primary")
                        .icon("send")
                        .action(ActionDescriptors.of("send", runPayload, List.of(MESSAGE_INPUT)))
                        .build());
        if (runLive) {
            row.child(Ui.button("Cancel")
                    .style("danger")
                    .action(ActionDescriptors.of("cancel", runPayload, List.of()))
                    .build());
        }
        row.child(Ui.iconButton()
                .icon("add")
                .set("command", SEND_AND_NEW)
                .tooltip("New session")
                .build());
        return row.build();
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

    private static String textOf(Map<String, Object> payload, String key) {
        Object value = payload.get(key);
        return (value == null) ? "" : String.valueOf(value);
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
}
