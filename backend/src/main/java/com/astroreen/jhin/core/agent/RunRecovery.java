package com.astroreen.jhin.core.agent;

import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import java.time.Instant;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Восстановление после рестарта: все run'ы, оставшиеся в RUNNING (процесс упал или был
 * убит), переводятся в INTERRUPTED с проставленным {@code ended_at}. Повторный запуск
 * безопасен — обновляются только строки в RUNNING.
 *
 * <p>Порядок ApplicationRunner'ов не гарантирован, поэтому перед UPDATE вызывается
 * {@link MigrationRunner#migrate()} (идемпотентно) — на свежей БД таблица {@code runs}
 * гарантированно существует.
 */
@Component
public class RunRecovery implements ApplicationRunner {

    private static final String SQL_INTERRUPT =
            "UPDATE runs SET status = 'INTERRUPTED', ended_at = ? WHERE status = 'RUNNING'";

    private final WriteQueue writeQueue;
    private final JdbcClient jdbcClient;
    private final MigrationRunner migrationRunner;

    @Autowired
    public RunRecovery(WriteQueue writeQueue, JdbcClient jdbcClient, MigrationRunner migrationRunner) {
        this.writeQueue = writeQueue;
        this.jdbcClient = jdbcClient;
        this.migrationRunner = migrationRunner;
    }

    @Override
    public void run(ApplicationArguments args) {
        migrationRunner.migrate();
        String endedAt = Instant.now().toString();
        writeQueue.submit(() -> jdbcClient.sql(SQL_INTERRUPT).param(endedAt).update()).join();
    }
}
