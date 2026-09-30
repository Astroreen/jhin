/**
 * Schema migrations of the sessions plugin: sessions, append-only events and
 * the run ledger used by the agent plugin later.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.sdk.db.MigrationSpec;
import java.util.List;

final class Migrations {

    private Migrations() {}

    /**
     * All migrations of this plugin, versions strictly increasing.
     *
     * @return the migration list handed to {@code ctx.db().migrate()}
     */
    static List<MigrationSpec> all() {
        return List.of(v1());
    }

    /**
     * V1: the three tables of the sessions domain plus their indexes. Every
     * target carries the mandatory {@code jhin_sessions_} prefix.
     *
     * @return migration version 1
     */
    static MigrationSpec v1() {
        return new MigrationSpec(1, """
                CREATE TABLE jhin_sessions_sessions(
                    id TEXT PRIMARY KEY,
                    account_id TEXT,
                    title TEXT,
                    workdir TEXT,
                    model TEXT,
                    provider_id TEXT,
                    status TEXT,
                    created_at INT,
                    updated_at INT
                );
                CREATE TABLE jhin_sessions_events(
                    session_id TEXT,
                    seq INT,
                    ts INT,
                    type TEXT,
                    payload TEXT,
                    PRIMARY KEY(session_id, seq)
                );
                CREATE TABLE jhin_sessions_runs(
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    status TEXT,
                    started_at INT,
                    ended_at INT,
                    error TEXT
                );
                CREATE INDEX jhin_sessions_events_ts_idx ON jhin_sessions_events(ts);
                CREATE INDEX jhin_sessions_runs_session_idx ON jhin_sessions_runs(session_id);
                """);
    }
}
