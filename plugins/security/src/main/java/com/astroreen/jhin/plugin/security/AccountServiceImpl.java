/**
 * SQLite-backed {@link AccountDirectory} over the {@code jhin_security_accounts}
 * table. Reads go through {@code DbAccess.read}, writes through the serialized
 * {@code DbAccess.write} lane. The unique-name check runs inside the write
 * unit, so concurrent creates cannot race past it.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.plugin.security.api.AccountDirectory;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import com.astroreen.jhin.sdk.db.DbAccess;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

final class AccountServiceImpl implements AccountDirectory {

    private final DbAccess db;
    private final Clock clock;

    AccountServiceImpl(DbAccess db) {
        this(db, Clock.systemUTC());
    }

    AccountServiceImpl(DbAccess db, Clock clock) {
        this.db = db;
        this.clock = clock;
    }

    @Override
    public Account create(String name) {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("name must not be null or blank");
        }
        String id = UUID.randomUUID().toString();
        long now = clock.millis();
        return db.write(connection -> {
            try (PreparedStatement find = connection.prepareStatement(
                    "SELECT id FROM jhin_security_accounts WHERE name = ?")) {
                find.setString(1, name);
                try (ResultSet rs = find.executeQuery()) {
                    if (rs.next()) {
                        throw new SecurityException(SecurityException.CODE_CONFLICT, 409,
                                "account name already exists: " + name);
                    }
                }
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_security_accounts(id, name, created_at) VALUES (?, ?, ?)")) {
                insert.setString(1, id);
                insert.setString(2, name);
                insert.setLong(3, now);
                insert.executeUpdate();
            }
            return new Account(id, name, now);
        });
    }

    @Override
    public Optional<Account> findById(String id) {
        return find("id", id);
    }

    @Override
    public Optional<Account> findByName(String name) {
        return find("name", name);
    }

    @Override
    public List<Account> list() {
        return db.read(connection -> {
            List<Account> out = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT * FROM jhin_security_accounts ORDER BY created_at, id");
                    ResultSet rs = query.executeQuery()) {
                while (rs.next()) {
                    out.add(map(rs));
                }
            }
            return List.copyOf(out);
        });
    }

    private Optional<Account> find(String column, String value) {
        return db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT * FROM jhin_security_accounts WHERE " + column + " = ?")) {
                query.setString(1, value);
                try (ResultSet rs = query.executeQuery()) {
                    return rs.next() ? Optional.of(map(rs)) : Optional.empty();
                }
            }
        });
    }

    private static Account map(ResultSet rs) throws SQLException {
        return new Account(
                rs.getString("id"),
                rs.getString("name"),
                rs.getLong("created_at"));
    }
}
