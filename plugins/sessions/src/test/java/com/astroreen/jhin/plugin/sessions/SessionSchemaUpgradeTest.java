/**
 * Upgrade coverage of the sessions schema: a real v1 database is created,
 * populated and migrated to v2, and the pre-v2 rows are asserted to survive
 * with the lifecycle columns defaulted. Also pins the migration idempotence
 * (the version table guard) and the unknown-session patch failure, and writes
 * the QA evidence dumps under {@code build/upgrade}.
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.PluginException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionSchemaUpgradeTest {

    /** Where the QA script picks up the schema and row dumps. */
    private static final Path EVIDENCE_DIR = Path.of("build", "upgrade").toAbsolutePath().normalize();

    private static final List<String> V1_COLUMNS = List.of(
            "id", "account_id", "title", "workdir", "model", "provider_id",
            "status", "created_at", "updated_at");

    private static final List<String> LIFECYCLE_COLUMNS = List.of(
            "pinned", "pinned_order", "settled_at", "snoozed_until", "archived_at",
            "auto_settle", "sort_order", "settled_reason", "auto_settle_suppressed");

    @TempDir
    Path tmp;

    private TestDbAccess db;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    /**
     * The UNVERIFIED probe: SQLite {@code ALTER TABLE ADD COLUMN} defaults on
     * pre-v2 rows. A v1 database with three rows is migrated to v2; the old
     * rows must read back {@code pinned=0}, {@code auto_settle=1},
     * {@code auto_settle_suppressed=0} and {@code NULL} everywhere else, with
     * every v1 column intact. Dumps the schema and rows before and after into
     * {@code build/upgrade} for the QA evidence.
     */
    @Test
    void v1ToV2UpgradeKeepsRowsAndDefaultsNewColumns() throws Exception {
        db.migrate(List.of(Migrations.v1()));
        insertV1Row("s-1", "alice", "alpha", "/w/1", "m1", "p1", 1000, 1001);
        insertV1Row("s-2", "alice", "beta", "/w/2", null, null, 2000, 2001);
        insertV1Row("s-3", "bob", "gamma", "/w/3", "m2", "p2", 3000, 3001);

        String beforeSchema = schemaDump();
        String beforeRows = rowsDump(V1_COLUMNS);
        writeEvidence("before.sql", beforeSchema);

        db.migrate(Migrations.all());

        String afterSchema = schemaDump();
        String afterRows = rowsDump(allColumns());
        writeEvidence("after.sql", afterSchema);
        writeEvidence("rows.json", "{\n  \"before\": [\n" + beforeRows
                + "\n  ],\n  \"after\": [\n" + afterRows + "\n  ]\n}\n");

        assertThat(afterSchema).contains("pinned INT DEFAULT 0");
        assertThat(afterSchema).contains("auto_settle INT DEFAULT 1");
        assertThat(afterSchema).contains("auto_settle_suppressed INT DEFAULT 0");
        assertThat(afterSchema).contains("settled_reason TEXT");

        SessionStore store = new SessionStoreImpl(db);
        List<Session> rows = store.list(SessionStore.StatusFilter.ALL);
        assertThat(rows).hasSize(3);

        for (Session row : rows) {
            assertThat(row.pinned()).as("pinned default on pre-v2 row %s", row.id()).isFalse();
            assertThat(row.autoSettle()).as("auto_settle default on pre-v2 row %s", row.id()).isTrue();
            assertThat(row.autoSettleSuppressed())
                    .as("auto_settle_suppressed default on pre-v2 row %s", row.id()).isFalse();
            assertThat(row.pinnedOrder()).as("pinned_order on pre-v2 row %s", row.id()).isNull();
            assertThat(row.settledAt()).as("settled_at on pre-v2 row %s", row.id()).isNull();
            assertThat(row.snoozedUntil()).as("snoozed_until on pre-v2 row %s", row.id()).isNull();
            assertThat(row.archivedAt()).as("archived_at on pre-v2 row %s", row.id()).isNull();
            assertThat(row.sortOrder()).as("sort_order on pre-v2 row %s", row.id()).isNull();
            assertThat(row.settledReason()).as("settled_reason on pre-v2 row %s", row.id()).isNull();
        }

        Session first = store.get("s-1").orElseThrow();
        assertThat(first.accountId()).isEqualTo("alice");
        assertThat(first.title()).isEqualTo("alpha");
        assertThat(first.workdir()).isEqualTo("/w/1");
        assertThat(first.model()).isEqualTo("m1");
        assertThat(first.providerId()).isEqualTo("p1");
        assertThat(first.status()).isEqualTo("active");
        assertThat(first.createdAt()).isEqualTo(1000);
        assertThat(first.updatedAt()).isEqualTo(1001);

        Session second = store.get("s-2").orElseThrow();
        assertThat(second.model()).isNull();
        assertThat(second.providerId()).isNull();
        assertThat(second.createdAt()).isEqualTo(2000);
    }

    /**
     * {@code list()} over a freshly upgraded v1 database keeps the v1 order:
     * every lifecycle position is unset, so the view falls back to
     * {@code created_at DESC}.
     */
    @Test
    void listOrderUnchangedAfterUpgrade() {
        db.migrate(List.of(Migrations.v1()));
        insertV1Row("s-1", "alice", "alpha", "/w/1", null, null, 1000, 1000);
        insertV1Row("s-2", "alice", "beta", "/w/2", null, null, 2000, 2000);
        insertV1Row("s-3", "alice", "gamma", "/w/3", null, null, 3000, 3000);

        db.migrate(Migrations.all());

        SessionStore store = new SessionStoreImpl(db);
        assertThat(store.list("alice"))
                .extracting(Session::id)
                .containsExactly("s-3", "s-2", "s-1");
    }

    /**
     * Negative-path probes for the QA transcript: re-running v2 on a v2
     * database is a no-op guarded by the version table (the raw SQL itself is
     * not idempotent), and a patch carrying {@code pinned} on an unknown
     * session throws {@link PluginException}. Writes
     * {@code build/upgrade/negative.txt}.
     */
    @Test
    void negativeProbes() throws Exception {
        db.migrate(Migrations.all());
        insertV1Row("s-1", "alice", "alpha", "/w/1", null, null, 1000, 1000);
        String schemaAfterFirst = schemaDump();
        List<Integer> versionsAfterFirst = appliedVersions();

        db.migrate(Migrations.all());
        String schemaAfterSecond = schemaDump();
        List<Integer> versionsAfterSecond = appliedVersions();

        assertThat(versionsAfterFirst).containsExactly(1, 2);
        assertThat(versionsAfterSecond).isEqualTo(versionsAfterFirst);
        assertThat(schemaAfterSecond).isEqualTo(schemaAfterFirst);

        String rawFailure;
        try {
            db.write(connection -> {
                try (Statement statement = connection.createStatement()) {
                    for (String piece : Migrations.v2().sql().split(";")) {
                        if (!piece.isBlank()) {
                            statement.execute(piece);
                        }
                    }
                }
                return null;
            });
            rawFailure = "unexpectedly succeeded";
        } catch (PluginException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            rawFailure = cause.getClass().getSimpleName() + ": " + cause.getMessage();
        }
        assertThat(rawFailure).contains("duplicate column");

        String patchFailure;
        try {
            new SessionStoreImpl(db).patch("missing-session",
                    new SessionStore.Patch(null, null, null, null, null,
                            true, null, null, null, null, null, null, null, null));
            patchFailure = "unexpectedly succeeded";
        } catch (PluginException e) {
            patchFailure = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        assertThat(patchFailure).contains("not found");

        writeEvidence("negative.txt", """
                T71 negative probes
                ===================

                1. re-running v2 on a v2 database is a no-op
                   - first migrate(all()) applied versions %s and recorded them in _jhin_plugin_schema
                   - second migrate(all()) applied nothing: versions still %s, schema unchanged
                   OK: migration idempotence holds; the version table is the guard

                2. raw v2 SQL re-applied outside the bookkeeper fails
                   - executing the v2 script again directly: %s
                   OK: the SQL itself is not idempotent; only the bookkeeper makes re-runs safe

                3. patch with pinned on an unknown session throws
                   - store.patch("missing-session", Patch(pinned=true, ...)) threw %s
                   OK: unknown-session patch fails loudly
                """.formatted(versionsAfterFirst, versionsAfterSecond, rawFailure, patchFailure));
    }

    private void insertV1Row(String id, String accountId, String title, String workdir,
            String model, String providerId, long createdAt, long updatedAt) {
        db.write(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_sessions_sessions"
                            + "(id, account_id, title, workdir, model, provider_id, status,"
                            + " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)")) {
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
            return null;
        });
    }

    private String schemaDump() {
        return db.read(connection -> {
            StringBuilder out = new StringBuilder();
            try (Statement statement = connection.createStatement();
                    ResultSet rs = statement.executeQuery(
                            "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")) {
                while (rs.next()) {
                    out.append("-- ").append(rs.getString(1)).append('\n')
                            .append(rs.getString(2)).append(";\n\n");
                }
            }
            return out.toString();
        });
    }

    private List<Integer> appliedVersions() {
        return db.read(connection -> {
            List<Integer> out = new ArrayList<>();
            try (Statement statement = connection.createStatement();
                    ResultSet rs = statement.executeQuery(
                            "SELECT version FROM _jhin_plugin_schema"
                                    + " WHERE plugin_id = 'jhin.sessions' ORDER BY version")) {
                while (rs.next()) {
                    out.add(rs.getInt(1));
                }
            }
            return out;
        });
    }

    private String rowsDump(List<String> columns) {
        return db.read(connection -> {
            List<String> rows = new ArrayList<>();
            try (Statement statement = connection.createStatement();
                    ResultSet rs = statement.executeQuery(
                            "SELECT * FROM jhin_sessions_sessions ORDER BY created_at, id")) {
                while (rs.next()) {
                    rows.add(rowJson(rs, columns));
                }
            }
            return String.join(",\n", rows);
        });
    }

    private static String rowJson(ResultSet rs, List<String> columns) throws SQLException {
        StringBuilder out = new StringBuilder("    {");
        for (int i = 0; i < columns.size(); i++) {
            if (i > 0) {
                out.append(", ");
            }
            String column = columns.get(i);
            out.append('"').append(column).append("\": ");
            Object value = rs.getObject(column);
            if (value == null) {
                out.append("null");
            } else if (value instanceof Number) {
                out.append(value);
            } else {
                out.append('"').append(value.toString()
                        .replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
            }
        }
        return out.append('}').toString();
    }

    private static List<String> allColumns() {
        List<String> all = new ArrayList<>(V1_COLUMNS);
        all.addAll(LIFECYCLE_COLUMNS);
        return all;
    }

    private static void writeEvidence(String name, String content) throws Exception {
        Files.createDirectories(EVIDENCE_DIR);
        Files.writeString(EVIDENCE_DIR.resolve(name), content);
    }
}