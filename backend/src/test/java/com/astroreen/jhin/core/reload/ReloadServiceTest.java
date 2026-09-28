package com.astroreen.jhin.core.reload;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.db.DatabaseConfig;
import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.sse.SseRegistry;
import com.astroreen.jhin.core.sse.SseSink;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * Unit-тесты graceful reload и регистрации workers('local'). Exit — только через шов
 * ({@link ExitHandler}-фейк + latch), никакого {@code System.exit}: тестовый JVM не умирает.
 * Prod-ветка гоняется с явным {@code devMode=false} (в exploded-контексте авто-детект
 * дал бы dev-mode).
 */
class ReloadServiceTest {

    private static final long AWAIT_MILLIS = 5_000;

    @TempDir
    Path jhinHome;

    private DataSource dataSource;
    private WriteQueue writeQueue;
    private JdbcClient jdbc;
    private MigrationRunner migrationRunner;
    private SseRegistry registry;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = DatabaseConfig.createDataSource(jhinHome);
        migrationRunner = new MigrationRunner(dataSource);
        migrationRunner.migrate();
        writeQueue = new WriteQueue();
        jdbc = JdbcClient.create(dataSource);
        registry = new SseRegistry();
        jdbc.sql("INSERT INTO accounts (id, name, created_at) VALUES ('acc-1', 'alice', '1')")
                .update();
        jdbc.sql("INSERT INTO sessions (id, account_id, title, workdir, model, provider_id, created_at, updated_at)"
                        + " VALUES ('session-1', 'acc-1', 'test', '/tmp/work', NULL, NULL, '1', '1')")
                .update();
    }

    @AfterEach
    void tearDown() {
        writeQueue.close();
    }

    @Test
    void reloadInterruptsRunningRunsClosesSinksAndExitsAfterDelay() throws Exception {
        CountDownLatch exitLatch = new CountDownLatch(1);
        AtomicInteger exitCode = new AtomicInteger(-1);
        long delayMillis = 500;
        ReloadService service = new ReloadService(
                writeQueue,
                jdbc,
                registry,
                code -> {
                    exitCode.set(code);
                    exitLatch.countDown();
                },
                delayMillis,
                false);
        String runId = insertRunningRun();
        RecordingSink sink = new RecordingSink();
        registry.register("device-1", sink);

        assertThat(service.reload()).isTrue();

        Map<String, Object> run = runRow(runId);
        assertThat(run.get("status")).isEqualTo("INTERRUPTED");
        assertThat(run.get("ended_at")).isNotNull();
        assertThat(sink.completions.get()).isEqualTo(1);
        assertThat(sink.isOpen()).isFalse();
        assertThat(registry.activeCount()).isZero();
        assertThat(exitLatch.getCount()).isEqualTo(1);

        assertThat(exitLatch.await(AWAIT_MILLIS, TimeUnit.MILLISECONDS)).isTrue();
        assertThat(exitCode.get()).isEqualTo(0);
    }

    @Test
    void reloadLeavesTerminalRunsUntouched() throws Exception {
        ReloadService service = new ReloadService(writeQueue, jdbc, registry, code -> {}, 10, false);
        String runId = insertRunningRun();
        jdbc.sql("UPDATE runs SET status = 'DONE', ended_at = 't1' WHERE id = ?")
                .param(runId)
                .update();

        assertThat(service.reload()).isTrue();

        Map<String, Object> run = runRow(runId);
        assertThat(run.get("status")).isEqualTo("DONE");
        assertThat(run.get("ended_at")).isEqualTo("t1");
    }

    @Test
    void reloadInDevModeDoesNothing() throws Exception {
        CountDownLatch exitLatch = new CountDownLatch(1);
        ReloadService service = new ReloadService(
                writeQueue,
                jdbc,
                registry,
                code -> exitLatch.countDown(),
                10,
                true);
        String runId = insertRunningRun();
        RecordingSink sink = new RecordingSink();
        registry.register("device-1", sink);

        assertThat(service.isDevMode()).isTrue();
        assertThat(service.reload()).isFalse();

        assertThat(exitLatch.await(200, TimeUnit.MILLISECONDS)).isFalse();
        assertThat(runRow(runId).get("status")).isEqualTo("RUNNING");
        assertThat(sink.isOpen()).isTrue();
        assertThat(registry.activeCount()).isEqualTo(1);
    }

    @Test
    void workerRegistrationUpsertsLocalRowIdempotently() {
        WorkerRegistration registration = new WorkerRegistration(writeQueue, jdbc, migrationRunner);
        long before = System.currentTimeMillis();

        registration.registerLocal();
        registration.registerLocal();

        List<Map<String, Object>> rows = workerRows();
        assertThat(rows).hasSize(1);
        Map<String, Object> row = rows.get(0);
        assertThat(row.get("id")).isEqualTo("local");
        assertThat(row.get("name")).isEqualTo("local");
        assertThat(row.get("status")).isEqualTo("ONLINE");
        long heartbeat = ((Number) row.get("last_heartbeat")).longValue();
        assertThat(heartbeat).isBetween(before, System.currentTimeMillis() + 1);
    }

    private String insertRunningRun() {
        String runId = UUID.randomUUID().toString();
        jdbc.sql("INSERT INTO runs (id, session_id, status, model, provider_id, started_at)"
                        + " VALUES (?, 'session-1', 'RUNNING', 'mock-model', NULL, ?)")
                .param(runId)
                .param(Instant.now().toString())
                .update();
        return runId;
    }

    private Map<String, Object> runRow(String runId) {
        return jdbc.sql("SELECT status, ended_at FROM runs WHERE id = ?")
                .param(runId)
                .query((rs, rowNum) -> {
                    Map<String, Object> row = new java.util.LinkedHashMap<>();
                    row.put("status", rs.getString("status"));
                    row.put("ended_at", rs.getString("ended_at"));
                    return row;
                })
                .single();
    }

    private List<Map<String, Object>> workerRows() {
        return jdbc.sql("SELECT id, name, status, last_heartbeat FROM workers")
                .query((rs, rowNum) -> {
                    Map<String, Object> row = new java.util.LinkedHashMap<>();
                    row.put("id", rs.getString("id"));
                    row.put("name", rs.getString("name"));
                    row.put("status", rs.getString("status"));
                    row.put("last_heartbeat", rs.getLong("last_heartbeat"));
                    return row;
                })
                .list();
    }

    /** Считает вызовы complete; потокобезопасно. */
    private static final class RecordingSink implements SseSink {

        final AtomicInteger completions = new AtomicInteger();
        private final AtomicInteger open = new AtomicInteger(1);

        @Override
        public void send(String frame) {
            // тесту не нужны фреймы
        }

        @Override
        public void comment(String text) {
            // тесту не нужны heartbeat'ы
        }

        @Override
        public void complete() {
            if (open.compareAndSet(1, 0)) {
                completions.incrementAndGet();
            }
        }

        @Override
        public boolean isOpen() {
            return open.get() == 1;
        }
    }
}
