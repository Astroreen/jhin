package com.astroreen.jhin.core.tools.impl;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Общие помощники файловых тулов (T15).
 *
 * <p><b>Лимиты вывода.</b> {@link #MAX_LINES} строк / {@link #MAX_BYTES} байт UTF-8
 * (с +1 байт на разделитель {@code \n} — как в BashTool).
 *
 * <p><b>Нумерация строк read.</b> {@link #numbered} — {@code N| text}, N абсолютный
 * номер строки в файле (1-indexed), номер дополняется пробелами слева до ширины 4.
 *
 * <p><b>splitLines</b> — разбиение как у {@code Files.readAllLines}: {@code \n},
 * {@code \r\n}, {@code \r}; хвостовой перевод строки не создаёт пустую последнюю строку.
 *
 * <p><b>detectImageMime</b> — magic bytes (png {@code 89 50 4E 47}, jpeg {@code FF D8 FF},
 * gif {@code GIF8}, webp {@code RIFF....WEBP}) либо расширение файла
 * (.png/.jpg/.jpeg/.gif/.webp); приоритет у magic bytes. Не картинка → null.
 *
 * <p><b>Замены литеральные (без regex).</b> {@link #replaceFirstLiteral} — сплайс
 * первого вхождения ({@code indexOf}), {@link #countOccurrences} — подчёт
 * не-перекрывающихся вхождений (семантика {@code String.replace}).
 */
final class FileToolSupport {

    static final int MAX_LINES = 2000;
    static final int MAX_BYTES = 51200;

    private FileToolSupport() {}

    static String numbered(int lineNo, String line) {
        return String.format(Locale.ROOT, "%4d| %s", lineNo, line);
    }

    static List<String> splitLines(String text) {
        List<String> lines = new ArrayList<>();
        int n = text.length();
        int start = 0;
        for (int i = 0; i < n; i++) {
            char c = text.charAt(i);
            if (c == '\n') {
                lines.add(text.substring(start, i));
                start = i + 1;
            } else if (c == '\r') {
                int end = i;
                if (i + 1 < n && text.charAt(i + 1) == '\n') {
                    i++;
                }
                lines.add(text.substring(start, end));
                start = i + 1;
            }
        }
        if (start < n) {
            lines.add(text.substring(start));
        }
        return lines;
    }

    static String detectImageMime(Path file, byte[] bytes) {
        if (bytes != null) {
            if (bytes.length >= 4
                    && (bytes[0] & 0xFF) == 0x89
                    && bytes[1] == 0x50
                    && bytes[2] == 0x4E
                    && bytes[3] == 0x47) {
                return "image/png";
            }
            if (bytes.length >= 3
                    && (bytes[0] & 0xFF) == 0xFF
                    && (bytes[1] & 0xFF) == 0xD8
                    && (bytes[2] & 0xFF) == 0xFF) {
                return "image/jpeg";
            }
            if (bytes.length >= 4
                    && bytes[0] == 'G'
                    && bytes[1] == 'I'
                    && bytes[2] == 'F'
                    && bytes[3] == '8') {
                return "image/gif";
            }
            if (bytes.length >= 12
                    && bytes[0] == 'R'
                    && bytes[1] == 'I'
                    && bytes[2] == 'F'
                    && bytes[3] == 'F'
                    && bytes[8] == 'W'
                    && bytes[9] == 'E'
                    && bytes[10] == 'B'
                    && bytes[11] == 'P') {
                return "image/webp";
            }
        }
        String name = file.getFileName() == null ? "" : file.getFileName().toString().toLowerCase(Locale.ROOT);
        if (name.endsWith(".png")) {
            return "image/png";
        }
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (name.endsWith(".gif")) {
            return "image/gif";
        }
        if (name.endsWith(".webp")) {
            return "image/webp";
        }
        return null;
    }

    static String replaceFirstLiteral(String content, String oldString, String newString) {
        int i = content.indexOf(oldString);
        return content.substring(0, i) + newString + content.substring(i + oldString.length());
    }

    static int countOccurrences(String content, String needle) {
        int count = 0;
        int idx = 0;
        while ((idx = content.indexOf(needle, idx)) >= 0) {
            count++;
            idx += needle.length();
        }
        return count;
    }

    static Map<String, Object> property(String type, String description) {
        Map<String, Object> property = new LinkedHashMap<>();
        property.put("type", type);
        property.put("description", description);
        return property;
    }

    static String message(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.toString();
    }
}
