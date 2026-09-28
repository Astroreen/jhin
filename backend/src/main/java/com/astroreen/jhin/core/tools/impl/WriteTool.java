package com.astroreen.jhin.core.tools.impl;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Тул "write": запись UTF-8 контента в файл в workdir (перезапись целиком).
 *
 * <p><b>Write-guard «сначала прочитай».</b> Если файл УЖЕ существует и в этом запуске
 * не был прочитан ({@code !ctx.hasRead}) — ошибка
 * {@code "Read the file first before writing"} (точный текст), файл не меняется.
 * Новый (несуществующий) файл пишется без предварительного read. Каталог —
 * {@code "Is a directory"}; несуществующий путь не проверяется на read.
 *
 * <p>Родительские директории создаются при необходимости ({@code Files.createDirectories}).
 * После успешной записи файл помечается прочитанным ({@code ctx.markRead} — автор
 * записи знает контент). Meta: {@code bytes}, {@code lines} (строк как у splitLines).
 * Выход за workdir — ToolException из resolvePath.
 */
@Component
public class WriteTool implements ToolDefinition {

    @Override
    public String name() {
        return "write";
    }

    @Override
    public String label() {
        return "Write file";
    }

    @Override
    public String description() {
        return "Writes UTF-8 content to a file in the session working directory,"
                + " creating parent directories; overwriting an existing file requires reading it first.";
    }

    @Override
    public String promptSnippet() {
        return "write - create or overwrite a file (existing files must be read first)";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use write to create a new file or fully replace the contents of a file.",
                "To overwrite an existing file you must read it first in this run, otherwise the write is rejected.",
                "Use edit for small targeted changes - write always replaces the whole file.",
                "Parent directories are created automatically when missing.");
    }

    @Override
    public Map<String, Object> parametersSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "File path in the workspace"));
        properties.put("content", FileToolSupport.property("string", "Full UTF-8 content to write"));
        schema.put("properties", properties);
        schema.put("required", List.of("path", "content"));
        return schema;
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        Map<String, Object> args = call.arguments();
        if (!(args.get("path") instanceof String path) || path.isBlank()) {
            return ToolResult.error("path must not be blank");
        }
        if (!(args.get("content") instanceof String content)) {
            return ToolResult.error("content must be a string");
        }
        if (ctx.isCancelled()) {
            return ToolResult.error("cancelled");
        }
        Path resolved = ctx.resolvePath(path);
        if (Files.isDirectory(resolved)) {
            return ToolResult.error("Is a directory");
        }
        if (Files.exists(resolved) && !ctx.hasRead(resolved)) {
            return ToolResult.error("Read the file first before writing");
        }
        try {
            Path parent = resolved.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            Files.write(resolved, content.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            return ToolResult.error("Cannot write file: " + FileToolSupport.message(e));
        }
        ctx.markRead(resolved);
        int bytes = content.getBytes(StandardCharsets.UTF_8).length;
        int lines = FileToolSupport.splitLines(content).size();
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("bytes", bytes);
        meta.put("lines", lines);
        return new ToolResult("Wrote " + bytes + " bytes, " + lines + " line(s)", false, false, null, meta);
    }
}
