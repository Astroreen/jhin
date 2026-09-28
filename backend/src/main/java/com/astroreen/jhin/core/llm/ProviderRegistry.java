package com.astroreen.jhin.core.llm;

import com.astroreen.jhin.core.db.WriteQueue;
import dev.langchain4j.model.chat.ChatModel;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * Реестр LLM-провайдеров: account-scoped CRUD поверх таблицы providers и сборка
 * {@link ChatModel} через фабрики {@link LlmProviderFactory}.
 *
 * <p>Дубликаты форматов: первая регистрация побеждает, повторные — warn + skip
 * ({@link #register} — шов для плагинов T25). Секрент уходит в БД как есть (схема требует
 * api_key NOT NULL), но не логируется и не возвращается наружу: {@link ProviderRecord} без
 * apiKey, API-ответы без секрета.
 */
@Service
public class ProviderRegistry {

    private static final Logger log = LoggerFactory.getLogger(ProviderRegistry.class);

    private static final String SQL_INSERT =
            "INSERT INTO providers (id, account_id, name, format, base_url, api_key, model, is_default)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    private static final String SQL_CLEAR_DEFAULTS =
            "UPDATE providers SET is_default = 0 WHERE account_id = ? AND is_default = 1";
    private static final String SQL_COLUMNS = "id, account_id, name, format, base_url, model, is_default";
    private static final String SQL_LIST = "SELECT " + SQL_COLUMNS + " FROM providers WHERE account_id = ?"
            + " ORDER BY name, id";
    private static final String SQL_BY_ID = "SELECT " + SQL_COLUMNS + " FROM providers WHERE id = ?"
            + " AND account_id = ?";
    private static final String SQL_DELETE = "DELETE FROM providers WHERE id = ? AND account_id = ?";
    private static final String SQL_DEFAULT = "SELECT " + SQL_COLUMNS + " FROM providers WHERE account_id = ?"
            + " AND is_default = 1";
    private static final String SQL_API_KEY = "SELECT api_key FROM providers WHERE id = ? AND account_id = ?";

    private final JdbcClient jdbcClient;
    private final WriteQueue writeQueue;
    private final Map<String, LlmProviderFactory> factories = new LinkedHashMap<>();

    @Autowired
    public ProviderRegistry(JdbcClient jdbcClient, WriteQueue writeQueue, List<LlmProviderFactory> factories) {
        this.jdbcClient = jdbcClient;
        this.writeQueue = writeQueue;
        factories.forEach(this::register);
    }

    /** Плагины (T25): формат регистрируется один раз — первый выигрывает, повтор → warn + skip. */
    public synchronized void register(LlmProviderFactory factory) {
        String format = factory.format();
        if (factories.containsKey(format)) {
            log.warn("LlmProviderFactory for format '{}' already registered, keeping the first one", format);
            return;
        }
        factories.put(format, factory);
    }

    public synchronized Set<String> knownFormats() {
        return Collections.unmodifiableSet(new LinkedHashSet<>(factories.keySet()));
    }

    /**
     * Создаёт провайдера (id = UUID). Валидация до постановки в очередь: пустые
     * name/format/apiKey/model и неизвестный формат — {@link IllegalArgumentException}.
     * isDefault=true сначала снимает флаг с прежних default аккаунта той же задачей
     * WriteQueue (ровно один default на аккаунт). Возвращает {@link ProviderRecord} без apiKey.
     */
    public CompletableFuture<ProviderRecord> create(
            String accountId, String name, String format, String apiKey, String model, String baseUrl,
            boolean isDefault) {
        if (isBlank(name) || isBlank(format) || isBlank(apiKey) || isBlank(model)) {
            throw new IllegalArgumentException("name, format, apiKey and model must not be blank");
        }
        if (!knownFormats().contains(format)) {
            throw new IllegalArgumentException("unknown format: " + format);
        }
        String id = UUID.randomUUID().toString();
        return writeQueue.submit(() -> {
            if (isDefault) {
                jdbcClient.sql(SQL_CLEAR_DEFAULTS).param(accountId).update();
            }
            jdbcClient.sql(SQL_INSERT)
                    .param(id)
                    .param(accountId)
                    .param(name)
                    .param(format)
                    .param(baseUrl)
                    .param(apiKey)
                    .param(model)
                    .param(isDefault ? 1 : 0)
                    .update();
            return new ProviderRecord(id, accountId, name, format, model, baseUrl, isDefault);
        });
    }

    public List<ProviderRecord> list(String accountId) {
        return jdbcClient.sql(SQL_LIST).param(accountId).query(ProviderRegistry::mapRow).list();
    }

    public Optional<ProviderRecord> find(String accountId, String id) {
        return jdbcClient.sql(SQL_BY_ID).param(id).param(accountId).query(ProviderRegistry::mapRow).optional();
    }

    public boolean delete(String accountId, String id) {
        return await(writeQueue.submit(() -> jdbcClient.sql(SQL_DELETE).param(id).param(accountId).update())) == 1;
    }

    public Optional<ProviderRecord> defaultOf(String accountId) {
        return jdbcClient.sql(SQL_DEFAULT).param(accountId).query(ProviderRegistry::mapRow).optional();
    }

    /** Собирает {@link ChatModel}: apiKey достаётся из БД по id, наружу не уходит. */
    public ChatModel buildChatModel(ProviderRecord rec) {
        String apiKey = jdbcClient
                .sql(SQL_API_KEY)
                .param(rec.id())
                .param(rec.accountId())
                .query((rs, rowNum) -> rs.getString("api_key"))
                .optional()
                .orElseThrow(() -> new IllegalArgumentException("unknown provider: " + rec.id()));
        LlmProviderFactory factory;
        synchronized (this) {
            factory = factories.get(rec.format());
        }
        if (factory == null) {
            throw new IllegalArgumentException("unknown format: " + rec.format());
        }
        return factory.create(new ProviderConfig(rec.format(), apiKey, rec.model(), rec.baseUrl()));
    }

    private static ProviderRecord mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new ProviderRecord(
                rs.getString("id"),
                rs.getString("account_id"),
                rs.getString("name"),
                rs.getString("format"),
                rs.getString("model"),
                rs.getString("base_url"),
                rs.getInt("is_default") != 0);
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
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

    /**
     * Провайдер без apiKey: секрет не покидает БД/фабрику и не возвращается в API-ответах.
     */
    public record ProviderRecord(
            String id, String accountId, String name, String format, String model, String baseUrl,
            boolean isDefault) {}
}
