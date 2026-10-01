/**
 * The {@code grep} tool: regex content search over text files in the workdir,
 * pure Java ({@code java.util.regex}).
 *
 * <p><b>Arguments.</b> {@code pattern} (required), {@code path} (search root,
 * default {@code .}), {@code glob} (optional file filter; matched against the
 * workdir-relative path OR the file name, as in {@code find}), {@code
 * ignoreCase} (default false), {@code literal} (default false - the pattern is
 * a regex; {@code true} quotes it as plain text), {@code context} (lines
 * before/after a match, default 0), {@code limit} (max matches, default 100,
 * hard cap 100).
 *
 * <p><b>Walking.</b> As in {@code find}: symlinks are skipped, the root
 * {@code .gitignore} is honoured (ignored directories are pruned), binary
 * files are skipped (a NUL byte in the first 8KB). Files are searched in
 * lexicographic path order, lines in file order.
 *
 * <p><b>Long lines.</b> Only the first 2000 characters of a line are searched
 * and printed; the card row {@code linesTruncated} records that a longer line
 * was seen.
 *
 * <p><b>Output</b> (grep {@code -n} style): a match is {@code path:N: text},
 * a context line is {@code path-N- text} (the dash marks context). N is the
 * 1-based line number. Overlapping or adjacent context ranges in one file are
 * merged; a matched line is printed once in match form. No matches - empty
 * content and NOT an error (as grep with a non-zero exit).
 *
 * <p><b>Limit.</b> Collection stops at the (limit+1)-th match; the card row
 * {@code limitReached} is {@code true} only when more than {@code limit}
 * matches existed.
 *
 * <p><b>Structured card.</b> {@code card} with rows {@code pattern},
 * {@code matches}, {@code limitReached}, {@code linesTruncated} and one row
 * per match ({@code label} = {@code path:N}, {@code value} = matched text).
 *
 * <p><b>Failures.</b> An invalid regex is
 * {@code "Invalid pattern: <description>"} (from
 * {@link java.util.regex.PatternSyntaxException#getDescription()}); a missing
 * search root is {@code "Not a directory: <path>"}; a workspace escape is
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

final class GrepTool implements ToolDefinition {

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
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("pattern", FileToolSupport.property("string", "Pattern to search for (regex by default)"));
        properties.put("path", FileToolSupport.property("string", "Root directory in the workspace (default .)"));
        properties.put("glob", FileToolSupport.property("string", "Optional file filter glob, e.g. *.java"));
        properties.put("ignoreCase", FileToolSupport.property("boolean", "Case-insensitive matching (default false)"));
        properties.put("literal", FileToolSupport.property("boolean", "Treat pattern as plain text (default false)"));
        properties.put("context",
                FileToolSupport.property("number", "Context lines before and after a match (default 0)"));
        properties.put("limit", FileToolSupport.property("number", "Max matches to return (default 100, max 100)"));
        return FileToolSupport.schema(properties, List.of("pattern"));
    }

    @Override
    public String promptSnippet() {
        return "grep - regex/literal search in files (gitignore-aware, glob filter, context lines, limit 100 matches)";
    }

    @Override
    public String promptGuidelines() {
        return "Use grep to find code or text across the workspace before editing.\n"
                + "Output is grep -n style: 'path:N: text' for matches, 'path-N- text' for context lines.\n"
                + "Set literal=true for plain-text search (no regex metacharacters) and ignoreCase=true to fold case.\n"
                + "Only the first 2000 chars of a line are searched and printed; binary files and .gitignore'd paths are skipped.\n"
                + "Matches stop at 'limit' (default 100, max 100) and set limitReached=true on the card.";
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
        String glob = FileToolSupport.optionalString(args, "glob", null);
        boolean ignoreCase = FileToolSupport.boolArg(args.get("ignoreCase"), false, "ignoreCase");
        boolean literal = FileToolSupport.boolArg(args.get("literal"), false, "literal");
        int context = FileToolSupport.nonNegativeInt(args.get("context"), 0, "context");
        int limit = Math.min(FileToolSupport.positiveInt(args.get("limit"), MAX_MATCHES, "limit"), MAX_MATCHES);
        if (ctx.isCancelled()) {
            return ToolResult.error("cancelled");
        }
        Pattern compiled;
        try {
            compiled = Pattern.compile(
                    literal ? Pattern.quote(pattern) : pattern,
                    ignoreCase ? Pattern.CASE_INSENSITIVE : 0);
        } catch (PatternSyntaxException e) {
            return ToolResult.error("Invalid pattern: " + e.getDescription());
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
        List<Map<String, String>> matchRows = new ArrayList<>();
        boolean linesTruncated = false;
        boolean limitReached = false;
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
                        limitReached = true;
                        break;
                    }
                    matched.add(i);
                    matchRows.add(FileToolSupport.Structured.row(rel + ":" + (i + 1), search));
                    totalMatches++;
                }
            }
            appendMatches(out, rel, lines, matched, context);
            if (limitReached) {
                break;
            }
        }

        List<Map<String, String>> rows = new ArrayList<>();
        rows.add(FileToolSupport.Structured.row("pattern", pattern));
        rows.add(FileToolSupport.Structured.row("matches", Integer.toString(totalMatches)));
        rows.add(FileToolSupport.Structured.row("limitReached", Boolean.toString(limitReached)));
        rows.add(FileToolSupport.Structured.row("linesTruncated", Boolean.toString(linesTruncated)));
        rows.addAll(matchRows);
        return ToolResult.ok(String.join("\n", out), FileToolSupport.Structured.card("grep", rows));
    }

    /** Prints the file's matches and their (merged) context in grep format. */
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

    /** Walk with pruning of ignored directories and symlinks; collects files to search. */
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
