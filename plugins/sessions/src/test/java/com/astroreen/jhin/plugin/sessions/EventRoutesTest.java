/**
 * Event route behaviour: replay semantics of {@code fromSeq}, the 404/400
 * failure contract, the preamble race de-duplication (each seq is written at
 * most once when the live buffer overlaps the replay window) and the QA
 * append helper.
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.SseWriter;
import com.astroreen.jhin.sdk.stream.Subscription;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class EventRoutesTest {

    /** Preamble writer collecting the frames a connection would see. */
    static final class RecordingSseWriter implements SseWriter {

        private final List<Map<String, Object>> frames = new ArrayList<>();

        @Override
        public void event(String type, Object payload) throws IOException {
            assertThat(type).isNotBlank();
            assertThat(payload).isInstanceOf(Map.class);
            frames.add(Map.copyOf((Map<String, Object>) payload));
        }

        List<Map<String, Object>> frames() {
            return frames;
        }
    }

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private RecordingStreamRegistry streams;
    private SessionStore store;
    private EventLog eventLog;
    private EventRoutes routes;
    private String sessionId;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        streams = new RecordingStreamRegistry();
        store = new SessionStoreImpl(db);
        eventLog = new EventLogImpl(db, streams);
        routes = new EventRoutes(store, eventLog, streams);
        sessionId = store.create("demo", "/tmp/demo").id();
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void unknownSessionIs404JsonAndOpensNoStream() {
        HttpResponse response = routes.stream(request("GET", "/sessions/nope/events",
                Map.of("id", "nope"), ""));

        assertThat(response.status()).isEqualTo(404);
        assertThat(new String(response.body())).contains("not_found");
        assertThat(streams.sseRequests()).isEmpty();
    }

    @Test
    void malformedFromSeqIs400NamingFromSeq() {
        for (String bad : new String[] {"abc", "-1", "", "1.5"}) {
            HttpResponse response = routes.stream(request("GET", "/sessions/" + sessionId + "/events",
                    Map.of("id", sessionId), "fromSeq=" + bad));
            assertThat(response.status()).isEqualTo(400);
            assertThat(new String(response.body())).contains("fromSeq");
        }
        assertThat(streams.sseRequests()).isEmpty();
    }

    @Test
    void replayWritesRowsAfterFromSeqInWireShape() throws Exception {
        for (int i = 1; i <= 3; i++) {
            eventLog.append(sessionId, EventType.TEXT_DELTA, "{\"n\":" + i + "}");
        }

        HttpResponse response = routes.stream(request("GET", "/sessions/" + sessionId + "/events",
                Map.of("id", sessionId), "fromSeq=1"));
        assertThat(response.status()).isEqualTo(200);
        assertThat(streams.sseRequests()).hasSize(1);
        assertThat(streams.sseRequests().get(0).topic()).isEqualTo("sessions/" + sessionId);

        RecordingSseWriter writer = new RecordingSseWriter();
        streams.sseRequests().get(0).preamble().write(writer);

        assertThat(writer.frames()).hasSize(2);
        assertThat(seqOf(writer.frames().get(0))).isEqualTo(2L);
        assertThat(seqOf(writer.frames().get(1))).isEqualTo(3L);
        assertThat(writer.frames().get(0)).containsEntry("type", "text_delta");
        assertThat(writer.frames().get(0)).containsEntry("payload", "{\"n\":2}");
    }

    @Test
    void liveBufferRacingTheReplayWindowWritesEachSeqOnce() throws Exception {
        for (int i = 1; i <= 3; i++) {
            eventLog.append(sessionId, EventType.TEXT_DELTA, "{\"n\":" + i + "}");
        }

        HttpResponse response = routes.stream(request("GET", "/sessions/" + sessionId + "/events",
                Map.of("id", sessionId), ""));
        assertThat(response.status()).isEqualTo(200);

        // kernel hand-off order: subscribe and buffer live events FIRST ...
        List<StreamEvent> buffer = new ArrayList<>();
        Subscription kernelBuffer = streams.subscribe(streams.sseRequests().get(0).topic(), buffer::add);

        // ... history grows while the buffer already runs (the preamble race) ...
        eventLog.append(sessionId, EventType.USER_MESSAGE, "{\"n\":4}");
        eventLog.append(sessionId, EventType.TEXT_DELTA, "{\"n\":5}");

        // ... then the preamble replays ...
        RecordingSseWriter writer = new RecordingSseWriter();
        streams.sseRequests().get(0).preamble().write(writer);

        // ... then the buffer is flushed and the live tail begins.
        for (StreamEvent event : buffer) {
            writer.event(event.type(), event.payload());
        }
        kernelBuffer.close();

        assertThat(writer.frames()).extracting(EventRoutesTest::seqOf)
                .containsExactly(1L, 2L, 3L, 4L, 5L);
    }

    @Test
    void replaySkipsRowsBeforeFromSeq() throws Exception {
        eventLog.append(sessionId, EventType.TEXT_DELTA, "{\"n\":1}");
        eventLog.append(sessionId, EventType.TEXT_DELTA, "{\"n\":2}");

        RecordingSseWriter writer = new RecordingSseWriter();
        routes.stream(request("GET", "/sessions/" + sessionId + "/events",
                Map.of("id", sessionId), "fromSeq=1"));
        streams.sseRequests().get(0).preamble().write(writer);
        assertThat(writer.frames()).extracting(EventRoutesTest::seqOf).containsExactly(2L);
    }

    @Test
    void qaAppenderWritesOneEventAndNamesTheOffendingField() {
        HttpResponse created = routes.appendOne(request("POST", "/sessions/" + sessionId + "/events",
                Map.of("id", sessionId), "", "{\"type\":\"text_delta\",\"payload\":{\"n\":1}}"));
        assertThat(created.status()).isEqualTo(201);
        assertThat(new String(created.body())).contains("text_delta");

        List<EventRecord> rows = eventLog.list(sessionId, 0);
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).type()).isEqualTo(EventType.TEXT_DELTA);
        assertThat(rows.get(0).payload()).isEqualTo("{\"n\":1}");

        HttpResponse unknownType = routes.appendOne(request("POST", "/sessions/" + sessionId + "/events",
                Map.of("id", sessionId), "", "{\"type\":\"nope\"}"));
        assertThat(unknownType.status()).isEqualTo(400);
        assertThat(new String(unknownType.body())).contains("type");

        HttpResponse missingType = routes.appendOne(request("POST", "/sessions/" + sessionId + "/events",
                Map.of("id", sessionId), "", "{}"));
        assertThat(missingType.status()).isEqualTo(400);
        assertThat(new String(missingType.body())).contains("type");

        HttpResponse unknownSession = routes.appendOne(request("POST", "/sessions/nope/events",
                Map.of("id", "nope"), "", "{\"type\":\"text_delta\"}"));
        assertThat(unknownSession.status()).isEqualTo(404);
        assertThat(new String(unknownSession.body())).contains("not_found");
    }

    private static FakeHttpRequest request(String method, String path, Map<String, String> params, String query) {
        return request(method, path, params, query, "");
    }

    private static FakeHttpRequest request(String method, String path, Map<String, String> params,
                                           String query, String body) {
        Map<String, List<String>> parsed = Map.of();
        if (!query.isBlank()) {
            int eq = query.indexOf('=');
            parsed = Map.of(query.substring(0, eq), List.of(query.substring(eq + 1)));
        }
        return new FakeHttpRequest(method, path, params, parsed, body);
    }

    private static long seqOf(Map<String, Object> frame) {
        return ((Number) frame.get("seq")).longValue();
    }
}
