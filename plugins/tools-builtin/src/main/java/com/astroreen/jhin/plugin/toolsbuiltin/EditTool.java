/**
 * The {@code edit} tool: literal (not regex) string replacement in a file in
 * the workdir.
 *
 * <p><b>Read gate.</b> The file must have been read during this run
 * ({@code ctx.hasRead}); otherwise the call fails with
 * {@code "Read the file first before editing"} and the file is unchanged.
 *
 * <p><b>Replacement.</b> {@code oldString} is matched literally. With
 * {@code replaceAll=false} (default) exactly one occurrence must exist: zero
 * matches is {@code "No matches found for oldString"}, more than one is
 * {@code "oldString is ambiguous: found <N> matches; add context or set
 * replaceAll=true"}. With {@code replaceAll=true} every literal occurrence is
 * replaced ({@code String.replace} semantics).
 *
 * <p>After a successful edit the file is rewritten and marked read
 * ({@code ctx.markRead}); the result content is
 * {@code "replaced <N> occurrence(s)"}.
 *
 * <p><b>Structured card.</b> {@code card} with rows {@code path},
 * {@code replacements}.
 *
 * <p><b>Failures.</b> A missing file is {@code "File not found: <path>"};
 * a directory is {@code "Is a directory"}; a workspace escape is
 * {@code "Path goes outside of workspace"}.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class EditTool implements ToolDefinition {

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
                + " exactly one occurrence by default, or all occurrences with replaceAll.";
    }

    @Override
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "File path in the workspace"));
        properties.put("oldString", FileToolSupport.property("string", "Literal text to find (not a regex)"));
        properties.put("newString", FileToolSupport.property("string", "Literal replacement text"));
        properties.put("replaceAll",
                FileToolSupport.property("boolean", "replace all occurrences (default false = exactly one)"));
        return FileToolSupport.schema(properties, List.of("path", "oldString", "newString"));
    }

    @Override
    public String promptSnippet() {
        return "edit - literal string replacement in a file (read it first; exactly one match unless replaceAll)";
    }

    @Override
    public String promptGuidelines() {
        return "Use edit for small targeted changes; use edit-diff first to preview the change.\n"
                + "The file must be read first in this run, otherwise the edit is rejected.\n"
                + "oldString is matched literally (no regex) and must match exactly once unless replaceAll=true.\n"
                + "Include enough surrounding context in oldString so the match is unique.\n"
                + "If you get 'No matches found for oldString' the text has changed - read the file again.";
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        try {
            return run(call, ctx);
        } catch (ToolException e) {
            return ToolResult.error(e.getMessage());
        }
    }

    private ToolResult run(ToolCall call, ToolContext ctx) {
        Map<String, Object> args = FileToolSupport.args(call);
        String path = FileToolSupport.requireString(args, "path");
        String oldString = FileToolSupport.requireString(args, "oldString");
        String newString = FileToolSupport.optionalString(args, "newString", null);
        if (newString == null) {
            throw new ToolException("newString must be a string");
        }
        boolean replaceAll = FileToolSupport.boolArg(args.get("replaceAll"), false, "replaceAll");
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
        if (!ctx.hasRead(resolved)) {
            return ToolResult.error("Read the file first before editing");
        }
        String content;
        try {
            content = new String(Files.readAllBytes(resolved), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return ToolResult.error("Cannot read file: " + FileToolSupport.message(e));
        }
        int matches = FileToolSupport.countOccurrences(content, oldString);
        if (matches == 0) {
            return ToolResult.error("No matches found for oldString");
        }
        if (!replaceAll && matches > 1) {
            return ToolResult.error("oldString is ambiguous: found " + matches
                    + " matches; add context or set replaceAll=true");
        }
        String updated;
        int count;
        if (replaceAll) {
            count = matches;
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

        List<Map<String, String>> rows = new ArrayList<>();
        rows.add(FileToolSupport.Structured.row("path", path));
        rows.add(FileToolSupport.Structured.row("replacements", Integer.toString(count)));
        return ToolResult.ok(
                "replaced " + count + " occurrence(s)",
                FileToolSupport.Structured.card("edit", rows));
    }
}
