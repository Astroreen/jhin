/**
 * Self-contained in-process harness for plugin tests: a real SQLite database
 * behind the {@link DbAccess} contract.
 *
 * <p>Mirrors the kernel semantics the plugin relies on at runtime: reads run on
 * the caller thread against a fresh connection, writes are serialized through a
 * single executor thread (one unit at a time, in submission order), unchecked
 * exceptions from a work unit propagate unchanged and {@link java.sql.SQLException}s
 * are wrapped into {@code PluginException}. {@link #migrate} mirrors the kernel
 * migration bookkeeper: applied versions are recorded in
 * {@code _jhin_plugin_schema} and skipped on later calls, so migrating twice is
 * a no-op. Deliberately independent of the kernel module: a plugin only ever
 * sees the SDK at runtime.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.db.DbAccess;
import com.astroreen.jhin.sdk.db.MigrationSpec;
import com.astroreen.jhin.sdk.db.SqlWork;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

final class TestDbAccess implements DbAccess, AutoCloseable {

    /** Plugin id recorded in the migration bookkeeping table. */
    private static final String PLUGIN_ID = "jhin.sessions";

    private final Path file;
    private final ExecutorService writer;

    private TestDbAccess(Path file) {
        this.file = file;
        this.writer = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "test-db-writer");
            thread.setDaemon(true);
            return thread;
        });
    }

    /**
     * Opens a fresh SQLite database file for one test.
     *
     * @param dir directory holding the database file
     * @return the open harness
     */
    static TestDbAccess open(Path dir) {
        return new TestDbAccess(dir.resolve("test.db"));
    }

    @Override
    public void migrate(List<MigrationSpec> migrations) {
        write(connection -> {
            try (Statement statement = connection.createStatement()) {
                statement.execute("""
                        CREATE TABLE IF NOT EXISTS _jhin_plugin_schema(
                            plugin_id TEXT,
                            version INT,
                            applied_at INT,
                            PRIMARY KEY(plugin_id, version)
                        )""");
            }
            Set<Integer> applied = new HashSet<>();
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT version FROM _jhin_plugin_schema WHERE plugin_id = ?")) {
                query.setString(1, PLUGIN_ID);
                try (ResultSet rs = query.executeQuery()) {
                    while (rs.next()) {
                        applied.add(rs.getInt(1));
                    }
                }
            }
            List<MigrationSpec> ordered = new ArrayList<>(migrations);
            ordered.sort(Comparator.comparingInt(MigrationSpec::version));
            for (MigrationSpec migration : ordered) {
                if (!applied.add(migration.version())) {
                    continue;
                }
                try (Statement statement = connection.createStatement()) {
                    for (String piece : split(migration.sql())) {
                        statement.execute(piece);
                    }
                }
                try (PreparedStatement record = connection.prepareStatement(
                        "INSERT INTO _jhin_plugin_schema (plugin_id, version, applied_at)"
                                + " VALUES (?, ?, ?)")) {
                    record.setString(1, PLUGIN_ID);
                    record.setInt(2, migration.version());
                    record.setLong(3, System.currentTimeMillis());
                    record.executeUpdate();
                }
            }
            return null;
        });
    }

    @Override
    public <R> R read(SqlWork<R> work) {
        try (Connection connection = connect()) {
            return work.apply(connection);
        } catch (SQLException e) {
            throw new PluginException("read failed for plugin jhin.sessions", e);
        }
    }

    @Override
    public <R> R write(SqlWork<R> work) {
        Future<R> future = writer.submit(() -> {
            try (Connection connection = connect()) {
                return work.apply(connection);
            }
        });
        try {
            return future.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new PluginException("interrupted while waiting for a queued write", e);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof SQLException sql) {
                throw new PluginException("write failed for plugin jhin.sessions", sql);
            }
            toss(cause);
            throw new PluginException("write failed for plugin jhin.sessions", cause);
        }
    }

    @Override
    public String tablePrefix() {
        return "jhin_sessions_";
    }

    @Override
    public void close() {
        writer.shutdown();
    }

    private Connection connect() throws SQLException {
        Connection connection = DriverManager.getConnection("jdbc:sqlite:" + file);
        try (Statement statement = connection.createStatement()) {
            statement.execute("PRAGMA journal_mode=WAL");
            statement.execute("PRAGMA busy_timeout=5000");
        } catch (SQLException e) {
            connection.close();
            throw e;
        }
        return connection;
    }

    private static List<String> split(String sql) {
        return java.util.Arrays.stream(sql.split(";"))
                .map(String::trim)
                .filter(piece -> !piece.isEmpty())
                .toList();
    }

    @SuppressWarnings("unchecked")
    private static <E extends Throwable> void toss(Throwable cause) throws E {
        throw (E) cause;
    }
}
