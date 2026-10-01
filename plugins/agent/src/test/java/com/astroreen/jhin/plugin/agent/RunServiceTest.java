/**
 * Run lifecycle: one active run per session, the {@code user_message} event
 * before the loop, the ledger transitions and the cancel route semantics.
 */
package com.astroreen.jhin.plugin.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

class RunServiceTest {

    @TempDir
    Path work;

    private TestDbAccess db;
    private FakeEventLog events;
    private RecordingStreamRegistry streams;
    private Session session;
    private RunServiceImpl runs;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(work);
        events = new FakeEventLog();
        streams = new RecordingStreamRegistry();
        session = new Session("s1", "local", "test session", work.toString(),
                "test-model", "p1", "active", 1L, 1L);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void secondStartWhileRunningIsRejected() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        RunServiceImpl service = service(ctx -> {
            started.countDown();
            await(release);
            return null;
        });

        String runId = service.start(session, "first");
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
        assertThatThrownBy(() -> service.start(session, "second"))
                .isInstanceOf(RunException.class)
                .hasMessageContaining("already has an active run");
        assertThat(row(runId)).containsEntry("status", "running");
        release.countDown();

        String secondId = awaitSecondStart(service, "third");
        assertThat(row(secondId)).containsEntry("status", "done");
    }

    @Test
    void startAppendsTheUserMessageFirst() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        List<EventType> atRunStart = new ArrayList<>();
        RunServiceImpl service = service(ctx -> {
            atRunStart.addAll(events.types("s1"));
            started.countDown();
            await(release);
            return null;
        });

        String runId = service.start(session, "hello");
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
        release.countDown();
        awaitRowStatus(runId, "done");

        assertThat(atRunStart).containsExactly(EventType.USER_MESSAGE);
    }

    @Test
    void cancelFlipsTheFlagAndIsNotFoundWithoutActiveRun() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicBoolean observed = new AtomicBoolean();
        RunServiceImpl service = service(ctx -> {
            started.countDown();
            await(release);
            observed.set(ctx.isCancelled());
            return ctx.isCancelled() ? "cancelled" : null;
        });

        String runId = service.start(session, "hello");
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
        service.cancel("s1");
        release.countDown();
        awaitRowStatus(runId, "cancelled");

        assertThat(observed.get()).isTrue();
        assertThat(row(runId)).containsEntry("status", "cancelled")
                .containsEntry("error", "cancelled");
        assertThatThrownBy(() -> service.cancel("s1"))
                .isInstanceOf(RunException.class)
                .hasMessageContaining("no active run");
    }

    @Test
    void failedRunIsRecordedAsError() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        RunServiceImpl service = service(ctx -> {
            started.countDown();
            await(release);
            return "boom";
        });

        String runId = service.start(session, "hello");
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
        release.countDown();
        awaitRowStatus(runId, "error");

        assertThat(row(runId)).containsEntry("status", "error").containsEntry("error", "boom");
    }

    private RunServiceImpl service(java.util.function.Function<RunContext, String> loop) {
        return new RunServiceImpl(db, events, streams, loop, LoggerFactory.getLogger("test"));
    }

    private String awaitSecondStart(RunServiceImpl service, String text) throws Exception {
        for (int i = 0; i < 100; i++) {
            try {
                String runId = service.start(session, text);
                awaitRowStatus(runId, "done");
                return runId;
            } catch (RunException e) {
                Thread.sleep(50);
            }
        }
        throw new AssertionError("the first run never released the session");
    }

    private void awaitRowStatus(String runId, String status) throws Exception {
        for (int i = 0; i < 100; i++) {
            if (status.equals(row(runId).get("status"))) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("run " + runId + " never reached status " + status);
    }

    private Map<String, Object> row(String runId) {
        return db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT status, error FROM jhin_sessions_runs WHERE id = ?")) {
                query.setString(1, runId);
                try (ResultSet rs = query.executeQuery()) {
                    if (!rs.next()) {
                        throw new AssertionError("no run row for " + runId);
                    }
                    java.util.Map<String, Object> row = new java.util.LinkedHashMap<>();
                    row.put("status", rs.getString("status"));
                    row.put("error", rs.getString("error"));
                    return row;
                }
            }
        });
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) {
                throw new AssertionError("latch timed out");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }
}
