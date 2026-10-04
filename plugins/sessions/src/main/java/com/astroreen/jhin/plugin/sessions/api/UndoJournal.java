/**
 * The short undo window over the session lifecycle: the previous-state
 * snapshots of the last {@code undoWindowMs} milliseconds of lifecycle
 * operations, restored on demand by the {@code undo} action.
 *
 * <p>Every mutating lifecycle operation records its entry <em>before</em> the
 * store write (see {@code SessionLifecycleServiceImpl}), so the journal always
 * holds the exact pre-operation {@link Session} — the full row, {@code pinned},
 * {@code pinned_order}, {@code settled_at}, {@code snoozed_until},
 * {@code archived_at} and {@code sort_order} included. The no-op successes
 * (the documented wake / unpin / auto-settle no-ops) change nothing and are
 * not recorded; title regeneration is not undoable and never recorded.
 *
 * <h2>Coalescing rule</h2>
 *
 * <p>Consecutive same-kind operations on one session inside the window
 * coalesce into one entry that keeps only the <em>oldest</em> snapshot: pin,
 * pin, pin undo as one and restore the pre-first-pin state. A different-kind
 * operation replaces the entry with a snapshot taken before that new
 * operation, so the undo reverts exactly the last kind of change (pin then
 * settle undoes the settle and restores the pinned state). Each new operation
 * restarts the window ({@code expiresAt = now + undoWindowMs}); an entry whose
 * window has closed is dead and undoable no more.
 *
 * <h2>Undo</h2>
 *
 * <p>{@link #undo} restores the snapshot exactly — the columns the snapshot
 * leaves {@code NULL} go through the {@link SessionStore} clear-aware patch —
 * bumps {@code updatedAt}, emits one {@code session_updated} event and consumes
 * the entry. An expired or absent entry answers empty and mutates nothing.
 *
 * <h2>Single-instance assumption</h2>
 *
 * <p>The journal is in-memory and per-process: the window is short (5 s by
 * default), so persistence is unnecessary, but a second host instance cannot
 * see the first one's entries and multi-instance deployments get per-instance
 * undo only.
 */
package com.astroreen.jhin.plugin.sessions.api;

import java.util.Optional;

/**
 * The lifecycle undo journal: one coalescing previous-state entry per session,
 * alive for the undo window.
 */
public interface UndoJournal {

    /**
     * The lifecycle operation kinds a journal entry belongs to. One constant
     * per undoable {@link SessionLifecycleService} operation; title
     * regeneration is deliberately absent (not undoable).
     */
    enum OpKind {

        /** {@link SessionLifecycleService#settle}. */
        SETTLE,

        /** {@link SessionLifecycleService#unsettle}. */
        UNSETTLE,

        /** {@link SessionLifecycleService#pin}. */
        PIN,

        /** {@link SessionLifecycleService#unpin}. */
        UNPIN,

        /** {@link SessionLifecycleService#snooze} and {@code snoozeFor}. */
        SNOOZE,

        /** {@link SessionLifecycleService#wake}. */
        WAKE,

        /** {@link SessionLifecycleService#archive}. */
        ARCHIVE,

        /** {@link SessionLifecycleService#restore}. */
        RESTORE,

        /** {@link SessionLifecycleService#reorder}. */
        REORDER,

        /** {@link SessionLifecycleService#setAutoSettle}. */
        SET_AUTO_SETTLE
    }

    /**
     * Records the pre-operation snapshot of one session. Called before each
     * mutating lifecycle operation; the coalescing rule of the interface
     * documentation decides whether the entry keeps its old snapshot (same
     * kind) or adopts this one (different kind or a fresh window).
     *
     * @param sessionId         the session the operation is about to change
     * @param opKind            the operation kind about to run
     * @param previousSnapshot  the session as it is right before the operation
     * @throws IllegalArgumentException when any argument is {@code null} or
     *                                  {@code sessionId} is blank
     */
    void record(String sessionId, OpKind opKind, Session previousSnapshot);

    /**
     * Restores the session to its entry snapshot and consumes the entry.
     *
     * <p>The restored session equals the snapshot in every column except
     * {@code updatedAt}, which is bumped to the restore time; the columns the
     * snapshot leaves {@code NULL} are cleared. One {@code session_updated}
     * event is emitted for the restore.
     *
     * @param sessionId the session to undo
     * @return the restored session, or empty when no unexpired entry exists
     *         (nothing to undo — the session is not touched)
     */
    Optional<Session> undo(String sessionId);

    /**
     * Undoes the most recently recorded unexpired entry across all sessions.
     * The empty-payload {@code undo} action path: the user just acted
     * somewhere and asks for "the last thing" back.
     *
     * @return the restored session, or empty when the journal holds no
     *         unexpired entry
     */
    Optional<Session> undoLatest();
}
