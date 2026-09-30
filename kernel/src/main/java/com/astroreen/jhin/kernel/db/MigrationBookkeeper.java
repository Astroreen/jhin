/**
 * Per-plugin migration bookkeeping against {@code _jhin_plugin_schema}. The
 * missing versions of a plugin are applied in ascending order, one transaction
 * per version, and each applied version is recorded with its application time.
 * Applying the same list again is a no-op.
 */
package com.astroreen.jhin.kernel.db;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.db.MigrationSpec;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class MigrationBookkeeper {

    private final Database database;

    /**
     * Creates a bookkeeper over the shared database.
     *
     * @param database the database holding {@code _jhin_plugin_schema}
     */
    public MigrationBookkeeper(Database database) {
        this.database = database;
    }

    /**
     * Applies the missing migrations of one plugin. Every script is validated
     * against the plugin's table prefix first; then the versions not yet
     * recorded in {@code _jhin_plugin_schema} are applied in ascending order,
     * one transaction per version. Idempotent.
     *
     * @param pluginId   the id of the owning plugin
     * @param migrations the migration list of the plugin
     * @throws PluginException when a migration is rejected or fails to apply
     */
    public void apply(String pluginId, List<MigrationSpec> migrations) {
        for (MigrationSpec migration : migrations) {
            MigrationGuard.check(pluginId, migration.sql());
        }
        List<MigrationSpec> ordered = new ArrayList<>(migrations);
        ordered.sort(Comparator.comparingInt(MigrationSpec::version));
        try {
            database.write(connection -> applyMissing(connection, pluginId, ordered));
        } catch (SQLException e) {
            throw new PluginException("migrations failed for plugin " + pluginId, e);
        }
    }

    private static Void applyMissing(Connection connection, String pluginId, List<MigrationSpec> ordered)
            throws SQLException {
        Set<Integer> applied = new HashSet<>(appliedVersions(connection, pluginId));
        for (MigrationSpec migration : ordered) {
            if (applied.add(migration.version())) {
                applyOne(connection, pluginId, migration);
            }
        }
        return null;
    }

    private static void applyOne(Connection connection, String pluginId, MigrationSpec migration)
            throws SQLException {
        connection.setAutoCommit(false);
        try (Statement statement = connection.createStatement()) {
            for (String piece : Database.statements(migration.sql())) {
                statement.execute(piece);
            }
            try (PreparedStatement record = connection.prepareStatement(
                    "INSERT INTO _jhin_plugin_schema (plugin_id, version, applied_at) VALUES (?, ?, ?)")) {
                record.setString(1, pluginId);
                record.setInt(2, migration.version());
                record.setLong(3, System.currentTimeMillis());
                record.executeUpdate();
            }
            connection.commit();
        } catch (SQLException e) {
            connection.rollback();
            throw e;
        } finally {
            connection.setAutoCommit(true);
        }
    }

    private static List<Integer> appliedVersions(Connection connection, String pluginId)
            throws SQLException {
        List<Integer> out = new ArrayList<>();
        try (PreparedStatement query = connection.prepareStatement(
                "SELECT version FROM _jhin_plugin_schema WHERE plugin_id = ?")) {
            query.setString(1, pluginId);
            try (ResultSet rs = query.executeQuery()) {
                while (rs.next()) {
                    out.add(rs.getInt(1));
                }
            }
        }
        return out;
    }
}
