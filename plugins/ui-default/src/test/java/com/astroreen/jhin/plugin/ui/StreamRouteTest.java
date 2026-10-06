/**
 * Stream route behaviour: the frame translation of every event kind, the
 * structured tool cards, the live forwarder, the preamble race
 * de-duplication and the {@code unknown_session} / {@code invalid_request}
 * failure codes.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import com.astroreen.jhin.sdk.stream.SseWriter;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class StreamRouteTest {

    /** Preamble writer collecting the frames a connection would see. */
    static final class RecordingSseWriter implements SseWriter {

        private final List<Map<String, Object>> frames = new ArrayList<>();

        @Override
        public void event(String type, Object payload) throws IOException {
            assertThat(type).isEqualTo(EventFrames.FRAME_EVENT);
            assertThat(payload).isInstanceOf(Map.class);
            frames.add(castMap(payload));
        }

        List<Map<String, Object>> frames() {
            return frames;
        }
    }

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private RecordingStreamRegistry streams;
    private EventLog eventLog;
    private SessionStore store;
    private StreamRoute route;
    private String sessionId;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        eventLog = services.find(EventLog.class).orElseThrow();
        store = services.find(SessionStore.class).orElseThrow();
        route = new StreamRoute(store, eventLog, streams);
        sessionId = store.create("demo", "/tmp/work").id();
    }

    @AfterEach
    void tearDown() {
        route.shutdown();
        db.close();
    }

    @Test
    void unknownSessionIs404AndOpensNoStream() {
        HttpResponse response = route.handle(request("nope", ""));

        assertThat(response.status()).isEqualTo(404);
        assertThat(new String(response.body())).contains("unknown_session");
        assertThat(streams.sseRequests()).isEmpty();
    }

    @Test
    void malformedFromSeqIs400NamingFromSeq() {
        HttpResponse response = route.handle(request(sessionId, "fromSeq=abc"));

        assertThat(response.status()).isEqualTo(400);
        assertThat(new String(response.body())).contains("fromSeq");
        assertThat(streams.sseRequests()).isEmpty();
    }

    @Test
    void replayTranslatesEveryEventKind() throws Exception {
        eventLog.append(sessionId, EventType.USER_MESSAGE, json("text", "hi"));
        eventLog.append(sessionId, EventType.MESSAGE_START, json("role", "assistant"));
        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "Hel"));
        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "lo"));
        eventLog.append(sessionId, EventType.MESSAGE_END, json("text", "Hello"));
        eventLog.append(sessionId, EventType.RUN_START, json("runId", "r1"));
        eventLog.append(sessionId, EventType.RUN_END, json("runId", "r1"));
        eventLog.append(sessionId, EventType.TOOL_USE, Json.write(Map.of("id", "c1", "name", "read")));
        eventLog.append(sessionId, EventType.TOOL_RESULT,
                Json.write(Map.of("id", "c1", "name", "read", "content", "done", "error", false)));
        eventLog.append(sessionId, EventType.ERROR, json("message", "boom"));

        open("");
        List<Map<String, Object>> frames = lastPreamble();

        assertThat(frames).hasSize(10);
        // user_message -> the message:user row on the message surface.
        Map<String, Object> user = nodeOf(frames.get(0));
        assertThat(user).containsEntry("rowKind", "message").containsEntry("rowKey", "message:user");
        assertThat(Json.write(user)).contains("$color.message").contains("hi");
        // message_start -> the message:assistant row with the msg patch target.
        Map<String, Object> assistant = nodeOf(frames.get(1));
        assertThat(assistant).containsEntry("rowKind", "message").containsEntry("rowKey", "message:assistant");
        assertThat(assistant.get("id")).isEqualTo("ev-2");
        assertThat(Json.write(assistant)).contains("\"id\":\"msg-2\"");
        assertThat(patchOf(frames.get(2)).get("id")).isEqualTo("msg-2");
        assertThat(castMap(patchOf(frames.get(2)).get("props"))).containsEntry("text", "Hel");
        assertThat(castMap(patchOf(frames.get(3)).get("props"))).containsEntry("text", "Hello");
        assertThat(castMap(patchOf(frames.get(4)).get("props"))).containsEntry("text", "Hello");
        // run_start -> the working row; run_end -> the remove of that row.
        Map<String, Object> working = nodeOf(frames.get(5));
        assertThat(working).containsEntry("rowKind", "working").containsEntry("rowKey", "working:run");
        assertThat(Json.write(working)).contains("agent is working");
        assertThat(frames.get(6)).containsEntry("remove", "ev-6");
        // tool events -> work:log rows with the collapsible sections.
        Map<String, Object> toolUse = nodeOf(frames.get(7));
        assertThat(toolUse).containsEntry("rowKind", "work").containsEntry("rowKey", "work:log");
        assertThat(Json.write(toolUse)).contains("read").contains("\"collapsed\":true");
        Map<String, Object> toolResult = nodeOf(frames.get(8));
        assertThat(toolResult).containsEntry("rowKind", "work").containsEntry("rowKey", "work:log");
        assertThat(Json.write(toolResult)).contains("done");
        // error -> the event:error row in the danger tone.
        Map<String, Object> error = nodeOf(frames.get(9));
        assertThat(error).containsEntry("rowKind", "event").containsEntry("rowKey", "event:error");
        assertThat(Json.write(error)).contains("$color.error").contains("boom");
    }

    @Test
    void toolResultRendersTheWorkRowDetail() throws Exception {
        eventLog.append(sessionId, EventType.TOOL_RESULT, Json.write(Map.of(
                "id", "c1", "name", "read", "content", "raw", "error", false,
                "structured", "{\"kind\":\"card\",\"title\":\"File\",\"rows\":[{\"label\":\"path\",\"value\":\"/a\"}]}")));
        eventLog.append(sessionId, EventType.TOOL_RESULT, Json.write(Map.of(
                "id", "c3", "name", "bash", "content", "plain text", "error", true)));

        open("");
        List<Map<String, Object>> frames = lastPreamble();

        // The structured payload is T102 scope: the T101 work row renders the
        // plain content detail inside the collapsible section.
        Map<String, Object> first = nodeOf(frames.get(0));
        assertThat(first).containsEntry("rowKind", "work");
        String firstJson = Json.write(first);
        assertThat(firstJson).contains("read result").contains("raw");
        assertThat(firstJson).doesNotContain("path: /a");

        Map<String, Object> failed = nodeOf(frames.get(1));
        assertThat(failed).containsEntry("rowKind", "work");
        assertThat(Json.write(failed))
                .contains("plain text").contains("$color.error");
    }

    @Test
    void unknownWireEventFallsBackToTheUnknownRow() throws Exception {
        EventFrames.Translator translator = new EventFrames.Translator();
        Map<String, Object> frame = translator.frame("holo", "{\"text\":\"?\"}", 7);

        Map<String, Object> row = nodeOf(frame);
        assertThat(row).containsEntry("rowKind", "unknown").containsEntry("rowKey", "unknown:unknown");
        assertThat(Json.write(row)).contains("Unknown row: holo");
    }

    @Test
    void liveEventsAreTranslatedByTheForwarder() {
        open("");

        eventLog.append(sessionId, EventType.MESSAGE_START, json("role", "assistant"));
        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "Hel"));
        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "lo"));

        List<com.astroreen.jhin.sdk.stream.StreamEvent> published =
                streams.publishedOn("ui/frames/" + sessionId);
        assertThat(published).hasSize(3);
        Map<String, Object> first = castMap(published.get(0).payload());
        assertThat(nodeOf(first).get("id")).isEqualTo("ev-1");
        assertThat(Json.write(nodeOf(first))).contains("\"id\":\"msg-1\"");
        Map<String, Object> last = castMap(published.get(2).payload());
        assertThat(castMap(patchOf(last).get("props"))).containsEntry("text", "Hello");
    }

    @Test
    void forwarderSeedsItsStateFromThePersistedHistory() {
        eventLog.append(sessionId, EventType.MESSAGE_START, json("role", "assistant"));
        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "Hello "));
        open("");

        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "world"));

        List<com.astroreen.jhin.sdk.stream.StreamEvent> published =
                streams.publishedOn("ui/frames/" + sessionId);
        assertThat(published).hasSize(1);
        Map<String, Object> frame = castMap(published.get(0).payload());
        assertThat(castMap(patchOf(frame).get("props"))).containsEntry("text", "Hello world");
    }

    @Test
    void preambleSkipsRowsAlreadyObservedLive() throws Exception {
        eventLog.append(sessionId, EventType.USER_MESSAGE, json("text", "one"));
        HttpResponse response = open("");
        assertThat(response.status()).isEqualTo(200);

        eventLog.append(sessionId, EventType.USER_MESSAGE, json("text", "two"));

        List<Map<String, Object>> frames = lastPreamble();
        assertThat(frames).hasSize(1);
        assertThat(childText(frames.get(0))).isEqualTo("one");
        assertThat(streams.publishedOn("ui/frames/" + sessionId)).hasSize(1);
    }

    @Test
    void fromSeqBoundsTheReplay() throws Exception {
        eventLog.append(sessionId, EventType.USER_MESSAGE, json("text", "one"));
        eventLog.append(sessionId, EventType.USER_MESSAGE, json("text", "two"));
        eventLog.append(sessionId, EventType.USER_MESSAGE, json("text", "three"));

        HttpResponse response = open("fromSeq=1");
        assertThat(response.status()).isEqualTo(200);
        assertThat(streams.sseRequests().get(0).topic()).isEqualTo("ui/frames/" + sessionId);

        List<Map<String, Object>> frames = lastPreamble();
        assertThat(frames).hasSize(2);
        assertThat(childText(frames.get(0))).isEqualTo("two");
        assertThat(childText(frames.get(1))).isEqualTo("three");
    }

    @Test
    void sessionUpdatedReplayBecomesARowPatchFrame() throws Exception {
        eventLog.append(sessionId, EventType.SESSION_UPDATED, Json.write(store.get(sessionId).orElseThrow()));

        open("");
        List<Map<String, Object>> frames = lastPreamble();

        assertThat(frames).hasSize(1);
        assertThat(patchOf(frames.get(0)).get("id")).isEqualTo("session-row:" + sessionId);
        Map<String, Object> props = castMap(patchOf(frames.get(0)).get("props"));
        assertThat(props).containsEntry("title", "demo");
        assertThat(props).containsKey("pinned");
        assertThat(props).containsKey("settledAt");
    }

    @Test
    void liveSessionUpdatedBecomesARowPatchFrame() {
        open("");

        eventLog.append(sessionId, EventType.SESSION_UPDATED, Json.write(store.get(sessionId).orElseThrow()));

        List<com.astroreen.jhin.sdk.stream.StreamEvent> published =
                streams.publishedOn("ui/frames/" + sessionId);
        assertThat(published).hasSize(1);
        Map<String, Object> frame = castMap(published.get(0).payload());
        assertThat(patchOf(frame).get("id")).isEqualTo("session-row:" + sessionId);
        assertThat(castMap(patchOf(frame).get("props"))).containsEntry("title", "demo");
    }

    @Test
    void overviewStreamBroadcastsRowPatchesOnly() {
        HttpResponse response = route.handleOverview(new FakeHttpRequest("GET",
                "/ui/stream/sessions-overview", Map.of(), Map.of(), ""));
        assertThat(response.status()).isEqualTo(200);
        assertThat(streams.sseRequests().get(streams.sseRequests().size() - 1).topic())
                .isEqualTo("ui/frames/sessions-overview");

        eventLog.append(sessionId, EventType.SESSION_UPDATED, Json.write(store.get(sessionId).orElseThrow()));
        eventLog.append(sessionId, EventType.USER_MESSAGE, json("text", "ignored"));

        List<com.astroreen.jhin.sdk.stream.StreamEvent> published =
                streams.publishedOn("ui/frames/sessions-overview");
        assertThat(published).hasSize(1);
        Map<String, Object> frame = castMap(published.get(0).payload());
        assertThat(published.get(0).type()).isEqualTo(EventFrames.FRAME_EVENT);
        assertThat(patchOf(frame).get("id")).isEqualTo("session-row:" + sessionId);
        assertThat(castMap(patchOf(frame).get("props"))).containsEntry("title", "demo");
    }

    /** Opens the stream endpoint for the session under test. */
    private HttpResponse open(String query) {
        return route.handle(request(sessionId, query));
    }

    /** Replays the preamble of the most recent SSE request into a writer. */
    private List<Map<String, Object>> lastPreamble() throws Exception {
        List<RecordingStreamRegistry.SseRequest> requests = streams.sseRequests();
        assertThat(requests).isNotEmpty();
        RecordingSseWriter writer = new RecordingSseWriter();
        requests.get(requests.size() - 1).preamble().write(writer);
        return writer.frames();
    }

    private static FakeHttpRequest request(String sessionId, String query) {
        Map<String, List<String>> parsed = new LinkedHashMap<>();
        if (!query.isBlank()) {
            String[] parts = query.split("=", 2);
            parsed.put(parts[0], List.of(parts[1]));
        }
        return new FakeHttpRequest("GET", "/ui/stream/session/" + sessionId,
                Map.of("id", sessionId), parsed, "");
    }

    /** One JSON object with a single string field. */
    private static String json(String key, String value) {
        return Json.write(Map.of(key, value));
    }

    private static Map<String, Object> nodeOf(Map<String, Object> frame) {
        return castMap(frame.get("node"));
    }

    private static Map<String, Object> patchOf(Map<String, Object> frame) {
        return castMap(frame.get("patch"));
    }

    private static String nodeType(Map<String, Object> frame) {
        return String.valueOf(nodeOf(frame).get("type"));
    }

    /** The text of the first text descendant of a node frame (row shorthand). */
    private static String childText(Map<String, Object> frame) {
        return deepText(nodeOf(frame));
    }

    /** The first {@code text} prop found depth-first under the node. */
    private static String deepText(Map<String, Object> node) {
        Object text = node.get("text");
        if (text instanceof String value) {
            return value;
        }
        for (Object child : castList(node.get("children"))) {
            if (child instanceof Map<?, ?> map) {
                String found = deepText(castMap(child));
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
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
