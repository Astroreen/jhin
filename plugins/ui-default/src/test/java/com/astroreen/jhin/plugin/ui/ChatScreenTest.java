/**
 * The T101 chat timeline: the transcript renders the 14 row kinds of
 * {@code MessageCardBuilder} — user bubbles on the message surface, bordered
 * assistant cards, collapsible {@code work} tool entries, the {@code event}
 * error row and the {@code working} strip of an open run — with the
 * continuation gaps baked in (rows sharing a continuation key close with no
 * gap). The T103 composer carries the {@code messageInput} textarea at the
 * 160px minimum height, the real {@code send} action and the stop button
 * that appears only while a run is live. The T100 frame wraps the timeline
 * in the content lane ({@code laneWidth}), the top scroll fade and the
 * composer-seam divider, and the header row carries the title, the status
 * badge, the demo-marked panel toggles and the thread action menu.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ChatScreenTest {

    private static final String SESSION_ID = "s-1";

    @Test
    void fullRunTranscriptRendersUserAssistantToolRowsAndAssistant() {
        Map<String, Object> json = render(fullRun());

        List<Map<String, Object>> items = messageItems(json);
        assertThat(items).hasSize(5);

        Map<String, Object> first = items.get(0);
        assertThat(first).containsEntry("type", "container")
                .containsEntry("id", "ev-2")
                .containsEntry("rowKind", "message")
                .containsEntry("rowKey", "message:user")
                .containsEntry("align", "centerRight");
        assertThat(Json.write(first)).contains("Fix the bug").contains("$color.message");

        Map<String, Object> assistant = items.get(1);
        assertThat(assistant).containsEntry("type", "container")
                .containsEntry("id", "ev-3")
                .containsEntry("rowKind", "message")
                .containsEntry("rowKey", "message:assistant")
                .containsEntry("align", "centerLeft");
        assertThat(Json.write(assistant)).contains("\"id\":\"msg-3\"").contains("Let me look.");

        Map<String, Object> toolUse = items.get(2);
        assertThat(toolUse).containsEntry("type", "container")
                .containsEntry("id", "ev-7")
                .containsEntry("rowKind", "work")
                .containsEntry("rowKey", "work:log");
        assertThat(Json.write(toolUse)).contains("/tmp/a.txt").contains("hello world!")
                .contains("\"collapsed\":true");

        Map<String, Object> toolResult = items.get(3);
        assertThat(toolResult).containsEntry("type", "container")
                .containsEntry("id", "ev-8")
                .containsEntry("rowKind", "work")
                .containsEntry("rowKey", "work:log");
        assertThat(Json.write(toolResult)).contains("ok");

        Map<String, Object> closing = items.get(4);
        assertThat(closing).containsEntry("type", "container")
                .containsEntry("id", "ev-9")
                .containsEntry("rowKind", "message")
                .containsEntry("rowKey", "message:assistant");
        assertThat(Json.write(closing)).contains("\"id\":\"msg-9\"").contains("All done");
    }

    @Test
    void stopButtonIsPresentOnlyWhileARunIsLive() {
        Map<String, Object> idle = render(List.of());
        Map<String, Object> running = render(List.of(
                event(1, EventType.RUN_START, "{\"runId\":\"r1\"}")));
        Map<String, Object> finished = render(List.of(
                event(1, EventType.RUN_START, "{\"runId\":\"r1\"}"),
                event(2, EventType.RUN_END, "{\"runId\":\"r1\"}")));
        Map<String, Object> failed = render(List.of(
                event(1, EventType.RUN_START, "{\"runId\":\"r1\"}"),
                event(2, EventType.ERROR, "{\"message\":\"boom\"}")));

        assertThat(stopButton(idle)).isEmpty();
        assertThat(stopButton(running)).isNotEmpty();
        assertThat(stopButton(finished)).isEmpty();
        assertThat(stopButton(failed)).isEmpty();

        assertThat(statusBadge(idle)).containsEntry("label", "Idle");
        assertThat(statusBadge(running)).containsEntry("label", "Running\u2026");
        assertThat(statusBadge(finished)).containsEntry("label", "Idle");
        assertThat(statusBadge(failed)).containsEntry("label", "Limited");
    }

    @Test
    void toolResultRowsRenderThePlainContentDetail() {
        Map<String, Object> json = render(List.of(
                event(1, EventType.TOOL_RESULT, Json.write(Map.of(
                        "id", "c1", "name", "bash", "content", "raw output",
                        "structured", "{{{ not json")))));

        List<Map<String, Object>> items = messageItems(json);
        assertThat(items).hasSize(1);
        Map<String, Object> row = items.get(0);
        assertThat(row).containsEntry("type", "container").containsEntry("rowKind", "work");
        assertThat(Json.write(row)).contains("raw output");
    }

    @Test
    void failedToolResultDetailCarriesTheDangerColor() {
        Map<String, Object> json = render(List.of(
                event(1, EventType.TOOL_RESULT, Json.write(Map.of(
                        "id", "c1", "name", "bash", "content", "boom out",
                        "error", true)))));

        Map<String, Object> row = messageItems(json).get(0);
        assertThat(row).containsEntry("type", "container").containsEntry("rowKind", "work");
        assertThat(Json.write(row)).contains("boom out").contains("$color.error");
    }

    @Test
    void errorEventsRenderEventRowsInSequenceOrder() {
        Map<String, Object> json = render(List.of(
                event(1, EventType.USER_MESSAGE, "{\"text\":\"hello\"}"),
                event(2, EventType.ERROR, "{\"message\":\"boom\"}")));

        List<Map<String, Object>> items = messageItems(json);
        assertThat(items).hasSize(2);
        assertThat(items.get(1)).containsEntry("type", "container")
                .containsEntry("id", "ev-2")
                .containsEntry("rowKind", "event")
                .containsEntry("rowKey", "event:error");
        assertThat(Json.write(items.get(1))).contains("boom").contains("$color.error");
        assertThat(items.get(0)).containsEntry("type", "container").containsEntry("id", "ev-1");
    }

    @Test
    void anOpenRunRendersTheWorkingRowAndAClosedRunDoesNot() {
        Map<String, Object> open = render(List.of(
                event(1, EventType.RUN_START, "{\"runId\":\"r1\"}")));
        Map<String, Object> closed = render(List.of(
                event(1, EventType.RUN_START, "{\"runId\":\"r1\"}"),
                event(2, EventType.RUN_END, "{\"runId\":\"r1\"}")));

        List<Map<String, Object>> openItems = messageItems(open);
        assertThat(openItems).hasSize(1);
        assertThat(openItems.get(0)).containsEntry("rowKind", "working")
                .containsEntry("rowKey", "working:run");
        assertThat(messageItems(closed)).isEmpty();
    }

    @Test
    void consecutiveRowsSharingAContinuationKeyCloseWithNoGap() {
        Map<String, Object> json = render(fullRun());

        List<Map<String, Object>> items = messageItems(json);
        // ev-7 and ev-8 are both work:log rows — the first closes with no
        // gap, the second (the group end) with the 8px work gap.
        assertThat(items.get(2)).containsEntry("rowKey", "work:log");
        assertThat(castMap(items.get(2).get("margin"))).containsEntry("bottom", 0);
        assertThat(castMap(items.get(3).get("margin"))).containsEntry("bottom", 8);
        // The closing assistant message closes with the 16px message gap.
        assertThat(castMap(items.get(4).get("margin"))).containsEntry("bottom", 16);
    }

    @Test
    void messageIdsAreStableAcrossFrames() {
        List<EventRecord> history = fullRun();
        Map<String, Object> json = render(history);

        EventFrames.Translator translator = new EventFrames.Translator();
        List<String> frameIds = new ArrayList<>();
        for (EventRecord record : history) {
            Map<String, Object> frame = translator.frame(
                    record.type().wire(), record.payload(), record.seq());
            collectIds(frame, frameIds);
        }

        List<String> treeIds = new ArrayList<>();
        collectIds(json, treeIds);

        List<String> shared = List.of("ev-2", "msg-3", "ev-7", "ev-8", "ev-9", "msg-9");
        assertThat(treeIds).containsAll(shared);
        assertThat(frameIds).containsAll(shared);
    }

    @Test
    void composerCarriesTheMessageInputAndTheSendAction() {
        Map<String, Object> json = render(List.of());

        Map<String, Object> input = nodesOfType(json, "textarea").get(0);
        assertThat(input).containsEntry("id", "messageInput")
                .containsEntry("minLines", 1)
                .containsEntry("maxLines", 8);
        assertThat(castMap(input.get("constraints"))).containsEntry("minHeight",
                ChatScreen.COMPOSER_MIN_HEIGHT);

        Map<String, Object> send = button(json, "Send");
        assertThat(send).containsEntry("icon", "send");
        Map<String, Object> action = castMap(send.get("action"));
        assertThat(action).containsEntry("name", "send")
                .containsEntry("path", "/ui/action/send")
                .containsEntry("method", "POST");
        assertThat(castList(action.get("include"))).containsExactly("messageInput");
        assertThat(castMap(action.get("payload"))).containsEntry("sessionId", SESSION_ID);
    }

    @Test
    void streamViewContinuesAfterTheRenderedHistory() {
        Map<String, Object> json = render(fullRun());

        Map<String, Object> stream = nodesOfType(json, "stream_view").get(0);
        assertThat(stream).containsEntry("id", "stream")
                .containsEntry("itemLimit", 200)
                .containsEntry("autoScroll", true)
                .containsEntry("topic", "/ui/stream/session/" + SESSION_ID + "?fromSeq=12");
    }

    @Test
    void frameWrapsTheTimelineInTheLaneWithSeamAndComposerDock() {
        Map<String, Object> json = render(List.of());

        Map<String, Object> body = castMap(json.get("body"));
        // T105 wraps the frame column in a stack so the right panel can
        // overlay it; the lane expanded is still the frame column's child.
        assertThat(body).containsEntry("type", "stack")
                .containsEntry("id", "chat-frame-stack");
        Map<String, Object> frame = nodesOfType(body, "column").stream()
                .filter(node -> "chat-frame".equals(node.get("id")))
                .findFirst()
                .orElseThrow();
        assertThat(frame).containsEntry("type", "column");

        // The lane: the centered content column with the server-side default
        // width; the client resolves the effective lane from its chatWidth
        // switch (T86).
        Map<String, Object> lane = nodesOfType(json, "container").stream()
                .filter(node -> ChatScreen.LANE_ID.equals(node.get("id")))
                .findFirst()
                .orElseThrow();
        assertThat(lane).containsEntry("laneWidth", ChatScreen.LANE_WIDTH);

        // The timeline scrolls under a top scroll fade inside the lane.
        Map<String, Object> fade = nodesOfType(json, "scroll_fade").get(0);
        assertThat(fade).containsEntry("edge", "top");
        Map<String, Object> timeline = castMap(fade.get("child"));
        assertThat(timeline).containsEntry("id", ChatScreen.TIMELINE_ID);

        // The seam divider paints the composer-seam gradient between the
        // timeline and the docked composer.
        Map<String, Object> seam = nodesOfType(json, "box").stream()
                .filter(node -> ChatScreen.SEAM_ID.equals(node.get("id")))
                .findFirst()
                .orElseThrow();
        Map<String, Object> gradient = castMap(seam.get("gradient"));
        // Typeless on the wire: the client defaults a typeless gradient to
        // linear, and a literal "type" key would read as a node
        // discriminator to the primitive-catalog walkers.
        assertThat(gradient).doesNotContainKey("type")
                .containsEntry("begin", "bottomCenter")
                .containsEntry("end", "topCenter");
        assertThat(castList(gradient.get("colors"))).containsExactly("#2E000000", "#00000000");

        // The composer docks below the seam, inside the lane (the T103
        // composer is the column carrying the reserved surface id).
        Map<String, Object> composer = nodesOfType(json, "column").stream()
                .filter(node -> "composer".equals(node.get("id")))
                .findFirst()
                .orElseThrow();
        assertThat(castList(lane.get("children"))).contains(seam, composer);
    }

    @Test
    void headerCarriesTitleStatusTogglesAndThreadMenu() {
        Map<String, Object> json = render(fullRun());

        Map<String, Object> header = nodesOfType(json, "row").stream()
                .filter(node -> ChatScreen.HEADER_ID.equals(node.get("id")))
                .findFirst()
                .orElseThrow();
        List<Map<String, Object>> children = castList(header.get("children")).stream()
                .map(ChatScreenTest::castMap)
                .toList();

        // The thread title and the run status indicator lead the row.
        Map<String, Object> title = children.get(0);
        assertThat(title).containsEntry("type", "text").containsEntry("text", "demo");
        assertThat(children.get(1)).containsEntry("type", "badge")
                .containsEntry("id", "runStatus")
                .containsEntry("label", "Idle");

        // The panel toggles: inline setState shells, demo-marked.
        List<Map<String, Object>> toggles = children.stream()
                .filter(node -> "icon_button".equals(node.get("type"))
                        && Boolean.TRUE.equals(node.get("demo")))
                .toList();
        assertThat(toggles).hasSize(2);
        assertThat(toggles.stream().map(node -> node.get("icon")))
                .containsExactly("view_sidebar", "dock");
        for (Map<String, Object> toggle : toggles) {
            Map<String, Object> action = castMap(toggle.get("action"));
            assertThat(action).containsEntry("op", "setState");
            assertThat(action.get("id")).isIn(ChatScreen.STATE_RIGHT_PANEL,
                    ChatScreen.STATE_TERMINAL);
        }

        // The thread action menu carries the real lifecycle actions.
        Map<String, Object> menu = children.get(children.size() - 1);
        assertThat(menu).containsEntry("type", "menu");
        List<Map<String, Object>> items = castList(menu.get("items")).stream()
                .map(ChatScreenTest::castMap)
                .toList();
        assertThat(items.stream().map(node -> node.get("label"))).containsExactly(
                "Pin thread", "Settle thread", "Snooze", "Regenerate title",
                "Archive thread", "Delete");
        assertThat(castMap(items.get(0).get("action"))).containsEntry("name", "pin");
        assertThat(castMap(castMap(items.get(0).get("action")).get("payload")))
                .containsEntry("id", SESSION_ID);
        assertThat(castMap(items.get(5).get("action"))).containsEntry("name", "delete-session");
        assertThat(items.get(5)).containsEntry("danger", true);

        // The snooze submenu carries the preset entries.
        List<Map<String, Object>> snooze = castList(items.get(2).get("children")).stream()
                .map(ChatScreenTest::castMap)
                .toList();
        assertThat(snooze).isNotEmpty();
        assertThat(castMap(snooze.get(0).get("action"))).containsEntry("name", "snooze");
    }

    // --- fixture ---

    /** One completed run with a tool call: user -> assistant -> tool -> assistant. */
    private static List<EventRecord> fullRun() {
        return List.of(
                event(1, EventType.RUN_START, "{\"runId\":\"r1\"}"),
                event(2, EventType.USER_MESSAGE, "{\"text\":\"Fix the bug\"}"),
                event(3, EventType.MESSAGE_START, "{\"role\":\"assistant\"}"),
                event(4, EventType.TEXT_DELTA, "{\"text\":\"Let me \"}"),
                event(5, EventType.TEXT_DELTA, "{\"text\":\"look.\"}"),
                event(6, EventType.MESSAGE_END, "{\"text\":\"Let me look.\"}"),
                event(7, EventType.TOOL_USE, Json.write(Map.of(
                        "id", "c1", "name", "write",
                        "arguments", "{\"path\":\"/tmp/a.txt\",\"content\":\"hello world!\"}"))),
                event(8, EventType.TOOL_RESULT, Json.write(Map.of(
                        "id", "c1", "name", "write", "content", "ok", "error", false,
                        "structured", "{\"kind\":\"card\",\"title\":\"write\","
                                + "\"rows\":[{\"label\":\"bytes\",\"value\":\"12\"}]}"))),
                event(9, EventType.MESSAGE_START, "{\"role\":\"assistant\"}"),
                event(10, EventType.TEXT_DELTA, "{\"text\":\"All done\"}"),
                event(11, EventType.MESSAGE_END, "{\"text\":\"All done\"}"),
                event(12, EventType.RUN_END, "{\"runId\":\"r1\"}"));
    }

    private static EventRecord event(long seq, EventType type, String payload) {
        return new EventRecord(SESSION_ID, seq, seq * 1000L, type, payload);
    }

    private static Map<String, Object> render(List<EventRecord> history) {
        Session session = new Session(SESSION_ID, "acc-1", "demo", "/tmp/work",
                null, null, "active", 0L, 0L, false, null, null, null, null,
                false, null, null, false);
        return ChatScreen.render(session, history).toJson();
    }

    // --- node walking helpers over the JSON wire shape ---

    /** The items of the {@code messages} list, in render order. */
    private static List<Map<String, Object>> messageItems(Map<String, Object> screen) {
        Map<String, Object> list = nodesOfType(screen, "list").stream()
                .filter(node -> "messages".equals(node.get("id")))
                .findFirst()
                .orElseThrow();
        List<Object> items = castList(list.get("items"));
        return items == null ? List.of() : items.stream()
                .map(ChatScreenTest::castMap)
                .toList();
    }

    private static Map<String, Object> statusBadge(Map<String, Object> screen) {
        return nodesOfType(screen, "badge").stream()
                .filter(node -> "runStatus".equals(node.get("id")))
                .findFirst()
                .orElseThrow();
    }

    private static List<Map<String, Object>> stopButton(Map<String, Object> screen) {
        return nodesOfType(screen, "icon_button").stream()
                .filter(node -> ChatScreen.STOP_ID.equals(node.get("id")))
                .toList();
    }

    private static Map<String, Object> button(Map<String, Object> screen, String label) {
        return nodesOfType(screen, "button").stream()
                .filter(node -> label.equals(node.get("label")))
                .findFirst()
                .orElseThrow();
    }

    private static void collectIds(Object fragment, List<String> ids) {
        walk(fragment, node -> {
            Object id = node.get("id");
            if (id instanceof String text) {
                ids.add(text);
            }
        });
    }

    private static List<Map<String, Object>> nodesOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            seen.accept(typed);
            for (Object value : map.values()) {
                walk(value, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object value : list) {
                walk(value, seen);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}