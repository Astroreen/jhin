package com.astroreen.jhin.core.reload;

import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Регистрация hub'а в {@code workers} строкой {@code local} (FUTURE SEAM из T5):
 * при старте UPSERT {@code id='local', name='local', status='ONLINE'} с
 * {@code last_heartbeat} в epoch millis (консистентно с accounts/devices).
 *
 * <p>Идемпотентно: {@code INSERT OR REPLACE} — повторный старт обновляет heartbeat,
 * строк ровно одна. Никакого worker-протокола сверх этого — только строка.
 *
 * <p>Порядок ApplicationRunner'ов не гарантирован, поэтому перед UPSERT вызывается
 * {@link MigrationRunner#migrate()} (идемпотентно) — таблица {@code workers} существует.
 */
@Component
public class WorkerRegistration implements ApplicationRunner {

    static final String SQL_UPSERT = "INSERT OR REPLACE INTO workers (id, name, status, last_heartbeat)"
            + " VALUES ('local', 'local', 'ONLINE', ?)";

    private final WriteQueue writeQueue;
    private final JdbcClient jdbcClient;
    private final MigrationRunner migrationRunner;

    @Autowired
    public WorkerRegistration(WriteQueue writeQueue, JdbcClient jdbcClient, MigrationRunner migrationRunner) {
        this.writeQueue = writeQueue;
        this.jdbcClient = jdbcClient;
        this.migrationRunner = migrationRunner;
    }

    @Override
    public void run(ApplicationArguments args) {
        registerLocal();
    }

    /** UPSERT строки {@code workers('local')} с текущим heartbeat. Идемпотентно. */
    public void registerLocal() {
        migrationRunner.migrate();
        writeQueue.submit(() -> jdbcClient.sql(SQL_UPSERT).param(System.currentTimeMillis()).update())
                .join();
    }
}
