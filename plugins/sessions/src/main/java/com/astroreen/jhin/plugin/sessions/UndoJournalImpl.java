/**
 * Default {@link UndoJournal}: one coalescing previous-state entry per
 * session, kept in memory for {@code undoWindowMs} milliseconds and restored
 * through the clear-aware store patch plus one {@code session_updated} event.
 *
 * <p>In-memory by design — the window is short (5 s by default) — which pins
 * the host to a single instance for correct undo (see the interface
 * documentation). Expired entries are pruned lazily on every record and undo.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.SessionStore.ClearableField;
import com.astroreen.jhin.plugin.sessions.api.SessionStore.Patch;
import com.astroreen.jhin.plugin.sessions.api.UndoJournal;
import com.astroreen.jhin.sdk.json.Json;
import java.util.EnumSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

final class UndoJournalImpl implements UndoJournal {

    private final SessionStore store;
    private final EventLog eventLog;
    private final long windowMs;
    private final LongSupplier clock;
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();

    /**
     * One undo window entry: the operation kind (for coalescing), the full
     * pre-operation session, when it was last recorded and when the window
     * closes.
     */
    private record Entry(OpKind opKind, Session snapshot, long recordedAt, long expiresAt) {
    }

    /**
     * @param store     the session store the restore writes through
     * @param eventLog  the event log the restore emits to
     * @param windowMs  the undo window in milliseconds, strictly positive
     */
    UndoJournalImpl(SessionStore store, EventLog eventLog, long windowMs) {
        this(store, eventLog, windowMs, System::currentTimeMillis);
    }

    /**
     * Test constructor with an injectable clock, so expiry is deterministic.
     *
     * @param store     the session store the restore writes through
     * @param eventLog  the event log the restore emits to
     * @param windowMs  the undo window in milliseconds, strictly positive
     * @param clock     the epoch-millisecond time source
     */
    UndoJournalImpl(SessionStore store, EventLog eventLog, long windowMs, LongSupplier clock) {
        if (windowMs <= 0) {
            throw new IllegalArgumentException("windowMs must be positive");
        }
        this.store = store;
        this.eventLog = eventLog;
        this.windowMs = windowMs;
        this.clock = clock;
    }

    @Override
    public void record(String sessionId, OpKind opKind, Session previousSnapshot) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new IllegalArgumentException("sessionId must not be blank");
        }
        if (opKind == null) {
            throw new IllegalArgumentException("opKind must not be null");
        }
        if (previousSnapshot == null) {
            throw new IllegalArgumentException("previousSnapshot must not be null");
        }
        long now = clock.getAsLong();
        prune(now);
        // Coalescing: a same-kind operation inside the window keeps the
        // oldest snapshot (the pre-first-op state) and only restarts the
        // window; a different-kind operation adopts this snapshot instead.
        entries.compute(sessionId, (id, existing) -> {
            if (existing != null && existing.expiresAt() > now && existing.opKind() == opKind) {
                return new Entry(opKind, existing.snapshot(), now, now + windowMs);
            }
            return new Entry(opKind, previousSnapshot, now, now + windowMs);
        });
    }

    @Override
    public Optional<Session> undo(String sessionId) {
        if (sessionId == null) {
            return Optional.empty();
        }
        long now = clock.getAsLong();
        Entry entry = entries.remove(sessionId);
        if (entry == null || entry.expiresAt() <= now) {
            return Optional.empty();
        }
        if (store.get(sessionId).isEmpty()) {
            // The session vanished after the operation was recorded; there is
            // nothing to restore and the entry is consumed regardless.
            return Optional.empty();
        }
        return Optional.of(restore(entry.snapshot()));
    }

    @Override
    public Optional<Session> undoLatest() {
        long now = clock.getAsLong();
        prune(now);
        String latestId = null;
        long latestAt = Long.MIN_VALUE;
        for (Map.Entry<String, Entry> candidate : entries.entrySet()) {
            if (candidate.getValue().recordedAt() > latestAt) {
                latestAt = candidate.getValue().recordedAt();
                latestId = candidate.getKey();
            }
        }
        return latestId == null ? Optional.empty() : undo(latestId);
    }

    /**
     * Writes the snapshot back through the clear-aware patch and emits one
     * {@code session_updated} event. {@code updatedAt} is bumped to the
     * restore time by the store write.
     */
    private Session restore(Session snapshot) {
        Set<ClearableField> clears = EnumSet.noneOf(ClearableField.class);
        if (snapshot.pinnedOrder() == null) {
            clears.add(ClearableField.PINNED_ORDER);
        }
        if (snapshot.settledAt() == null) {
            clears.add(ClearableField.SETTLED_AT);
        }
        if (snapshot.settledReason() == null) {
            clears.add(ClearableField.SETTLED_REASON);
        }
        if (snapshot.snoozedUntil() == null) {
            clears.add(ClearableField.SNOOZED_UNTIL);
        }
        if (snapshot.archivedAt() == null) {
            clears.add(ClearableField.ARCHIVED_AT);
        }
        if (snapshot.sortOrder() == null) {
            clears.add(ClearableField.SORT_ORDER);
        }
        Patch patch = new Patch(snapshot.title(), snapshot.workdir(), snapshot.model(),
                snapshot.providerId(), snapshot.status(), snapshot.pinned(),
                snapshot.pinnedOrder(), snapshot.settledAt(), snapshot.snoozedUntil(),
                snapshot.archivedAt(), snapshot.autoSettle(), snapshot.sortOrder(),
                snapshot.settledReason(), snapshot.autoSettleSuppressed());
        Session restored = store.patch(snapshot.id(), patch, clears);
        eventLog.append(restored.id(), EventType.SESSION_UPDATED, Json.write(restored));
        return restored;
    }

    /** Drops the entries whose window has closed. */
    private void prune(long now) {
        entries.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= now);
    }
}
