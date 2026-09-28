package com.astroreen.jhin.core.tools.impl;

import com.astroreen.jhin.core.tools.PathSandbox;
import com.astroreen.jhin.core.tools.gitignore.GitIgnore;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Тул "ls": список записей ОДНОГО каталога (не рекурсивно — обход дерева это find).
 *
 * <p><b>Аргументы.</b> {@code path} (каталог относительно workdir, default {@code .}),
 * {@code limit} (максимум записей, default 500).
 *
 * <p><b>Вывод.</b> Одна workdir-relative POSIX-строка пути на строку, каталоги с суффиксом
 * {@code /}. Сортировка: сначала каталоги, потом файлы, в каждой группе по алфавиту.
 * Скрытые dot-файлы показываются.
 *
 * <p><b>Фильтрация.</b> Записи, игнорируемые корневым .gitignore, скрыты (консистентно с
 * find); symlink-ы (файлы и каталоги) пропускаются целиком.
 *
 * <p><b>Лимит.</b> При числом записей больше {@code limit} выводятся первые {@code limit}
 * отсортированного списка (префикс «каталоги, потом файлы») и {@code truncated=true}.
 * Ровно {@code limit} записей → truncated=false.
 */
@Component
public class LsTool implements ToolDefinition {

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
        return "Lists a single directory (non-recursive): directories first with a trailing '/',"
                + " then files alphabetically, skipping entries ignored by the root .gitignore.";
    }

    @Override
    public String promptSnippet() {
        return "ls - list one directory (dirs first with '/', gitignore-aware, limit 500)";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use ls for a quick look at one directory level; use find to walk the tree.",
                "Directories come first with a trailing '/', then files, each group alphabetical.",
                "Entries ignored by the root .gitignore and symlinks are hidden, consistent with find.",
                "Output paths are workspace-relative; 'limit' (default 500) caps the list and sets truncated=true.");
    }

    @Override
    public Map<String, Object> parametersSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("path", FileToolSupport.property("string", "Directory in the workspace (default .)"));
        properties.put("limit", FileToolSupport.property("number", "Max entries to return (default 500)"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        Map<String, Object> args = call.arguments();
        String path = ".";
        if (args.get("path") instanceof String rawPath) {
            path = rawPath;
        }
        int limit;
        try {
            limit = positiveInt(args.get("limit"), 500, "limit");
        } catch (IllegalArgumentException e) {
            return ToolResult.error(e.getMessage());
        }
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

        List<String> dirs = new ArrayList<>();
        List<String> files = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
            for (Path entry : stream) {
                if (Files.isSymbolicLink(entry)) {
                    continue;
                }
                boolean isDir = Files.isDirectory(entry);
                String rel = toPosix(workdir.relativize(entry));
                if (ignore.isIgnored(rel, isDir)) {
                    continue;
                }
                if (isDir) {
                    dirs.add(rel + "/");
                } else {
                    files.add(rel);
                }
            }
        } catch (IOException e) {
            return ToolResult.error("Cannot list directory: " + FileToolSupport.message(e));
        }
        Collections.sort(dirs);
        Collections.sort(files);
        List<String> all = new ArrayList<>(dirs);
        all.addAll(files);
        boolean truncated = all.size() > limit;
        List<String> out = truncated ? all.subList(0, limit) : all;
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

    private static String toPosix(Path path) {
        return path.toString().replace('\\', '/');
    }
}
