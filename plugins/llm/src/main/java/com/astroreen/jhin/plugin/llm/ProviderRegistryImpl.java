/**
 * SQLite-backed {@link ProviderRegistry} over the {@code jhin_llm_providers}
 * table.
 *
 * <p>Factories are discovered live through the service registry on every
 * lookup (first-wins by {@code format()}), so a factory plugin installed later
 * is visible without a restart. Reads and writes are scoped by account; only
 * {@code create} ever touches the api key column, and no read selects it.
 */
package com.astroreen.jhin.plugin.llm;

import com.astroreen.jhin.plugin.llm.api.LlmProviderFactory;
import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import com.astroreen.jhin.plugin.llm.api.ProviderException;
import com.astroreen.jhin.plugin.llm.api.ProviderRecord;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.sdk.db.DbAccess;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;

final class ProviderRegistryImpl implements ProviderRegistry {

    private final DbAccess db;
    private final Supplier<List<LlmProviderFactory>> factories;

    ProviderRegistryImpl(DbAccess db, Supplier<List<LlmProviderFactory>> factories) {
        this.db = db;
        this.factories = factories;
    }

    @Override
    public ProviderRecord create(String format, ProviderConfig cfg) {
        return create(LOCAL_ACCOUNT, format, cfg);
    }

    @Override
    public ProviderRecord create(String accountId, String format, ProviderConfig cfg) {
        requireText(accountId, "accountId");
        requireText(format, "format");
        if (cfg == null) {
            throw new IllegalArgumentException("cfg must not be null");
        }
        LlmProviderFactory factory = resolveFactory(format);
        // Fail fast on a configuration the format cannot honour; the model
        // itself is rebuilt on demand by consumers holding the same config.
        factory.create(cfg);
        String id = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        return db.write(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_llm_providers"
                            + "(id, account_id, format, api_key_enc, model, base_url, created_at)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, id);
                insert.setString(2, accountId);
                insert.setString(3, format);
                insert.setString(4, cfg.apiKey());
                insert.setString(5, cfg.model());
                insert.setString(6, cfg.baseUrl());
                insert.setLong(7, now);
                insert.executeUpdate();
            }
            return new ProviderRecord(id, accountId, format, cfg.model(), cfg.baseUrl(), now);
        });
    }

    @Override
    public List<ProviderRecord> list(String accountId) {
        requireText(accountId, "accountId");
        return db.read(connection -> {
            List<ProviderRecord> out = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT id, account_id, format, model, base_url, created_at"
                            + " FROM jhin_llm_providers WHERE account_id = ?"
                            + " ORDER BY created_at DESC, id")) {
                query.setString(1, accountId);
                try (ResultSet rs = query.executeQuery()) {
                    while (rs.next()) {
                        out.add(map(rs));
                    }
                }
            }
            return List.copyOf(out);
        });
    }

    @Override
    public Optional<ProviderRecord> get(String accountId, String id) {
        requireText(accountId, "accountId");
        requireText(id, "id");
        return db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT id, account_id, format, model, base_url, created_at"
                            + " FROM jhin_llm_providers WHERE id = ? AND account_id = ?")) {
                query.setString(1, id);
                query.setString(2, accountId);
                try (ResultSet rs = query.executeQuery()) {
                    return rs.next() ? Optional.of(map(rs)) : Optional.empty();
                }
            }
        });
    }

    @Override
    public boolean delete(String accountId, String id) {
        requireText(accountId, "accountId");
        requireText(id, "id");
        return db.write(connection -> {
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM jhin_llm_providers WHERE id = ? AND account_id = ?")) {
                delete.setString(1, id);
                delete.setString(2, accountId);
                return delete.executeUpdate() > 0;
            }
        });
    }

    @Override
    public List<String> formats() {
        return factories.get().stream()
                .map(LlmProviderFactory::format)
                .filter(value -> value != null && !value.isBlank())
                .distinct()
                .sorted()
                .toList();
    }

    private LlmProviderFactory resolveFactory(String format) {
        for (LlmProviderFactory factory : factories.get()) {
            if (factory != null && format.equals(factory.format())) {
                return factory;
            }
        }
        throw new ProviderException(ProviderException.CODE_UNKNOWN_FORMAT, 400,
                "no factory for '" + format + "'; available: " + available());
    }

    private String available() {
        return formats().toString();
    }

    private static ProviderRecord map(ResultSet rs) throws SQLException {
        return new ProviderRecord(
                rs.getString("id"),
                rs.getString("account_id"),
                rs.getString("format"),
                rs.getString("model"),
                rs.getString("base_url"),
                rs.getLong("created_at"));
    }

    private static void requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be null or blank");
        }
    }
}
