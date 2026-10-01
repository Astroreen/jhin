/**
 * Startup recovery of the run ledger: rows left {@code running} by a crashed
 * or restarted host are marked {@code error} with the exact error text
 * {@code interrupted}, so a stale run never looks live.
 *
 * <p>Runs once from {@link AgentPlugin#start} before any new run can be
 * started. Runs that finished normally are untouched.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.sdk.db.DbAccess;
import java.sql.PreparedStatement;
import org.slf4j.Logger;

final class RunRecovery {

    static final String STALE_ERROR_TEXT = "interrupted";

    private final DbAccess db;
    private final Logger log;

    RunRecovery(DbAccess db, Logger log) {
        this.db = db;
        this.log = log;
    }

    /**
     * Marks every {@code running} ledger row as {@code error: interrupted}.
     * Idempotent: a second invocation finds nothing to do.
     *
     * @return how many stale rows were recovered
     */
    int recover() {
        return db.write(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE jhin_sessions_runs SET status = ?, ended_at = ?, error = ?"
                            + " WHERE status = ?")) {
                update.setString(1, RunServiceImpl.STATUS_ERROR);
                update.setLong(2, System.currentTimeMillis());
                update.setString(3, STALE_ERROR_TEXT);
                update.setString(4, RunServiceImpl.STATUS_RUNNING);
                int stale = update.executeUpdate();
                if (stale > 0) {
                    log.warn("recovered {} run(s) left running: marked error: {}", stale,
                            STALE_ERROR_TEXT);
                }
                return stale;
            }
        });
    }
}
