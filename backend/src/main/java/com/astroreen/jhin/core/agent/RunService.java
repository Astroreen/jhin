package com.astroreen.jhin.core.agent;

import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.events.EventTypes;
import com.astroreen.jhin.core.llm.ProviderRegistry;
import com.astroreen.jhin.core.llm.ProviderRegistry.ProviderRecord;
import com.astroreen.jhin.core.tools.ToolRegistry;
import dev.langchain4j.model.chat.ChatModel;
import jakarta.annotation.PreDestroy;
import java.nio.file.Path;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * Жизненный цикл run'ов: синхронное создание строки {@code runs} + события, асинхронное
 * исполнение {@link AgentLoop} на выделенном пуле потоков, отмена, lookup.
 *
 * <p>{@link #startRun} возвращает runId сразу после того, как строка run'а и событие
 * {@code user_message} гарантированно в логе (WriteQueue join) — дальше работа идёт в
 * фоне. Модель/провайдер копируются из строки {@code sessions}; отсутствующая сессия —
 * {@link IllegalArgumentException}. Проблемы провайдера возникают уже в фоне и
 * финализируют run как ERROR.
 *
 * <p>Отмена ({@link #cancel}) — кооперативная: флаг {@link RunContext} плюс
 * {@code ToolContext.cancel()}; неизвестный или уже завершённый run — no-op.
 */
@Service
public class RunService {

    private static final Logger log = LoggerFactory.getLogger(RunService.class);

    private static final String SQL_SELECT_SESSION =
            "SELECT id, account_id, title, workdir, model, provider_id FROM sessions WHERE id = ?";
    private static final String SQL_INSERT_RUN =
            "INSERT INTO runs (id, session_id, status, model, provider_id, usage_json, error, started_at, ended_at)"
                    + " VALUES (?, ?, 'RUNNING', ?, ?, NULL, NULL, ?, NULL)";
    private static final String SQL_SELECT_RUN =
            "SELECT id, session_id, status, model, provider_id, error FROM runs WHERE id = ?";

    private final JdbcClient jdbcClient;
    private final WriteQueue writeQueue;
    private final EventLogService eventLog;
    private final ProviderRegistry providerRegistry;
    private final AgentLoop agentLoop;
    private final Map<String, RunContext> activeRuns = new ConcurrentHashMap<>();
    private final AtomicLong threadCounter = new AtomicLong();
    private final ExecutorService executor = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "jhin-run-" + threadCounter.incrementAndGet());
        thread.setDaemon(true);
        return thread;
    });

    @Autowired
    public RunService(
            JdbcClient jdbcClient,
            WriteQueue writeQueue,
            EventLogService eventLog,
            SystemPromptBuilder systemPromptBuilder,
            ToolRegistry toolRegistry,
            ProviderRegistry providerRegistry) {
        this.jdbcClient = jdbcClient;
        this.writeQueue = writeQueue;
        this.eventLog = eventLog;
        this.providerRegistry = providerRegistry;
        this.agentLoop = new AgentLoop(systemPromptBuilder, toolRegistry, eventLog, writeQueue, jdbcClient);
    }

    /**
     * Создаёт run: строка {@code runs} (RUNNING, model/provider_id из {@code sessions}) и
     * событие {@code user_message} пишутся синхронно, исполнение уходит в фон.
     *
     * @return идентификатор run'а (UUID)
     * @throws IllegalArgumentException сессии нет или она принадлежит другому аккаунту
     */
    public String startRun(String sessionId, String accountId, String userText) {
        if (userText == null) {
            throw new IllegalArgumentException("userText must not be null");
        }
        SessionRow session = jdbcClient
                .sql(SQL_SELECT_SESSION)
                .param(sessionId)
                .query(RunService::mapSession)
                .optional()
                .orElseThrow(() -> new IllegalArgumentException("unknown session: " + sessionId));
        if (!session.accountId().equals(accountId)) {
            throw new IllegalArgumentException("unknown session: " + sessionId);
        }

        String runId = UUID.randomUUID().toString();
        String startedAt = Instant.now().toString();
        writeQueue.submit(() -> jdbcClient
                        .sql(SQL_INSERT_RUN)
                        .param(runId)
                        .param(sessionId)
                        .param(session.model())
                        .param(session.providerId())
                        .param(startedAt)
                        .update())
                .join();
        eventLog.append(sessionId, EventTypes.USER_MESSAGE, Map.of("text", userText)).join();

        RunContext ctx = new RunContext(
                runId,
                sessionId,
                accountId,
                Path.of(session.workdir()),
                session.model(),
                session.providerId());
        activeRuns.put(runId, ctx);
        executor.execute(() -> executeRun(ctx));
        return runId;
    }

    /** Отмена run'а: неизвестный, null или завершённый — no-op. */
    public void cancel(String runId) {
        if (runId == null) {
            return;
        }
        RunContext ctx = activeRuns.get(runId);
        if (ctx != null) {
            ctx.cancel();
        }
    }

    /** Строка {@code runs} по id (для последующих задач/контроллеров). */
    public Optional<RunRecord> findRun(String runId) {
        return jdbcClient.sql(SQL_SELECT_RUN).param(runId).query(RunService::mapRun).optional();
    }

    private void executeRun(RunContext ctx) {
        try {
            Object model = resolveModel(ctx);
            agentLoop.run(ctx, model);
        } catch (RuntimeException e) {
            log.warn("Run {} failed before the agent loop", ctx.runId(), e);
            agentLoop.failRun(ctx, e.getMessage() != null ? e.getMessage() : e.toString());
        } catch (Throwable t) {
            log.warn("Run {} failed unexpectedly", ctx.runId(), t);
            agentLoop.failRun(ctx, t.getMessage() != null ? t.getMessage() : t.toString());
        } finally {
            activeRuns.remove(ctx.runId());
        }
    }

    /**
     * Модель run'а: {@code providerRegistry.buildChatModel} (реальный {@link ChatModel}).
     * {@code protected} — тестовый шов: в LC4j 1.20.1 {@code ChatModel} и
     * {@code StreamingChatModel} несовместимы, streaming-мок не пройдёт через фабрику,
     * тесты подменяют модель здесь.
     */
    protected Object resolveModel(RunContext ctx) {
        ProviderRecord record;
        if (ctx.providerId() == null || ctx.providerId().isBlank()) {
            record = providerRegistry
                    .defaultOf(ctx.accountId())
                    .orElseThrow(() -> new IllegalStateException("no provider configured"));
        } else {
            record = providerRegistry
                    .find(ctx.accountId(), ctx.providerId())
                    .orElseThrow(() -> new IllegalStateException("unknown provider: " + ctx.providerId()));
        }
        return providerRegistry.buildChatModel(record);
    }

    @PreDestroy
    void shutdown() {
        executor.shutdownNow();
    }

    private static SessionRow mapSession(ResultSet rs, int rowNum) throws SQLException {
        return new SessionRow(
                rs.getString("id"),
                rs.getString("account_id"),
                rs.getString("workdir"),
                rs.getString("model"),
                rs.getString("provider_id"));
    }

    private static RunRecord mapRun(ResultSet rs, int rowNum) throws SQLException {
        return new RunRecord(
                rs.getString("id"),
                rs.getString("session_id"),
                rs.getString("status"),
                rs.getString("model"),
                rs.getString("provider_id"),
                rs.getString("error"));
    }

    private record SessionRow(String id, String accountId, String workdir, String model, String providerId) {}
}
