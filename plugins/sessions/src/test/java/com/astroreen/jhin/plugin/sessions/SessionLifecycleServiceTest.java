/**
 * Lifecycle service behaviour: the field effects of every operation (the
 * clears included), the {@code updatedAt} bump, the {@code session_updated}
 * emission on the log and the {@code sessions/<id>} topic, the transition
 * matrix, the no-op successes and the title service seam.
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.LifecycleException;
import com.astroreen.jhin.plugin.sessions.api.LifecycleException.Failure;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.SettleReason;
import com.astroreen.jhin.plugin.sessions.api.TitleService;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionLifecycleServiceTest {

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
    void settleSetsFieldsClearsPinAndSnoozeBumpsUpdatedAtAndEmits() {
        Session created = create("demo");
        lifecycle.pin(created.id(), 3);
        lifecycle.snoozeFor(created.id(), 60_000);
        long before = current(created.id()).updatedAt();

        Session settled = lifecycle.settle(created.id(), SettleReason.MANUAL);

        assertThat(settled.settledAt()).isNotNull();
        assertThat(settled.settledReason()).isEqualTo("manual");
        assertThat(settled.pinned()).isFalse();
        assertThat(settled.pinnedOrder()).isNull();
        assertThat(settled.snoozedUntil()).isNull();
        assertThat(settled.updatedAt()).isGreaterThanOrEqualTo(before);
        assertSessionUpdatedEmitted(created.id());
    }

    @Test
    void settleRejectsArchivedAndSettledSessions() {
        Session archived = create("archived");
        lifecycle.archive(archived.id());
        assertThatThrownBy(() -> lifecycle.settle(archived.id(), SettleReason.MANUAL))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);

        Session settled = create("settled");
        lifecycle.settle(settled.id(), SettleReason.OTHER);
        assertThatThrownBy(() -> lifecycle.settle(settled.id(), SettleReason.MANUAL))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);
    }

    @Test
    void settleRejectsNullReason() {
        Session created = create("demo");
        assertThatThrownBy(() -> lifecycle.settle(created.id(), null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void unsettleClearsSettleFieldsAndSuppressesAutoSettle() {
        Session created = create("demo");
        lifecycle.settle(created.id(), SettleReason.MANUAL);

        Session unsettled = lifecycle.unsettle(created.id());

        assertThat(unsettled.settledAt()).isNull();
        assertThat(unsettled.settledReason()).isNull();
        assertThat(unsettled.autoSettleSuppressed()).isTrue();
        assertSessionUpdatedEmitted(created.id());
    }

    @Test
    void unsettleRejectsUnsettledAndArchivedSessions() {
        Session active = create("active");
        assertThatThrownBy(() -> lifecycle.unsettle(active.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);

        Session archived = create("archived");
        lifecycle.settle(archived.id(), SettleReason.MANUAL);
        lifecycle.archive(archived.id());
        assertThatThrownBy(() -> lifecycle.unsettle(archived.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);
    }

    @Test
    void pinSetsPinnedAndOrder() {
        Session created = create("demo");

        Session pinned = lifecycle.pin(created.id(), 2);

        assertThat(pinned.pinned()).isTrue();
        assertThat(pinned.pinnedOrder()).isEqualTo(2);
        assertSessionUpdatedEmitted(created.id());
    }

    @Test
    void unpinClearsPinnedAndOrder() {
        Session created = create("demo");
        lifecycle.pin(created.id(), 1);

        Session unpinned = lifecycle.unpin(created.id());

        assertThat(unpinned.pinned()).isFalse();
        assertThat(unpinned.pinnedOrder()).isNull();
        assertSessionUpdatedEmitted(created.id());
    }

    @Test
    void unpinOnUnpinnedSessionIsANoOp() {
        Session created = create("demo");
        long before = current(created.id()).updatedAt();
        long eventsBefore = eventLog.list(created.id(), 0).size();

        Session unchanged = lifecycle.unpin(created.id());

        assertThat(unchanged.updatedAt()).isEqualTo(before);
        assertThat(unchanged.pinned()).isFalse();
        assertThat(unchanged.pinnedOrder()).isNull();
        assertThat(eventLog.list(created.id(), 0)).hasSize((int) eventsBefore);
    }

    @Test
    void pinAndUnpinRejectArchivedSessions() {
        Session created = create("demo");
        lifecycle.archive(created.id());
        assertThatThrownBy(() -> lifecycle.pin(created.id(), 0))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);
        assertThatThrownBy(() -> lifecycle.unpin(created.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);
    }

    @Test
    void snoozeSetsTimestampAndWakeClearsIt() {
        Session created = create("demo");
        long until = System.currentTimeMillis() + 60_000;

        Session snoozed = lifecycle.snooze(created.id(), until);
        assertThat(snoozed.snoozedUntil()).isEqualTo(until);
        assertSessionUpdatedEmitted(created.id());

        Session woken = lifecycle.wake(created.id());
        assertThat(woken.snoozedUntil()).isNull();
        assertSessionUpdatedEmitted(created.id());
    }

    @Test
    void snoozeRejectsPastTimestampAndNonPositiveDuration() {
        Session created = create("demo");
        assertThatThrownBy(() -> lifecycle.snooze(created.id(), System.currentTimeMillis() - 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> lifecycle.snooze(created.id(), System.currentTimeMillis()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> lifecycle.snoozeFor(created.id(), 0))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void wakeOnNonSnoozedSessionIsANoOp() {
        Session created = create("demo");
        long before = current(created.id()).updatedAt();
        long eventsBefore = eventLog.list(created.id(), 0).size();

        Session unchanged = lifecycle.wake(created.id());

        assertThat(unchanged.updatedAt()).isEqualTo(before);
        assertThat(unchanged.snoozedUntil()).isNull();
        assertThat(eventLog.list(created.id(), 0)).hasSize((int) eventsBefore);
    }

    @Test
    void wakeClearsAnExpiredSnoozeInsteadOfNoOp() throws InterruptedException {
        Session created = create("demo");
        lifecycle.snooze(created.id(), System.currentTimeMillis() + 20);
        Thread.sleep(40);

        Session woken = lifecycle.wake(created.id());

        assertThat(woken.snoozedUntil()).isNull();
        assertSessionUpdatedEmitted(created.id());
    }

    @Test
    void snoozeAndWakeRejectArchivedSessions() {
        Session created = create("demo");
        lifecycle.archive(created.id());
        assertThatThrownBy(() -> lifecycle.snoozeFor(created.id(), 60_000))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);
        assertThatThrownBy(() -> lifecycle.wake(created.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);
    }

    @Test
    void archiveSetsTimestampAndRestoreClearsIt() {
        Session created = create("demo");

        Session archived = lifecycle.archive(created.id());
        assertThat(archived.archivedAt()).isNotNull();
        assertSessionUpdatedEmitted(created.id());

        Session restored = lifecycle.restore(created.id());
        assertThat(restored.archivedAt()).isNull();
        assertSessionUpdatedEmitted(created.id());
    }

    @Test
    void archiveRejectsArchivedAndRestoreRejectsUnarchived() {
        Session created = create("demo");
        lifecycle.archive(created.id());
        assertThatThrownBy(() -> lifecycle.archive(created.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);

        Session active = create("active");
        assertThatThrownBy(() -> lifecycle.restore(active.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);
    }

    @Test
    void reorderPersistsOrderAcrossTheWholeList() {
        Session first = create("first");
        Session second = create("second");
        Session third = create("third");

        List<Session> updated = lifecycle.reorder(
                List.of(third.id(), first.id(), second.id()));

        assertThat(updated).extracting(Session::id)
                .containsExactly(third.id(), first.id(), second.id());
        assertThat(updated.get(0).sortOrder()).isEqualTo(0);
        assertThat(updated.get(0).pinnedOrder()).isEqualTo(0);
        assertThat(updated.get(1).sortOrder()).isEqualTo(1);
        assertThat(updated.get(2).sortOrder()).isEqualTo(2);
        assertThat(store.list()).extracting(Session::id)
                .containsExactly(third.id(), first.id(), second.id());
        for (Session session : updated) {
            assertSessionUpdatedEmitted(session.id());
        }
    }

    @Test
    void reorderKeepsPinnedSessionsOnTopOrderedByPinnedOrder() {
        Session pinned = create("pinned");
        Session plain = create("plain");
        lifecycle.pin(pinned.id(), null);

        lifecycle.reorder(List.of(plain.id(), pinned.id()));

        List<Session> listed = store.list();
        assertThat(listed.get(0).id()).isEqualTo(pinned.id());
        assertThat(listed.get(0).pinnedOrder()).isEqualTo(1);
        assertThat(listed.get(1).id()).isEqualTo(plain.id());
        assertThat(listed.get(1).pinnedOrder()).isEqualTo(0);
    }

    @Test
    void reorderRejectsEmptyDuplicateUnknownAndArchivedIds() {
        Session created = create("demo");
        assertThatThrownBy(() -> lifecycle.reorder(List.of()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> lifecycle.reorder(List.of(created.id(), created.id())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> lifecycle.reorder(List.of("nope")))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.NOT_FOUND);

        lifecycle.archive(created.id());
        assertThatThrownBy(() -> lifecycle.reorder(List.of(created.id())))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);
    }

    @Test
    void setAutoSettleTogglesAndIsNoOpWhenUnchanged() {
        Session created = create("demo");

        Session off = lifecycle.setAutoSettle(created.id(), false);
        assertThat(off.autoSettle()).isFalse();
        assertSessionUpdatedEmitted(created.id());

        long before = current(created.id()).updatedAt();
        long eventsBefore = eventLog.list(created.id(), 0).size();
        Session same = lifecycle.setAutoSettle(created.id(), false);
        assertThat(same.updatedAt()).isEqualTo(before);
        assertThat(eventLog.list(created.id(), 0)).hasSize((int) eventsBefore);

        Session on = lifecycle.setAutoSettle(created.id(), true);
        assertThat(on.autoSettle()).isTrue();
    }

    @Test
    void regenerateTitleDelegatesToThePublishedTitleService() {
        Session created = create("demo");
        services.publish(TitleService.class,
                (TitleService) (session, history) -> "retitled");

        Session retitled = lifecycle.regenerateTitle(created.id());

        assertThat(retitled.title()).isEqualTo("retitled");
        assertSessionUpdatedEmitted(created.id());
    }

    @Test
    void regenerateTitleWithoutATitleServiceFailsWith503() {
        Session created = create("demo");
        assertThatThrownBy(() -> lifecycle.regenerateTitle(created.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.TITLE_UNAVAILABLE);
    }

    @Test
    void regenerateTitleFailsWhenTheServiceProducesNoTitle() {
        Session created = create("demo");
        services.publish(TitleService.class, (TitleService) (session, history) -> " ");
        assertThatThrownBy(() -> lifecycle.regenerateTitle(created.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.TITLE_UNAVAILABLE);

        services = new FakeServiceRegistry();
        lifecycle = new SessionLifecycleServiceImpl(store, eventLog, services, journal);
        services.publish(TitleService.class, (TitleService) (session, history) -> {
            throw new IllegalStateException("llm down");
        });
        assertThatThrownBy(() -> lifecycle.regenerateTitle(created.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.TITLE_UNAVAILABLE);
    }

    @Test
    void regenerateTitleRejectsArchivedSessions() {
        Session created = create("demo");
        lifecycle.archive(created.id());
        assertThatThrownBy(() -> lifecycle.regenerateTitle(created.id()))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.INVALID_TRANSITION);
    }

    @Test
    void unknownSessionIdsFailWithNotFound() {
        assertThatThrownBy(() -> lifecycle.settle("nope", SettleReason.MANUAL))
                .isInstanceOf(LifecycleException.class)
                .extracting(e -> ((LifecycleException) e).failure())
                .isEqualTo(Failure.NOT_FOUND);
    }

    @Test
    void settleIsUndoableThroughTheJournal() {
        Session created = create("demo");
        lifecycle.pin(created.id(), 2);
        Session pinned = current(created.id());

        Session settled = lifecycle.settle(created.id(), SettleReason.MANUAL);
        Session restored = journal.undo(settled.id()).orElseThrow();

        assertThat(settled.settledAt()).isNotNull();
        assertThat(restored).usingRecursiveComparison()
                .ignoringFields("updatedAt")
                .isEqualTo(pinned);
        assertThat(restored.settledAt()).isNull();
        assertThat(restored.pinned()).isTrue();
        assertThat(restored.pinnedOrder()).isEqualTo(2);
    }

    @Test
    void reorderIsUndoablePerSessionClearingTheSortOrder() {
        Session first = create("first");
        Session second = create("second");

        lifecycle.reorder(List.of(first.id(), second.id()));
        Session restored = journal.undo(first.id()).orElseThrow();

        assertThat(restored.sortOrder()).isNull();
        assertThat(restored.pinnedOrder()).isNull();
        assertThat(current(second.id()).sortOrder()).isEqualTo(1);
    }

    @Test
    void noOpSuccessesAreNotRecordedInTheJournal() {
        Session created = create("demo");

        lifecycle.wake(created.id());
        lifecycle.unpin(created.id());
        lifecycle.setAutoSettle(created.id(), true);

        assertThat(journal.undo(created.id())).isEmpty();
        assertThat(journal.undoLatest()).isEmpty();
    }

    @Test
    void regenerateTitleIsNotRecordedInTheJournal() {
        Session created = create("demo");
        services.publish(TitleService.class, (TitleService) (session, history) -> "Fresh title");

        Session retitled = lifecycle.regenerateTitle(created.id());

        assertThat(retitled.title()).isEqualTo("Fresh title");
        assertThat(journal.undo(created.id())).isEmpty();
    }

    private Session create(String title) {
        return store.create(title, "/tmp/" + title);
    }

    private Session current(String id) {
        return store.get(id).orElseThrow();
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
