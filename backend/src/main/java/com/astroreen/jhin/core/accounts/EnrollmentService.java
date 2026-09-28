package com.astroreen.jhin.core.accounts;

import com.astroreen.jhin.core.accounts.EnrollmentException.Reason;
import com.astroreen.jhin.core.db.WriteQueue;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * Enrollment-коды: 128 бит энтропии ({@link SecureRandom}) → Base32 (26 символов A-Z2-7).
 * В БД — только SHA-256 hex-хеш кода; plaintext существует ровно один вызов
 * ({@link IssueResult#code()}). Погашение — одноразовое (атомарный UPDATE ... WHERE used=0).
 */
@Service
public class EnrollmentService {

    private static final int CODE_BYTES = 16;
    private static final long TTL_MILLIS = 10 * 60 * 1000L;
    private static final String SQL_INSERT =
            "INSERT INTO enrollment_codes (code_hash, account_id, expires_at, used) VALUES (?, ?, ?, 0)";
    private static final String SQL_LOOKUP =
            "SELECT code_hash, account_id, expires_at, used FROM enrollment_codes WHERE code_hash = ?";
    private static final String SQL_CONSUME =
            "UPDATE enrollment_codes SET used = 1 WHERE code_hash = ? AND used = 0";

    private final JdbcClient jdbcClient;
    private final WriteQueue writeQueue;
    private final SecureRandom secureRandom = new SecureRandom();

    @Autowired
    public EnrollmentService(JdbcClient jdbcClient, WriteQueue writeQueue) {
        this.jdbcClient = jdbcClient;
        this.writeQueue = writeQueue;
    }

    public IssueResult issueEnrollment(String accountId) {
        byte[] raw = new byte[CODE_BYTES];
        secureRandom.nextBytes(raw);
        String code = Base32.encode(raw);
        String codeHash = Hashes.sha256Hex(code);
        long expiresAt = System.currentTimeMillis() + TTL_MILLIS;
        await(writeQueue.submit(() -> {
            jdbcClient.sql(SQL_INSERT).param(codeHash).param(accountId).param(expiresAt).update();
            return null;
        }));
        return new IssueResult(code, expiresAt);
    }

    public EnrollResult consumeEnrollment(String code) {
        if (code == null) {
            throw new EnrollmentException(Reason.INVALID, "unknown enrollment code");
        }
        byte[] digest = Hashes.sha256(code);
        String codeHash = java.util.HexFormat.of().formatHex(digest);
        CodeRow row = jdbcClient
                .sql(SQL_LOOKUP)
                .param(codeHash)
                .query(EnrollmentService::mapRow)
                .optional()
                .orElseThrow(() -> new EnrollmentException(Reason.INVALID, "unknown enrollment code"));
        if (!Hashes.constantTimeEquals(digest, Hashes.fromHex(row.codeHash()))) {
            throw new EnrollmentException(Reason.INVALID, "unknown enrollment code");
        }
        if (row.used() != 0) {
            throw new EnrollmentException(Reason.USED, "enrollment code already used");
        }
        if (row.expiresAt() <= System.currentTimeMillis()) {
            throw new EnrollmentException(Reason.EXPIRED, "enrollment code expired");
        }
        int consumed = await(writeQueue.submit(() -> jdbcClient.sql(SQL_CONSUME).param(codeHash).update()));
        if (consumed != 1) {
            throw new EnrollmentException(Reason.USED, "enrollment code already used");
        }
        return new EnrollResult(row.accountId());
    }

    private record CodeRow(String codeHash, String accountId, long expiresAt, int used) {}

    private static CodeRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new CodeRow(
                rs.getString("code_hash"), rs.getString("account_id"), rs.getLong("expires_at"), rs.getInt("used"));
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
