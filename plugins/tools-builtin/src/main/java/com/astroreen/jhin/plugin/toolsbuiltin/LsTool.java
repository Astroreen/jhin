/**
 * The {@code ls} tool: lists the entries of ONE directory (non-recursive -
 * walking the tree is {@code find}).
 *
 * <p><b>Arguments.</b> {@code path} (directory relative to the workdir,
 * default {@code .}), {@code limit} (max entries, default 500).
 *
 * <p><b>Output.</b> One entry per content line as {@code name, type, size}:
 * {@code dir  <name>/} (no size) or {@code file <name>  <size>} (size in
 * bytes). Directories come first, then files, each group alphabetical.
 * Hidden dot-files are shown.
 *
 * <p><b>Filtering.</b> Entries ignored by the root {@code .gitignore} are
 * hidden (consistent with {@code find}); symlinks (files and directories) are
 * skipped entirely.
 *
 * <p><b>Limit.</b> When there are more than {@code limit} entries the first
 * {@code limit} of the sorted list are shown and the card row {@code truncated}
 * is {@code true}. Exactly {@code limit} entries - {@code false}.
 *
 * <p><b>Structured card.</b> {@code card} with rows {@code path},
 * {@code entries}, {@code truncated} and one row per shown entry
 * ({@code label} = name, {@code value} = type and size).
 *
 * <p><b>Failures.</b> A missing directory is
 * {@code "Directory not found: <path>"}; a non-directory is
 * {@code "Not a directory: <path>"}; a workspace escape is
 * {@code "Path goes outside of workspace"}.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.toolsbuiltin.gitignore.GitIgnore;
import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class LsTool implements ToolDefinition {

    @Override
    public String name() {
        return "ls";
    }

    @Override
    public String label() {
        return "List directory";
    }

    @Override
    public String description() {
        return "Lists a single directory (non-recursive) with name, type and size per entry:"
                + " directories first, then files alphabetically, skipping entries ignored by"
                + " the root .gitignore.";
    }

    @Override
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "Directory in the workspace (default .)"));
        properties.put("limit", FileToolSupport.property("number", "Max entries to return (default 500)"));
        return FileToolSupport.schema(properties, List.of());
    }

    @Override
    public String promptSnippet() {
        return "ls - list one directory (name, type, size; dirs first; gitignore-aware, limit 500)";
    }

    @Override
    public String promptGuidelines() {
        return "Use ls for a quick look at one directory level; use find to walk the tree.\n"
                + "Each line is 'dir  <name>/' or 'file <name>  <size>' (size in bytes).\n"
                + "Entries ignored by the root .gitignore and symlinks are hidden, consistent with find.\n"
                + "'limit' (default 500) caps the list and sets truncated=true on the card.";
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
        String path = FileToolSupport.optionalString(args, "path", ".");
        int limit = FileToolSupport.positiveInt(args.get("limit"), 500, "limit");
        if (ctx.isCancelled()) {
            return ToolResult.error("cancelled");
        }
        Path workdir = PathSandbox.realPath(ctx.workdir());
        Path dir = ctx.resolvePath(path);
        if (!Files.exists(dir)) {
            return ToolResult.error("Directory not found: " + path);
        }
        if (!Files.isDirectory(dir)) {
            return ToolResult.error("Not a directory: " + path);
        }
        GitIgnore ignore;
        try {
            ignore = GitIgnore.load(ctx.workdir());
        } catch (IOException e) {
            return ToolResult.error("Cannot read .gitignore: " + FileToolSupport.message(e));
        }

        List<Entry> dirs = new ArrayList<>();
        List<Entry> files = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
            for (Path entry : stream) {
                if (Files.isSymbolicLink(entry)) {
                    continue;
                }
                boolean isDir = Files.isDirectory(entry);
                String name = entry.getFileName().toString();
                String rel = toPosix(workdir.relativize(entry));
                if (ignore.isIgnored(rel, isDir)) {
                    continue;
                }
                if (isDir) {
                    dirs.add(new Entry(name + "/", "dir", "-"));
                } else {
                    files.add(new Entry(name, "file", Long.toString(sizeOf(entry))));
                }
            }
        } catch (IOException e) {
            return ToolResult.error("Cannot list directory: " + FileToolSupport.message(e));
        }
        dirs.sort((a, b) -> a.name().compareTo(b.name()));
        files.sort((a, b) -> a.name().compareTo(b.name()));
        List<Entry> entries = new ArrayList<>(dirs);
        entries.addAll(files);
        boolean truncated = entries.size() > limit;
        List<Entry> shown = truncated ? entries.subList(0, limit) : entries;

        List<String> out = new ArrayList<>();
        for (Entry entry : shown) {
            if ("dir".equals(entry.type())) {
                out.add("dir  " + entry.name());
            } else {
                out.add("file " + entry.name() + "  " + entry.size());
            }
        }

        List<Map<String, String>> rows = new ArrayList<>();
        rows.add(FileToolSupport.Structured.row("path", toPosix(workdir.relativize(dir))));
        rows.add(FileToolSupport.Structured.row("entries", Integer.toString(entries.size())));
        rows.add(FileToolSupport.Structured.row("truncated", Boolean.toString(truncated)));
        for (Entry entry : shown) {
            String value = "dir".equals(entry.type()) ? "dir" : "file, " + entry.size() + " bytes";
            rows.add(FileToolSupport.Structured.row(entry.name(), value));
        }
        return ToolResult.ok(String.join("\n", out), FileToolSupport.Structured.card("ls", rows));
    }

    private static long sizeOf(Path file) {
        try {
            return Files.size(file);
        } catch (IOException e) {
            return -1;
        }
    }

    private static String toPosix(Path path) {
        return path.toString().replace('\\', '/');
    }

    private record Entry(String name, String type, String size) {}
}
