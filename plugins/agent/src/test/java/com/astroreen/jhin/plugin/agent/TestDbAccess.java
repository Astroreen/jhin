/**
 * Self-contained in-process harness for plugin tests: a real SQLite database
 * behind the {@link DbAccess} contract.
 *
 * <p>Mirrors the kernel semantics the plugin relies on at runtime: reads run on
 * the caller thread against a fresh connection, writes are serialized through a
 * single executor thread (one unit at a time, in submission order), unchecked
 * exceptions from a work unit propagate unchanged and {@link java.sql.SQLException}s
 * are wrapped into {@code PluginException}. Deliberately independent of the
 * kernel module: a plugin only ever sees the SDK at runtime. The run-ledger
 * table {@code jhin_sessions_runs} is created by the tests with the exact DDL
 * the sessions migration provisions — the documented cross-plugin interplay:
 * sessions creates the table, the agent owns its rows at runtime.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.db.DbAccess;
import com.astroreen.jhin.sdk.db.MigrationSpec;
import com.astroreen.jhin.sdk.db.SqlWork;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

final class TestDbAccess implements DbAccess, AutoCloseable {

    /** The run-ledger DDL, exactly as the sessions migration provisions it. */
    static final String RUNS_DDL = """
            CREATE TABLE jhin_sessions_runs(
                id TEXT PRIMARY KEY,
                session_id TEXT,
                status TEXT,
                started_at INT,
                ended_at INT,
                error TEXT
            );
            CREATE INDEX jhin_sessions_runs_session_idx ON jhin_sessions_runs(session_id);
            """;

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
     * Opens a fresh SQLite database file for one test and provisions the run
     * ledger table.
     *
     * @param dir directory holding the database file
     * @return the open harness
     */
    static TestDbAccess open(Path dir) {
        TestDbAccess db = new TestDbAccess(dir.resolve("test.db"));
        db.write(connection -> {
            try (Statement statement = connection.createStatement()) {
                for (String piece : split(RUNS_DDL)) {
                    statement.execute(piece);
                }
            }
            return null;
        });
        return db;
    }

    @Override
    public void migrate(List<MigrationSpec> migrations) {
        for (MigrationSpec migration : migrations) {
            write(connection -> {
                try (Statement statement = connection.createStatement()) {
                    for (String piece : split(migration.sql())) {
                        statement.execute(piece);
                    }
                }
                return null;
            });
        }
    }

    @Override
    public <R> R read(SqlWork<R> work) {
        try (Connection connection = connect()) {
            return work.apply(connection);
        } catch (SQLException e) {
            throw new PluginException("read failed for plugin jhin.agent", e);
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
                throw new PluginException("write failed for plugin jhin.agent", sql);
            }
            toss(cause);
            throw new PluginException("write failed for plugin jhin.agent", cause);
        }
    }

    @Override
    public String tablePrefix() {
        return "jhin_agent_";
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
