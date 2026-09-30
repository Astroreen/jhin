package com.astroreen.jhin.kernel.db;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.db.MigrationSpec;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class MigrationBookkeeperTest {

    private static final String PLUGIN = "demo.one";

    private static Function<String, String> env(Path home) {
        return k -> "JHIN_HOME".equals(k) ? home.toString() : null;
    }

    @Test
    void appliesTwoVersionsThenSecondApplyIsNoOp(@TempDir Path tmp) throws Exception {
        try (Database database = Database.open(env(tmp))) {
            MigrationBookkeeper bookkeeper = new MigrationBookkeeper(database);
            List<MigrationSpec> migrations = List.of(
                    new MigrationSpec(1, "CREATE TABLE demo_one_alpha (id INTEGER PRIMARY KEY, v TEXT)"),
                    new MigrationSpec(2, "CREATE TABLE demo_one_beta (id INTEGER PRIMARY KEY, v TEXT)"));
            bookkeeper.apply(PLUGIN, migrations);
            bookkeeper.apply(PLUGIN, migrations);
            assertThat(appliedVersions(database)).containsExactly(1, 2);
            assertThat(totalRows(database)).isEqualTo(2);
            assertThat(countOf(database, "demo_one_alpha")).isEqualTo(0);
            assertThat(countOf(database, "demo_one_beta")).isEqualTo(0);
        }
    }

    @Test
    void appliesVersionsInAscendingOrderEvenWhenGivenUnsorted(@TempDir Path tmp) throws Exception {
        try (Database database = Database.open(env(tmp))) {
            MigrationBookkeeper bookkeeper = new MigrationBookkeeper(database);
            bookkeeper.apply(PLUGIN, List.of(
                    new MigrationSpec(2, "CREATE TABLE demo_one_beta (id INTEGER PRIMARY KEY)"),
                    new MigrationSpec(1, "CREATE TABLE demo_one_alpha (id INTEGER PRIMARY KEY)")));
            assertThat(appliedVersions(database)).containsExactly(1, 2);
        }
    }

    @Test
    void bootstrapsKernelSchemaVersion(@TempDir Path tmp) throws Exception {
        try (Database database = Database.open(env(tmp))) {
            String version = database.read(connection -> {
                try (Statement statement = connection.createStatement();
                        ResultSet rs = statement.executeQuery(
                                "SELECT value FROM _jhin_kernel_meta WHERE key = 'kernel_schema_version'")) {
                    return rs.next() ? rs.getString(1) : null;
                }
            });
            assertThat(version).isEqualTo("1");
        }
    }

    private static List<Integer> appliedVersions(Database database) throws Exception {
        return database.read(connection -> {
            List<Integer> out = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT version FROM _jhin_plugin_schema WHERE plugin_id = ? ORDER BY version")) {
                query.setString(1, PLUGIN);
                try (ResultSet rs = query.executeQuery()) {
                    while (rs.next()) {
                        out.add(rs.getInt(1));
                    }
                }
            }
            return out;
        });
    }

    private static int totalRows(Database database) throws Exception {
        return database.read(connection -> {
            try (Statement statement = connection.createStatement();
                    ResultSet rs = statement.executeQuery("SELECT count(*) FROM _jhin_plugin_schema")) {
                return rs.next() ? rs.getInt(1) : -1;
            }
        });
    }

    private static int countOf(Database database, String table) throws Exception {
        return database.read(connection -> {
            try (Statement statement = connection.createStatement();
                    ResultSet rs = statement.executeQuery("SELECT count(*) FROM " + table)) {
                return rs.next() ? rs.getInt(1) : -1;
            }
        });
    }
}
