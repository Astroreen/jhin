/**
 * CRUD over sessions, the domain nucleus every other plugin builds on.
 *
 * <p>Access is scoped by account when a principal is present and unscoped
 * otherwise. Without a security plugin there is a single implicit account
 * {@link #LOCAL_ACCOUNT} that owns everything.
 */
package com.astroreen.jhin.plugin.sessions.api;

import java.util.List;
import java.util.Optional;
import java.util.Set;

public interface SessionStore {

    /** The implicit account used when no security plugin is present. */
    String LOCAL_ACCOUNT = "local";

    /**
     * Creates a session owned by the given account. The id is generated, the
     * status starts as {@code active}, model and provider are unset. The
     * session starts unpinned and unsettled with auto-settle enabled.
     *
     * @param accountId the owning account
     * @param title     the session title
     * @param workdir   the absolute workspace directory
     * @return the persisted session
     * @throws IllegalArgumentException when {@code accountId}, {@code title} or
     *                                  {@code workdir} is null or blank
     */
    Session create(String accountId, String title, String workdir);

    /**
     * Creates a session owned by {@link #LOCAL_ACCOUNT}. Called when no
     * security plugin is present.
     *
     * @param title   the session title
     * @param workdir the absolute workspace directory
     * @return the persisted session
     * @throws IllegalArgumentException when {@code title} or {@code workdir} is
     *                                  null or blank
     */
    Session create(String title, String workdir);

    /**
     * Fetches one session by id, unscoped. Called when no principal is present.
     *
     * @param id the session id
     * @return the session, or empty when unknown
     */
    Optional<Session> get(String id);

    /**
     * Fetches one session by id, restricted to the given account. A session
     * owned by another account is indistinguishable from an unknown one.
     *
     * @param accountId the owning account
     * @param id        the session id
     * @return the session, or empty when unknown or owned by another account
     */
    Optional<Session> get(String accountId, String id);

    /**
     * Lists the default view of all sessions, unscoped: every non-archived
     * session ordered by {@code pinned DESC, pinned_order ASC, sort_order ASC,
     * created_at DESC}. Called when no principal is present.
     *
     * @return the non-archived sessions, pinned first
     */
    List<Session> list();

    /**
     * Lists the default view of one account's sessions: every non-archived
     * session ordered by {@code pinned DESC, pinned_order ASC, sort_order ASC,
     * created_at DESC}.
     *
     * @param accountId the owning account
     * @return the non-archived sessions of the account, pinned first
     */
    List<Session> list(String accountId);

    /**
     * Lists all sessions of all accounts through one status filter, unscoped.
     *
     * @param filter the status view to apply
     * @return the matching sessions, pinned first
     */
    List<Session> list(StatusFilter filter);

    /**
     * Lists the sessions of one account through one status filter.
     *
     * @param accountId the owning account
     * @param filter    the status view to apply
     * @return the matching sessions of the account, pinned first
     */
    List<Session> list(String accountId, StatusFilter filter);

    /**
     * Applies a partial update, unscoped. Fields left {@code null} in the
     * patch keep their current values; {@code updatedAt} is bumped to the
     * current time when at least one field changes.
     *
     * @param id    the session id
     * @param patch the fields to change
     * @return the updated session
     * @throws com.astroreen.jhin.sdk.PluginException when the session is unknown
     */
    Session patch(String id, Patch patch);

    /**
     * Applies a partial update, restricted to the given account. A session
     * owned by another account is indistinguishable from an unknown one.
     *
     * @param accountId the owning account
     * @param id        the session id
     * @param patch     the fields to change
     * @return the updated session
     * @throws com.astroreen.jhin.sdk.PluginException when the session is unknown
     *                                                  or owned by another account
     */
    Session patch(String accountId, String id, Patch patch);

    /**
     * Applies a partial update that may also clear columns, unscoped.
     *
     * <p>{@link Patch} keeps every field that is {@code null}, so this variant
     * takes the columns to reset explicitly: fields listed in {@code clears}
     * become {@code NULL} whatever the patch says, every other field follows
     * the usual patch semantics ({@code null} keeps the current value). An
     * empty {@code clears} set behaves exactly like
     * {@link #patch(String, Patch)}; when both the patch and {@code clears}
     * target the same field the call is rejected.
     *
     * @param id     the session id
     * @param patch  the fields to change; never {@code null}
     * @param clears the fields to reset to {@code NULL}; never {@code null}
     * @return the updated session
     * @throws IllegalArgumentException when {@code patch} or {@code clears} is
     *         {@code null} or one field is both set and cleared
     * @throws com.astroreen.jhin.sdk.PluginException when the session is unknown
     */
    Session patch(String id, Patch patch, Set<ClearableField> clears);

    /**
     * Applies a partial update that may also clear columns, restricted to the
     * given account. A session owned by another account is indistinguishable
     * from an unknown one.
     *
     * @param accountId the owning account
     * @param id        the session id
     * @param patch     the fields to change; never {@code null}
     * @param clears    the fields to reset to {@code NULL}; never {@code null}
     * @return the updated session
     * @throws IllegalArgumentException when {@code patch} or {@code clears} is
     *         {@code null} or one field is both set and cleared
     * @throws com.astroreen.jhin.sdk.PluginException when the session is unknown
     *                                                  or owned by another account
     */
    Session patch(String accountId, String id, Patch patch, Set<ClearableField> clears);

    /**
     * Deletes one session and its events, unscoped.
     *
     * @param id the session id
     * @return {@code true} when a session was deleted
     */
    boolean delete(String id);

    /**
     * Deletes one session and its events, restricted to the given account.
     *
     * @param accountId the owning account
     * @param id        the session id
     * @return {@code true} when a session was deleted
     */
    boolean delete(String accountId, String id);

    /**
     * Status view for list queries.
     *
     * <p>The filters are independent predicates and may overlap: a settled
     * session whose {@code snoozed_until} is still in the future matches both
     * {@link #SETTLED} and {@link #SNOOZED}. {@link #ACTIVE} is the exact
     * complement of the union of the other three. Pinning never changes the
     * status classification: a pinned and settled session is still
     * {@link #SETTLED}.
     */
    enum StatusFilter {

        /** Not settled, not archived and not snoozed right now. */
        ACTIVE,

        /** {@code snoozed_until} is strictly in the future. */
        SNOOZED,

        /** {@code settled_at} is set. */
        SETTLED,

        /** {@code archived_at} is set. */
        ARCHIVED,

        /** Every session, archived ones included. */
        ALL
    }

    /**
     * The nullable columns a {@link #patch(String, Patch, Set) clear-aware}
     * update may reset to {@code NULL}. Only these five can ever be empty again
     * after being set, which is what the lifecycle transitions need: a plain
     * {@link Patch} keeps a {@code null} field instead of clearing it.
     */
    enum ClearableField {

        /** Clears {@code pinned_order}; written by unpin and settle. */
        PINNED_ORDER,

        /** Clears {@code settled_at}; written by un-settle. */
        SETTLED_AT,

        /** Clears {@code settled_reason}; written by un-settle. */
        SETTLED_REASON,

        /** Clears {@code snoozed_until}; written by wake and settle. */
        SNOOZED_UNTIL,

        /** Clears {@code archived_at}; written by restore. */
        ARCHIVED_AT
    }

    /**
     * Partial session update: {@code null} fields keep their current values.
     *
     * @param title      new title, or {@code null}
     * @param workdir    new workdir, or {@code null}
     * @param model      new model, or {@code null}
     * @param providerId new provider id, or {@code null}
     * @param status     new status, or {@code null}
     * @param pinned     new pinned flag, or {@code null}
     * @param pinnedOrder new pinned position, or {@code null}
     * @param settledAt  new settle time, epoch milliseconds, or {@code null}
     * @param snoozedUntil new sleep-until time, epoch milliseconds, or
     *                   {@code null}
     * @param archivedAt new archive time, epoch milliseconds, or {@code null}
     * @param autoSettle new auto-settle flag, or {@code null}
     * @param sortOrder  new manual position, or {@code null}
     * @param settledReason new settle reason, or {@code null}
     * @param autoSettleSuppressed new auto-settle suppression flag, or
     *                   {@code null}
     */
    record Patch(
            String title,
            String workdir,
            String model,
            String providerId,
            String status,
            Boolean pinned,
            Integer pinnedOrder,
            Long settledAt,
            Long snoozedUntil,
            Long archivedAt,
            Boolean autoSettle,
            Integer sortOrder,
            String settledReason,
            Boolean autoSettleSuppressed) {

        /**
         * Backward-compatible constructor over the pre-lifecycle fields; the
         * lifecycle fields stay {@code null} and change nothing.
         *
         * @param title      new title, or {@code null}
         * @param workdir    new workdir, or {@code null}
         * @param model      new model, or {@code null}
         * @param providerId new provider id, or {@code null}
         * @param status     new status, or {@code null}
         */
        public Patch(String title, String workdir, String model, String providerId, String status) {
            this(title, workdir, model, providerId, status,
                    null, null, null, null, null, null, null, null, null);
        }

        /**
         * @return {@code true} when every field is {@code null} and the patch
         *         changes nothing
         */
        public boolean isEmpty() {
            return title == null && workdir == null && model == null
                    && providerId == null && status == null
                    && pinned == null && pinnedOrder == null && settledAt == null
                    && snoozedUntil == null && archivedAt == null && autoSettle == null
                    && sortOrder == null && settledReason == null
                    && autoSettleSuppressed == null;
        }
    }
}