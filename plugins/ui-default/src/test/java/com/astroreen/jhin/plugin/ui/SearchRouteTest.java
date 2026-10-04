/**
 * The palette search endpoint (T69): {@code POST /ui/action/search} over
 * session titles and the {@code user_message} / {@code message_end} payloads.
 *
 * <p>Cases: a title hit, a user_message hit, a message_end hit, a
 * one-character query answering an empty list, a blank/non-string query
 * staying safe, case-insensitive matching and a malformed body rejected with
 * {@code 400} — never {@code 500}.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SearchRouteTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private EventLog events;
    private SearchRoute route;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        store = services.find(SessionStore.class).orElseThrow();
        events = services.find(EventLog.class).orElseThrow();
        route = new SearchRoute(store, events);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void titleHitAnswersASessionEntryNavigatingToTheChat() {
        Session session = store.create("Fix the widget bug", "/tmp/work");

        Map<String, Object> body = search("widget");

        assertThat(results(body)).hasSize(1);
        Map<String, Object> hit = results(body).get(0);
        assertThat(hit).containsEntry("id", session.id())
                .containsEntry("title", "Fix the widget bug")
                .containsEntry("kind", "session");
        assertThat(asMap(hit.get("action")))
                .containsEntry("op", "navigate")
                .containsEntry("screen", "chat:" + session.id());
    }

    @Test
    void userMessageHitAnswersAMessageEntry() {
        Session session = store.create("Notes", "/tmp/work");
        events.append(session.id(), EventType.USER_MESSAGE,
                Json.write(Map.of("text", "please fix the widget today")));

        Map<String, Object> body = search("widget");

        assertThat(results(body)).hasSize(1);
        Map<String, Object> hit = results(body).get(0);
        assertThat(hit).containsEntry("kind", "user_message")
                .containsEntry("title", "please fix the widget today");
        assertThat(asMap(hit.get("action")))
                .containsEntry("screen", "chat:" + session.id());
    }

    @Test
    void messageEndHitAnswersAMessageEntry() {
        Session session = store.create("Notes", "/tmp/work");
        events.append(session.id(), EventType.MESSAGE_END,
                Json.write(Map.of("text", "the widget is fixed")));

        Map<String, Object> body = search("widget");

        assertThat(results(body)).hasSize(1);
        Map<String, Object> hit = results(body).get(0);
        assertThat(hit).containsEntry("kind", "message_end")
                .containsEntry("title", "the widget is fixed");
        assertThat(asMap(hit.get("action")))
                .containsEntry("screen", "chat:" + session.id());
    }

    @Test
    void oneCharacterQueryAnswersAnEmptyList() {
        store.create("Fix the widget bug", "/tmp/work");

        Map<String, Object> body = search("w");

        assertThat(results(body)).isEmpty();
    }

    @Test
    void blankAndNonStringQueriesStaySafeAndEmpty() {
        store.create("Fix the widget bug", "/tmp/work");

        HttpResponse blank = route.handle(new FakeHttpRequest(
                "POST", "/ui/action/search", Map.of(), Map.of(), ""));
        assertThat(blank.status()).isEqualTo(200);
        assertThat(results(Json.readMap(new String(blank.body())))).isEmpty();

        HttpResponse whitespace = route.handle(new FakeHttpRequest(
                "POST", "/ui/action/search", Map.of(), Map.of(), "{\"query\": \"   \"}"));
        assertThat(whitespace.status()).isEqualTo(200);
        assertThat(results(Json.readMap(new String(whitespace.body())))).isEmpty();

        HttpResponse nonString = route.handle(new FakeHttpRequest(
                "POST", "/ui/action/search", Map.of(), Map.of(), "{\"query\": 7}"));
        assertThat(nonString.status()).isEqualTo(200);
        assertThat(results(Json.readMap(new String(nonString.body())))).isEmpty();
    }

    @Test
    void matchingIsCaseInsensitive() {
        store.create("Fix the Widget bug", "/tmp/work");

        Map<String, Object> body = search("WIDGET");

        assertThat(results(body)).hasSize(1);
    }

    @Test
    void malformedBodyIsRejectedWith400() {
        HttpResponse response = route.handle(new FakeHttpRequest(
                "POST", "/ui/action/search", Map.of(), Map.of(), "not-json"));

        assertThat(response.status()).isEqualTo(400);
        assertThat(new String(response.body())).contains("body");
    }

    @Test
    void unrelatedEventKindsAreNotSearched() {
        Session session = store.create("Notes", "/tmp/work");
        events.append(session.id(), EventType.TEXT_DELTA,
                Json.write(Map.of("text", "widget")));

        Map<String, Object> body = search("widget");

        assertThat(results(body)).isEmpty();
    }

    private Map<String, Object> search(String query) {
        HttpResponse response = route.handle(new FakeHttpRequest(
                "POST", "/ui/action/search", Map.of(), Map.of(),
                Json.write(Map.of("query", query))));
        assertThat(response.status()).isEqualTo(200);
        return Json.readMap(new String(response.body()));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> results(Map<String, Object> body) {
        return (List<Map<String, Object>>) body.get("results");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        return (Map<String, Object>) value;
    }
}