/**
 * The {@code chat:<session-id>} screen: the redesigned conversation surface
 * (T77) — a run status badge, a scrollable message list, the live stream tail
 * and the composer.
 *
 * <p><b>Message list.</b> The persisted event history renders through
 * {@link MessageCardBuilder} into a {@code list} of card bubbles: user
 * messages tinted {@value com.astroreen.jhin.plugin.ui.screens.MessageCardBuilder#USER_TINT}
 * and pushed right, plain assistant bubbles with markdown text, compact
 * {@code code_block}s for {@code tool_use} arguments and collapsed
 * {@code tool_result} cards; {@code error} events hoist to {@code banner}
 * nodes at the top of the list. The ids ({@code ev-<seq>}, {@code msg-<seq>})
 * are the same ones {@code EventFrames} emits, so live frames patch the
 * rendered history in place.
 *
 * <p><b>Live tail.</b> The {@code stream_view} ({@code id} {@code stream},
 * {@code itemLimit} {@code 200}, {@code autoScroll}) opens
 * {@code /ui/stream/session/<id>} with {@code fromSeq} set to the last
 * rendered sequence number, so the replay continues after the pre-rendered
 * list instead of duplicating it; patches aimed at a rendered message id fall
 * back to the screen and grow the bubble in place.
 *
 * <p><b>Composer.</b> The textarea carries the reserved id {@code messageInput}
 * the Send action and the T68 keyboard layer operate on; Send posts to the
 * {@code send} action ({@code POST /ui/action/send} with {@code sessionId} and
 * the included {@code messageInput}), Cancel (danger) appears only while a run
 * is live and the New {@code icon_button} carries the
 * {@code composer.sendAndNew} command. The status badge reads
 * {@code Running\u2026} while the last {@code run_start} is unpaired,
 * {@code Limited} when the last run closed with an {@code error} and
 * {@code Idle} otherwise.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class ChatScreen {

    /** Path prefix of the session stream endpoint the UI plugin serves. */
    private static final String STREAM_TOPIC_PREFIX = "/ui/stream/session/";

    /** The input id the send action and the composer commands include. */
    private static final String MESSAGE_INPUT = "messageInput";

    /** The command the New icon button carries (the T68 send-and-new flow). */
    private static final String SEND_AND_NEW = "composer.sendAndNew";

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
                .body(Ui.container()
                        .direction("column")
                        .gap(12)
                        .padding(16)
                        .child(MessageCardBuilder.runBadge(status, statusColor(status)))
                        .child(Ui.expanded()
                                .child(messageList(history))
                                .build())
                        .child(liveTail(sessionId, history))
                        .child(composer(sessionId, runLive))
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
     * The scrollable message list: error banners on top, then the transcript
     * in sequence order (an open assistant message is flushed as-is).
     */
    private static UiNode messageList(List<EventRecord> history) {
        List<UiNode> banners = new ArrayList<>();
        List<UiNode> items = new ArrayList<>();
        long openSeq = -1;
        StringBuilder buffer = new StringBuilder();
        for (EventRecord record : history) {
            long seq = record.seq();
            Map<String, Object> payload = parse(record.payload());
            switch (record.type().wire()) {
                case "user_message" -> items.add(MessageCardBuilder.userBubble(textOf(payload, "text"), seq));
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
                    items.add(MessageCardBuilder.assistantBubble(
                            openSeq >= 0 ? openSeq : seq, text));
                    openSeq = -1;
                    buffer.setLength(0);
                }
                case "tool_use" -> items.add(MessageCardBuilder.toolUse(
                        textOf(payload, "name"), jsonOf(payload.get("arguments")), seq));
                case "tool_result" -> items.add(MessageCardBuilder.toolResult(
                        textOf(payload, "name"), textOf(payload, "content"),
                        jsonOf(payload.get("structured")),
                        Boolean.TRUE.equals(payload.get("error")), seq));
                case "error" -> banners.add(MessageCardBuilder.errorBanner(
                        textOf(payload, "message"), seq));
                default -> {
                }
            }
        }
        if (openSeq >= 0) {
            items.add(MessageCardBuilder.assistantBubble(openSeq, buffer.toString()));
        }
        List<UiNode> merged = new ArrayList<>(banners);
        merged.addAll(items);
        Ui.ListBuilder list = Ui.list().id("messages").set("empty", "No messages yet.");
        for (UiNode node : merged) {
            list.item(node);
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
