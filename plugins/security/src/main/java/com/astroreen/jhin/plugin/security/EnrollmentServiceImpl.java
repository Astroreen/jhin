/**
 * Single-use enrollment codes binding a future device to an account.
 *
 * <p>A code is 128 bits of {@link java.security.SecureRandom} entropy rendered
 * as unpadded Base32 ({@link Base32}) — the display form printed to the user
 * exactly once. Only {@code SHA-256(code)} (hex, see {@link Hashes}) is stored,
 * in the {@code code_sha256} primary key of
 * {@code jhin_security_enrollment_codes}. A code lives for {@link #TTL_MILLIS}
 * and may be redeemed exactly once: the validity check and the {@code used_at}
 * mark happen inside one serialized write unit.
 *
 * <p>A successful redemption creates the device row (256-bit token, again
 * stored only as SHA-256) and returns the raw token once — it is never
 * recoverable afterwards.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.plugin.security.api.Principal;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import com.astroreen.jhin.sdk.db.DbAccess;
import java.security.SecureRandom;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.util.UUID;

final class EnrollmentServiceImpl {

    /** Enrollment code TTL: 10 minutes. */
    static final long TTL_MILLIS = 10 * 60 * 1000L;

    /** Code entropy: 128 bits. */
    private static final int CODE_BYTES = 16;

    /** Device token entropy: 256 bits. */
    private static final int TOKEN_BYTES = 32;

    private final DbAccess db;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();

    EnrollmentServiceImpl(DbAccess db) {
        this(db, Clock.systemUTC());
    }

    EnrollmentServiceImpl(DbAccess db, Clock clock) {
        this.db = db;
        this.clock = clock;
    }

    /**
     * Issues a fresh enrollment code for an account. The raw code is returned
     * to the caller and never stored; only its SHA-256 digest is persisted.
     *
     * @param accountId the account the code enrolls devices for
     * @return the issued code with its canonical display form and expiry
     * @throws IllegalArgumentException when {@code accountId} is null or blank
     * @throws SecurityException         with code {@code not_found} (HTTP 404)
     *                                   when the account is unknown
     */
    IssuedCode issue(String accountId) {
        requireText(accountId, "accountId");
        db.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT id FROM jhin_security_accounts WHERE id = ?")) {
                query.setString(1, accountId);
                try (ResultSet rs = query.executeQuery()) {
                    if (!rs.next()) {
                        throw new SecurityException(SecurityException.CODE_NOT_FOUND, 404,
                                "unknown account: " + accountId);
                    }
                }
            }
            return null;
        });
        byte[] entropy = new byte[CODE_BYTES];
        random.nextBytes(entropy);
        String code = Base32.encode(entropy);
        long now = clock.millis();
        long expiresAt = now + TTL_MILLIS;
        db.write(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_security_enrollment_codes"
                            + "(code_sha256, account_id, expires_at, used_at) VALUES (?, ?, ?, NULL)")) {
                insert.setString(1, Hashes.sha256Hex(code));
                insert.setString(2, accountId);
                insert.setLong(3, expiresAt);
                insert.executeUpdate();
            }
            return null;
        });
        return new IssuedCode(code, accountId, expiresAt);
    }

    /**
     * Redeems an enrollment code and enrolls a new device for its account.
     * The code is matched by digest: the input is canonicalized first (case
     * folded to uppercase, surrounding whitespace, grouping hyphens and any
     * trailing Base32 padding removed), so the digest is always taken over the
     * canonical display form.
     *
     * <p>Single use: the {@code used_at} mark is set in the same serialized
     * write unit as the validity check, so a second redemption can never pass.
     *
     * @param code       the enrollment code as printed at issue time
     * @param deviceName display name of the device being enrolled
     * @return the raw device token (shown once) and the enrolled principal
     * @throws IllegalArgumentException when {@code code} or {@code deviceName}
     *                                  is null or blank
     * @throws SecurityException         with code {@code unauthorized} (HTTP 401)
     *                                   when the code is unknown,
     *                                   {@code code_used} (HTTP 410) when it was
     *                                   already redeemed,
     *                                   {@code code_expired} (HTTP 410) when its
     *                                   TTL has passed
     */
    RedeemResult redeem(String code, String deviceName) {
        requireText(code, "code");
        requireText(deviceName, "deviceName");
        String canonical = canonicalize(code);
        String codeSha = Hashes.sha256Hex(canonical);
        long now = clock.millis();
        byte[] entropy = new byte[TOKEN_BYTES];
        random.nextBytes(entropy);
        String token = Hashes.toHex(entropy);
        return db.write(connection -> {
            String accountId;
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT account_id, expires_at, used_at FROM jhin_security_enrollment_codes"
                            + " WHERE code_sha256 = ?")) {
                query.setString(1, codeSha);
                try (ResultSet rs = query.executeQuery()) {
                    if (!rs.next()) {
                        throw new SecurityException(SecurityException.CODE_UNAUTHORIZED, 401,
                                "unknown enrollment code");
                    }
                    if (rs.getObject("used_at") != null) {
                        throw new SecurityException(SecurityException.CODE_CODE_USED, 410,
                                "enrollment code already used");
                    }
                    if (now >= rs.getLong("expires_at")) {
                        throw new SecurityException(SecurityException.CODE_CODE_EXPIRED, 410,
                                "enrollment code expired");
                    }
                    accountId = rs.getString("account_id");
                }
            }
            try (PreparedStatement mark = connection.prepareStatement(
                    "UPDATE jhin_security_enrollment_codes SET used_at = ? WHERE code_sha256 = ?")) {
                mark.setLong(1, now);
                mark.setString(2, codeSha);
                mark.executeUpdate();
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
            String deviceId = UUID.randomUUID().toString();
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_security_devices"
                            + "(id, account_id, name, token_sha256, created_at, last_seen_at, revoked_at)"
                            + " VALUES (?, ?, ?, ?, ?, ?, NULL)")) {
                insert.setString(1, deviceId);
                insert.setString(2, accountId);
                insert.setString(3, deviceName);
                insert.setString(4, Hashes.sha256Hex(token));
                insert.setLong(5, now);
                insert.setLong(6, now);
                insert.executeUpdate();
            }
            return new RedeemResult(token, new Principal(accountId, accountName, deviceId));
        });
    }

    /**
     * Canonicalizes a user-typed enrollment code: uppercase, without
     * surrounding whitespace, grouping hyphens or trailing Base32 padding.
     *
     * @param code the user input
     * @return the canonical display form the digest is taken over
     */
    private static String canonicalize(String code) {
        return code.trim()
                .replaceAll("[\\s-]", "")
                .replaceAll("=+$", "")
                .toUpperCase();
    }

    private static void requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be null or blank");
        }
    }

    /**
     * One issued enrollment code: the raw display form (returned to the user
     * exactly once) plus its expiry.
     *
     * @param code      the canonical display form of the code
     * @param accountId the account the code enrolls devices for
     * @param expiresAt expiry time, epoch milliseconds; the code is valid
     *                  strictly before this instant
     */
    record IssuedCode(String code, String accountId, long expiresAt) {
    }

    /**
     * The outcome of a successful redemption: the raw device token (never
     * stored, shown once) and the principal of the enrolled device.
     *
     * @param token     the raw device token, 256 bits rendered as hex
     * @param principal the enrolled device principal
     */
    record RedeemResult(String token, Principal principal) {
    }
}
