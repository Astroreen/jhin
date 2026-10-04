/**
 * T69 QA evidence: dumps representative {@code POST /ui/action/search}
 * answers into the module build directory for {@code scripts/qa/t69.sh} to
 * copy and jq-assert — a title hit, a user_message hit, a message_end hit,
 * a one-character query and a blank query. Not an assertion suite itself
 * ({@link SearchRouteTest} already asserts the shapes); this only captures
 * the wire bytes a live server would answer with.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SearchEvidenceTest {

    /** Relative to the module's test-task working directory (the module dir). */
    private static final Path EVIDENCE_DIR = Path.of("build", "evidence-t69");

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private EventLog events;
    private SearchRoute route;
    private String sessionId;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        SessionStore store = services.find(SessionStore.class).orElseThrow();
        events = services.find(EventLog.class).orElseThrow();
        route = new SearchRoute(store, events);
        Session session = store.create("Fix the widget bug", "/tmp/work");
        sessionId = session.id();
        events.append(sessionId, EventType.USER_MESSAGE,
                Json.write(Map.of("text", "please fix the widget today")));
        events.append(sessionId, EventType.MESSAGE_END,
                Json.write(Map.of("text", "the widget is fixed")));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void dumpsSearchResponseSamples() throws IOException {
        Map<String, Object> samples = new LinkedHashMap<>();
        samples.put("titleHit", search("bug"));
        samples.put("userMessageHit", search("please"));
        samples.put("messageEndHit", search("fixed"));
        samples.put("shortQuery", search("b"));
        samples.put("blankQuery", search(""));
        Files.createDirectories(EVIDENCE_DIR);
        Files.writeString(EVIDENCE_DIR.resolve("search.json"), Json.write(samples));
    }

    private Map<String, Object> search(String query) {
        HttpResponse response = route.handle(new FakeHttpRequest(
                "POST", "/ui/action/search", Map.of(), Map.of(),
                Json.write(Map.of("query", query))));
        Map<String, Object> body = Json.readMap(new String(response.body()));
        Map<String, Object> sample = new LinkedHashMap<>();
        sample.put("request", Map.of("query", query));
        sample.put("status", response.status());
        sample.put("response", body);
        return sample;
    }
}