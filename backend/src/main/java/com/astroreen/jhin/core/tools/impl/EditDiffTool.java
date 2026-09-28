package com.astroreen.jhin.core.tools.impl;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.github.difflib.DiffUtils;
import com.github.difflib.UnifiedDiffUtils;
import com.github.difflib.patch.Patch;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Тул "edit-diff": превью правки как unified diff, файл НЕ пишется.
 *
 * <p>Семантика замены — как у EditTool c {@code replaceAll=false}: первое ЛИТЕРАЛЬНОЕ
 * вхождение {@code oldString} сплайсится в {@code newString} (не regex). Нет совпадений —
 * ошибка {@code "No matches found for oldString"} (точный текст, как у edit).
 * Несуществующий файл — {@code "File not found: <path>"}; каталог — {@code "Is a directory"};
 * пустой {@code oldString} — ошибка {@code "oldString must not be blank"}.
 *
 * <p><b>Diff.</b> java-diff-utils: {@code DiffUtils.diff(oldLines, newLines)} +
 * {@code UnifiedDiffUtils.generateUnifiedDiff(...)} с контекстом 3 строки и заголовками
 * {@code a/<path>} / {@code b/<path>} (path — как дал юзер). Строки диффа склеены {@code \n}
 * без завершающего перевода строки; трункации нет. Файл на диске не меняется и
 * прочитанным не помечается — write после edit-diff всё равно требует read.
 * Выход за workdir — ToolException из resolvePath.
 */
@Component
public class EditDiffTool implements ToolDefinition {

    private static final int CONTEXT_LINES = 3;

    @Override
    public String name() {
        return "edit-diff";
    }

    @Override
    public String label() {
        return "Edit diff";
    }

    @Override
    public String description() {
        return "Shows the unified diff an edit would produce for a file in the session"
                + " working directory without changing the file.";
    }

    @Override
    public String promptSnippet() {
        return "edit-diff - preview an edit as a unified diff without writing the file";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use edit-diff to preview a change before applying it with edit.",
                "oldString is matched literally (no regex): the first occurrence is replaced in the preview.",
                "The file is never modified - nothing is written and it does not count as read.",
                "The diff has 3 lines of context and headers a/<path> and b/<path>.");
    }

    @Override
    public Map<String, Object> parametersSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "File path in the workspace"));
        properties.put("oldString", FileToolSupport.property("string", "Literal text to find (not a regex)"));
        properties.put("newString", FileToolSupport.property("string", "Literal replacement text"));
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
        String updated = FileToolSupport.replaceFirstLiteral(content, oldString, newString);
        List<String> oldLines = FileToolSupport.splitLines(content);
        List<String> newLines = FileToolSupport.splitLines(updated);
        Patch<String> patch = DiffUtils.diff(oldLines, newLines);
        List<String> diff = UnifiedDiffUtils.generateUnifiedDiff("a/" + path, "b/" + path, oldLines, patch, CONTEXT_LINES);
        return ToolResult.ok(String.join("\n", diff));
    }
}
