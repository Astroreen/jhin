/**
 * Session lifecycle operations: settle, pin, snooze, archive, order and title
 * regeneration — the actions the UI calls on a session row.
 *
 * <p>Every successful operation persists through {@link SessionStore}, bumps
 * {@code updatedAt} and appends one {@link EventType#SESSION_UPDATED} event to
 * the session's event log (published on {@code sessions/<id>} after the write).
 * The two documented exceptions are the no-op successes and
 * {@link #regenerateTitle}, which needs a {@link TitleService}.
 */
package com.astroreen.jhin.plugin.sessions.api;

import java.util.List;

/**
 * The session lifecycle: state transitions, ordering and titles.
 *
 * <h2>Transition matrix</h2>
 *
 * <p>An <em>archived</em> session is sealed: every operation except
 * {@link #restore(String)} fails with
 * {@link LifecycleException.Failure#INVALID_TRANSITION}. On top of that:
 *
 * <ul>
 *   <li>{@link #settle} requires an unsettled session — re-settling a settled
 *       session is an invalid transition (un-settle first);</li>
 *   <li>{@link #unsettle} requires a settled session;</li>
 *   <li>{@link #archive} requires a non-archived session;</li>
 *   <li>{@link #restore} requires an archived session.</li>
 * </ul>
 *
 * <p>{@code pin}, {@code unpin}, {@code snooze}, {@code wake} and
 * {@code setAutoSettle} are not transitions but settings, and apply in every
 * non-archived state (a settled session can still be pinned or snoozed — the
 * status predicates are independent). Two of them are <em>no-op successes</em>:
 * when there is nothing to clear they answer {@code 200} with the unchanged
 * session and emit no event — {@code wake} on a session whose
 * {@code snoozed_until} is already {@code null}, and {@code unpin} on a
 * session that is already unpinned with no {@code pinned_order}. Re-pinning
 * and re-snoozing are allowed and simply overwrite the order / timestamp.
 *
 * <h2>Clear semantics</h2>
 *
 * <p>{@link SessionStore.Patch} keeps a field whose value is {@code null}, so
 * the operations that must <em>clear</em> columns go through the
 * {@link SessionStore#patch(String, SessionStore.Patch, java.util.Set)} clear
 * variant instead of a sentinel value:
 *
 * <ul>
 *   <li>{@code settle} clears the pin completely ({@code pinned} and
 *       {@code pinned_order} — a leftover order would still shape list
 *       ordering) and {@code snoozed_until};</li>
 *   <li>{@code unsettle} clears {@code settled_at} and {@code settled_reason}
 *       and sets {@code auto_settle_suppressed}, so the inactivity sweep does
 *       not immediately re-settle the session;</li>
 *   <li>{@code unpin} clears {@code pinned} and {@code pinned_order};</li>
 *   <li>{@code wake} clears {@code snoozed_until} (including a stale, expired
 *       value — the no-op case is only the already-clear column);</li>
 *   <li>{@code restore} clears {@code archived_at}.</li>
 * </ul>
 */
public interface SessionLifecycleService {

    /**
     * Settles a session: {@code settled_at=now}, {@code settled_reason} from
     * {@code reason}, the pin cleared and any snooze cleared.
     *
     * @param id     the session id
     * @param reason why the session is settled; never {@code null}
     * @return the updated session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         archived or already settled
     * @throws IllegalArgumentException when {@code reason} is {@code null}
     */
    Session settle(String id, SettleReason reason);

    /**
     * Un-settles a session: {@code settled_at} and {@code settled_reason}
     * cleared, {@code auto_settle_suppressed} set so the inactivity sweep
     * leaves the session alone until new activity.
     *
     * @param id the session id
     * @return the updated session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         archived or not settled
     */
    Session unsettle(String id);

    /**
     * Pins a session: {@code pinned=1} and {@code pinned_order=order}. Pinned
     * sessions sort above the others by {@code pinned_order}. Re-pinning is
     * allowed and overwrites the order.
     *
     * @param id    the session id
     * @param order the position among pinned sessions, or {@code null} to keep
     *              the current order
     * @return the updated session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         archived
     */
    Session pin(String id, Integer order);

    /**
     * Unpins a session: {@code pinned=0} and {@code pinned_order} cleared. On
     * an already unpinned session with no order left this is a no-op success:
     * the unchanged session is returned and no event is emitted.
     *
     * @param id the session id
     * @return the updated (or unchanged) session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         archived
     */
    Session unpin(String id);

    /**
     * Snoozes a session until an absolute time: {@code snoozed_until=untilTs}.
     * A session counts as snoozed only while the timestamp is strictly in the
     * future. Re-snoozing is allowed and overwrites the timestamp.
     *
     * @param id      the session id
     * @param untilTs epoch milliseconds; must be strictly in the future
     * @return the updated session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         archived
     * @throws IllegalArgumentException when {@code untilTs} is not in the
     *         future (the route answers {@code 400})
     */
    Session snooze(String id, long untilTs);

    /**
     * Snoozes a session for a duration from now, resolved against the wall
     * clock as {@code now + durationMs}.
     *
     * @param id          the session id
     * @param durationMs  the sleep duration in milliseconds; positive
     * @return the updated session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         archived
     * @throws IllegalArgumentException when {@code durationMs} is not positive
     *         (the route answers {@code 400})
     */
    Session snoozeFor(String id, long durationMs);

    /**
     * Wakes a session: {@code snoozed_until} cleared. On a session whose
     * column is already {@code null} this is a no-op success: the unchanged
     * session is returned and no event is emitted.
     *
     * @param id the session id
     * @return the updated (or unchanged) session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         archived
     */
    Session wake(String id);

    /**
     * Archives a session: {@code archived_at=now}. Archived sessions drop out
     * of the default listing and accept no further operation except
     * {@link #restore(String)}.
     *
     * @param id the session id
     * @return the updated session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         already archived
     */
    Session archive(String id);

    /**
     * Restores a session from the archive: {@code archived_at} cleared. The
     * other lifecycle fields are untouched — the session returns in whatever
     * state it was archived in.
     *
     * @param id the session id
     * @return the updated session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         not archived
     */
    Session restore(String id);

    /**
     * Persists a manual ordering across the given sessions: position
     * {@code i} of {@code ids} is written to {@code sort_order} and, so the
     * order survives the pinned-first listing, to {@code pinned_order} of
     * every listed session. The list should cover the whole visible set —
     * indices start at {@code 0} and sessions outside the list keep their old
     * order values.
     *
     * @param ids the full session id order, top first; non-empty, no
     *            duplicates
     * @return the updated sessions in the given order
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when any id is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when any
     *         session is archived
     * @throws IllegalArgumentException when {@code ids} is {@code null}, empty
     *         or holds duplicates (the route answers {@code 400})
     */
    List<Session> reorder(List<String> ids);

    /**
     * Sets the {@code auto_settle} flag: whether the server-side inactivity
     * sweep may settle the session on its own. Setting the flag to its current
     * value is a no-op success.
     *
     * @param id      the session id
     * @param enabled the new flag value
     * @return the updated (or unchanged) session
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         archived
     */
    Session setAutoSettle(String id, boolean enabled);

    /**
     * Regenerates the session title: delegates to the published
     * {@link TitleService} (the {@code jhin.agent} seam) with the session and
     * its full event history, then stores the returned title and emits
     * {@link EventType#SESSION_UPDATED}.
     *
     * @param id the session id
     * @return the updated session with the new title
     * @throws LifecycleException with {@link LifecycleException.Failure#NOT_FOUND}
     *         when the session is unknown,
     *         {@link LifecycleException.Failure#INVALID_TRANSITION} when it is
     *         archived,
     *         {@link LifecycleException.Failure#TITLE_UNAVAILABLE} when no
     *         {@link TitleService} is published or it failed to produce a
     *         title (the route answers {@code 503 title_service_unavailable})
     */
    Session regenerateTitle(String id);
}
