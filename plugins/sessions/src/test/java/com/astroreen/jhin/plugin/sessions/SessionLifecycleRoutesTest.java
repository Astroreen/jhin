/**
 * Lifecycle route behaviour: the status-code matrix over the transition rules
 * ({@code 200} with the updated session, {@code 404 not_found},
 * {@code 409 invalid_transition}, {@code 400 invalid_request} and
 * {@code 503 title_service_unavailable}) with the exact JSON error codes.
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.TitleService;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionLifecycleRoutesTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private RecordingStreamRegistry streams;
    private FakeServiceRegistry services;
    private SessionLifecycleServiceImpl lifecycle;
    private SessionRoutes routes;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        store = new SessionStoreImpl(db);
        streams = new RecordingStreamRegistry();
        services = new FakeServiceRegistry();
        lifecycle = new SessionLifecycleServiceImpl(
                store, new EventLogImpl(db, streams), services,
                new UndoJournalImpl(store, new EventLogImpl(db, streams), 5000));
        routes = new SessionRoutes(store, lifecycle);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void settleReturns200WithTheUpdatedSession() {
        Session created = create("demo");

        HttpResponse response = post(created.id() + "/settle", Map.of("id", created.id()),
                "{\"reason\":\"inactive\"}");

        assertThat(response.status()).isEqualTo(200);
        Session updated = Json.read(response.body(), Session.class);
        assertThat(updated.settledAt()).isNotNull();
        assertThat(updated.settledReason()).isEqualTo("inactive");
    }

    @Test
    void settleWithoutReasonDefaultsToManual() {
        Session created = create("demo");

        HttpResponse response = post(created.id() + "/settle", Map.of("id", created.id()), "");

        assertThat(response.status()).isEqualTo(200);
        assertThat(Json.read(response.body(), Session.class).settledReason()).isEqualTo("manual");
    }

    @Test
    void unknownSessionIdsAnswer404NotFound() {
        HttpResponse response = post("nope/settle", Map.of("id", "nope"), "");
        assertThat(response.status()).isEqualTo(404);
        assertThat(errorCode(response)).isEqualTo("not_found");
    }

    @Test
    void settleOnAnArchivedSessionAnswers409InvalidTransition() {
        Session created = create("demo");
        post(created.id() + "/archive", Map.of("id", created.id()), "");

        HttpResponse response = post(created.id() + "/settle", Map.of("id", created.id()), "");

        assertThat(response.status()).isEqualTo(409);
        assertThat(errorCode(response)).isEqualTo("invalid_transition");
    }

    @Test
    void restoreOnAnUnarchivedSessionAnswers409InvalidTransition() {
        Session created = create("demo");

        HttpResponse response = post(created.id() + "/restore", Map.of("id", created.id()), "");

        assertThat(response.status()).isEqualTo(409);
        assertThat(errorCode(response)).isEqualTo("invalid_transition");
    }

    @Test
    void unsettleOnAnUnsettledSessionAnswers409InvalidTransition() {
        Session created = create("demo");

        HttpResponse response = post(created.id() + "/unsettle", Map.of("id", created.id()), "");

        assertThat(response.status()).isEqualTo(409);
        assertThat(errorCode(response)).isEqualTo("invalid_transition");
    }

    @Test
    void snoozeWithAPastTimestampAnswers400() {
        Session created = create("demo");

        HttpResponse response = post(created.id() + "/snooze", Map.of("id", created.id()),
                "{\"until\":1}");

        assertThat(response.status()).isEqualTo(400);
        assertThat(errorCode(response)).isEqualTo("invalid_request");
    }

    @Test
    void snoozeNeedsExactlyOneOfUntilAndDuration() {
        Session created = create("demo");
        Map<String, String> params = Map.of("id", created.id());

        assertThat(post(created.id() + "/snooze", params, "{}").status()).isEqualTo(400);
        assertThat(post(created.id() + "/snooze", params,
                "{\"until\":%d,\"durationMs\":1000}".formatted(System.currentTimeMillis() + 60_000))
                .status()).isEqualTo(400);
        assertThat(post(created.id() + "/snooze", params,
                "{\"durationMs\":-5}").status()).isEqualTo(400);
    }

    @Test
    void snoozeWithDurationAnswers200() {
        Session created = create("demo");

        HttpResponse response = post(created.id() + "/snooze", Map.of("id", created.id()),
                "{\"durationMs\":60000}");

        assertThat(response.status()).isEqualTo(200);
        assertThat(Json.read(response.body(), Session.class).snoozedUntil()).isNotNull();
    }

    @Test
    void pinAndUnpinAnswer200WithTheUpdatedSession() {
        Session created = create("demo");
        Map<String, String> params = Map.of("id", created.id());

        HttpResponse pinned = post(created.id() + "/pin", params, "{\"order\":4}");
        assertThat(pinned.status()).isEqualTo(200);
        Session withOrder = Json.read(pinned.body(), Session.class);
        assertThat(withOrder.pinned()).isTrue();
        assertThat(withOrder.pinnedOrder()).isEqualTo(4);

        HttpResponse unpinned = post(created.id() + "/unpin", params, "");
        assertThat(unpinned.status()).isEqualTo(200);
        Session cleared = Json.read(unpinned.body(), Session.class);
        assertThat(cleared.pinned()).isFalse();
        assertThat(cleared.pinnedOrder()).isNull();
    }

    @Test
    void pinWithAMalformedOrderAnswers400() {
        Session created = create("demo");

        HttpResponse response = post(created.id() + "/pin", Map.of("id", created.id()),
                "{\"order\":\"first\"}");

        assertThat(response.status()).isEqualTo(400);
        assertThat(errorCode(response)).isEqualTo("invalid_request");
    }

    @Test
    void wakeOnANonSnoozedSessionAnswers200Unchanged() {
        Session created = create("demo");
        long before = store.get(created.id()).orElseThrow().updatedAt();

        HttpResponse response = post(created.id() + "/wake", Map.of("id", created.id()), "");

        assertThat(response.status()).isEqualTo(200);
        Session session = Json.read(response.body(), Session.class);
        assertThat(session.snoozedUntil()).isNull();
        assertThat(session.updatedAt()).isEqualTo(before);
    }

    @Test
    void autoSettleNeedsABooleanEnabledField() {
        Session created = create("demo");
        Map<String, String> params = Map.of("id", created.id());

        assertThat(post(created.id() + "/auto-settle", params, "{}").status()).isEqualTo(400);
        HttpResponse ok = post(created.id() + "/auto-settle", params, "{\"enabled\":false}");
        assertThat(ok.status()).isEqualTo(200);
        assertThat(Json.read(ok.body(), Session.class).autoSettle()).isFalse();
    }

    @Test
    void reorderReturnsTheUpdatedSessionsInTheGivenOrder() {
        Session first = create("first");
        Session second = create("second");

        HttpResponse response = post("reorder", Map.of(),
                "{\"ids\":[\"%s\",\"%s\"]}".formatted(second.id(), first.id()));

        assertThat(response.status()).isEqualTo(200);
        assertThat(List.of(Json.read(response.body(), Session[].class)))
                .extracting(Session::id)
                .containsExactly(second.id(), first.id());
    }

    @Test
    void reorderAnswers400ForMalformedBodiesAnd404ForUnknownIds() {
        assertThat(post("reorder", Map.of(), "{}").status()).isEqualTo(400);
        assertThat(post("reorder", Map.of(), "{\"ids\":[]}").status()).isEqualTo(400);
        assertThat(post("reorder", Map.of(), "{\"ids\":[1,2]}").status()).isEqualTo(400);

        HttpResponse unknown = post("reorder", Map.of(), "{\"ids\":[\"nope\"]}");
        assertThat(unknown.status()).isEqualTo(404);
        assertThat(errorCode(unknown)).isEqualTo("not_found");
    }

    @Test
    void regenerateTitleAnswers503WithoutATitleService() {
        Session created = create("demo");

        HttpResponse response = post(created.id() + "/title", Map.of("id", created.id()), "");

        assertThat(response.status()).isEqualTo(503);
        assertThat(errorCode(response)).isEqualTo("title_service_unavailable");
    }

    @Test
    void regenerateTitleAnswers200WithATitleService() {
        Session created = create("demo");
        services.publish(TitleService.class,
                (TitleService) (session, history) -> "retitled");

        HttpResponse response = post(created.id() + "/title", Map.of("id", created.id()), "");

        assertThat(response.status()).isEqualTo(200);
        assertThat(Json.read(response.body(), Session.class).title()).isEqualTo("retitled");
    }

    private Session create(String title) {
        return store.create(title, "/tmp/" + title);
    }

    private HttpResponse post(String path, Map<String, String> params, String body) {
        HttpRequest request = new FakeHttpRequest("POST", "/sessions/" + path, params, Map.of(), body);
        return switch (path) {
            case "reorder" -> routes.reorder(request);
            default -> {
                String action = path.substring(path.indexOf('/') + 1);
                yield switch (action) {
                    case "settle" -> routes.settle(request);
                    case "unsettle" -> routes.unsettle(request);
                    case "pin" -> routes.pin(request);
                    case "unpin" -> routes.unpin(request);
                    case "snooze" -> routes.snooze(request);
                    case "wake" -> routes.wake(request);
                    case "archive" -> routes.archive(request);
                    case "restore" -> routes.restore(request);
                    case "auto-settle" -> routes.autoSettle(request);
                    case "title" -> routes.regenerateTitle(request);
                    default -> throw new IllegalArgumentException("unknown action: " + action);
                };
            }
        };
    }

    private static String errorCode(HttpResponse response) {
        return String.valueOf(Json.readMap(new String(response.body(), StandardCharsets.UTF_8)).get("error"));
    }
}
