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
        return List.of(v1(), v2());
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

    /**
     * V2: the lifecycle columns of the sessions table — pin, settle, snooze,
     * archive, ordering and the auto-settle flags. Purely additive
     * {@code ALTER TABLE ADD COLUMN} statements, so a v1 database keeps every
     * row. Columns carrying a {@code DEFAULT} ({@code pinned},
     * {@code auto_settle}, {@code auto_settle_suppressed}) read back that
     * default on pre-v2 rows; the remaining columns are nullable and read back
     * {@code NULL}.
     *
     * @return migration version 2
     */
    static MigrationSpec v2() {
        return new MigrationSpec(2, """
                ALTER TABLE jhin_sessions_sessions ADD COLUMN pinned INT DEFAULT 0;
                ALTER TABLE jhin_sessions_sessions ADD COLUMN pinned_order INT;
                ALTER TABLE jhin_sessions_sessions ADD COLUMN settled_at INT;
                ALTER TABLE jhin_sessions_sessions ADD COLUMN snoozed_until INT;
                ALTER TABLE jhin_sessions_sessions ADD COLUMN archived_at INT;
                ALTER TABLE jhin_sessions_sessions ADD COLUMN auto_settle INT DEFAULT 1;
                ALTER TABLE jhin_sessions_sessions ADD COLUMN sort_order INT;
                ALTER TABLE jhin_sessions_sessions ADD COLUMN settled_reason TEXT;
                ALTER TABLE jhin_sessions_sessions ADD COLUMN auto_settle_suppressed INT DEFAULT 0;
                """);
    }
}
