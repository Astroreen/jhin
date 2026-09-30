/**
 * RFC 4648 Base32 encoding (alphabet {@code A-Z2-7}), uppercase and without
 * padding — the display form of enrollment codes. Deliberately self-contained:
 * the plugin adds no dependencies for this.
 */
package com.astroreen.jhin.plugin.security;

final class Base32 {

    private static final char[] ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".toCharArray();

    private Base32() {
    }

    /**
     * Encodes bytes as unpadded uppercase Base32. 16 bytes (128 bits) become
     * 26 characters.
     *
     * @param data the bytes to encode
     * @return the unpadded uppercase Base32 rendering
     */
    static String encode(byte[] data) {
        StringBuilder out = new StringBuilder((data.length * 8 + 4) / 5);
        int buffer = 0;
        int bitsLeft = 0;
        for (byte b : data) {
            buffer = (buffer << 8) | (b & 0xff);
            bitsLeft += 8;
            while (bitsLeft >= 5) {
                out.append(ALPHABET[(buffer >>> (bitsLeft - 5)) & 0x1f]);
                bitsLeft -= 5;
            }
        }
        if (bitsLeft > 0) {
            out.append(ALPHABET[(buffer << (5 - bitsLeft)) & 0x1f]);
        }
        return out.toString();
    }
}
