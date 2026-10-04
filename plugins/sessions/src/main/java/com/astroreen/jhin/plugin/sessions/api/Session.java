/**
 * One session row of the {@code jhin_sessions_sessions} table.
 *
 * <p>Exposed to dependant plugins through the exported API package; mirrors the
 * table columns one to one so it can be persisted and replayed without a
 * separate mapping layer.
 */
package com.astroreen.jhin.plugin.sessions.api;

/**
 * @param id        unique session id
 * @param accountId owning account; {@code local} when no security plugin is present
 * @param title     user-visible session title
 * @param workdir   absolute workspace directory of the session
 * @param model     model name the session runs with; {@code null} until chosen
 * @param providerId provider id the session runs with; {@code null} until chosen
 * @param status    free-form session status; {@code active} on creation
 * @param createdAt creation time, epoch milliseconds
 * @param updatedAt last modification time, epoch milliseconds
 * @param pinned    {@code true} when the session is pinned to the top of lists
 * @param pinnedOrder manual position among pinned sessions; {@code null} until
 *                  pinned with an explicit order
 * @param settledAt time the session was settled, epoch milliseconds;
 *                  {@code null} while unsettled
 * @param snoozedUntil time the session sleeps until, epoch milliseconds;
 *                  {@code null} when not snoozed; a session is snoozed only
 *                  while this timestamp is strictly in the future
 * @param archivedAt time the session was archived, epoch milliseconds;
 *                  {@code null} while not archived
 * @param autoSettle {@code true} when the server-side inactivity sweep may
 *                  settle the session on its own
 * @param sortOrder manual position among sessions; {@code null} until set
 * @param settledReason why the session was settled; one of {@code manual},
 *                  {@code inactive}, {@code closed}, {@code pr_merged},
 *                  {@code other}; {@code null} while unsettled
 * @param autoSettleSuppressed {@code true} when auto-settle is suppressed
 *                  until new activity (set by an explicit un-settle)
 */
public record Session(
        String id,
        String accountId,
        String title,
        String workdir,
        String model,
        String providerId,
        String status,
        long createdAt,
        long updatedAt,
        boolean pinned,
        Integer pinnedOrder,
        Long settledAt,
        Long snoozedUntil,
        Long archivedAt,
        boolean autoSettle,
        Integer sortOrder,
        String settledReason,
        boolean autoSettleSuppressed) {

    /**
     * Backward-compatible constructor without the lifecycle fields: the
     * session starts unpinned and unsettled with auto-settle enabled.
     *
     * @param id        unique session id
     * @param accountId owning account
     * @param title     user-visible session title
     * @param workdir   absolute workspace directory
     * @param model     model name, or {@code null}
     * @param providerId provider id, or {@code null}
     * @param status    free-form session status
     * @param createdAt creation time, epoch milliseconds
     * @param updatedAt last modification time, epoch milliseconds
     */
    public Session(String id, String accountId, String title, String workdir,
            String model, String providerId, String status, long createdAt, long updatedAt) {
        this(id, accountId, title, workdir, model, providerId, status, createdAt, updatedAt,
                false, null, null, null, null, true, null, null, false);
    }
}