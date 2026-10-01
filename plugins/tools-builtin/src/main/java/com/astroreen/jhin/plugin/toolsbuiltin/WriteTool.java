/**
 * The {@code write} tool: writes UTF-8 content to a file in the workdir,
 * replacing it entirely.
 *
 * <p><b>Write-guard "read first".</b> When the file already exists and was not
 * read during this run ({@code !ctx.hasRead}) the call fails with
 * {@code "Read the file first before writing"} and the file is unchanged. A
 * new (missing) file is written without a prior read. A directory target is
 * {@code "Is a directory"}.
 *
 * <p>Missing parent directories are created ({@code Files.createDirectories}).
 * After a successful write the file is marked read ({@code ctx.markRead} - the
 * author of the write knows the content).
 *
 * <p><b>Structured card.</b> {@code card} with rows {@code path},
 * {@code bytes}, {@code lines}.
 *
 * <p><b>Failures.</b> A workspace escape is
 * {@code "Path goes outside of workspace"}; IO failures are
 * {@code "Cannot write file: <reason>"}.
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

final class WriteTool implements ToolDefinition {

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
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "File path in the workspace"));
        properties.put("content", FileToolSupport.property("string", "Full UTF-8 content to write"));
        return FileToolSupport.schema(properties, List.of("path", "content"));
    }

    @Override
    public String promptSnippet() {
        return "write - create or overwrite a file (existing files must be read first)";
    }

    @Override
    public String promptGuidelines() {
        return "Use write to create a new file or fully replace the contents of a file.\n"
                + "To overwrite an existing file you must read it first in this run, otherwise the write is rejected.\n"
                + "Use edit for small targeted changes - write always replaces the whole file.\n"
                + "Parent directories are created automatically when missing.";
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
        Object rawContent = args.get("content");
        if (!(rawContent instanceof String content)) {
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

        List<Map<String, String>> rows = new ArrayList<>();
        rows.add(FileToolSupport.Structured.row("path", path));
        rows.add(FileToolSupport.Structured.row("bytes", Integer.toString(bytes)));
        rows.add(FileToolSupport.Structured.row("lines", Integer.toString(lines)));
        return ToolResult.ok(
                "Wrote " + bytes + " bytes, " + lines + " line(s)",
                FileToolSupport.Structured.card("write", rows));
    }
}
