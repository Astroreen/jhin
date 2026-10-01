/**
 * The {@code edit-diff} tool: previews an edit as a unified diff without
 * writing the file.
 *
 * <p><b>Replacement semantics - as {@code edit} with {@code replaceAll=false}:
 * </b> exactly one literal {@code oldString} occurrence is spliced into
 * {@code newString} (not a regex). Zero matches is
 * {@code "No matches found for oldString"}; more than one is
 * {@code "oldString is ambiguous: found <N> matches; add context or set
 * replaceAll=true"} - the same stable messages as {@code edit}.
 *
 * <p><b>Diff.</b> java-diff-utils: {@code DiffUtils.diff} plus
 * {@code UnifiedDiffUtils.generateUnifiedDiff} with 3 context lines and
 * {@code a/<path>} / {@code b/<path>} headers (path exactly as supplied).
 * The diff text is the result content, joined with {@code \n} and never
 * truncated.
 *
 * <p>The file on disk is NOT changed and is NOT marked read - a later
 * {@code write} still requires a prior {@code read}.
 *
 * <p><b>Structured card.</b> {@code card} with rows {@code path},
 * {@code diffLines}.
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
import com.github.difflib.DiffUtils;
import com.github.difflib.UnifiedDiffUtils;
import com.github.difflib.patch.Patch;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class EditDiffTool implements ToolDefinition {

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
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "File path in the workspace"));
        properties.put("oldString", FileToolSupport.property("string", "Literal text to find (not a regex)"));
        properties.put("newString", FileToolSupport.property("string", "Literal replacement text"));
        return FileToolSupport.schema(properties, List.of("path", "oldString", "newString"));
    }

    @Override
    public String promptSnippet() {
        return "edit-diff - preview an edit as a unified diff without writing the file";
    }

    @Override
    public String promptGuidelines() {
        return "Use edit-diff to preview a change before applying it with edit.\n"
                + "oldString is matched literally (no regex) and must match exactly once.\n"
                + "The file is never modified - nothing is written and it does not count as read.\n"
                + "The diff has 3 lines of context and headers a/<path> and b/<path>.";
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
        int matches = FileToolSupport.countOccurrences(content, oldString);
        if (matches == 0) {
            return ToolResult.error("No matches found for oldString");
        }
        if (matches > 1) {
            return ToolResult.error("oldString is ambiguous: found " + matches
                    + " matches; add context or set replaceAll=true");
        }
        String updated = FileToolSupport.replaceFirstLiteral(content, oldString, newString);
        List<String> oldLines = FileToolSupport.splitLines(content);
        List<String> newLines = FileToolSupport.splitLines(updated);
        Patch<String> patch = DiffUtils.diff(oldLines, newLines);
        List<String> diff =
                UnifiedDiffUtils.generateUnifiedDiff("a/" + path, "b/" + path, oldLines, patch, CONTEXT_LINES);

        List<Map<String, String>> rows = new ArrayList<>();
        rows.add(FileToolSupport.Structured.row("path", path));
        rows.add(FileToolSupport.Structured.row("diffLines", Integer.toString(diff.size())));
        return ToolResult.ok(String.join("\n", diff), FileToolSupport.Structured.card("edit-diff", rows));
    }
}
