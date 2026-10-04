/**
 * The message-node vocabulary of the redesigned chat (T77): one builder per
 * stored session event shape, shared by the {@link ChatScreen} transcript and
 * by {@code EventFrames} so a rendered history and a live or replayed frame
 * produce the very same node for the very same event.
 *
 * <p><b>Shapes.</b> Every node id is {@code ev-<seq>} except the text node of
 * a growing assistant message ({@code msg-<seq>}, the {@code patch} target of
 * {@code text_delta}/{@code message_end}):
 * <ul>
 *   <li>user message — a {@code card} bubble tinted {@code $color.accentMuted}
 *       and pushed right ({@code align: centerRight});</li>
 *   <li>assistant message — a plain {@code card} bubble around a {@code
 *       markdown} child carrying the text;</li>
 *   <li>{@code tool_use} — a compact {@code code_block} holding the raw tool
 *       arguments JSON (language label {@code json}, copyable, {@code maxLines}
 *       capped);</li>
 *   <li>{@code tool_result} — a {@code card} whose {@code structured} payload
 *       renders inside a nested collapsible {@code list} section (collapsed by
 *       default, expanded by tapping the section header); a malformed or
 *       unknown {@code structured} payload degrades to a plain card with the
 *       raw content;</li>
 *   <li>{@code error} — a {@code banner} whose message text carries the danger
 *       token (the chat screen hoists these to the top of the list).</li>
 * </ul>
 *
 * <p>All keys are documented contract props (docs/sdui.md sections 2.1 and
 * 2.6); color references are {@code $color.*}/{@code $radius.*} tokens so the
 * client theme stays authoritative.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class MessageCardBuilder {

    /** The tint of the user message bubbles. */
    public static final String USER_TINT = "$color.accentMuted";

    /** The danger color token of error and failed-tool content. */
    public static final String DANGER = "$color.error";

    /** The badge labels of the run status line. */
    public static final String STATUS_RUNNING = "Running\u2026";

    /** The idle badge label. */
    public static final String STATUS_IDLE = "Idle";

    /** The degraded badge label (the last run closed with an error). */
    public static final String STATUS_LIMITED = "Limited";

    /** The node id of the run status badge (the patch target of run frames). */
    public static final String STATUS_ID = "runStatus";

    private MessageCardBuilder() {
    }

    /**
     * The id of one event node.
     *
     * @param seq the event sequence number
     * @return {@code ev-<seq>}
     */
    public static String eventId(long seq) {
        return "ev-" + seq;
    }

    /**
     * The id of the text node of one assistant message; the patch target of
     * its {@code text_delta} and {@code message_end} frames.
     *
     * @param seq the {@code message_start} sequence number
     * @return {@code msg-<seq>}
     */
    public static String messageId(long seq) {
        return "msg-" + seq;
    }

    /**
     * The user message bubble: a right-aligned card tinted
     * {@value #USER_TINT}.
     *
     * @param text the message text
     * @param seq  the event sequence number (drives the node id)
     * @return the bubble node
     */
    public static UiNode userBubble(String text, long seq) {
        return Ui.card()
                .id(eventId(seq))
                .color(USER_TINT)
                .align("centerRight")
                .borderRadius("$radius.md")
                .padding(12)
                .maxWidth(560)
                .child(Ui.text(text == null ? "" : text).style("body").build())
                .build();
    }

    /**
     * The assistant message bubble: a plain card around the markdown text.
     *
     * @param seq  the {@code message_start} sequence number (drives the ids)
     * @param text the complete message text
     * @return the bubble node
     */
    public static UiNode assistantBubble(long seq, String text) {
        return Ui.card()
                .id(eventId(seq))
                .padding(12)
                .maxWidth(560)
                .child(Ui.markdown(text == null ? "" : text).id(messageId(seq)).build())
                .build();
    }

    /**
     * The {@code tool_use} node: a compact {@code code_block} with the raw
     * tool arguments JSON; the tool name rides on the tooltip and semantics
     * label (the {@code code_block} catalog has no title slot).
     *
     * @param name      the tool name
     * @param arguments the raw arguments JSON text
     * @param seq       the event sequence number (drives the node id)
     * @return the code block node
     */
    public static UiNode toolUse(String name, String arguments, long seq) {
        return Ui.codeBlock(arguments == null ? "" : arguments)
                .id(eventId(seq))
                .language("json")
                .wrap(false)
                .copyable(true)
                .maxLines(8)
                .lineNumbers(false)
                .tooltip(name + " arguments")
                .semanticsLabel("tool call " + name)
                .build();
    }

    /**
     * The {@code tool_result} node: a titled card whose details start
     * collapsed inside a collapsible list section. A malformed or unknown
     * {@code structured} payload (or none at all) degrades to a plain card
     * carrying the raw content.
     *
     * @param name       the tool name (the fallback card title)
     * @param content    the plain text content
     * @param structured the structured JSON payload text, may be {@code null}
     * @param error      whether the tool reported a failure
     * @param seq        the event sequence number (drives the node id)
     * @return the result card node
     */
    public static UiNode toolResult(String name, String content, String structured,
                                    boolean error, long seq) {
        String id = eventId(seq);
        UiNode details = detailsNode(structured, id);
        Ui.CardBuilder card = Ui.card().id(id).title(titleOf(name, structured));
        if (details == null) {
            if (content != null && !content.isBlank()) {
                Ui.TextBuilder text = Ui.text(content).style("body");
                if (error) {
                    text.color(DANGER);
                }
                card.child(text.build());
            }
            return card.build();
        }
        Map<String, Object> section = new LinkedHashMap<>();
        section.put("id", id + "-details");
        section.put("label", "Details");
        section.put("collapsible", true);
        section.put("collapsed", true);
        section.put("items", List.of(details));
        return card.child(Ui.list().sections(List.of(section)).build()).build();
    }

    /**
     * The {@code error} banner shown at the top of the message list.
     *
     * @param message the error message
     * @param seq     the event sequence number (drives the node id)
     * @return the banner node
     */
    public static UiNode errorBanner(String message, long seq) {
        UiNode text = Ui.text(message == null ? "" : message)
                .style("body")
                .color(DANGER)
                .build();
        return Ui.banner().id(eventId(seq)).content(text).build();
    }

    /**
     * The run status badge of the composer status line.
     *
     * @param label the status label ({@value #STATUS_RUNNING},
     *              {@value #STATUS_IDLE} or {@value #STATUS_LIMITED})
     * @param color the badge color token, {@code null} for the default
     * @return the badge node
     */
    public static UiNode runBadge(String label, String color) {
        Ui.BadgeBuilder badge = Ui.badge().id(STATUS_ID).label(label);
        if (color != null) {
            badge.color(color);
        }
        return badge.build();
    }

    /**
     * The status props one run frame patches onto the badge.
     *
     * @param label the status label
     * @param color the badge color token or {@code null}
     * @return the patch props
     */
    public static Map<String, Object> statusProps(String label, String color) {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("label", label);
        props.put("color", color);
        return props;
    }

    /** The card title: the structured title when present, else the tool name. */
    private static String titleOf(String name, String structured) {
        Map<String, Object> payload = parseObject(structured);
        if (payload != null) {
            Object title = payload.get("title");
            if (title instanceof String text && !text.isBlank()) {
                return text;
            }
        }
        return name;
    }

    /**
     * The detail node of a well-formed {@code structured} payload (the
     * documented {@code card}/{@code image} family); {@code null} when the
     * payload is missing, malformed or of an unknown kind — the caller then
     * degrades to the plain content card.
     */
    private static UiNode detailsNode(String structured, String id) {
        Map<String, Object> payload = parseObject(structured);
        if (payload == null) {
            return null;
        }
        String kind = String.valueOf(payload.getOrDefault("kind", ""));
        if ("card".equals(kind)) {
            List<Object> rows = new ArrayList<>();
            Object rawRows = payload.get("rows");
            if (rawRows instanceof List<?> list) {
                int index = 0;
                for (Object row : list) {
                    if (row instanceof Map<?, ?> map) {
                        String label = String.valueOf(map.get("label") == null ? "" : map.get("label"));
                        String value = String.valueOf(map.get("value") == null ? "" : map.get("value"));
                        rows.add(Ui.text(label + ": " + value).style("body")
                                .id(id + "-r" + index++).build());
                    }
                }
            }
            return Ui.column().gap(4).children(rows).build();
        }
        if ("image".equals(kind)) {
            String mime = String.valueOf(payload.getOrDefault("mimeType", "image/png"));
            Object data = payload.get("data");
            Ui.ImageBuilder image = Ui.image().id(id + "-img");
            if (data != null && !String.valueOf(data).isBlank()) {
                image.dataUri("data:" + mime + ";base64," + data);
            }
            return image.build();
        }
        return null;
    }

    /** Parses a structured payload; {@code null} when absent or malformed. */
    private static Map<String, Object> parseObject(String structured) {
        if (structured == null || structured.isBlank()) {
            return null;
        }
        try {
            return Json.readMap(structured);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
