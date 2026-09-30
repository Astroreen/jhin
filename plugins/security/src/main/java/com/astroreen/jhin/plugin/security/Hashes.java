/**
 * SHA-256 helpers: the only place the security plugin touches a message
 * digest.
 *
 * <p>Digests are rendered as lowercase hex (chosen over Base64 so the stored
 * values are safe in logs, URLs and SQL literals without quoting rules). The
 * String overloads hash the UTF-8 bytes of the input. Device tokens and
 * enrollment codes are persisted only as digests — the raw secret is returned
 * to the caller exactly once and never stored.
 */
package com.astroreen.jhin.plugin.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

final class Hashes {

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private Hashes() {
    }

    /**
     * Computes the SHA-256 digest of raw bytes.
     *
     * @param input the bytes to digest
     * @return the digest as lowercase hex (64 characters)
     */
    static String sha256Hex(byte[] input) {
        try {
            return toHex(MessageDigest.getInstance("SHA-256").digest(input));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable on this JVM", e);
        }
    }

    /**
     * Computes the SHA-256 digest of the UTF-8 bytes of a string.
     *
     * @param input the string to digest
     * @return the digest as lowercase hex (64 characters)
     */
    static String sha256Hex(String input) {
        return sha256Hex(input.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Renders bytes as lowercase hex. Used for the device token display form
     * (32 random bytes become 64 hex characters).
     *
     * @param bytes the bytes to render
     * @return the lowercase hex rendering
     */
    static String toHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(HEX[(b >> 4) & 0x0f]).append(HEX[b & 0x0f]);
        }
        return out.toString();
    }
}
