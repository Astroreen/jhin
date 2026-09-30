/**
 * One schema migration of a plugin: a version and the SQL to apply.
 *
 * <p>Created by a plugin and handed to
 * {@link DbAccess#migrate(java.util.List)}. Versions start at {@code 1} and
 * are strictly increasing across the migration list; the kernel records
 * applied versions and skips them on later starts.
 *
 * <p>Components: {@code version} — the migration version, {@code >= 1};
 * {@code sql} — the migration script, not blank.
 */
package com.astroreen.jhin.sdk.db;

public record MigrationSpec(int version, String sql) {

    /**
     * Creates a migration, rejecting illegal arguments. Called by plugins
     * building their migration list.
     *
     * @param version the migration version, must be {@code >= 1}
     * @param sql     the migration script, must not be {@code null} or blank
     * @throws IllegalArgumentException when {@code version < 1} or
     *                                  {@code sql} is {@code null} or blank
     */
    public MigrationSpec {
        if (version < 1) {
            throw new IllegalArgumentException("migration version must be >= 1, got " + version);
        }
        if (sql == null || sql.isBlank()) {
            throw new IllegalArgumentException("migration sql must not be null or blank");
        }
    }
}
