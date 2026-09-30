/**
 * The shared SQLite file of the installation, {@code data/jhin.db} under the
 * home root. One file holds the kernel schema and every plugin schema.
 *
 * <p>Each connection opens with {@code journal_mode=WAL} (persistent, concurrent
 * readers alongside one writer), {@code foreign_keys=ON} and
 * {@code busy_timeout=5000}. Reads execute on the caller thread against a fresh
 * connection; writes are serialized through the {@link WriteQueue}. The kernel
 * migrations from {@code db/kernel} are applied at open, keyed by
 * {@code kernel_schema_version} in {@code _jhin_kernel_meta}, so opening is
 * idempotent.
 */
package com.astroreen.jhin.kernel.db;

import com.astroreen.jhin.kernel.config.JhinHome;
import com.astroreen.jhin.sdk.db.SqlWork;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Function;

public final class Database implements AutoCloseable {

    /** Kernel migrations by version; applied in ascending version order. */
    private static final Map<Integer, String> KERNEL_MIGRATIONS =
            new TreeMap<>(Map.of(1, "db/kernel/V1__init.sql"));

    /** Meta key holding the highest applied kernel migration version. */
    private static final String KERNEL_VERSION_KEY = "kernel_schema_version";

    private final Path file;
    private final WriteQueue queue;

    private Database(Path file, WriteQueue queue) {
        this.file = file;
        this.queue = queue;
    }

    /**
     * Opens the shared SQLite file of the real home layout and applies the
     * kernel migrations.
     *
     * @return the open database
     * @throws IllegalStateException when the kernel schema cannot be applied
     */
    public static Database open() {
        return open(System::getenv);
    }

    /**
     * Opens the shared SQLite file of the home layout resolved through the
     * given environment lookup. Exists so tests can point the layout at a
     * temporary directory. Kernel migrations are applied here and are
     * idempotent.
     *
     * @param env lookup returning the value of an environment variable, or
     *            {@code null} when it is not set
     * @return the open database
     * @throws IllegalStateException when the kernel schema cannot be applied
     */
    public static Database open(Function<String, String> env) {
        Path home = JhinHome.resolve(env);
        Path file = home.resolve("data").resolve("jhin.db");
        Database database = new Database(file, new WriteQueue());
        try {
            database.applyKernelMigrations();
        } catch (SQLException e) {
            database.close();
            throw new IllegalStateException("cannot initialize schema in " + file, e);
        }
        return database;
    }

    /**
     * Executes a read-only work unit on the caller thread against a fresh
     * connection. Concurrent with other reads.
     *
     * @param <R>  the work result type
     * @param work the work to execute
     * @return whatever the work returns
     * @throws SQLException when the work fails or no connection can be opened
     */
    public <R> R read(SqlWork<R> work) throws SQLException {
        try (Connection connection = connect()) {
            return work.apply(connection);
        }
    }

    /**
     * Executes a read-write work unit on the write queue. Serialized with every
     * other write, in submission order.
     *
     * @param <R>  the work result type
     * @param work the work to execute
     * @return whatever the work returns
     * @throws SQLException when the work fails or no connection can be opened
     */
    public <R> R write(SqlWork<R> work) throws SQLException {
        return queue.write(() -> {
            try (Connection connection = connect()) {
                return work.apply(connection);
            }
        });
    }

    /**
     * Closes the write queue; open connections are closed per work unit.
     */
    @Override
    public void close() {
        queue.close();
    }

    /**
     * Splits a migration script into single statements. Statements are
     * separated by {@code ;}; empty segments are dropped.
     *
     * @param sql the migration script
     * @return the statements in order
     */
    static List<String> statements(String sql) {
        List<String> out = new ArrayList<>();
        for (String part : sql.split(";")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) {
                out.add(trimmed);
            }
        }
        return out;
    }

    private Connection connect() throws SQLException {
        Connection connection = DriverManager.getConnection("jdbc:sqlite:" + file);
        try (Statement statement = connection.createStatement()) {
            statement.execute("PRAGMA journal_mode=WAL");
            statement.execute("PRAGMA foreign_keys=ON");
            statement.execute("PRAGMA busy_timeout=5000");
        } catch (SQLException e) {
            connection.close();
            throw e;
        }
        return connection;
    }

    private void applyKernelMigrations() throws SQLException {
        for (var entry : KERNEL_MIGRATIONS.entrySet()) {
            int version = entry.getKey();
            String sql = resource(entry.getValue());
            write(connection -> {
                int current = kernelVersion(connection);
                if (version <= current) {
                    return null;
                }
                connection.setAutoCommit(false);
                try (Statement statement = connection.createStatement()) {
                    for (String piece : statements(sql)) {
                        statement.execute(piece);
                    }
                    recordKernelVersion(connection, version);
                    connection.commit();
                } catch (SQLException e) {
                    connection.rollback();
                    throw e;
                } finally {
                    connection.setAutoCommit(true);
                }
                return null;
            });
        }
    }

    private static int kernelVersion(Connection connection) throws SQLException {
        boolean present;
        try (Statement statement = connection.createStatement();
                ResultSet rs = statement.executeQuery(
                        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_jhin_kernel_meta'")) {
            present = rs.next() && rs.getInt(1) > 0;
        }
        if (!present) {
            return 0;
        }
        try (PreparedStatement query = connection.prepareStatement(
                "SELECT value FROM _jhin_kernel_meta WHERE key = ?")) {
            query.setString(1, KERNEL_VERSION_KEY);
            try (ResultSet rs = query.executeQuery()) {
                return rs.next() ? Integer.parseInt(rs.getString(1)) : 0;
            }
        }
    }

    private static void recordKernelVersion(Connection connection, int version) throws SQLException {
        try (PreparedStatement record = connection.prepareStatement(
                "INSERT OR REPLACE INTO _jhin_kernel_meta (key, value) VALUES (?, ?)")) {
            record.setString(1, KERNEL_VERSION_KEY);
            record.setString(2, Integer.toString(version));
            record.executeUpdate();
        }
    }

    private static String resource(String name) {
        try (InputStream in = Database.class.getClassLoader().getResourceAsStream(name)) {
            if (in == null) {
                throw new IllegalStateException("missing kernel migration resource " + name);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read kernel migration resource " + name, e);
        }
    }
}
