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
        assertThat(nodeType(frames.get(0))).isEqualTo("text");
        assertThat(nodeOf(frames.get(0)).get("text")).isEqualTo("hi");
        assertThat(nodeOf(frames.get(0)).get("bold")).isEqualTo(true);
        assertThat(nodeOf(frames.get(1)).get("id")).isEqualTo("msg-2");
        assertThat(patchOf(frames.get(2)).get("id")).isEqualTo("msg-2");
        assertThat(castMap(patchOf(frames.get(2)).get("props"))).containsEntry("text", "Hel");
        assertThat(castMap(patchOf(frames.get(3)).get("props"))).containsEntry("text", "Hello");
        assertThat(castMap(patchOf(frames.get(4)).get("props"))).containsEntry("text", "Hello");
        assertThat(nodeOf(frames.get(5)).get("text")).isEqualTo("Run started");
        assertThat(nodeOf(frames.get(6)).get("text")).isEqualTo("Run finished");
        assertThat(nodeType(frames.get(7))).isEqualTo("card");
        assertThat(nodeOf(frames.get(7)).get("title")).isEqualTo("read");
        assertThat(nodeType(frames.get(8))).isEqualTo("card");
        assertThat(nodeType(frames.get(9))).isEqualTo("card");
        assertThat(nodeOf(frames.get(9)).get("title")).isEqualTo("Error");
        assertThat(Json.write(nodeOf(frames.get(9)))).contains("#E53935");
    }

    @Test
    void toolResultRendersTheStructuredCardFamily() throws Exception {
        eventLog.append(sessionId, EventType.TOOL_RESULT, Json.write(Map.of(
                "id", "c1", "name", "read", "content", "raw", "error", false,
                "structured", "{\"kind\":\"card\",\"title\":\"File\",\"rows\":[{\"label\":\"path\",\"value\":\"/a\"}]}")));
        eventLog.append(sessionId, EventType.TOOL_RESULT, Json.write(Map.of(
                "id", "c2", "name", "read", "content", "raw",
                "structured", "{\"kind\":\"image\",\"title\":\"Shot\",\"mimeType\":\"image/png\",\"data\":\"aGk=\"}")));
        eventLog.append(sessionId, EventType.TOOL_RESULT, Json.write(Map.of(
                "id", "c3", "name", "bash", "content", "plain text", "error", true)));

        open("");
        List<Map<String, Object>> frames = lastPreamble();

        Map<String, Object> card = nodeOf(frames.get(0));
        assertThat(card).containsEntry("title", "File");
        List<Object> children = castList(card.get("children"));
        assertThat(Json.write(children.get(0))).contains("path: /a");

        Map<String, Object> imageCard = nodeOf(frames.get(1));
        assertThat(imageCard).containsEntry("title", "Shot");
        String imageJson = Json.write(castList(imageCard.get("children")).get(0));
        assertThat(imageJson).contains("data:image/png;base64,aGk=");

        Map<String, Object> plain = nodeOf(frames.get(2));
        assertThat(plain).containsEntry("title", "bash");
        assertThat(Json.write(castList(plain.get("children")).get(0)))
                .contains("plain text").contains("#E53935");
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
        assertThat(nodeOf(first).get("id")).isEqualTo("msg-1");
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
        assertThat(nodeOf(frames.get(0)).get("text")).isEqualTo("one");
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
        assertThat(nodeOf(frames.get(0)).get("text")).isEqualTo("two");
        assertThat(nodeOf(frames.get(1)).get("text")).isEqualTo("three");
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

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}
