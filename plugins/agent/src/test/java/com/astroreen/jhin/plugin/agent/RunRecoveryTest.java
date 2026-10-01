/**
 * Startup recovery: rows left {@code running} become {@code error: interrupted}
 * and finished rows are never touched.
 */
package com.astroreen.jhin.plugin.agent;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

class RunRecoveryTest {

    @TempDir
    Path work;

    private TestDbAccess db;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(work);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void staleRunningRowsAreMarkedErrorInterrupted() {
        insert("r1", "running");
        insert("r2", "done");
        insert("r3", "running");

        int recovered = new RunRecovery(db, LoggerFactory.getLogger("test")).recover();

        assertThat(recovered).isEqualTo(2);
        assertThat(row("r1")).containsExactly("error", "interrupted");
        assertThat(row("r2")).containsExactly("done", null);
        assertThat(row("r3")).containsExactly("error", "interrupted");
    }

    @Test
    void recoveryIsIdempotent() {
        insert("r1", "running");
        RunRecovery recovery = new RunRecovery(db, LoggerFactory.getLogger("test"));

        assertThat(recovery.recover()).isEqualTo(1);
        assertThat(recovery.recover()).isZero();
        assertThat(row("r1")).containsExactly("error", "interrupted");
    }

    private void insert(String id, String status) {
        db.write(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_sessions_runs(id, session_id, status, started_at, ended_at, error)"
                            + " VALUES (?, 's1', ?, 1, NULL, NULL)")) {
                insert.setString(1, id);
                insert.setString(2, status);
                insert.executeUpdate();
            }
            return null;
        });
    }

    private List<String> row(String id) {
        return db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT status, error FROM jhin_sessions_runs WHERE id = ?")) {
                query.setString(1, id);
                try (ResultSet rs = query.executeQuery()) {
                    assertThat(rs.next()).isTrue();
                    List<String> row = new ArrayList<>();
                    row.add(rs.getString("status"));
                    row.add(rs.getString("error"));
                    return row;
                }
            }
        });
    }
}
