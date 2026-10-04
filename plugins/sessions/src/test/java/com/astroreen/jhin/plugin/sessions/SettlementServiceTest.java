/**
 * Auto-settle sweep behaviour: the sweep predicate (inactivity threshold,
 * auto-settle flags, snooze window), the blocking rules (live runs and the
 * optional pending-approval seam), the in-place settlement that keeps the
 * pin, the undo-journal recording and the crash-safe idempotence guard.
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.RunActivityService;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.SettleReason;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

class SettlementServiceTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private EventLog eventLog;
    private RecordingStreamRegistry streams;
    private FakeServiceRegistry services;
    private UndoJournalImpl journal;
    private SessionLifecycleServiceImpl lifecycle;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        store = new SessionStoreImpl(db);
        streams = new RecordingStreamRegistry();
        eventLog = new EventLogImpl(db, streams);
        services = new FakeServiceRegistry();
        journal = new UndoJournalImpl(store, eventLog, 5000);
        lifecycle = new SessionLifecycleServiceImpl(store, eventLog, services, journal);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void sweepSettlesInactiveSessionWithReasonInactive() {
        Session created = create("idle");
        long idleSince = backdate(created.id(), 10_000);
        SettlementService sweep = sweep(1_000);

        int settled = sweep.sweep();

        assertThat(settled).isEqualTo(1);
        Session after = current(created.id());
        assertThat(after.settledAt()).isNotNull();
        assertThat(after.settledReason()).isEqualTo("inactive");
        assertThat(after.updatedAt()).isGreaterThan(idleSince);
        assertSessionUpdatedEmitted(created.id());
    }

    @Test
    void sweepSettlesPinnedSessionAndKeepsPin() {
        Session created = create("pinned");
        lifecycle.pin(created.id(), 3);
        backdate(created.id(), 10_000);

        int settled = sweep(1_000).sweep();

        assertThat(settled).isEqualTo(1);
        Session after = current(created.id());
        assertThat(after.settledAt()).isNotNull();
        assertThat(after.settledReason()).isEqualTo("inactive");
        assertThat(after.pinned()).isTrue();
        assertThat(after.pinnedOrder()).isEqualTo(3);
        assertSessionUpdatedEmitted(created.id());

        Session restored = journal.undo(created.id()).orElseThrow();
        assertThat(restored.settledAt()).isNull();
        assertThat(restored.pinned()).isTrue();
        assertThat(restored.pinnedOrder()).isEqualTo(3);
    }

    @Test
    void sweepWithHugeThresholdSettlesNothing() {
        Session created = create("forever-idle");
        backdate(created.id(), 10_000);

        int settled = sweep(Long.MAX_VALUE).sweep();

        assertThat(settled).isZero();
        assertThat(current(created.id()).settledAt()).isNull();
    }

    @Test
    void sweepSkipsLiveRunAndSettlesEndedRun() {
        Session live = create("live-run");
        Session done = create("ended-run");
        insertRun("run-live", live.id(), null);
        insertRun("run-done", done.id(), System.currentTimeMillis());
        backdate(live.id(), 10_000);
        backdate(done.id(), 10_000);

        int settled = sweep(1_000).sweep();

        assertThat(settled).isEqualTo(1);
        assertThat(current(live.id()).settledAt()).isNull();
        Session ended = current(done.id());
        assertThat(ended.settledAt()).isNotNull();
        assertThat(ended.settledReason()).isEqualTo("inactive");
    }

    @Test
    void sweepSkipsDisabledAndSuppressedAutoSettle() {
        Session disabled = create("disabled");
        lifecycle.setAutoSettle(disabled.id(), false);
        backdate(disabled.id(), 10_000);

        Session unsettled = create("suppressed");
        lifecycle.settle(unsettled.id(), SettleReason.MANUAL);
        lifecycle.unsettle(unsettled.id());
        backdate(unsettled.id(), 10_000);

        int settled = sweep(1_000).sweep();

        assertThat(settled).isZero();
        assertThat(current(disabled.id()).settledAt()).isNull();
        assertThat(current(unsettled.id()).settledAt()).isNull();
    }

    @Test
    void sweepHonorsSnoozeWindow() {
        Session snoozed = create("future-snooze");
        lifecycle.snoozeFor(snoozed.id(), 60_000);
        backdate(snoozed.id(), 10_000);

        Session expired = create("expired-snooze");
        lifecycle.snoozeFor(expired.id(), 60_000);
        setSnoozedUntil(expired.id(), System.currentTimeMillis() - 5_000);
        backdate(expired.id(), 10_000);

        int settled = sweep(1_000).sweep();

        assertThat(settled).isEqualTo(1);
        assertThat(current(snoozed.id()).settledAt()).isNull();
        Session after = current(expired.id());
        assertThat(after.settledAt()).isNotNull();
        assertThat(after.settledReason()).isEqualTo("inactive");
    }

    @Test
    void sweepIsIdempotent() {
        Session created = create("once");
        backdate(created.id(), 10_000);
        SettlementService sweep = sweep(1_000);

        assertThat(sweep.sweep()).isEqualTo(1);
        assertThat(sweep.sweep()).isZero();
        assertThat(current(created.id()).settledAt()).isNotNull();
    }

    @Test
    void sweepBlocksOnPendingApproval() {
        Session created = create("awaiting-approval");
        backdate(created.id(), 10_000);
        services.publish(RunActivityService.class, sessionId -> true);

        int settled = sweep(1_000).sweep();

        assertThat(settled).isZero();
        assertThat(current(created.id()).settledAt()).isNull();
    }

    @Test
    void sweepSettlesWhenRunOwnerReportsNoPendingApproval() {
        Session created = create("no-approval");
        backdate(created.id(), 10_000);
        services.publish(RunActivityService.class, sessionId -> false);

        int settled = sweep(1_000).sweep();

        assertThat(settled).isEqualTo(1);
        assertThat(current(created.id()).settledReason()).isEqualTo("inactive");
    }

    private SettlementService sweep(long inactivityMs) {
        return new SettlementService(db, lifecycle, services, inactivityMs,
                LoggerFactory.getLogger("settlement-test"));
    }

    private Session create(String title) {
        return store.create(title, "/tmp/" + title);
    }

    private Session current(String id) {
        return store.get(id).orElseThrow();
    }

    /**
     * Ages the session's {@code updated_at} by {@code msAgo} and returns the
     * written value.
     */
    private long backdate(String id, long msAgo) {
        long updatedAt = System.currentTimeMillis() - msAgo;
        db.write(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE jhin_sessions_sessions SET updated_at = ? WHERE id = ?")) {
                update.setLong(1, updatedAt);
                update.setString(2, id);
                update.executeUpdate();
            }
            return true;
        });
        return updatedAt;
    }

    private void setSnoozedUntil(String id, long untilTs) {
        db.write(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE jhin_sessions_sessions SET snoozed_until = ? WHERE id = ?")) {
                update.setLong(1, untilTs);
                update.setString(2, id);
                update.executeUpdate();
            }
            return true;
        });
    }

    /** Inserts one run row; a null {@code endedAt} means a live run. */
    private void insertRun(String runId, String sessionId, Long endedAt) {
        db.write(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_sessions_runs(id, session_id, status, started_at, ended_at, error)"
                            + " VALUES (?, ?, 'running', ?, ?, NULL)")) {
                insert.setString(1, runId);
                insert.setString(2, sessionId);
                insert.setLong(3, System.currentTimeMillis());
                insert.setObject(4, endedAt);
                insert.executeUpdate();
            }
            return true;
        });
    }

    private void assertSessionUpdatedEmitted(String id) {
        List<EventRecord> records = eventLog.list(id, 0);
        assertThat(records).isNotEmpty();
        EventRecord last = records.get(records.size() - 1);
        assertThat(last.type()).isEqualTo(EventType.SESSION_UPDATED);
        assertThat(last.payload()).contains("\"id\":\"" + id + "\"");
        assertThat(streams.publishedOn(EventLogImpl.topic(id)))
                .extracting(event -> event.type())
                .contains("session_updated");
    }
}
