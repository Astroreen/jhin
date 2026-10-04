/**
 * Undo journal behaviour: record/undo/restore fidelity (the cleared columns
 * included), window expiry, the coalescing rule in both directions, entry
 * consumption and the latest-entry lookup.
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.SessionStore.ClearableField;
import com.astroreen.jhin.plugin.sessions.api.SessionStore.Patch;
import com.astroreen.jhin.plugin.sessions.api.UndoJournal;
import com.astroreen.jhin.plugin.sessions.api.UndoJournal.OpKind;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.function.LongSupplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class UndoJournalTest {

    private static final long WINDOW_MS = 5000;

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private EventLog eventLog;
    private RecordingStreamRegistry streams;
    private FakeClock clock;
    private UndoJournalImpl journal;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        store = new SessionStoreImpl(db);
        streams = new RecordingStreamRegistry();
        eventLog = new EventLogImpl(db, streams);
        clock = new FakeClock(1_700_000_000_000L);
        journal = new UndoJournalImpl(store, eventLog, WINDOW_MS, clock);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void undoRestoresTheExactPreviousStateClearingTheColumnsTheSnapshotLeftNull() {
        Session created = store.create("demo", "/tmp/demo");
        journal.record(created.id(), OpKind.SETTLE, created);
        store.patch(created.id(), new Patch(null, null, null, null, null,
                true, 3, 1_000L, 2_000L, 3_000L, false, 7, "manual", true));

        Session restored = journal.undo(created.id()).orElseThrow();

        assertThat(restored).usingRecursiveComparison()
                .ignoringFields("updatedAt")
                .isEqualTo(created);
        assertThat(restored.settledAt()).isNull();
        assertThat(restored.settledReason()).isNull();
        assertThat(restored.pinnedOrder()).isNull();
        assertThat(restored.snoozedUntil()).isNull();
        assertThat(restored.archivedAt()).isNull();
        assertThat(restored.sortOrder()).isNull();
        assertThat(restored.updatedAt()).isGreaterThanOrEqualTo(created.updatedAt());
        List<EventRecord> records = eventLog.list(created.id(), 0);
        assertThat(records.get(records.size() - 1).type()).isEqualTo(EventType.SESSION_UPDATED);
    }

    @Test
    void undoRestoresTheValuesTheSnapshotCarried() {
        Session created = store.create("demo", "/tmp/demo");
        Session full = store.patch(created.id(), new Patch(null, null, null, null, null,
                true, 3, 1_000L, 2_000L, 3_000L, false, 7, "manual", true));
        journal.record(full.id(), OpKind.UNSETTLE, full);
        store.patch(full.id(), new Patch(null, null, null, null, null,
                null, null, null, null, null, null, null, null, null),
                Set.of(ClearableField.PINNED_ORDER, ClearableField.SETTLED_AT,
                        ClearableField.SETTLED_REASON, ClearableField.SNOOZED_UNTIL,
                        ClearableField.ARCHIVED_AT, ClearableField.SORT_ORDER));

        Session restored = journal.undo(full.id()).orElseThrow();

        assertThat(restored).usingRecursiveComparison()
                .ignoringFields("updatedAt")
                .isEqualTo(full);
        assertThat(restored.pinned()).isTrue();
        assertThat(restored.pinnedOrder()).isEqualTo(3);
        assertThat(restored.settledAt()).isEqualTo(1_000L);
        assertThat(restored.settledReason()).isEqualTo("manual");
        assertThat(restored.snoozedUntil()).isEqualTo(2_000L);
        assertThat(restored.archivedAt()).isEqualTo(3_000L);
        assertThat(restored.sortOrder()).isEqualTo(7);
    }

    @Test
    void undoExpiresWhenTheWindowCloses() {
        Session created = store.create("demo", "/tmp/demo");
        journal.record(created.id(), OpKind.PIN, created);
        store.patch(created.id(), new Patch(null, null, null, null, null,
                true, 1, null, null, null, null, null, null, null));
        clock.advance(WINDOW_MS);

        assertThat(journal.undo(created.id())).isEmpty();
        assertThat(current(created.id()).pinned()).isTrue();
        assertThat(current(created.id()).pinnedOrder()).isEqualTo(1);
    }

    @Test
    void undoStillWorksJustBeforeTheWindowCloses() {
        Session created = store.create("demo", "/tmp/demo");
        journal.record(created.id(), OpKind.PIN, created);
        clock.advance(WINDOW_MS - 1);

        assertThat(journal.undo(created.id())).isPresent();
    }

    @Test
    void consecutiveSameKindOpsKeepTheOldestSnapshot() {
        Session created = store.create("demo", "/tmp/demo");
        journal.record(created.id(), OpKind.PIN, created);
        Session afterFirstPin = store.patch(created.id(), new Patch(null, null, null, null, null,
                true, 1, null, null, null, null, null, null, null));
        journal.record(created.id(), OpKind.PIN, afterFirstPin);
        Session afterSecondPin = store.patch(created.id(), new Patch(null, null, null, null, null,
                true, 2, null, null, null, null, null, null, null));
        journal.record(created.id(), OpKind.PIN, afterSecondPin);
        store.patch(created.id(), new Patch(null, null, null, null, null,
                true, 3, null, null, null, null, null, null, null));

        Session restored = journal.undo(created.id()).orElseThrow();

        assertThat(restored).usingRecursiveComparison()
                .ignoringFields("updatedAt")
                .isEqualTo(created);
        assertThat(restored.pinned()).isFalse();
        assertThat(restored.pinnedOrder()).isNull();
    }

    @Test
    void differentKindOpReplacesTheEntryWithTheSnapshotBeforeIt() {
        Session created = store.create("demo", "/tmp/demo");
        journal.record(created.id(), OpKind.PIN, created);
        Session pinned = store.patch(created.id(), new Patch(null, null, null, null, null,
                true, 2, null, null, null, null, null, null, null));
        journal.record(created.id(), OpKind.SETTLE, pinned);
        store.patch(created.id(), new Patch(null, null, null, null, null,
                false, null, 999L, null, null, null, null, "manual", null),
                Set.of(ClearableField.PINNED_ORDER));

        Session restored = journal.undo(created.id()).orElseThrow();

        assertThat(restored).usingRecursiveComparison()
                .ignoringFields("updatedAt")
                .isEqualTo(pinned);
        assertThat(restored.pinned()).isTrue();
        assertThat(restored.pinnedOrder()).isEqualTo(2);
        assertThat(restored.settledAt()).isNull();
    }

    @Test
    void undoConsumesTheEntry() {
        Session created = store.create("demo", "/tmp/demo");
        journal.record(created.id(), OpKind.PIN, created);
        store.patch(created.id(), new Patch(null, null, null, null, null,
                true, 1, null, null, null, null, null, null, null));

        assertThat(journal.undo(created.id())).isPresent();
        assertThat(journal.undo(created.id())).isEmpty();
    }

    @Test
    void undoLatestPicksTheMostRecentlyRecordedEntry() {
        Session first = store.create("first", "/tmp/first");
        Session second = store.create("second", "/tmp/second");
        journal.record(first.id(), OpKind.PIN, first);
        clock.advance(1);
        journal.record(second.id(), OpKind.ARCHIVE, second);

        Session restored = journal.undoLatest().orElseThrow();

        assertThat(restored.id()).isEqualTo(second.id());
        assertThat(journal.undo(first.id())).isPresent();
    }

    @Test
    void undoLatestIsEmptyOnAnEmptyJournal() {
        assertThat(journal.undoLatest()).isEmpty();
    }

    @Test
    void undoOfAnEntryWithoutItsSessionIsSilentlyEmpty() {
        Session created = store.create("demo", "/tmp/demo");
        journal.record(created.id(), OpKind.PIN, created);
        store.delete(created.id());

        assertThat(journal.undo(created.id())).isEmpty();
    }

    @Test
    void recordRejectsNullAndBlankArguments() {
        Session created = store.create("demo", "/tmp/demo");
        assertThatThrownBy(() -> journal.record(null, OpKind.PIN, created))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> journal.record(" ", OpKind.PIN, created))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> journal.record(created.id(), null, created))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> journal.record(created.id(), OpKind.PIN, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void journalRejectsANonPositiveWindow() {
        assertThatThrownBy(() -> new UndoJournalImpl(store, eventLog, 0, clock))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void coalescingKeepsTheEntryThroughRepeatedSameKindRecords() {
        Session created = store.create("demo", "/tmp/demo");
        journal.record(created.id(), OpKind.SNOOZE, created);
        for (int i = 0; i < 3; i++) {
            clock.advance(100);
            journal.record(created.id(), OpKind.SNOOZE, created);
        }
        clock.advance(WINDOW_MS - 1);

        // The last record restarted the window, so the oldest snapshot is
        // still alive; the pre-first-record state is what comes back.
        assertThat(journal.undo(created.id())).isPresent();
        assertThat(current(created.id()).snoozedUntil()).isNull();
    }

    private Session current(String id) {
        return store.get(id).orElseThrow();
    }

    /** Deterministic epoch-millisecond clock for the expiry tests. */
    private static final class FakeClock implements LongSupplier {

        private long now;

        FakeClock(long now) {
            this.now = now;
        }

        void advance(long ms) {
            now += ms;
        }

        @Override
        public long getAsLong() {
            return now;
        }
    }
}
