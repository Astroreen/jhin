/**
 * One unit of database work, run against a JDBC connection.
 *
 * <p>Implemented by a plugin and handed to {@link DbAccess#read(SqlWork)} or
 * {@link DbAccess#write(SqlWork)}. The kernel owns the connection lifecycle:
 * the connection is open for the duration of {@link #apply(Connection)} and
 * must not be closed or escaped by the work.
 *
 * @param <R> the work result type
 */
package com.astroreen.jhin.sdk.db;

import java.sql.Connection;
import java.sql.SQLException;

public interface SqlWork<R> {

    /**
     * Runs the work. Called by the kernel with a live connection: concurrent
     * on {@link DbAccess#read(SqlWork)}, serialized on
     * {@link DbAccess#write(SqlWork)}.
     *
     * @param c the connection to use, owned by the kernel
     * @return the work result
     * @throws SQLException when the work fails; the kernel propagates it to
     *                      the caller of {@code read} or {@code write}
     */
    R apply(Connection c) throws SQLException;
}
