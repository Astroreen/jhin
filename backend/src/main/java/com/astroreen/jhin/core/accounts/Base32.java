package com.astroreen.jhin.core.accounts;

/**
 * Кодировщик Base32 (RFC 4648: алфавит A-Z2-7, без padding) для enrollment-кодов —
 * только encode, decode не нужен (код живёт ровно один вызов).
 */
public final class Base32 {

    private static final char[] ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".toCharArray();

    private Base32() {}

    public static String encode(byte[] data) {
        StringBuilder out = new StringBuilder((data.length * 8 + 4) / 5);
        int buffer = 0;
        int bitsInBuffer = 0;
        for (byte b : data) {
            buffer = (buffer << 8) | (b & 0xff);
            bitsInBuffer += 8;
            while (bitsInBuffer >= 5) {
                out.append(ALPHABET[(buffer >>> (bitsInBuffer - 5)) & 0x1f]);
                bitsInBuffer -= 5;
            }
        }
        if (bitsInBuffer > 0) {
            out.append(ALPHABET[(buffer << (5 - bitsInBuffer)) & 0x1f]);
        }
        return out.toString();
    }
}
