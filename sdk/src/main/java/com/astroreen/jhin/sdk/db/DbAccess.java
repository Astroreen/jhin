/**
 * Plugin-facing database access: schema migrations and work units over the
 * shared SQLite database.
 *
 * <p>Obtained from {@link com.astroreen.jhin.sdk.PluginContext#db()}. The
 * kernel owns the database and the write queue; a plugin only declares its
 * migrations and runs work units. Every table and index a plugin creates must
 * be named with its {@link #tablePrefix()}; the kernel enforces this at load
 * time.
 */
package com.astroreen.jhin.sdk.db;

import java.util.List;

public interface DbAccess {

    /**
     * Applies the missing migrations for this plugin. Idempotent: migrations
     * whose version is already applied are skipped. Called from
     * {@link com.astroreen.jhin.sdk.JhinPlugin#start}.
     *
     * <p>The kernel scans each migration's SQL for {@code CREATE TABLE [IF
     * NOT EXISTS] <name>}, {@code CREATE INDEX [IF NOT EXISTS] <name>} and
     * {@code CREATE UNIQUE INDEX …} statements (case-insensitive) and fails
     * the plugin load if any {@code <name>} does not start with
     * {@link #tablePrefix()}.
     *
     * @param migrations the migrations to apply, versions strictly increasing
     */
    void migrate(List<MigrationSpec> migrations);

    /**
     * Runs a read-only work unit. Concurrent read-only intent: many reads may
     * run at the same time and the work must not modify any data.
     *
     * @param <R>  the work result type
     * @param work the work to run
     * @return whatever the work returns
     */
    <R> R read(SqlWork<R> work);

    /**
     * Runs a read-write work unit. Serialized through the kernel write queue:
     * writes run one at a time, in submission order.
     *
     * @param <R>  the work result type
     * @param work the work to run
     * @return whatever the work returns
     */
    <R> R write(SqlWork<R> work);

    /**
     * The mandatory prefix for every table and index this plugin creates.
     * Computed from the plugin id: every character outside {@code [a-z0-9]} is
     * replaced by {@code _}, and a trailing {@code _} is appended (for example
     * {@code jhin.sessions} yields {@code jhin_sessions_}). Called by the
     * kernel when checking migration SQL and by plugins that build table names
     * at runtime.
     *
     * @return the table and index prefix of the owning plugin
     */
    String tablePrefix();
}
