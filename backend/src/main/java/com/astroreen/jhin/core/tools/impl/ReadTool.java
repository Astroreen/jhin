package com.astroreen.jhin.core.tools.impl;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Тул "read": чтение файла в workdir — текст с нумерацией строк или image (base64).
 *
 * <p><b>Текстовый режим.</b> Аргументы {@code offset} (1-indexed номер первой строки,
 * default 1) и {@code limit} (максимум строк, default 2000). Каждая строка вывода —
 * {@code N| text} (N — абсолютный номер строки в файле, номер по правому краю шириной 4,
 * затем {@code "| "}); строки склеены {@code \n}, без завершающего перевода строки.
 *
 * <p><b>Трункация.</b> Сверх {@code limit} действуют общие капы: не более 2000 строк и
 * 51200 байт UTF-8 (с +1 байт на разделитель); строка, не влезающая в лимит, и всё
 * после неё отбрасываются. {@code truncated=true} — если после последней выведенной
 * строки в файле есть ещё строки (не весь файл от offset показан).
 *
 * <p><b>Image-режим.</b> Magic bytes (png {@code 89 50 4E 47}, jpeg {@code FF D8 FF},
 * gif {@code GIF8...}, webp {@code RIFF....WEBP}) либо расширение
 * (.png/.jpg/.jpeg/.gif/.webp) → читаются ВСЕ байты, {@code offset}/{@code limit}
 * игнорируются. {@code structured} = {@code {"type":"image","mimeType":"image/png"|
 * "image/jpeg"|"image/gif"|"image/webp","data":"<base64>"}} (Base64.getEncoder());
 * MIME — по magic bytes, при их отсутствии по расширению. Ресайза нет — base64 as-is.
 * content = {@code [image: image/png, N bytes]}.
 *
 * <p>Успешное чтение (текст или image) помечает файл прочитанным ({@code ctx.markRead}).
 * Несуществующий файл — ошибка {@code "File not found: <path>"} (путь как дал юзер);
 * каталог — {@code "Is a directory"}. Выход за workdir — ToolException из resolvePath.
 */
@Component
public class ReadTool implements ToolDefinition {

    @Override
    public String name() {
        return "read";
    }

    @Override
    public String label() {
        return "Read file";
    }

    @Override
    public String description() {
        return "Reads a file from the session working directory: text with line numbers,"
                + " or an image returned as base64.";
    }

    @Override
    public String promptSnippet() {
        return "read - read a text file (line-numbered, offset/limit) or an image (base64)";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use read to look at file contents before editing or overwriting them.",
                "Text output lines are prefixed with absolute line numbers like '  12| text'.",
                "Use offset (1-based) and limit to page through long files; output is capped at 2000 lines / 50KB.",
                "Images (png/jpeg/gif/webp) come back as base64 in the structured result, never resized.");
    }

    @Override
    public Map<String, Object> parametersSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "File path in the workspace"));
        properties.put("offset", FileToolSupport.property("number", "1-based line number to start from (default 1)"));
        properties.put("limit", FileToolSupport.property("number", "max lines to return (default 2000)"));
        schema.put("properties", properties);
        schema.put("required", List.of("path"));
        return schema;
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        Map<String, Object> args = call.arguments();
        if (!(args.get("path") instanceof String path) || path.isBlank()) {
            return ToolResult.error("path must not be blank");
        }
        int offset;
        int limit;
        try {
            offset = positiveInt(args.get("offset"), 1, "offset");
            limit = positiveInt(args.get("limit"), 2000, "limit");
        } catch (IllegalArgumentException e) {
            return ToolResult.error(e.getMessage());
        }
        if (ctx.isCancelled()) {
            return ToolResult.error("cancelled");
        }
        Path resolved = ctx.resolvePath(path);
        if (!Files.exists(resolved)) {
            return ToolResult.error("File not found: " + path);
        }
        if (Files.isDirectory(resolved)) {
            return ToolResult.error("Is a directory");
        }
        byte[] bytes;
        try {
            bytes = Files.readAllBytes(resolved);
        } catch (IOException e) {
            return ToolResult.error("Cannot read file: " + FileToolSupport.message(e));
        }

        String mime = FileToolSupport.detectImageMime(resolved, bytes);
        if (mime != null) {
            ctx.markRead(resolved);
            Map<String, Object> structured = new LinkedHashMap<>();
            structured.put("type", "image");
            structured.put("mimeType", mime);
            structured.put("data", Base64.getEncoder().encodeToString(bytes));
            return ToolResult.ok("[image: " + mime + ", " + bytes.length + " bytes]", structured);
        }

        List<String> lines = FileToolSupport.splitLines(new String(bytes, StandardCharsets.UTF_8));
        int total = lines.size();
        int from = offset - 1;
        List<String> out = new ArrayList<>();
        int bytesOut = 0;
        if (from < total) {
            int window = Math.min(limit, total - from);
            for (int i = 0; i < window; i++) {
                String numbered = FileToolSupport.numbered(offset + i, lines.get(from + i));
                int add = numbered.getBytes(StandardCharsets.UTF_8).length + 1;
                if (out.size() >= FileToolSupport.MAX_LINES || bytesOut + add > FileToolSupport.MAX_BYTES) {
                    break;
                }
                out.add(numbered);
                bytesOut += add;
            }
        }
        boolean truncated = from + out.size() < total;
        ctx.markRead(resolved);
        return new ToolResult(String.join("\n", out), false, truncated, null, null);
    }

    private static int positiveInt(Object raw, int defaultValue, String name) {
        if (raw == null) {
            return defaultValue;
        }
        if (!(raw instanceof Number number)) {
            throw new IllegalArgumentException(name + " must be a number");
        }
        long value = number.longValue();
        if (value < 1) {
            throw new IllegalArgumentException(name + " must be a positive integer");
        }
        return (int) Math.min(value, Integer.MAX_VALUE);
    }
}
