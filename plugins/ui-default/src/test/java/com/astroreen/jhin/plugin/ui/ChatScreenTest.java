/**
 * The T77 chat redesign: the transcript renders user bubbles, assistant
 * bubbles, compact tool code blocks and collapsed tool result cards; the
 * composer carries the {@code messageInput} textarea, the {@code send} action
 * and the {@code composer.sendAndNew} command; Cancel appears only while a run
 * is live; malformed {@code tool_result} payloads degrade to a plain card and
 * {@code error} events hoist to banners at the top of the list.
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
    void fullRunTranscriptRendersUserAssistantToolCardAndAssistant() {
        Map<String, Object> json = render(fullRun());

        List<Map<String, Object>> items = messageItems(json);
        assertThat(items).hasSize(5);

        Map<String, Object> first = items.get(0);
        assertThat(first).containsEntry("type", "card")
                .containsEntry("id", "ev-2")
                .containsEntry("color", "$color.accentMuted")
                .containsEntry("align", "centerRight");
        assertThat(Json.write(first)).contains("Fix the bug");

        Map<String, Object> assistant = items.get(1);
        assertThat(assistant).containsEntry("type", "card").containsEntry("id", "ev-3");
        assertThat(Json.write(assistant)).contains("\"id\":\"msg-3\"").contains("Let me look.");

        Map<String, Object> toolUse = items.get(2);
        assertThat(toolUse).containsEntry("type", "code_block").containsEntry("id", "ev-7");
        assertThat(Json.write(toolUse)).contains("/tmp/a.txt").contains("hello world!");

        Map<String, Object> toolResult = items.get(3);
        assertThat(toolResult).containsEntry("type", "card").containsEntry("id", "ev-8");
        assertThat(toolResult).containsEntry("title", "write");
        assertThat(Json.write(toolResult)).contains("\"collapsed\":true").contains("bytes: 12");

        Map<String, Object> closing = items.get(4);
        assertThat(closing).containsEntry("type", "card").containsEntry("id", "ev-9");
        assertThat(Json.write(closing)).contains("\"id\":\"msg-9\"").contains("All done");
    }

    @Test
    void cancelButtonIsPresentOnlyWhileARunIsLive() {
        Map<String, Object> idle = render(List.of());
        Map<String, Object> running = render(List.of(
                event(1, EventType.RUN_START, "{\"runId\":\"r1\"}")));
        Map<String, Object> finished = render(List.of(
                event(1, EventType.RUN_START, "{\"runId\":\"r1\"}"),
                event(2, EventType.RUN_END, "{\"runId\":\"r1\"}")));
        Map<String, Object> failed = render(List.of(
                event(1, EventType.RUN_START, "{\"runId\":\"r1\"}"),
                event(2, EventType.ERROR, "{\"message\":\"boom\"}")));

        assertThat(labels(idle)).doesNotContain("Cancel");
        assertThat(labels(running)).contains("Cancel");
        assertThat(labels(finished)).doesNotContain("Cancel");
        assertThat(labels(failed)).doesNotContain("Cancel");

        assertThat(statusBadge(idle)).containsEntry("label", "Idle");
        assertThat(statusBadge(running)).containsEntry("label", "Running\u2026");
        assertThat(statusBadge(finished)).containsEntry("label", "Idle");
        assertThat(statusBadge(failed)).containsEntry("label", "Limited");
    }

    @Test
    void malformedToolResultDegradesToPlainCard() {
        Map<String, Object> json = render(List.of(
                event(1, EventType.TOOL_RESULT, Json.write(Map.of(
                        "id", "c1", "name", "bash", "content", "raw output",
                        "structured", "{{{ not json")))));

        List<Map<String, Object>> items = messageItems(json);
        assertThat(items).hasSize(1);
        Map<String, Object> card = items.get(0);
        assertThat(card).containsEntry("type", "card").containsEntry("title", "bash");
        assertThat(Json.write(card)).contains("raw output");
        assertThat(Json.write(card)).doesNotContain("collapsible");
    }

    @Test
    void unknownStructuredKindAlsoDegradesToPlainCard() {
        Map<String, Object> json = render(List.of(
                event(1, EventType.TOOL_RESULT, Json.write(Map.of(
                        "id", "c1", "name", "bash", "content", "raw output",
                        "structured", "{\"kind\":\"bogus\",\"title\":\"Nope\"}")))));

        Map<String, Object> card = messageItems(json).get(0);
        assertThat(card).containsEntry("type", "card");
        assertThat(Json.write(card)).contains("raw output").doesNotContain("collapsible");
    }

    @Test
    void errorEventsRenderBannersAtTheTopOfTheList() {
        Map<String, Object> json = render(List.of(
                event(1, EventType.USER_MESSAGE, "{\"text\":\"hello\"}"),
                event(2, EventType.ERROR, "{\"message\":\"boom\"}")));

        List<Map<String, Object>> items = messageItems(json);
        assertThat(items).hasSize(2);
        assertThat(items.get(0)).containsEntry("type", "banner").containsEntry("id", "ev-2");
        assertThat(Json.write(items.get(0))).contains("boom").contains("$color.error");
        assertThat(items.get(1)).containsEntry("type", "card").containsEntry("id", "ev-1");
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

        Map<String, Object> send = button(json, "Send");
        assertThat(send).containsEntry("icon", "send");
        Map<String, Object> action = castMap(send.get("action"));
        assertThat(action).containsEntry("name", "send")
                .containsEntry("path", "/ui/action/send")
                .containsEntry("method", "POST");
        assertThat(castList(action.get("include"))).containsExactly("messageInput");
        assertThat(castMap(action.get("payload"))).containsEntry("sessionId", SESSION_ID);

        Map<String, Object> fresh = nodesOfType(json, "icon_button").get(0);
        assertThat(fresh).containsEntry("command", "composer.sendAndNew");
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
        return castList(list.get("items")).stream()
                .map(ChatScreenTest::castMap)
                .toList();
    }

    private static Map<String, Object> statusBadge(Map<String, Object> screen) {
        return nodesOfType(screen, "badge").stream()
                .filter(node -> "runStatus".equals(node.get("id")))
                .findFirst()
                .orElseThrow();
    }

    private static Map<String, Object> button(Map<String, Object> screen, String label) {
        return nodesOfType(screen, "button").stream()
                .filter(node -> label.equals(node.get("label")))
                .findFirst()
                .orElseThrow();
    }

    private static List<String> labels(Map<String, Object> screen) {
        List<String> labels = new ArrayList<>();
        walk(screen, node -> {
            Object label = node.get("label");
            if (label instanceof String text) {
                labels.add(text);
            }
        });
        return labels;
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