/**
 * The two run routes: sessions-style validation (400 naming the field, 404
 * unknown session) and the typed run-lifecycle answers (202 with the run id,
 * 204 on cancel, 409 run_active, 404 no_active_run).
 */
package com.astroreen.jhin.plugin.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

class MessageRoutesTest {

    @TempDir
    Path work;

    private TestDbAccess db;
    private FakeSessionStore sessions;
    private MessageRoutes routes;
    private Session session;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(work);
        sessions = new FakeSessionStore();
        session = sessions.put(new Session("s1", "local", "test session", work.toString(),
                "test-model", "p1", "active", 1L, 1L));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void missingTextFieldIsA400NamingTheField() {
        routes = routes(ctx -> null);

        HttpResponse response = routes.messages(request("s1", "{}"));

        assertThat(response.status()).isEqualTo(400);
        assertThat(error(response)).containsEntry("error", "invalid_request")
                .containsEntry("message", "text is required");
    }

    @Test
    void unknownSessionIsA404() {
        routes = routes(ctx -> null);

        HttpResponse response = routes.messages(request("nope", "{\"text\":\"hi\"}"));

        assertThat(response.status()).isEqualTo(404);
        assertThat(error(response)).containsEntry("error", "not_found");
    }

    @Test
    void messagesStartsARunAndReturnsTheRunId() throws Exception {
        CountDownLatch ran = new CountDownLatch(1);
        routes = routes(ctx -> {
            ran.countDown();
            return null;
        });

        HttpResponse response = routes.messages(request("s1", "{\"text\":\"hi\"}"));

        assertThat(response.status()).isEqualTo(202);
        Map<String, Object> body = Json.readMap(new String(response.body()));
        assertThat(body).containsKey("runId");
        assertThat(ran.await(5, TimeUnit.SECONDS)).isTrue();
        awaitRunEnd(String.valueOf(body.get("runId")));
    }

    @Test
    void activeRunIsA409() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        routes = routes(ctx -> {
            started.countDown();
            try {
                release.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return null;
        });

        HttpResponse first = routes.messages(request("s1", "{\"text\":\"one\"}"));
        assertThat(first.status()).isEqualTo(202);
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
        HttpResponse second = routes.messages(request("s1", "{\"text\":\"two\"}"));

        assertThat(second.status()).isEqualTo(409);
        assertThat(error(second)).containsEntry("error", "run_active");
        release.countDown();
        awaitRunEnd(String.valueOf(Json.readMap(new String(first.body())).get("runId")));
    }

    @Test
    void cancelWithoutActiveRunIsA404() {
        routes = routes(ctx -> null);

        HttpResponse response = routes.cancel(request("s1", null));

        assertThat(response.status()).isEqualTo(404);
        assertThat(error(response)).containsEntry("error", "no_active_run");
    }

    @Test
    void cancelUnknownSessionIsA404() {
        routes = routes(ctx -> null);

        HttpResponse response = routes.cancel(request("nope", null));

        assertThat(response.status()).isEqualTo(404);
        assertThat(error(response)).containsEntry("error", "not_found");
    }

    @Test
    void cancelFlipsTheActiveRun() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        routes = routes(ctx -> {
            started.countDown();
            try {
                release.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return ctx.isCancelled() ? "cancelled" : null;
        });

        HttpResponse started2 = routes.messages(request("s1", "{\"text\":\"hi\"}"));
        assertThat(started2.status()).isEqualTo(202);
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
        HttpResponse response = routes.cancel(request("s1", null));

        assertThat(response.status()).isEqualTo(204);
        release.countDown();
        awaitRunEnd(String.valueOf(Json.readMap(new String(started2.body())).get("runId")));
    }

    private MessageRoutes routes(Function<RunContext, String> loop) {
        RunServiceImpl runs = new RunServiceImpl(db, new FakeEventLog(), new RecordingStreamRegistry(),
                loop, LoggerFactory.getLogger("test"));
        return new MessageRoutes(sessions, runs);
    }

    /**
     * Waits until the ledger row left {@code running}, which happens in the
     * run's final write — a completion barrier for the background thread.
     */
    private void awaitRunEnd(String runId) throws Exception {
        for (int i = 0; i < 100; i++) {
            String status = db.read(connection -> {
                try (java.sql.PreparedStatement query = connection.prepareStatement(
                        "SELECT status FROM jhin_sessions_runs WHERE id = ?")) {
                    query.setString(1, runId);
                    try (java.sql.ResultSet rs = query.executeQuery()) {
                        return rs.next() ? rs.getString("status") : null;
                    }
                }
            });
            if (!"running".equals(status)) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("run " + runId + " never finished");
    }

    private static HttpRequest request(String id, String body) {
        return new FakeHttpRequest("POST", "/sessions/" + id + "/messages",
                Map.of("id", id), Map.of(), body);
    }

    private static Map<String, Object> error(HttpResponse response) {
        return Json.readMap(new String(response.body()));
    }
}
