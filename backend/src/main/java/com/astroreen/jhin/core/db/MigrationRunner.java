package com.astroreen.jhin.core.db;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.sql.DataSource;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

/**
 * Самописный раннер миграций (без Flyway/Liquibase): находит classpath {@code db/V*.sql},
 * применяет файлы с версией больше текущей в возрастающем порядке. Каждый файл исполняется
 * в одной транзакции вместе с записью версии в {@code schema_version} — повторный запуск
 * ничего не делает (idempotent).
 */
public class MigrationRunner implements ApplicationRunner {

    private static final Pattern MIGRATION_FILE = Pattern.compile("V(\\d+)__.*\\.sql");
    private static final String MIGRATIONS_LOCATION = "classpath*:db/V*.sql";

    private final DataSource dataSource;

    public MigrationRunner(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    @Override
    public void run(ApplicationArguments args) {
        migrate();
    }

    public void migrate() {
        try (Connection connection = dataSource.getConnection()) {
            createVersionTableIfMissing(connection);
            int currentVersion = currentVersion(connection);
            for (Migration migration : discoverMigrations()) {
                if (migration.version() > currentVersion) {
                    apply(connection, migration);
                }
            }
        } catch (SQLException e) {
            throw new IllegalStateException("Migration failed", e);
        }
    }

    private static void createVersionTableIfMissing(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE IF NOT EXISTS schema_version (version INT NOT NULL)");
        }
    }

    private static int currentVersion(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement();
                ResultSet rs = statement.executeQuery("SELECT COALESCE(MAX(version), 0) FROM schema_version")) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static void apply(Connection connection, Migration migration) {
        try {
            connection.setAutoCommit(false);
            for (String statement : splitStatements(migration.readSql())) {
                try (Statement st = connection.createStatement()) {
                    st.execute(statement);
                }
            }
            try (PreparedStatement ps =
                    connection.prepareStatement("INSERT INTO schema_version (version) VALUES (?)")) {
                ps.setInt(1, migration.version());
                ps.executeUpdate();
            }
            connection.commit();
        } catch (SQLException | IOException e) {
            rollbackQuietly(connection);
            throw new IllegalStateException("Migration " + migration.filename() + " failed", e);
        } finally {
            restoreAutoCommit(connection);
        }
    }

    private static void rollbackQuietly(Connection connection) {
        try {
            connection.rollback();
        } catch (SQLException ignored) {
            // ошибка отката уже не важнее исходной — пробрасываем исходную
        }
    }

    private static void restoreAutoCommit(Connection connection) {
        try {
            connection.setAutoCommit(true);
        } catch (SQLException ignored) {
            // соединение уходит в пул/закрывается — состояние не критично
        }
    }

    private static List<String> splitStatements(String script) {
        List<String> statements = new ArrayList<>();
        for (String statement : script.replaceAll("--.*", "").split(";")) {
            String trimmed = statement.trim();
            if (!trimmed.isEmpty()) {
                statements.add(trimmed);
            }
        }
        return statements;
    }

    private static List<Migration> discoverMigrations() {
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver().getResources(MIGRATIONS_LOCATION);
            List<Migration> migrations = new ArrayList<>();
            for (Resource resource : resources) {
                String filename = resource.getFilename();
                if (filename == null) {
                    continue;
                }
                Matcher matcher = MIGRATION_FILE.matcher(filename);
                if (matcher.matches()) {
                    migrations.add(new Migration(Integer.parseInt(matcher.group(1)), filename, resource));
                }
            }
            migrations.sort(Comparator.comparingInt(Migration::version));
            return migrations;
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to discover migrations in " + MIGRATIONS_LOCATION, e);
        }
    }

    private record Migration(int version, String filename, Resource resource) {

        String readSql() throws IOException {
            return resource.getContentAsString(StandardCharsets.UTF_8);
        }
    }
}
