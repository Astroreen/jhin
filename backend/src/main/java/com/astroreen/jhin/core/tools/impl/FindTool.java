package com.astroreen.jhin.core.tools.impl;

import com.astroreen.jhin.core.tools.PathSandbox;
import com.astroreen.jhin.core.tools.gitignore.GitIgnore;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.io.IOException;
import java.nio.file.FileSystems;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.PatternSyntaxException;
import org.springframework.stereotype.Component;

/**
 * Тул "find": поиск файлов и каталогов по glob-паттерну в workdir (только чистая Java).
 *
 * <p><b>Аргументы.</b> {@code pattern} (glob, обязателен; например {@code *.java},
 * {@code **} + слэш + {@code *.md}), {@code path} (корень поиска относительно workdir,
 * default {@code .}), {@code limit} (максимум записей, default 1000).
 *
 * <p><b>Правило матча glob.</b> Побеждает совпадение по workdir-relative пути ИЛИ
 * по одному имени файла/катарога — засчитывается любое из двух. Семантика glob —
 * {@link java.nio.file.FileSystem#getPathMatcher}: {@code *} не пересекает {@code /},
 * {@code **} пересекает. Из-за этого {@code *.java} матчит имена файлов на любой
 * глубине, а, например, {@code **} + слэш + {@code *.md} на Java-глобе не матчит
 * {@code .md} прямо в корне.
 *
 * <p><b>Обход.</b> Без следования symlink-ам; symlink-ы (файлы и каталоги) пропускаются
 * целиком. Каталоги, игнорируемые корневым .gitignore, не спускаются (prune), сами
 * игнорируемые записи и всё под игнорируемыми каталогами не выводятся.
 *
 * <p><b>Вывод.</b> Одна workdir-relative POSIX-строка пути на строку вывода (без
 * {@code N| }-нумерации — машиночитаемо), каталоги с суффиксом {@code /}. Корень поиска
 * сам в вывод не входит. Записи сортируются лексикографически (суффикс {@code /} входит
 * в ключ сортировки).
 *
 * <p><b>Лимит.</b> Собираются записи до {@code limit}; при виде (limit+1)-й записи обход
 * останавливается (дальше не собираем), собранное сортируется и выводится. Meta
 * {@code limitReached=true} и {@code truncated=true} — только если записей больше
 * {@code limit} (ровно {@code limit} → флаги false). Подмножество при переполнении —
 * первые {@code limit} в порядке обхода ФС (OS-зависим), затем отсортированы.
 */
@Component
public class FindTool implements ToolDefinition {

    @Override
    public String name() {
        return "find";
    }

    @Override
    public String label() {
        return "Find files";
    }

    @Override
    public String description() {
        return "Lists files and directories under the session working directory matching a glob"
                + " pattern, skipping paths ignored by the root .gitignore.";
    }

    @Override
    public String promptSnippet() {
        return "find - list files/dirs matching a glob (gitignore-aware, sorted, limit 1000)";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use find to locate files by name pattern before reading or editing them.",
                "The glob matches the workspace-relative path or the bare file name - either counts ('*.java' finds x.java at any depth).",
                "Directories are printed with a trailing '/'; ignored paths (.gitignore) and symlinks are skipped.",
                "Output paths are sorted; 'limit' (default 1000) caps the list and sets truncated=true with meta limitReached=true.");
    }

    @Override
    public Map<String, Object> parametersSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("pattern", FileToolSupport.property("string", "Glob pattern, e.g. *.java or **/*.md"));
        properties.put("path", FileToolSupport.property("string", "Root directory in the workspace (default .)"));
        properties.put("limit", FileToolSupport.property("number", "Max entries to return (default 1000)"));
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
        int limit;
        try {
            limit = positiveInt(args.get("limit"), 1000, "limit");
        } catch (IllegalArgumentException e) {
            return ToolResult.error(e.getMessage());
        }
        if (ctx.isCancelled()) {
            return ToolResult.error("cancelled");
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
        PathMatcher matcher;
        try {
            matcher = FileSystems.getDefault().getPathMatcher("glob:" + pattern);
        } catch (PatternSyntaxException e) {
            return ToolResult.error("Invalid pattern: " + FileToolSupport.message(e));
        }

        CollectVisitor visitor = new CollectVisitor(root, workdir, ignore, matcher, limit);
        try {
            Files.walkFileTree(root, visitor);
        } catch (IOException e) {
            return ToolResult.error("Cannot list files: " + FileToolSupport.message(e));
        }
        List<String> found = visitor.found();
        Collections.sort(found);
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("limitReached", visitor.limitReached());
        return new ToolResult(String.join("\n", found), false, visitor.limitReached(), null, meta);
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

    /** Обход с prune игнорируемых каталогов и symlink-ов; сбор до limit, останов при переполнении. */
    private static final class CollectVisitor extends SimpleFileVisitor<Path> {

        private final Path root;
        private final Path workdir;
        private final GitIgnore ignore;
        private final PathMatcher matcher;
        private final int limit;
        private final List<String> found = new ArrayList<>();
        private boolean limitReached;

        CollectVisitor(Path root, Path workdir, GitIgnore ignore, PathMatcher matcher, int limit) {
            this.root = root;
            this.workdir = workdir;
            this.ignore = ignore;
            this.matcher = matcher;
            this.limit = limit;
        }

        List<String> found() {
            return found;
        }

        boolean limitReached() {
            return limitReached;
        }

        @Override
        public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
            if (dir.equals(root)) {
                return FileVisitResult.CONTINUE;
            }
            if (Files.isSymbolicLink(dir)) {
                return FileVisitResult.SKIP_SUBTREE;
            }
            if (ignored(dir, true)) {
                return FileVisitResult.SKIP_SUBTREE;
            }
            return consider(dir, true);
        }

        @Override
        public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
            if (Files.isSymbolicLink(file)) {
                return FileVisitResult.CONTINUE;
            }
            if (ignored(file, false)) {
                return FileVisitResult.CONTINUE;
            }
            return consider(file, false);
        }

        @Override
        public FileVisitResult visitFileFailed(Path file, IOException exc) {
            return FileVisitResult.CONTINUE;
        }

        private FileVisitResult consider(Path entry, boolean isDir) {
            Path rel = workdir.relativize(entry);
            if (!(matcher.matches(rel) || matcher.matches(rel.getFileName()))) {
                return FileVisitResult.CONTINUE;
            }
            if (found.size() >= limit) {
                limitReached = true;
                return FileVisitResult.TERMINATE;
            }
            found.add(toPosix(rel) + (isDir ? "/" : ""));
            return FileVisitResult.CONTINUE;
        }

        private boolean ignored(Path entry, boolean isDir) {
            return ignore.isIgnored(toPosix(workdir.relativize(entry)), isDir);
        }
    }

    private static String toPosix(Path path) {
        return path.toString().replace('\\', '/');
    }
}
