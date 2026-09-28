package com.astroreen.jhin.core.sessions;

import com.astroreen.jhin.api.dto.SessionResponse;
import com.astroreen.jhin.core.agent.RunService;
import com.astroreen.jhin.core.db.WriteQueue;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Доступ к сессиям аккаунта: CRUD, поиск/отмена активного run'а, штамп {@code updated_at}.
 * Записи — только через {@link WriteQueue}, чтение — {@link JdbcClient}. Авторизация ресурса —
 * {@link #findByIdAndAccountId}: чужая и несуществующая сессия неразличимы (empty).
 *
 * <p>{@link #delete} каскадит runs → events → sessions одной транзакцией (FK-порядок).
 * {@code updated_at} обновляется при create/patch/отправке сообщения ({@link #touch}).
 */
@Service
public class SessionService {

    private static final String SQL_COLUMNS =
            "id, account_id, title, workdir, model, provider_id, created_at, updated_at";
    private static final String SQL_INSERT =
            "INSERT INTO sessions (id, account_id, title, workdir, model, provider_id, created_at, updated_at)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    private static final String SQL_LIST =
            "SELECT " + SQL_COLUMNS + " FROM sessions WHERE account_id = ? ORDER BY updated_at DESC";
    private static final String SQL_BY_ID =
            "SELECT " + SQL_COLUMNS + " FROM sessions WHERE id = ? AND account_id = ?";
    private static final String SQL_UPDATE =
            "UPDATE sessions SET title = ?, model = ?, provider_id = ?, updated_at = ?"
                    + " WHERE id = ? AND account_id = ?";
    private static final String SQL_TOUCH = "UPDATE sessions SET updated_at = ? WHERE id = ?";
    private static final String SQL_DELETE_RUNS = "DELETE FROM runs WHERE session_id = ?";
    private static final String SQL_DELETE_EVENTS = "DELETE FROM events WHERE session_id = ?";
    private static final String SQL_DELETE_SESSION = "DELETE FROM sessions WHERE id = ? AND account_id = ?";
    private static final String SQL_ACTIVE_RUN =
            "SELECT id FROM runs WHERE session_id = ? AND status = 'RUNNING'"
                    + " ORDER BY started_at DESC LIMIT 1";

    private final JdbcClient jdbcClient;
    private final WriteQueue writeQueue;
    private final RunService runService;
    private final TransactionTemplate transactionTemplate;

    @Autowired
    public SessionService(
            JdbcClient jdbcClient,
            WriteQueue writeQueue,
            RunService runService,
            TransactionTemplate transactionTemplate) {
        this.jdbcClient = jdbcClient;
        this.writeQueue = writeQueue;
        this.runService = runService;
        this.transactionTemplate = transactionTemplate;
    }

    /** Создаёт сессию (id = UUID, createdAt = updatedAt = сейчас, ISO Instant). */
    public SessionResponse create(
            String accountId, String title, String workdir, String model, String providerId) {
        String id = UUID.randomUUID().toString();
        String now = Instant.now().toString();
        await(writeQueue.submit(() -> {
            jdbcClient
                    .sql(SQL_INSERT)
                    .param(id)
                    .param(accountId)
                    .param(title)
                    .param(workdir)
                    .param(model)
                    .param(providerId)
                    .param(now)
                    .param(now)
                    .update();
            return null;
        }));
        return new SessionResponse(id, title, workdir, model, providerId, now, now);
    }

    /** Сессии аккаунта, {@code updated_at DESC}. */
    public List<SessionResponse> list(String accountId) {
        return jdbcClient.sql(SQL_LIST).param(accountId).query(SessionService::mapRow).list().stream()
                .map(SessionService::toResponse)
                .toList();
    }

    /** Сессия аккаунта или empty (нет/чужая — неразличимо, контроллер отдаёт 404). */
    public Optional<SessionResponse> get(String accountId, String id) {
        return findByIdAndAccountId(id, accountId).map(SessionService::toResponse);
    }

    /**
     * Частичный PATCH: {@code null} в поле = не менять (клиент шлёт только явные поля).
     * Обновляет {@code updated_at}. Пусто — сессии нет/чужая.
     */
    public Optional<SessionResponse> update(
            String accountId, String id, String title, String model, String providerId) {
        Optional<SessionRow> current = findByIdAndAccountId(id, accountId);
        if (current.isEmpty()) {
            return Optional.empty();
        }
        SessionRow row = current.get();
        String newTitle = title != null ? title : row.title();
        String newModel = model != null ? model : row.model();
        String newProviderId = providerId != null ? providerId : row.providerId();
        String updatedAt = Instant.now().toString();
        await(writeQueue.submit(() -> {
            jdbcClient
                    .sql(SQL_UPDATE)
                    .param(newTitle)
                    .param(newModel)
                    .param(newProviderId)
                    .param(updatedAt)
                    .param(id)
                    .param(accountId)
                    .update();
            return null;
        }));
        return Optional.of(new SessionResponse(
                id, newTitle, row.workdir(), newModel, newProviderId, row.createdAt(), updatedAt));
    }

    /**
     * Каскадный delete (runs → events → sessions) одной транзакцией через {@link WriteQueue}.
     * Чужая/несуществующая — false без единого DELETE.
     */
    public boolean delete(String accountId, String id) {
        if (findByIdAndAccountId(id, accountId).isEmpty()) {
            return false;
        }
        await(writeQueue.submit(() -> {
            transactionTemplate.executeWithoutResult(status -> {
                jdbcClient.sql(SQL_DELETE_RUNS).param(id).update();
                jdbcClient.sql(SQL_DELETE_EVENTS).param(id).update();
                jdbcClient.sql(SQL_DELETE_SESSION).param(id).param(accountId).update();
            });
            return null;
        }));
        return true;
    }

    /** Штамп {@code updated_at} при отправке сообщения в сессию. */
    public void touch(String sessionId) {
        String now = Instant.now().toString();
        await(writeQueue.submit(() -> {
            jdbcClient.sql(SQL_TOUCH).param(now).param(sessionId).update();
            return null;
        }));
    }

    /** Последний RUNNING-run сессии (по {@code started_at DESC}). */
    public Optional<String> findActiveRunId(String sessionId) {
        return jdbcClient
                .sql(SQL_ACTIVE_RUN)
                .param(sessionId)
                .query((rs, rowNum) -> rs.getString("id"))
                .optional();
    }

    /**
     * Отменяет активный run сессии аккаунта ({@link RunService#cancel}). Пусто — сессии
     * нет/чужая. {@link CancelResult#runId} {@code null} — активного run не было.
     */
    public Optional<CancelResult> cancelActive(String sessionId, String accountId) {
        if (findByIdAndAccountId(sessionId, accountId).isEmpty()) {
            return Optional.empty();
        }
        String runId = findActiveRunId(sessionId).orElse(null);
        if (runId != null) {
            runService.cancel(runId);
        }
        return Optional.of(new CancelResult(runId));
    }

    /** Авторизация доступа к сессии: id + account_id из device-токена. */
    private Optional<SessionRow> findByIdAndAccountId(String id, String accountId) {
        return jdbcClient.sql(SQL_BY_ID).param(id).param(accountId).query(SessionService::mapRow).optional();
    }

    private static SessionRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new SessionRow(
                rs.getString("id"),
                rs.getString("account_id"),
                rs.getString("title"),
                rs.getString("workdir"),
                rs.getString("model"),
                rs.getString("provider_id"),
                rs.getString("created_at"),
                rs.getString("updated_at"));
    }

    private static SessionResponse toResponse(SessionRow row) {
        return new SessionResponse(
                row.id(),
                row.title(),
                row.workdir(),
                row.model(),
                row.providerId(),
                row.createdAt(),
                row.updatedAt());
    }

    private static <T> T await(CompletableFuture<T> future) {
        try {
            return future.join();
        } catch (CompletionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof RuntimeException runtimeException) {
                throw runtimeException;
            }
            throw new IllegalStateException(cause);
        }
    }

    /** Итог cancel: {@code runId} отменённого run'а или {@code null}, если активного не было. */
    public record CancelResult(String runId) {}

    private record SessionRow(
            String id,
            String accountId,
            String title,
            String workdir,
            String model,
            String providerId,
            String createdAt,
            String updatedAt) {}
}
