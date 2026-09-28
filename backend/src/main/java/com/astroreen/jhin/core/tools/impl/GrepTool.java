package com.astroreen.jhin.core.tools.impl;

import com.astroreen.jhin.core.tools.PathSandbox;
import com.astroreen.jhin.core.tools.gitignore.GitIgnore;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import org.springframework.stereotype.Component;

/**
 * Тул "grep": поиск regex-литерала по строкам текстовых файлов в workdir (чистая Java).
 *
 * <p><b>Аргументы.</b> {@code pattern} (строка, обязателен), {@code path} (корень поиска,
 * default {@code .}), {@code glob} (фильтр файлов, опционально; матчится по workdir-relative
 * пути ИЛИ имени файла — засчитывается любое, как в FindTool), {@code ignoreCase}
 * (default false), {@code literal} (default false — паттерн как есть через
 * {@link Pattern#quote}; false — regex), {@code context} (строк до/после, default 0),
 * {@code limit} (максимум совпадений, default 100, больше 100 не берётся).
 *
 * <p><b>Обход.</b> Как в FindTool: без symlink-ов (пропускаются целиком), записи и
 * каталоги из корневого .gitignore пропускаются, игнорируемые каталоги не спускаются.
 * Бинарные файлы пропускаются: NUL-байт в первых 8КБ → файл не ищется. Файлы ищутся
 * в лексикографическом порядке путей, строки — по порядку в файле.
 *
 * <p><b>Длинные строки.</b> У строки ищется и печатается только первые 2000 символов;
 * при просмотре более длинной строки ставится meta {@code linesTruncated=true}, печатается
 * усечённая форма строки.
 *
 * <p><b>Формат вывода</b> (как grep -n): строка-совпадение — {@code path:N: text},
 * контекстная строка — {@code path-N- text} (дефис — признак контекста). N — 1-based номер
 * строки. Контекстные диапазоны совпадений в одном файле, пересекающиеся или соседние,
 * объединяются; строка-совпадение печатается в форме совпадения один раз. Без совпадений
 * — пустой content и error=false (как grep с ненулевым кодом).
 *
 * <p><b>Лимит и meta.</b> Собираются совпадения до {@code limit}; при виде (limit+1)-го
 * совпадения поиск останавливается. Meta: {@code matchLimitReached=true} и
 * {@code truncated=true} — только если совпадений больше {@code limit}; всегда
 * {@code matchLimitReached} и {@code linesTruncated} (Boolean) в meta.
 */
@Component
public class GrepTool implements ToolDefinition {

    private static final int MAX_LINE_CHARS = 2000;
    private static final int BINARY_CHECK_BYTES = 8192;
    private static final int MAX_MATCHES = 100;

    @Override
    public String name() {
        return "grep";
    }

    @Override
    public String label() {
        return "Search in files";
    }

    @Override
    public String description() {
        return "Searches text files under a directory for a regex or literal pattern and prints"
                + " grep-style matches with optional context lines, skipping .gitignore'd and binary files.";
    }

    @Override
    public String promptSnippet() {
        return "grep - regex/literal search in files (gitignore-aware, glob filter, context lines, limit 100 matches)";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use grep to find code or text across the workspace before editing.",
                "Output is grep -n style: 'path:N: text' for matches, 'path-N- text' for context lines.",
                "Set literal=true for plain-text search (no regex metacharacters) and ignoreCase=true to fold case.",
                "Only the first 2000 chars of a line are searched and printed (meta linesTruncated); binary files and .gitignore'd paths are skipped.",
                "Matches stop at 'limit' (default 100, max 100) and set meta matchLimitReached=true.");
    }

    @Override
    public Map<String, Object> parametersSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("pattern", FileToolSupport.property("string", "Pattern to search for (regex by default)"));
        properties.put("path", FileToolSupport.property("string", "Root directory in the workspace (default .)"));
        properties.put("glob", FileToolSupport.property("string", "Optional file filter glob, e.g. *.java"));
        properties.put("ignoreCase", FileToolSupport.property("boolean", "Case-insensitive matching (default false)"));
        properties.put("literal", FileToolSupport.property("boolean", "Treat pattern as plain text (default false)"));
        properties.put("context", FileToolSupport.property("number", "Context lines before and after a match (default 0)"));
        properties.put("limit", FileToolSupport.property("number", "Max matches to return (default 100, max 100)"));
        schema.put("properties", properties);
        schema.put("required", List.of("pattern"));
        return schema;
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        Map<String, Object> args = call.arguments();
        if (!(args.get("pattern") instanceof String pattern) || pattern.isBlank()) {
            return ToolResult.error("pattern must not be blank");
        }
        String path = ".";
        if (args.get("path") instanceof String rawPath) {
            path = rawPath;
        }
        String glob = null;
        if (args.get("glob") instanceof String rawGlob) {
            glob = rawGlob;
        }
        boolean ignoreCase;
        boolean literal;
        int context;
        int limit;
        try {
            ignoreCase = boolArg(args.get("ignoreCase"), false, "ignoreCase");
            literal = boolArg(args.get("literal"), false, "literal");
            context = nonNegativeInt(args.get("context"), 0, "context");
            limit = Math.min(positiveInt(args.get("limit"), MAX_MATCHES, "limit"), MAX_MATCHES);
        } catch (IllegalArgumentException e) {
            return ToolResult.error(e.getMessage());
        }
        if (ctx.isCancelled()) {
            return ToolResult.error("cancelled");
        }
        Pattern compiled;
        try {
            compiled =
                    Pattern.compile(
                            literal ? Pattern.quote(pattern) : pattern,
                            ignoreCase ? Pattern.CASE_INSENSITIVE : 0);
        } catch (PatternSyntaxException e) {
            return ToolResult.error("Invalid pattern: " + FileToolSupport.message(e));
        }
        Path workdir = PathSandbox.realPath(ctx.workdir());
        Path root = ctx.resolvePath(path);
        if (!Files.isDirectory(root)) {
            return ToolResult.error("Not a directory: " + path);
        }
        GitIgnore ignore;
        try {
            ignore = GitIgnore.load(ctx.workdir());
        } catch (IOException e) {
            return ToolResult.error("Cannot read .gitignore: " + FileToolSupport.message(e));
        }
        PathMatcher matcher = null;
        if (glob != null) {
            try {
                matcher = FileSystems.getDefault().getPathMatcher("glob:" + glob);
            } catch (PatternSyntaxException e) {
                return ToolResult.error("Invalid glob: " + FileToolSupport.message(e));
            }
        }

        FileCollector collector = new FileCollector(root, workdir, ignore, matcher);
        try {
            Files.walkFileTree(root, collector);
        } catch (IOException e) {
            return ToolResult.error("Cannot list files: " + FileToolSupport.message(e));
        }
        List<Path> files = collector.files();
        Collections.sort(files);

        List<String> out = new ArrayList<>();
        boolean linesTruncated = false;
        boolean matchLimitReached = false;
        int totalMatches = 0;
        for (Path file : files) {
            if (ctx.isCancelled()) {
                return ToolResult.error("cancelled");
            }
            String rel = toPosix(workdir.relativize(file));
            byte[] data;
            try {
                data = Files.readAllBytes(file);
            } catch (IOException e) {
                continue;
            }
            if (hasNulByte(data)) {
                continue;
            }
            List<String> lines = FileToolSupport.splitLines(new String(data, StandardCharsets.UTF_8));
            List<Integer> matched = new ArrayList<>();
            for (int i = 0; i < lines.size(); i++) {
                String line = lines.get(i);
                String search = line.length() > MAX_LINE_CHARS ? line.substring(0, MAX_LINE_CHARS) : line;
                if (line.length() > MAX_LINE_CHARS) {
                    linesTruncated = true;
                }
                if (compiled.matcher(search).find()) {
                    if (totalMatches == limit) {
                        matchLimitReached = true;
                        break;
                    }
                    matched.add(i);
                    totalMatches++;
                }
            }
            appendMatches(out, rel, lines, matched, context);
            if (matchLimitReached) {
                break;
            }
        }
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("matchLimitReached", matchLimitReached);
        meta.put("linesTruncated", linesTruncated);
        return new ToolResult(String.join("\n", out), false, matchLimitReached, null, meta);
    }

    /** Печатает совпадения файла и их (объединённый) контекст в grep-формате. */
    private static void appendMatches(
            List<String> out, String rel, List<String> lines, List<Integer> matched, int context) {
        if (matched.isEmpty()) {
            return;
        }
        List<int[]> ranges = new ArrayList<>();
        for (int m : matched) {
            int start = Math.max(0, m - context);
            int end = Math.min(lines.size() - 1, m + context);
            if (!ranges.isEmpty() && start <= ranges.get(ranges.size() - 1)[1] + 1) {
                ranges.get(ranges.size() - 1)[1] = Math.max(ranges.get(ranges.size() - 1)[1], end);
            } else {
                ranges.add(new int[] {start, end});
            }
        }
        Set<Integer> matchSet = new HashSet<>(matched);
        for (int[] range : ranges) {
            for (int i = range[0]; i <= range[1]; i++) {
                String line = lines.get(i);
                String text = line.length() > MAX_LINE_CHARS ? line.substring(0, MAX_LINE_CHARS) : line;
                if (matchSet.contains(i)) {
                    out.add(rel + ":" + (i + 1) + ": " + text);
                } else {
                    out.add(rel + "-" + (i + 1) + "- " + text);
                }
            }
        }
    }

    private static boolean hasNulByte(byte[] data) {
        int n = Math.min(data.length, BINARY_CHECK_BYTES);
        for (int i = 0; i < n; i++) {
            if (data[i] == 0) {
                return true;
            }
        }
        return false;
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

    private static int nonNegativeInt(Object raw, int defaultValue, String name) {
        if (raw == null) {
            return defaultValue;
        }
        if (!(raw instanceof Number number)) {
            throw new IllegalArgumentException(name + " must be a number");
        }
        long value = number.longValue();
        if (value < 0) {
            throw new IllegalArgumentException(name + " must not be negative");
        }
        return (int) Math.min(value, Integer.MAX_VALUE);
    }

    private static boolean boolArg(Object raw, boolean defaultValue, String name) {
        if (raw == null) {
            return defaultValue;
        }
        if (!(raw instanceof Boolean value)) {
            throw new IllegalArgumentException(name + " must be a boolean");
        }
        return value;
    }

    /** Обход с prune игнорируемых каталогов и symlink-ов; сбор файлов под поиск. */
    private static final class FileCollector extends SimpleFileVisitor<Path> {

        private final Path root;
        private final Path workdir;
        private final GitIgnore ignore;
        private final PathMatcher matcher;
        private final List<Path> files = new ArrayList<>();

        FileCollector(Path root, Path workdir, GitIgnore ignore, PathMatcher matcher) {
            this.root = root;
            this.workdir = workdir;
            this.ignore = ignore;
            this.matcher = matcher;
        }

        List<Path> files() {
            return files;
        }

        @Override
        public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
            if (dir.equals(root)) {
                return FileVisitResult.CONTINUE;
            }
            if (Files.isSymbolicLink(dir)) {
                return FileVisitResult.SKIP_SUBTREE;
            }
            if (ignore.isIgnored(toPosix(workdir.relativize(dir)), true)) {
                return FileVisitResult.SKIP_SUBTREE;
            }
            return FileVisitResult.CONTINUE;
        }

        @Override
        public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
            if (Files.isSymbolicLink(file)) {
                return FileVisitResult.CONTINUE;
            }
            if (ignore.isIgnored(toPosix(workdir.relativize(file)), false)) {
                return FileVisitResult.CONTINUE;
            }
            if (matcher != null) {
                Path rel = workdir.relativize(file);
                if (!(matcher.matches(rel) || matcher.matches(rel.getFileName()))) {
                    return FileVisitResult.CONTINUE;
                }
            }
            files.add(file);
            return FileVisitResult.CONTINUE;
        }

        @Override
        public FileVisitResult visitFileFailed(Path file, IOException exc) {
            return FileVisitResult.CONTINUE;
        }
    }

    private static String toPosix(Path path) {
        return path.toString().replace('\\', '/');
    }
}
