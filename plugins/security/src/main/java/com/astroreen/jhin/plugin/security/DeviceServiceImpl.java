/**
 * SQLite-backed device verification over the {@code jhin_security_devices}
 * table. Tokens are matched by SHA-256 digest — the raw token is never stored,
 * so the database alone cannot impersonate a device.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.plugin.security.api.Principal;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import com.astroreen.jhin.sdk.db.DbAccess;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;

final class DeviceServiceImpl {

    private final DbAccess db;
    private final Clock clock;

    DeviceServiceImpl(DbAccess db) {
        this(db, Clock.systemUTC());
    }

    DeviceServiceImpl(DbAccess db, Clock clock) {
        this.db = db;
        this.clock = clock;
    }

    /**
     * Verifies a raw device token and resolves its principal. Surrounding
     * whitespace is ignored; the SHA-256 digest of the remaining string is the
     * lookup key.
     *
     * @param rawToken the raw token from the {@code Authorization} header
     * @return the principal of the owning account and device
     * @throws IllegalArgumentException when {@code rawToken} is null or blank
     * @throws SecurityException         with code {@code unauthorized} (HTTP 401)
     *                                   when the token is unknown,
     *                                   {@code forbidden} (HTTP 403) when the
     *                                   device has been revoked
     */
    Principal verify(String rawToken) {
        requireText(rawToken, "rawToken");
        String tokenSha = Hashes.sha256Hex(rawToken.trim());
        return db.read(connection -> {
            String deviceId;
            String accountId;
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT id, account_id, revoked_at FROM jhin_security_devices"
                            + " WHERE token_sha256 = ?")) {
                query.setString(1, tokenSha);
                try (ResultSet rs = query.executeQuery()) {
                    if (!rs.next()) {
                        throw new SecurityException(SecurityException.CODE_UNAUTHORIZED, 401,
                                "unknown device token");
                    }
                    if (rs.getObject("revoked_at") != null) {
                        throw new SecurityException(SecurityException.CODE_FORBIDDEN, 403,
                                "device revoked");
                    }
                    deviceId = rs.getString("id");
                    accountId = rs.getString("account_id");
                }
            }
            String accountName;
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT name FROM jhin_security_accounts WHERE id = ?")) {
                query.setString(1, accountId);
                try (ResultSet rs = query.executeQuery()) {
                    if (!rs.next()) {
                        throw new SecurityException(SecurityException.CODE_NOT_FOUND, 404,
                                "unknown account: " + accountId);
                    }
                    accountName = rs.getString("name");
                }
            }
            return new Principal(accountId, accountName, deviceId);
        });
    }

    /**
     * Revokes a device: every later {@link #verify(String)} of its token fails
     * with {@code forbidden}. Idempotent — a revoked device stays revoked.
     *
     * @param deviceId the device id
     * @return {@code true} when the device exists and is now revoked,
     *         {@code false} when the id is unknown
     * @throws IllegalArgumentException when {@code deviceId} is null or blank
     */
    boolean revoke(String deviceId) {
        requireText(deviceId, "deviceId");
        long now = clock.millis();
        return db.write(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE jhin_security_devices SET revoked_at = ? WHERE id = ?")) {
                update.setLong(1, now);
                update.setString(2, deviceId);
                return update.executeUpdate() > 0;
            }
        });
    }

    /**
     * Records device liveness ({@code last_seen_at}). The caller decides how
     * often to run it — throttling is a filter concern, not this store's.
     *
     * @param deviceId the device id
     * @return {@code true} when the device exists, {@code false} otherwise
     * @throws IllegalArgumentException when {@code deviceId} is null or blank
     */
    boolean touch(String deviceId) {
        requireText(deviceId, "deviceId");
        long now = clock.millis();
        return db.write(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE jhin_security_devices SET last_seen_at = ? WHERE id = ?")) {
                update.setLong(1, now);
                update.setString(2, deviceId);
                return update.executeUpdate() > 0;
            }
        });
    }

    /**
     * Lists device rows for display: one row per device joined with its
     * account name, oldest first. The host CLI's {@code list-devices} is the
     * consumer; the raw token is never part of a row — only its digest is
     * stored at all.
     *
     * @param accountId the owning account to filter by, or {@code null} for
     *                  every device
     * @return the matching device rows
     */
    List<DeviceRow> list(String accountId) {
        return db.read(connection -> {
            List<DeviceRow> out = new ArrayList<>();
            String sql = "SELECT d.id, d.name, d.account_id, d.created_at, d.last_seen_at,"
                    + " d.revoked_at, a.name AS account_name"
                    + " FROM jhin_security_devices d"
                    + " LEFT JOIN jhin_security_accounts a ON a.id = d.account_id"
                    + (accountId == null ? "" : " WHERE d.account_id = ?")
                    + " ORDER BY d.created_at, d.id";
            try (PreparedStatement query = connection.prepareStatement(sql)) {
                if (accountId != null) {
                    query.setString(1, accountId);
                }
                try (ResultSet rs = query.executeQuery()) {
                    while (rs.next()) {
                        Long revokedAt = rs.getObject("revoked_at") == null
                                ? null
                                : rs.getLong("revoked_at");
                        out.add(new DeviceRow(
                                rs.getString("id"),
                                rs.getString("name"),
                                rs.getString("account_id"),
                                rs.getString("account_name"),
                                rs.getLong("created_at"),
                                rs.getLong("last_seen_at"),
                                revokedAt));
                    }
                }
            }
            return List.copyOf(out);
        });
    }

    private static void requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be null or blank");
        }
    }

    /**
     * One device row of the {@code jhin_security_devices} table, with the
     * owning account name resolved for display.
     *
     * @param id          unique device id
     * @param name        display name of the device
     * @param accountId   id of the owning account
     * @param accountName name of the owning account, or {@code null} when the
     *                    account row is gone
     * @param createdAt   creation time, epoch milliseconds
     * @param lastSeenAt  last liveness update, epoch milliseconds
     * @param revokedAt   revocation time, epoch milliseconds, or {@code null}
     *                    while the device is active
     */
    record DeviceRow(String id, String name, String accountId, String accountName,
            long createdAt, long lastSeenAt, Long revokedAt) {
    }
}
