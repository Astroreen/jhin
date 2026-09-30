/**
 * The plugin-facing database access of one plugin: its table prefix, its
 * migrations through the shared {@link MigrationBookkeeper} and work units
 * through the shared {@link Database}.
 */
package com.astroreen.jhin.kernel.db;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.db.DbAccess;
import com.astroreen.jhin.sdk.db.MigrationSpec;
import com.astroreen.jhin.sdk.db.SqlWork;
import java.sql.SQLException;
import java.util.List;

public final class DbAccessImpl implements DbAccess {

    private final String pluginId;
    private final String prefix;
    private final Database database;
    private final MigrationBookkeeper bookkeeper;

    /**
     * Binds a plugin id to the shared database and migration bookkeeping.
     *
     * @param pluginId   the id of the owning plugin
     * @param database   the shared database
     * @param bookkeeper the shared migration bookkeeper
     */
    public DbAccessImpl(String pluginId, Database database, MigrationBookkeeper bookkeeper) {
        this.pluginId = pluginId;
        this.prefix = MigrationGuard.prefixFor(pluginId);
        this.database = database;
        this.bookkeeper = bookkeeper;
    }

    /**
     * Applies the missing migrations of this plugin. Idempotent: versions
     * already recorded in {@code _jhin_plugin_schema} are skipped.
     *
     * @param migrations the migrations to apply
     * @throws PluginException when a migration is rejected or fails to apply
     */
    @Override
    public void migrate(List<MigrationSpec> migrations) {
        bookkeeper.apply(pluginId, migrations);
    }

    /**
     * Executes a read-only work unit on the caller thread. Concurrent with other
     * reads.
     *
     * @param <R>  the work result type
     * @param work the work to execute
     * @return whatever the work returns
     * @throws PluginException when the work fails
     */
    @Override
    public <R> R read(SqlWork<R> work) {
        try {
            return database.read(work);
        } catch (SQLException e) {
            throw new PluginException("read failed for plugin " + pluginId, e);
        }
    }

    /**
     * Executes a read-write work unit on the write queue. Serialized with every
     * other write, in submission order.
     *
     * @param <R>  the work result type
     * @param work the work to execute
     * @return whatever the work returns
     * @throws PluginException when the work fails
     */
    @Override
    public <R> R write(SqlWork<R> work) {
        try {
            return database.write(work);
        } catch (SQLException e) {
            throw new PluginException("write failed for plugin " + pluginId, e);
        }
    }

    /**
     * The mandatory table and index prefix of this plugin.
     *
     * @return the prefix derived from the plugin id
     */
    @Override
    public String tablePrefix() {
        return prefix;
    }
}
