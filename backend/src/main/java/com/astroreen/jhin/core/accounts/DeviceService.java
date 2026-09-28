package com.astroreen.jhin.core.accounts;

import com.astroreen.jhin.core.db.WriteQueue;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * Device-токены: 256 бит энтропии ({@link SecureRandom}) → base64url без padding (43 символа).
 * В БД — только SHA-256 hex-хеш токена; plaintext существует ровно один вызов
 * ({@link IssuedDevice#token()}). Отзыв — мгновенный (revoked=1), lookup отвергает отозванные.
 */
@Service
public class DeviceService {

    private static final int TOKEN_BYTES = 32;
    private static final String SQL_INSERT =
            "INSERT INTO devices (id, account_id, name, token_hash, created_at, revoked)"
                    + " VALUES (?, ?, ?, ?, ?, 0)";
    private static final String SQL_BY_TOKEN =
            "SELECT id, account_id, name, revoked, last_seen, last_ip FROM devices WHERE token_hash = ?";
    private static final String SQL_TOUCH = "UPDATE devices SET last_seen = ?, last_ip = ? WHERE id = ?";
    private static final String SQL_REVOKE = "UPDATE devices SET revoked = 1 WHERE id = ?";
    private static final String SQL_LIST =
            "SELECT id, account_id, name, revoked, last_seen, last_ip FROM devices WHERE account_id = ?"
                    + " ORDER BY created_at, id";

    private final JdbcClient jdbcClient;
    private final WriteQueue writeQueue;
    private final SecureRandom secureRandom = new SecureRandom();

    @Autowired
    public DeviceService(JdbcClient jdbcClient, WriteQueue writeQueue) {
        this.jdbcClient = jdbcClient;
        this.writeQueue = writeQueue;
    }

    public IssuedDevice issueDevice(String accountId, String deviceName) {
        byte[] raw = new byte[TOKEN_BYTES];
        secureRandom.nextBytes(raw);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        String tokenHash = Hashes.sha256Hex(token);
        String id = UUID.randomUUID().toString();
        long createdAt = System.currentTimeMillis();
        await(writeQueue.submit(() -> {
            jdbcClient
                    .sql(SQL_INSERT)
                    .param(id)
                    .param(accountId)
                    .param(deviceName)
                    .param(tokenHash)
                    .param(createdAt)
                    .update();
            return null;
        }));
        return new IssuedDevice(id, accountId, deviceName, token);
    }

    public Optional<DevicePrincipal> lookup(String token) {
        if (token == null) {
            return Optional.empty();
        }
        String tokenHash = Hashes.sha256Hex(token);
        return jdbcClient
                .sql(SQL_BY_TOKEN)
                .param(tokenHash)
                .query(DeviceService::mapRow)
                .optional()
                .filter(device -> !device.revoked());
    }

    public void touch(String deviceId, String ip) {
        await(writeQueue.submit(() -> {
            jdbcClient.sql(SQL_TOUCH).param(System.currentTimeMillis()).param(ip).param(deviceId).update();
            return null;
        }));
    }

    public boolean revokeDevice(String deviceId) {
        return await(writeQueue.submit(() -> jdbcClient.sql(SQL_REVOKE).param(deviceId).update())) == 1;
    }

    public List<DevicePrincipal> listDevices(String accountId) {
        return jdbcClient.sql(SQL_LIST).param(accountId).query(DeviceService::mapRow).list();
    }

    private static DevicePrincipal mapRow(ResultSet rs, int rowNum) throws SQLException {
        long lastSeen = rs.getLong("last_seen");
        Long lastSeenValue = rs.wasNull() ? null : lastSeen;
        return new DevicePrincipal(
                rs.getString("id"),
                rs.getString("account_id"),
                rs.getString("name"),
                rs.getInt("revoked") != 0,
                lastSeenValue,
                rs.getString("last_ip"));
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
}
