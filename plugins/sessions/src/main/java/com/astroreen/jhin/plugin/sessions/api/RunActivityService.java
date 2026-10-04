/**
 * Optional run-owner seam of the auto-settle sweep: the plugin that owns agent
 * runs publishes this service alongside its run contract and reports whether a
 * session is waiting on a tool-call approval or another run gate.
 *
 * <p>The inactivity sweep settles idle sessions but must not settle a session
 * whose run is mid-approval. Live runs are detected from the run table itself
 * ({@code jhin_sessions_runs} rows with a null {@code ended_at}); pending
 * approvals are not, so the sweep asks this service. When no run owner
 * publishes it, the sweep treats every session as approval-free and settles on
 * inactivity alone — the documented degradation.
 *
 * <p>The run owner (for example the agent plugin with its {@code RunService})
 * implements this interface in addition to its own run contract and publishes
 * both to the service registry; the sessions plugin never references the run
 * owner's types, so the dependency stays one-way.
 */
package com.astroreen.jhin.plugin.sessions.api;

/**
 * The run owner's answer to "may this session be settled right now?".
 */
public interface RunActivityService {

    /**
     * Whether the session currently has a pending approval or another run
     * gate blocking its completion. Checked by the sweep per candidate; a
     * throwing implementation is treated as blocked (the session is skipped
     * this round and retried on the next sweep).
     *
     * @param sessionId the session to inspect
     * @return {@code true} when the session must not be settled yet
     */
    boolean hasPendingApproval(String sessionId);
}
