/**
 * The server-owned auto-settle sweep: settles inactive sessions on a timer
 * with no client connected.
 *
 * <p>One periodic task named {@value #TASK_NAME} is armed from the plugin's
 * {@code onStarted} hook (first run {@value #INITIAL_DELAY_MS} ms after the
 * HTTP server is up, then every {@value #INTERVAL_MS} ms) and cancelled from
 * {@code onShutdown}; both production delays may be shortened through the
 * {@code sweepInitialDelayMs} / {@code sweepIntervalMs} plugin config keys.
 * Tests drive {@link #sweep()} directly with their own threshold.
 *
 * <p>Sweep predicate — a session is settled when all of the following hold:
 * not settled ({@code settled_at IS NULL}), not archived
 * ({@code archived_at IS NULL}), not snoozed into the future
 * ({@code snoozed_until IS NULL OR <= now}), auto-settle enabled
 * ({@code auto_settle = 1}), auto-settle not suppressed
 * ({@code auto_settle_suppressed = 0}) and idle past the threshold
 * ({@code updated_at < now - inactivityMs}). {@code inactivityMs} comes from
 * the {@code jhin.sessions.inactivityMs} config key and defaults to
 * {@value #DEFAULT_INACTIVITY_MS} ms (3 days).
 *
 * <p>Blocked sessions are skipped this round and retried on the next sweep:
 * a live run (a {@code jhin_sessions_runs} row with {@code ended_at IS NULL})
 * or a pending approval reported by the optional
 * {@link RunActivityService} — absent that service (the degradation path),
 * approvals never block.
 *
 * <p>Each match is settled <em>in place</em> with
 * {@code settled_reason = inactive}: {@code pinned} and {@code pinned_order}
 * survive, so a pinned session keeps its pin and stays in the Pinned group.
 * The pre-operation snapshot goes through the undo journal and one
 * {@code session_updated} event is emitted, exactly like a manual settle.
 *
 * <p>Crash-safe and idempotent: the predicate excludes already-settled rows
 * and the settle path no-ops on one that became settled concurrently, so a
 * re-run after a crash mid-sweep settles each eligible session exactly once.
 * A failure on one session is logged and never aborts the rest of the sweep.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.RunActivityService;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SettleReason;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.db.DbAccess;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;

final class SettlementService {

    /** Task name of the periodic sweep, unique per host. */
    static final String TASK_NAME = "settlement-sweep";

    /** Production first-run delay: 30 s after the HTTP server is up. */
    static final long INITIAL_DELAY_MS = 30_000;

    /** Production period: one sweep per minute. */
    static final long INTERVAL_MS = 60_000;

    /** Default inactivity threshold: 3 days. */
    static final long DEFAULT_INACTIVITY_MS = 3L * 24 * 60 * 60 * 1000;

    /** The sweep predicate: every idle, settle-able session. */
    private static final String CANDIDATES =
            "SELECT id FROM jhin_sessions_sessions"
                    + " WHERE settled_at IS NULL AND archived_at IS NULL"
                    + " AND (snoozed_until IS NULL OR snoozed_until <= ?)"
                    + " AND auto_settle = 1 AND auto_settle_suppressed = 0"
                    + " AND updated_at < ?";

    /** A session with an unfinished run row is live and must not settle. */
    private static final String LIVE_RUN =
            "SELECT 1 FROM jhin_sessions_runs"
                    + " WHERE session_id = ? AND ended_at IS NULL LIMIT 1";

    private final DbAccess db;
    private final SessionLifecycleServiceImpl lifecycle;
    private final ServiceRegistry services;
    private final long inactivityMs;
    private final Logger log;

    SettlementService(DbAccess db, SessionLifecycleServiceImpl lifecycle,
            ServiceRegistry services, long inactivityMs, Logger log) {
        this.db = db;
        this.lifecycle = lifecycle;
        this.services = services;
        this.inactivityMs = inactivityMs;
        this.log = log;
    }

    /**
     * One sweep pass: settles every eligible session with
     * {@link SettleReason#INACTIVE} and logs what happened.
     *
     * @return the number of sessions settled by this pass
     */
    int sweep() {
        long now = System.currentTimeMillis();
        List<String> candidates = candidates(now);
        int settled = 0;
        for (String id : candidates) {
            try {
                if (hasLiveRun(id) || hasPendingApproval(id)) {
                    log.info("settlement sweep: {} blocked (live run or pending approval), skipped", id);
                    continue;
                }
                Session after = lifecycle.settlePreservingPin(id, SettleReason.INACTIVE);
                if (SettleReason.INACTIVE.wire().equals(after.settledReason())) {
                    settled++;
                    log.info("settlement sweep: settled {} (inactive)", id);
                }
            } catch (RuntimeException e) {
                log.warn("settlement sweep: session {} failed to settle, skipped", id, e);
            }
        }
        log.info("settlement sweep: settled {} of {} candidates", settled, candidates.size());
        return settled;
    }

    /**
     * The ids matching the sweep predicate at {@code now}. The cutoff is
     * clamped so a threshold of {@link Long#MAX_VALUE} reads as "older than
     * any possible activity" instead of overflowing into the future.
     */
    private List<String> candidates(long now) {
        long cutoff = inactivityMs >= now ? Long.MIN_VALUE : now - inactivityMs;
        return db.read(connection -> {
            List<String> ids = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement(CANDIDATES)) {
                query.setLong(1, now);
                query.setLong(2, cutoff);
                try (ResultSet rs = query.executeQuery()) {
                    while (rs.next()) {
                        ids.add(rs.getString("id"));
                    }
                }
            }
            return List.copyOf(ids);
        });
    }

    /** Whether the session has a run that has not ended yet. */
    private boolean hasLiveRun(String id) {
        return db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(LIVE_RUN)) {
                query.setString(1, id);
                try (ResultSet rs = query.executeQuery()) {
                    return rs.next();
                }
            }
        });
    }

    /**
     * Whether the run owner reports a pending approval. Absent run owner —
     * the documented degradation — nothing blocks.
     */
    private boolean hasPendingApproval(String id) {
        return services.find(RunActivityService.class)
                .map(runs -> runs.hasPendingApproval(id))
                .orElse(false);
    }
}
