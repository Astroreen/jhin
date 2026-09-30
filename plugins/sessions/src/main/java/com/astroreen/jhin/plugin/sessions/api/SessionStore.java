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

public interface SessionStore {

    /** The implicit account used when no security plugin is present. */
    String LOCAL_ACCOUNT = "local";

    /**
     * Creates a session owned by the given account. The id is generated, the
     * status starts as {@code active}, model and provider are unset.
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
     * Lists all sessions, newest first, unscoped. Called when no principal is
     * present.
     *
     * @return all sessions ordered by creation time descending
     */
    List<Session> list();

    /**
     * Lists the sessions of one account, newest first.
     *
     * @param accountId the owning account
     * @return the sessions of the account ordered by creation time descending
     */
    List<Session> list(String accountId);

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
     * Partial session update: {@code null} fields keep their current values.
     *
     * @param title      new title, or {@code null}
     * @param workdir    new workdir, or {@code null}
     * @param model      new model, or {@code null}
     * @param providerId new provider id, or {@code null}
     * @param status     new status, or {@code null}
     */
    record Patch(String title, String workdir, String model, String providerId, String status) {

        /**
         * @return {@code true} when every field is {@code null} and the patch
         *         changes nothing
         */
        public boolean isEmpty() {
            return title == null && workdir == null && model == null
                    && providerId == null && status == null;
        }
    }
}
