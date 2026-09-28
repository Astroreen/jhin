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
 * Тул "edit": литеральная (не regex) замена фрагмента файла в workdir.
 *
 * <p><b>Замена.</b> {@code oldString} ищется как литеральная подстрока. При
 * {@code replaceAll=false} (default) сплайсится только первое вхождение
 * ({@code indexOf} + конкатенация, НЕ {@code replaceFirst} — это regex); при
 * {@code replaceAll=true} — {@code String.replace} (все литеральные вхождения).
 * Нет совпадений — ошибка {@code "No matches found for oldString"} (точный текст).
 * Пустой/пропущенный {@code oldString} — ошибка {@code "oldString must not be blank"}.
 *
 * <p>Write-guard НЕ применяется (в отличие от write): edit сам читает файл перед
 * правкой. Несуществующий файл — {@code "File not found: <path>"}; каталог —
 * {@code "Is a directory"}. После успешной правки файл переписывается и помечается
 * прочитанным ({@code ctx.markRead}). Результат — {@code "replaced N occurrence(s)"}.
 * Выход за workdir — ToolException из resolvePath.
 */
@Component
public class EditTool implements ToolDefinition {

    @Override
    public String name() {
        return "edit";
    }

    @Override
    public String label() {
        return "Edit file";
    }

    @Override
    public String description() {
        return "Replaces a literal string in a file in the session working directory:"
                + " first occurrence by default, or all occurrences with replaceAll.";
    }

    @Override
    public String promptSnippet() {
        return "edit - literal string replacement in a file (first occurrence, or all with replaceAll)";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use edit for small targeted changes; use edit-diff first to preview the change.",
                "oldString is matched literally (no regex) and must be unique unless replaceAll=true.",
                "Include enough surrounding context in oldString so the first occurrence is the one you mean.",
                "If you get 'No matches found for oldString' the text has changed - read the file again.");
    }

    @Override
    public Map<String, Object> parametersSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "File path in the workspace"));
        properties.put("oldString", FileToolSupport.property("string", "Literal text to find (not a regex)"));
        properties.put("newString", FileToolSupport.property("string", "Literal replacement text"));
        properties.put(
                "replaceAll", FileToolSupport.property("boolean", "replace all occurrences (default false = first only)"));
        schema.put("properties", properties);
        schema.put("required", List.of("path", "oldString", "newString"));
        return schema;
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        Map<String, Object> args = call.arguments();
        if (!(args.get("path") instanceof String path) || path.isBlank()) {
            return ToolResult.error("path must not be blank");
        }
        if (!(args.get("oldString") instanceof String oldString) || oldString.isBlank()) {
            return ToolResult.error("oldString must not be blank");
        }
        if (!(args.get("newString") instanceof String newString)) {
            return ToolResult.error("newString must be a string");
        }
        boolean replaceAll = false;
        if (args.get("replaceAll") != null) {
            if (!(args.get("replaceAll") instanceof Boolean flag)) {
                return ToolResult.error("replaceAll must be a boolean");
            }
            replaceAll = flag;
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
        String content;
        try {
            content = new String(Files.readAllBytes(resolved), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return ToolResult.error("Cannot read file: " + FileToolSupport.message(e));
        }
        if (content.indexOf(oldString) < 0) {
            return ToolResult.error("No matches found for oldString");
        }
        String updated;
        int count;
        if (replaceAll) {
            count = FileToolSupport.countOccurrences(content, oldString);
            updated = content.replace(oldString, newString);
        } else {
            count = 1;
            updated = FileToolSupport.replaceFirstLiteral(content, oldString, newString);
        }
        try {
            Files.write(resolved, updated.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            return ToolResult.error("Cannot write file: " + FileToolSupport.message(e));
        }
        ctx.markRead(resolved);
        return ToolResult.ok("replaced " + count + " occurrence(s)");
    }
}
