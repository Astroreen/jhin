package com.astroreen.jhin.core.db;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class MigrationRunnerTest {

    private static final Set<String> DOMAIN_TABLES =
            Set.of("accounts", "devices", "enrollment_codes", "sessions", "events", "runs", "providers", "workers");

    @TempDir
    Path jhinHome;

    @Test
    void firstRunCreatesAllTablesSecondRunIsIdempotent() throws Exception {
        DataSource dataSource = DatabaseConfig.createDataSource(jhinHome);
        MigrationRunner runner = new MigrationRunner(dataSource);

        runner.migrate();

        assertThat(jhinHome.resolve("jhin.db")).exists();
        assertThat(tableNames(dataSource))
                .containsExactlyInAnyOrderElementsOf(allTables())
                .doesNotHaveDuplicates();
        assertThat(currentVersion(dataSource)).isEqualTo(1);

        runner.migrate();

        assertThat(currentVersion(dataSource)).isEqualTo(1);
        assertThat(tableNames(dataSource)).containsExactlyInAnyOrderElementsOf(allTables());
    }

    @Test
    void dbFileHasOwnerOnlyPermissions() throws Exception {
        DatabaseConfig.createDataSource(jhinHome);

        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(jhinHome.resolve("jhin.db"))))
                .isEqualTo("rw-------");
    }

    private static List<String> allTables() {
        List<String> names = new ArrayList<>(DOMAIN_TABLES);
        names.add("schema_version");
        return names;
    }

    private static Set<String> tableNames(DataSource dataSource) throws SQLException {
        try (Connection connection = dataSource.getConnection();
                Statement statement = connection.createStatement();
                ResultSet rs = statement.executeQuery(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
            Set<String> names = new LinkedHashSet<>();
            while (rs.next()) {
                names.add(rs.getString(1));
            }
            return names;
        }
    }

    private static int currentVersion(DataSource dataSource) throws SQLException {
        try (Connection connection = dataSource.getConnection();
                Statement statement = connection.createStatement();
                ResultSet rs = statement.executeQuery("SELECT COALESCE(MAX(version), 0) FROM schema_version")) {
            rs.next();
            return rs.getInt(1);
        }
    }
}
