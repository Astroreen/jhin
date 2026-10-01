/**
 * The {@code find} tool: recursive name/glob search over the workdir, pure
 * Java ({@code Files.walk} semantics via {@code Files.walkFileTree}).
 *
 * <p><b>Arguments.</b> {@code pattern} (glob, required; for example
 * {@code *.java}, {@code **}/{@code *.md}), {@code path} (search root relative
 * to the workdir, default {@code .}), {@code limit} (max entries, default
 * 1000, documented cap).
 *
 * <p><b>Glob match rule.</b> A hit counts when the pattern matches the
 * workdir-relative path OR the bare file/directory name. Glob semantics are
 * {@link java.nio.file.FileSystem#getPathMatcher}: {@code *} does not cross
 * {@code /}, {@code **} does; because of that {@code *.java} matches names at
 * any depth while {@code **}/{@code *.md} does not match {@code .md} files
 * directly in the root.
 *
 * <p><b>Walking.</b> Without following symlinks; symlinks (files and
 * directories) are skipped entirely. Directories ignored by the root
 * {@code .gitignore} are pruned; ignored entries are not listed.
 *
 * <p><b>Output.</b> One workdir-relative POSIX path per content line,
 * directories with a trailing {@code /}; the search root itself is never
 * listed. Entries are sorted lexicographically (the {@code /} suffix is part
 * of the sort key).
 *
 * <p><b>Limit.</b> Collection stops when the (limit+1)-th hit would be
 * collected; the collected subset (first {@code limit} in walk order) is then
 * sorted. The card row {@code limitReached} is {@code true} only when more
 * than {@code limit} entries matched.
 *
 * <p><b>Structured card.</b> {@code card} with rows {@code pattern},
 * {@code path}, {@code limitReached} and one row per hit
 * ({@code label} = dir|file, {@code value} = path).
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.toolsbuiltin.gitignore.GitIgnore;
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

final class FindTool implements ToolDefinition {

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
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("pattern", FileToolSupport.property("string", "Glob pattern, e.g. *.java or **/*.md"));
        properties.put("path", FileToolSupport.property("string", "Root directory in the workspace (default .)"));
        properties.put("limit", FileToolSupport.property("number", "Max entries to return (default 1000)"));
        return FileToolSupport.schema(properties, List.of("pattern"));
    }

    @Override
    public String promptSnippet() {
        return "find - list files/dirs matching a glob (gitignore-aware, sorted, limit 1000)";
    }

    @Override
    public String promptGuidelines() {
        return "Use find to locate files by name pattern before reading or editing them.\n"
                + "The glob matches the workspace-relative path or the bare file name - either counts ('*.java' finds x.java at any depth).\n"
                + "Directories are printed with a trailing '/'; ignored paths (.gitignore) and symlinks are skipped.\n"
                + "Output paths are sorted; 'limit' (default 1000) caps the list and sets limitReached=true on the card.";
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
        String pattern = FileToolSupport.requireString(args, "pattern");
        String path = FileToolSupport.optionalString(args, "path", ".");
        int limit = FileToolSupport.positiveInt(args.get("limit"), 1000, "limit");
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

        List<Map<String, String>> rows = new ArrayList<>();
        rows.add(FileToolSupport.Structured.row("pattern", pattern));
        rows.add(FileToolSupport.Structured.row("path", path));
        rows.add(FileToolSupport.Structured.row("limitReached", Boolean.toString(visitor.limitReached())));
        for (String hit : found) {
            String type = hit.endsWith("/") ? "dir" : "file";
            rows.add(FileToolSupport.Structured.row(hit, type));
        }
        return ToolResult.ok(String.join("\n", found), FileToolSupport.Structured.card("find", rows));
    }

    /**
     * Walk with pruning of ignored directories and symlinks; collects up to
     * {@code limit} hits and stops when the limit would overflow.
     */
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
