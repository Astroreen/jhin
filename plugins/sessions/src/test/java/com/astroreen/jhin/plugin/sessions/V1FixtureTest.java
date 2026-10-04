/**
 * Writes the T81 QA upgrade fixture: a real v1 {@code data/jhin.db} — the
 * three sessions tables WITHOUT the v2 lifecycle columns, three pre-v2 rows
 * and the plugin schema bookkeeping at version 1 — into
 * {@code build/v1-fixture/jhin.db}. The QA script copies the file into a
 * scratch JHIN_HOME, boots the kernel against it and asserts the v2 migration
 * added the lifecycle columns while keeping every row.
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class V1FixtureTest {

    /** Where the QA script picks the fixture up. */
    private static final Path FIXTURE_DIR =
            Path.of("build", "v1-fixture").toAbsolutePath().normalize();

    private static final List<String> V1_COLUMNS = List.of(
            "id", "account_id", "title", "workdir", "model", "provider_id",
            "status", "created_at", "updated_at");

    @Test
    void writesV1SessionsDatabaseFixture() throws Exception {
        Files.createDirectories(FIXTURE_DIR);
        Path file = FIXTURE_DIR.resolve("jhin.db");
        Files.deleteIfExists(file);

        try (Connection db = DriverManager.getConnection("jdbc:sqlite:" + file)) {
            for (String piece : Migrations.v1().sql().split(";")) {
                String sql = piece.strip();
                if (!sql.isEmpty()) {
                    try (Statement statement = db.createStatement()) {
                        statement.execute(sql);
                    }
                }
            }
            try (Statement statement = db.createStatement()) {
                statement.execute("""
                        CREATE TABLE _jhin_plugin_schema(
                            plugin_id  TEXT    NOT NULL,
                            version    INTEGER NOT NULL,
                            applied_at INTEGER NOT NULL,
                            PRIMARY KEY (plugin_id, version)
                        )""");
            }
            try (PreparedStatement record = db.prepareStatement(
                    "INSERT INTO _jhin_plugin_schema (plugin_id, version, applied_at)"
                            + " VALUES (?, ?, ?)")) {
                record.setString(1, "jhin.sessions");
                record.setInt(2, 1);
                record.setLong(3, System.currentTimeMillis());
                record.executeUpdate();
            }
            insertV1Row(db, "s-1", "alice", "alpha", "/w/1", "m1", "p1", 1000, 1001);
            insertV1Row(db, "s-2", "alice", "beta", "/w/2", null, null, 2000, 2001);
            insertV1Row(db, "s-3", "bob", "gamma", "/w/3", "m2", "p2", 3000, 3001);
        }

        try (Connection db = DriverManager.getConnection("jdbc:sqlite:" + file)) {
            assertThat(columns(db)).containsExactlyElementsOf(V1_COLUMNS);
            try (Statement statement = db.createStatement();
                    ResultSet rs = statement.executeQuery(
                            "SELECT count(*) FROM jhin_sessions_sessions")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getInt(1)).isEqualTo(3);
            }
            try (Statement statement = db.createStatement();
                    ResultSet rs = statement.executeQuery(
                            "SELECT version FROM _jhin_plugin_schema"
                                    + " WHERE plugin_id = 'jhin.sessions'")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getInt(1)).isEqualTo(1);
            }
        }
    }

    private static void insertV1Row(Connection db, String id, String accountId, String title,
            String workdir, String model, String providerId, long createdAt, long updatedAt)
            throws SQLException {
        try (PreparedStatement insert = db.prepareStatement(
                "INSERT INTO jhin_sessions_sessions(id, account_id, title, workdir, model,"
                        + " provider_id, status, created_at, updated_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)")) {
            insert.setString(1, id);
            insert.setString(2, accountId);
            insert.setString(3, title);
            insert.setString(4, workdir);
            insert.setString(5, model);
            insert.setString(6, providerId);
            insert.setLong(7, createdAt);
            insert.setLong(8, updatedAt);
            insert.executeUpdate();
        }
    }

    private static List<String> columns(Connection db) throws SQLException {
        List<String> names = new ArrayList<>();
        try (Statement statement = db.createStatement();
                ResultSet rs = statement.executeQuery(
                        "PRAGMA table_info(jhin_sessions_sessions)")) {
            while (rs.next()) {
                names.add(rs.getString("name"));
            }
        }
        return names;
    }
}
