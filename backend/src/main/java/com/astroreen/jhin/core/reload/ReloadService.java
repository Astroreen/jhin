package com.astroreen.jhin.core.reload;

import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.sse.SseRegistry;
import java.net.URL;
import java.security.CodeSource;
import java.security.ProtectionDomain;
import java.time.Instant;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Graceful reload hub'а (POST /admin/reload): процесс завершается сам, рестарт-луп
 * ({@code deploy/run.sh}) поднимает его заново на целой БД (миграции идемпотентны).
 *
 * <p>Порядок действия {@link #reload()} (prod-режим):
 * <ol>
 *   <li>{@code UPDATE runs SET status='INTERRUPTED', ended_at=? WHERE status='RUNNING'} —
 *       через {@link WriteQueue}, тот же SQL-подход что и RunRecovery;</li>
 *   <li>{@link SseRegistry#closeAll()} — все SSE-стримы закрыты, клиенты реконнектятся
 *       с fromSeq и перечитают /ui/manifest;</li>
 *   <li>планирует {@link ExitHandler#exit} через {@code exitDelayMillis} (daemon-поток,
 *       request-поток не блокируется) — ответ 202 успевает уйти клиенту до выхода.</li>
 * </ol>
 *
 * <p><b>Dev-режим</b> (gradle bootRun / exploded classes — нет wrapper'а, рестарт невозможен):
 * {@link #reload()} ничего не делает и возвращает {@code false}; контроллер отвечает
 * 503 {@code {"error":"restart manually"}}. Детект: свойство {@code jhin.dev-mode}
 * (boolean) — если задано явно, оно побеждает; иначе авто-детект по URL кода:
 * код грузится из jar (URL содержит {@code .jar} — {@code file:/app.jar} или nested-jar
 * Spring Boot fat jar вида {@code jar:nested:/app.jar/!BOOT-INF/classes/!/}) → prod;
 * exploded-каталог без {@code .jar} в URL → dev-mode. В тестовом контексте (exploded
 * classes) авто-детект даёт dev-mode — prod-ветка тесты гоняют с явным
 * {@code jhin.dev-mode=false}.
 */
@Component
public class ReloadService {

    static final String SQL_INTERRUPT =
            "UPDATE runs SET status = 'INTERRUPTED', ended_at = ? WHERE status = 'RUNNING'";
    static final String DEV_MODE_PROPERTY = "jhin.dev-mode";
    static final long DEFAULT_EXIT_DELAY_MILLIS = 2000;

    private final WriteQueue writeQueue;
    private final JdbcClient jdbcClient;
    private final SseRegistry sseRegistry;
    private final ExitHandler exitHandler;
    private final long exitDelayMillis;
    private final boolean devMode;

    @Autowired
    public ReloadService(
            WriteQueue writeQueue,
            JdbcClient jdbcClient,
            SseRegistry sseRegistry,
            ExitHandler exitHandler,
            Environment environment,
            @Value("${jhin.reload.exit-delay-millis:2000}") long exitDelayMillis) {
        this(writeQueue, jdbcClient, sseRegistry, exitHandler, exitDelayMillis, resolveDevMode(environment));
    }

    /**
     * Тестовый шов: свой exit-действие (никакого {@code System.exit}), свой delay,
     * явный dev-mode. Обычный тест гоняет короткий delay и ловит exit через latch.
     */
    ReloadService(
            WriteQueue writeQueue,
            JdbcClient jdbcClient,
            SseRegistry sseRegistry,
            ExitHandler exitHandler,
            long exitDelayMillis,
            boolean devMode) {
        this.writeQueue = writeQueue;
        this.jdbcClient = jdbcClient;
        this.sseRegistry = sseRegistry;
        this.exitHandler = exitHandler;
        this.exitDelayMillis = exitDelayMillis;
        this.devMode = devMode;
    }

    /** Dev-режим: рестарт невозможен (процесс не под wrapper'ом). */
    public boolean isDevMode() {
        return devMode;
    }

    /**
     * Graceful reload. Prod: INTERRUPT запущенных runs → закрыть все SSE → запланировать
     * exit через {@code exitDelayMillis}. Возвращает {@code true}, если рестарт
     * запланирован; {@code false} в dev-режиме (ничего не трогает: ни runs, ни SSE).
     */
    public boolean reload() {
        if (devMode) {
            return false;
        }
        String endedAt = Instant.now().toString();
        writeQueue.submit(() -> jdbcClient.sql(SQL_INTERRUPT).param(endedAt).update()).join();
        sseRegistry.closeAll();
        scheduleExit();
        return true;
    }

    private void scheduleExit() {
        Thread thread = new Thread(
                () -> {
                    try {
                        Thread.sleep(exitDelayMillis);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                    exitHandler.exit(0);
                },
                "jhin-reload-exit");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * Явное свойство {@code jhin.dev-mode} побеждает; иначе авто-детект: dev-mode, если
     * код не грузится из jar (см. javadoc класса).
     */
    static boolean resolveDevMode(Environment environment) {
        if (environment.containsProperty(DEV_MODE_PROPERTY)) {
            return environment.getProperty(DEV_MODE_PROPERTY, Boolean.class, false);
        }
        return !isLoadedFromJar();
    }

    /** URL кода сервиса ссылается на jar (плоский или nested-jar fat jar) или нет. */
    static boolean isLoadedFromJar() {
        ProtectionDomain domain = ReloadService.class.getProtectionDomain();
        CodeSource source = domain == null ? null : domain.getCodeSource();
        URL location = source == null ? null : source.getLocation();
        return location != null && location.toString().contains(".jar");
    }
}
