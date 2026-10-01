/**
 * The agent run lifecycle: start one run per session and cancel the active
 * one. Published to the cross-plugin service registry so a user-interface
 * plugin can post a message and cancel a run with the exact semantics of
 * {@code POST /sessions/{id}/messages} and {@code POST /sessions/{id}/cancel}
 * without speaking HTTP to itself.
 *
 * <p>One active run per session. Failures are typed wire codes carried by a
 * {@link com.astroreen.jhin.sdk.PluginException} message:
 * {@code run_active} when a run is already live and {@code no_active_run} when
 * cancellation finds nothing to cancel.
 */
package com.astroreen.jhin.plugin.agent.api;

import com.astroreen.jhin.plugin.sessions.api.Session;

public interface RunService {

    /**
     * Starts one agent run asynchronously: appends the {@code user_message}
     * event, claims the session's run slot and returns without waiting for the
     * run to finish. Every step of the run lands in the session event log.
     *
     * @param session the session to run in
     * @param text    the triggering user message
     * @return the run id
     * @throws IllegalArgumentException when {@code session} or {@code text} is
     *                                  null or blank
     * @throws com.astroreen.jhin.sdk.PluginException
     *         with code {@code run_active} when the session already has an
     *         active run
     */
    String start(Session session, String text);

    /**
     * Flips the cancellation flag of the session's active run. The run
     * observes it between steps; nothing is cancelled synchronously.
     *
     * @param sessionId the session whose run to cancel
     * @throws com.astroreen.jhin.sdk.PluginException
     *         with code {@code no_active_run} when the session has no active
     *         run
     */
    void cancel(String sessionId);
}
