/**
 * A pragmatic {@code .gitignore} matcher (JDK only, no external libraries)
 * used by {@code ls}, {@code find} and {@code grep} to skip ignored paths.
 *
 * <p><b>Rule source.</b> Only the root {@code {workdir}/.gitignore} - nested
 * {@code .gitignore} files are out of scope. {@link #load(Path)} returns an
 * empty matcher when the file is missing. Blank lines and {@code #} comments
 * are skipped; the line syntax follows git.
 *
 * <p><b>Pattern semantics</b> (a pragmatic subset, not a full git reimplementation):
 * <ul>
 *   <li>{@code *} - any characters except {@code /}; {@code **} - any
 *       characters including {@code /} (a leading {@code **}/ and an embedded
 *       /{@code **}/ mean "any number of directories", a trailing
 *       /{@code **} means "everything inside"); {@code ?} - one character
 *       except {@code /}; {@code [...]} - character class with ranges and
 *       {@code !}/{@code ^} negation.</li>
 *   <li>Trailing {@code /} - a directory-only pattern: the directory itself
 *       and everything under it.</li>
 *   <li>A leading {@code /} or an embedded {@code /} (except the trailing one)
 *       anchors the pattern to the workdir root; without {@code /} the pattern
 *       matches the basename at any depth.</li>
 *   <li>Escapes: {@code \#}, {@code \!}, {@code \\} and other {@code \<char>}.</li>
 *   <li>Negation {@code !...} re-includes; the <b>last matching pattern wins</b>.</li>
 *   <li>An ignored directory ignores its whole contents: re-including a file
 *       under an ignored directory is impossible (as in git).</li>
 * </ul>
 *
 * <p>Each pattern is translated to a regex by hand. Paths are tested in POSIX
 * form (separators {@code /}, relative to the workdir root). API:
 * {@link #isIgnored(String, boolean)}.
 */
package com.astroreen.jhin.plugin.toolsbuiltin.gitignore;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public final class GitIgnore {

    private final List<Rule> rules;

    private GitIgnore(List<Rule> rules) {
        this.rules = List.copyOf(rules);
    }

    /**
     * Reads {@code {workdir}/.gitignore}; a missing file yields an empty
     * matcher (nothing is ignored).
     *
     * @param workdir the session working directory
     * @return the matcher for the root ignore file
     * @throws IOException when the file exists but cannot be read
     */
    public static GitIgnore load(Path workdir) throws IOException {
        Path file = workdir.resolve(".gitignore");
        if (!Files.isRegularFile(file)) {
            return new GitIgnore(List.of());
        }
        return parse(Files.readString(file));
    }

    /**
     * Parses {@code .gitignore} content (also used directly in tests).
     *
     * @param content the file content
     * @return the matcher for the parsed rules
     */
    public static GitIgnore parse(String content) {
        List<Rule> rules = new ArrayList<>();
        for (String line : content.lines().toList()) {
            addRule(rules, line);
        }
        return new GitIgnore(rules);
    }

    /**
     * Whether the path is ignored. The path is workdir-relative with POSIX
     * separators; {@code isDirectory} guides directory-only patterns and the
     * ignored-directory check of ancestors.
     *
     * @param relativePath the workdir-relative path
     * @param isDirectory  whether the path itself is a directory
     * @return {@code true} when the path is ignored
     */
    public boolean isIgnored(String relativePath, boolean isDirectory) {
        String path = normalize(relativePath);
        if (path.isEmpty()) {
            return false;
        }
        int slash = path.indexOf('/');
        while (slash >= 0) {
            if (lastMatch(path.substring(0, slash), true)) {
                return true;
            }
            slash = path.indexOf('/', slash + 1);
        }
        return lastMatch(path, isDirectory);
    }

    /** The last matching pattern decides; no match means not ignored. */
    private boolean lastMatch(String path, boolean isDirectory) {
        Boolean ignored = null;
        for (Rule rule : rules) {
            if (rule.dirOnly() && !isDirectory) {
                continue;
            }
            if (rule.regex().matcher(path).matches()) {
                ignored = !rule.negated();
            }
        }
        return Boolean.TRUE.equals(ignored);
    }

    private static String normalize(String path) {
        String s = path.replace('\\', '/');
        while (s.startsWith("./")) {
            s = s.substring(2);
        }
        while (s.startsWith("/")) {
            s = s.substring(1);
        }
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    private static void addRule(List<Rule> rules, String line) {
        String s = line.strip();
        if (s.isEmpty() || s.startsWith("#")) {
            return;
        }
        boolean negated = false;
        if (s.startsWith("!")) {
            negated = true;
            s = s.substring(1);
            if (s.isEmpty()) {
                return;
            }
        }
        boolean dirOnly = false;
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
            dirOnly = true;
            if (s.isEmpty()) {
                return;
            }
        }
        boolean anchored = s.indexOf('/') >= 0;
        if (s.startsWith("/")) {
            s = s.substring(1);
            if (s.isEmpty()) {
                return;
            }
            anchored = true;
        }
        String body = translate(s);
        String regex = anchored ? body : "(?:.*/)?" + body;
        rules.add(new Rule(Pattern.compile("^" + regex + "$"), negated, dirOnly));
    }

    /** Translates a glob fragment (no anchors/negation/slashes) into a regex. */
    private static String translate(String glob) {
        StringBuilder rx = new StringBuilder();
        int n = glob.length();
        int i = 0;
        while (i < n) {
            char c = glob.charAt(i);
            if (c == '*') {
                int j = i;
                while (j < n && glob.charAt(j) == '*') {
                    j++;
                }
                boolean afterSlash = i > 0 && glob.charAt(i - 1) == '/';
                boolean beforeSlash = j < n && glob.charAt(j) == '/';
                if (j - i >= 2) {
                    if (beforeSlash && (i == 0 || afterSlash)) {
                        // leading **/ or embedded /**/ - any number of directories
                        rx.append("(?:[^/]+/)*");
                        i = j + 1;
                    } else {
                        // trailing /** and bare ** - across separators
                        rx.append(".*");
                        i = j;
                    }
                } else {
                    rx.append("[^/]*");
                    i = j;
                }
                continue;
            }
            if (c == '?') {
                rx.append("[^/]");
                i++;
                continue;
            }
            if (c == '[') {
                int next = appendClass(rx, glob, i);
                if (next < 0) {
                    appendLiteral(rx, '[');
                    i++;
                } else {
                    i = next;
                }
                continue;
            }
            if (c == '\\') {
                if (i + 1 < n) {
                    appendLiteral(rx, glob.charAt(i + 1));
                    i += 2;
                } else {
                    appendLiteral(rx, '\\');
                    i++;
                }
                continue;
            }
            appendLiteral(rx, c);
            i++;
        }
        return rx.toString();
    }

    /**
     * Character class {@code [...]} to a regex class. Returns the index past
     * the closing bracket, or -1 when the class is unterminated (the opening
     * bracket then stays a literal).
     */
    private static int appendClass(StringBuilder rx, String glob, int start) {
        int n = glob.length();
        int k = start + 1;
        StringBuilder cls = new StringBuilder("[");
        if (k < n && (glob.charAt(k) == '!' || glob.charAt(k) == '^')) {
            cls.append('^');
            k++;
        }
        boolean first = true;
        if (k < n && glob.charAt(k) == ']') {
            cls.append("\\]");
            k++;
            first = false;
        }
        while (k < n && glob.charAt(k) != ']') {
            char c = glob.charAt(k);
            if (c == '\\' && k + 1 < n) {
                appendClassLiteral(cls, glob.charAt(k + 1));
                k += 2;
            } else if (c == '-' && !first) {
                cls.append('-');
                k++;
            } else {
                appendClassLiteral(cls, c);
                k++;
            }
            first = false;
        }
        if (k >= n) {
            return -1;
        }
        cls.append(']');
        rx.append(cls);
        return k + 1;
    }

    private static void appendClassLiteral(StringBuilder cls, char c) {
        if (c == '\\' || c == ']' || c == '^' || c == '-' || c == '[') {
            cls.append('\\');
        }
        cls.append(c);
    }

    private static void appendLiteral(StringBuilder rx, char c) {
        if ("\\.[]{}()*+-?^$|".indexOf(c) >= 0) {
            rx.append('\\');
        }
        rx.append(c);
    }

    private record Rule(Pattern regex, boolean negated, boolean dirOnly) {}
}
