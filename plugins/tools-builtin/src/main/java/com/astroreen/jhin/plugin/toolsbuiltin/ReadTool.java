/**
 * The {@code read} tool: reads a file in the workdir - text with line numbers
 * or an image as base64.
 *
 * <p><b>Text mode.</b> Arguments {@code offset} (1-based first line, default
 * 1) and {@code limit} (max lines, default 2000). Each content line is
 * {@code N| text} with N the absolute line number, right-aligned to width 4.
 * The general caps apply on top of {@code limit}: at most 2000 lines and
 * 51200 UTF-8 bytes (plus 1 per separator); a line that does not fit and
 * everything after it is dropped.
 *
 * <p><b>Image mode.</b> Magic bytes (png {@code 89 50 4E 47}, jpeg
 * {@code FF D8 FF}, gif {@code GIF8...}, webp {@code RIFF....WEBP}) or the
 * extension (.png/.jpg/.jpeg/.gif/.webp) switch to image mode:
 * {@code offset}/{@code limit} are ignored, ALL bytes are read and the
 * structured payload is the {@code image} kind (base64 as-is, never resized;
 * mime from magic bytes first, extension second). Content is
 * {@code [image: <mime>, <N> bytes]}.
 *
 * <p>A successful read (text or image) marks the file read
 * ({@code ctx.markRead}).
 *
 * <p><b>Structured card.</b> Text mode returns a {@code card} with rows
 * {@code path}, {@code lines} (returned), {@code total} (in the file);
 * image mode returns the {@code image} payload.
 *
 * <p><b>Failures.</b> A missing file is {@code "File not found: <path>"}
 * (the path exactly as supplied); a directory is {@code "Is a directory"};
 * a workspace escape is {@code "Path goes outside of workspace"}.
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

final class ReadTool implements ToolDefinition {

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
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "File path in the workspace"));
        properties.put("offset", FileToolSupport.property("number", "1-based line number to start from (default 1)"));
        properties.put("limit", FileToolSupport.property("number", "max lines to return (default 2000)"));
        return FileToolSupport.schema(properties, List.of("path"));
    }

    @Override
    public String promptSnippet() {
        return "read - read a text file (line-numbered, offset/limit) or an image (base64)";
    }

    @Override
    public String promptGuidelines() {
        return "Use read to look at file contents before editing or overwriting them.\n"
                + "Text output lines are prefixed with absolute line numbers like '  12| text'.\n"
                + "Use offset (1-based) and limit to page through long files; output is capped at 2000 lines / 50KB.\n"
                + "Images (png/jpeg/gif/webp) come back as base64 in the structured result, never resized.";
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
        int offset = FileToolSupport.positiveInt(args.get("offset"), 1, "offset");
        int limit = FileToolSupport.positiveInt(args.get("limit"), 2000, "limit");
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
            return ToolResult.ok(
                    "[image: " + mime + ", " + bytes.length + " bytes]",
                    FileToolSupport.Structured.image(path, mime, FileToolSupport.Structured.base64(bytes)));
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
        ctx.markRead(resolved);

        List<Map<String, String>> rows = new ArrayList<>();
        rows.add(FileToolSupport.Structured.row("path", path));
        rows.add(FileToolSupport.Structured.row("lines", Integer.toString(out.size())));
        rows.add(FileToolSupport.Structured.row("total", Integer.toString(total)));
        return ToolResult.ok(String.join("\n", out), FileToolSupport.Structured.card("read", rows));
    }
}
