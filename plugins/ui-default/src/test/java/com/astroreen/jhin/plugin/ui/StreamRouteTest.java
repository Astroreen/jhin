/**
 * Stream route behaviour: the frame translation of every event kind (the
 * level-4 {@code {id, html}} envelopes of docs/sdui.md section 5), the
 * delta batching of {@code text_delta}, the structured tool cards, the live
 * forwarder, the preamble race de-duplication and the
 * {@code unknown_session} / {@code invalid_request} failure codes. The route
 * runs on a fixed clock so the delta flush window is deterministic.
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
        // a fixed clock: the delta flush window never elapses mid-test, so
        // batching is decided by the event kinds alone
        route = new StreamRoute(store, eventLog, streams, () -> 1_000L);
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

        // 10 events -> 8 frames: the two text_deltas coalesce into the single
        // message_end patch (delta batching, T205)
        assertThat(frames).hasSize(8);
        // user_message -> the message:user row on the message surface.
        Map<String, Object> user = payload(frames.get(0), "node");
        assertThat(user.get("id")).isEqualTo("ev-1");
        assertThat(String.valueOf(user.get("html")))
                .contains("data-jhin-id=\"ev-1\"").contains("hi");
        // message_start -> the message:assistant row with the msg patch target.
        Map<String, Object> assistant = payload(frames.get(1), "node");
        assertThat(assistant.get("id")).isEqualTo("ev-2");
        assertThat(String.valueOf(assistant.get("html"))).contains("data-jhin-id=\"msg-2\"");
        // text_delta x2 + message_end -> one patch of the complete message.
        Map<String, Object> grown = payload(frames.get(2), "patch");
        assertThat(grown.get("id")).isEqualTo("msg-2");
        assertThat(String.valueOf(grown.get("html"))).contains("<p>Hello</p>");
        // run_start -> the working row; run_end -> the remove of that row.
        Map<String, Object> working = payload(frames.get(3), "node");
        assertThat(working.get("id")).isEqualTo("ev-6");
        assertThat(String.valueOf(working.get("html"))).contains("agent is working");
        assertThat(frames.get(4)).containsExactly(Map.entry("remove", "ev-6"));
        // tool events -> work:log rows with the collapsible sections.
        Map<String, Object> toolUse = payload(frames.get(5), "node");
        assertThat(toolUse.get("id")).isEqualTo("ev-8");
        assertThat(String.valueOf(toolUse.get("html"))).contains("read");
        Map<String, Object> toolResult = payload(frames.get(6), "node");
        assertThat(toolResult.get("id")).isEqualTo("ev-9");
        assertThat(String.valueOf(toolResult.get("html"))).contains("done");
        // error -> the event:error row in the danger tone.
        Map<String, Object> error = payload(frames.get(7), "node");
        assertThat(error.get("id")).isEqualTo("ev-10");
        assertThat(String.valueOf(error.get("html"))).contains("boom");
        // no frame carries a level-3 payload key
        assertThat(Json.write(frames)).doesNotContain("\"props\"");
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
        Map<String, Object> first = payload(frames.get(0), "node");
        String firstHtml = String.valueOf(first.get("html"));
        assertThat(firstHtml).contains("read result").contains("raw");
        assertThat(firstHtml).doesNotContain("path: /a");

        Map<String, Object> failed = payload(frames.get(1), "node");
        assertThat(String.valueOf(failed.get("html")))
                .contains("plain text").contains("bash result");
    }

    @Test
    void unknownWireEventFallsBackToTheUnknownRow() {
        EventFrames.Translator translator = new EventFrames.Translator();

        List<Map<String, Object>> frames = translator.frames("holo", "{\"text\":\"?\"}", 7);

        assertThat(frames).hasSize(1);
        Map<String, Object> row = payload(frames.get(0), "node");
        assertThat(String.valueOf(row.get("html"))).contains("Unknown row: holo");
    }

    @Test
    void liveEventsAreTranslatedByTheForwarder() {
        open("");

        eventLog.append(sessionId, EventType.MESSAGE_START, json("role", "assistant"));
        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "Hel"));
        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "lo"));
        eventLog.append(sessionId, EventType.MESSAGE_END, json("text", "Hello"));

        List<com.astroreen.jhin.sdk.stream.StreamEvent> published =
                streams.publishedOn("ui/frames/" + sessionId);
        // the open row plus one batched patch — the deltas never each become
        // a frame
        assertThat(published).hasSize(2);
        Map<String, Object> first = castMap(published.get(0).payload());
        assertThat(payload(first, "node").get("id")).isEqualTo("ev-1");
        assertThat(String.valueOf(payload(first, "node").get("html")))
                .contains("data-jhin-id=\"msg-1\"");
        Map<String, Object> last = castMap(published.get(1).payload());
        assertThat(payload(last, "patch").get("id")).isEqualTo("msg-1");
        assertThat(String.valueOf(payload(last, "patch").get("html")))
                .contains("<p>Hello</p>");
    }

    @Test
    void forwarderSeedsItsStateFromThePersistedHistory() {
        eventLog.append(sessionId, EventType.MESSAGE_START, json("role", "assistant"));
        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "Hello "));
        open("");

        eventLog.append(sessionId, EventType.TEXT_DELTA, json("text", "world"));
        eventLog.append(sessionId, EventType.MESSAGE_END, json("text", "Hello world"));

        List<com.astroreen.jhin.sdk.stream.StreamEvent> published =
                streams.publishedOn("ui/frames/" + sessionId);
        assertThat(published).hasSize(1);
        Map<String, Object> frame = castMap(published.get(0).payload());
        assertThat(payload(frame, "patch").get("id")).isEqualTo("msg-1");
        assertThat(String.valueOf(payload(frame, "patch").get("html")))
                .contains("<p>Hello world</p>");
    }

    @Test
    void preambleSkipsRowsAlreadyObservedLive() throws Exception {
        eventLog.append(sessionId, EventType.USER_MESSAGE, json("text", "one"));
        HttpResponse response = open("");
        assertThat(response.status()).isEqualTo(200);

        eventLog.append(sessionId, EventType.USER_MESSAGE, json("text", "two"));

        List<Map<String, Object>> frames = lastPreamble();
        assertThat(frames).hasSize(1);
        assertThat(String.valueOf(payload(frames.get(0), "node").get("html"))).contains("one");
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
        assertThat(String.valueOf(payload(frames.get(0), "node").get("html"))).contains("two");
        assertThat(String.valueOf(payload(frames.get(1), "node").get("html"))).contains("three");
    }

    @Test
    void sessionUpdatedReplayBecomesARowPatchFrame() throws Exception {
        eventLog.append(sessionId, EventType.SESSION_UPDATED, Json.write(store.get(sessionId).orElseThrow()));

        open("");
        List<Map<String, Object>> frames = lastPreamble();

        assertThat(frames).hasSize(1);
        Map<String, Object> patch = payload(frames.get(0), "patch");
        assertThat(patch).containsOnlyKeys("id", "html");
        assertThat(patch.get("id")).isEqualTo("session-row:" + sessionId);
        assertThat(String.valueOf(patch.get("html"))).contains("demo").contains("/tmp/work");
    }

    @Test
    void liveSessionUpdatedBecomesARowPatchFrame() {
        open("");

        eventLog.append(sessionId, EventType.SESSION_UPDATED, Json.write(store.get(sessionId).orElseThrow()));

        List<com.astroreen.jhin.sdk.stream.StreamEvent> published =
                streams.publishedOn("ui/frames/" + sessionId);
        assertThat(published).hasSize(1);
        Map<String, Object> frame = castMap(published.get(0).payload());
        assertThat(payload(frame, "patch").get("id")).isEqualTo("session-row:" + sessionId);
        assertThat(String.valueOf(payload(frame, "patch").get("html"))).contains("demo");
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
        assertThat(payload(frame, "patch").get("id")).isEqualTo("session-row:" + sessionId);
        assertThat(String.valueOf(payload(frame, "patch").get("html"))).contains("demo");
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

    /** The payload object of one frame shape. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> payload(Map<String, Object> frame, String shape) {
        return (Map<String, Object>) frame.get(shape);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
