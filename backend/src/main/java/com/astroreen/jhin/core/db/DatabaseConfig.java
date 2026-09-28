package com.astroreen.jhin.core.db;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import javax.sql.DataSource;
import org.sqlite.SQLiteConfig;
import org.sqlite.SQLiteDataSource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Сборка единственного DataSource поверх {@code ${jhin.home}/jhin.db}.
 *
 * <p>DataSource собирается вручную (без {@code spring.datasource}) — это единственная точка
 * wiring'а для {@code JdbcClient}/{@code JdbcTemplate} последующих задач. Прагмы SQLite
 * применяются на каждом новом соединении: {@code journal_mode=WAL}, {@code foreign_keys=ON},
 * {@code busy_timeout=5000}.
 */
@Configuration
public class DatabaseConfig {

    @Bean
    public DataSource dataSource(@Value("${jhin.home}") String jhinHome) throws IOException {
        return createDataSource(Path.of(jhinHome));
    }

    @Bean
    public MigrationRunner migrationRunner(DataSource dataSource) {
        return new MigrationRunner(dataSource);
    }

    /**
     * Создаёт DataSource поверх {@code jhinHome/jhin.db}: каталог и файл БД (права 0600,
     * на не-POSIX файловых системах — без chmod), прагмы SQLite через {@link SQLiteConfig}.
     */
    public static DataSource createDataSource(Path jhinHome) throws IOException {
        Files.createDirectories(jhinHome);
        Path dbFile = jhinHome.resolve("jhin.db");
        if (Files.notExists(dbFile)) {
            Files.createFile(dbFile);
        }
        try {
            Files.setPosixFilePermissions(dbFile, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException e) {
            // non-POSIX (Windows) — права не выставляем
        }
        SQLiteConfig config = new SQLiteConfig();
        config.setJournalMode(SQLiteConfig.JournalMode.WAL);
        config.enforceForeignKeys(true);
        config.setBusyTimeout(5000);
        SQLiteDataSource dataSource = new SQLiteDataSource(config);
        dataSource.setUrl("jdbc:sqlite:" + dbFile.toAbsolutePath());
        return dataSource;
    }
}
