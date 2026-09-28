package com.astroreen.jhin.core.tools.impl;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SearchToolsTest {

    @TempDir
    Path workdir;

    private final FindTool find = new FindTool();
    private final GrepTool grep = new GrepTool();
    private final LsTool ls = new LsTool();

    @BeforeEach
    void setupTree() throws IOException {
        Files.writeString(workdir.resolve(".gitignore"), "*.log\nbuild/\n");
        Files.writeString(
                workdir.resolve("keep.java"),
                "class Keep {\n  String s = \"fooXbar\";\n  int NEEDLE = 1;\n}\n");
        Files.writeString(workdir.resolve("notes.txt"), "line one\nfoo.bar here\nline three\n");
        Files.writeString(workdir.resolve("a.log"), "foo.bar secret log\n");
        Files.createDirectories(workdir.resolve("build"));
        Files.writeString(workdir.resolve("build/gen.java"), "foo.bar in build\n");
        Files.createDirectories(workdir.resolve("src/deep"));
        Files.writeString(workdir.resolve("src/deep/x.java"), "package deep;\nfoo.bar in deep\n");
    }

    @Test
    void findGlobMatchesNamesAndSkipsGitignored() {
        ToolResult result = find.execute(call("pattern", "*.java"), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("keep.java\nsrc/deep/x.java");
        assertThat(result.truncated()).isFalse();
        assertThat(result.meta()).containsEntry("limitReached", false);
    }

    @Test
    void findStarListsDirsAndFilesWithoutIgnored() {
        ToolResult result = find.execute(call("pattern", "*"), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content())
                .contains("keep.java", "notes.txt", ".gitignore", "src/", "src/deep/", "src/deep/x.java");
        assertThat(result.content()).doesNotContain("a.log", "build");
    }

    @Test
    void findLimitCapsOutputAndFlagsTruncated() {
        ToolResult result = find.execute(call("pattern", "*.java", "limit", 1), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content().split("\n", -1)).hasSize(1);
        assertThat(result.content()).isIn("keep.java", "src/deep/x.java");
        assertThat(result.truncated()).isTrue();
        assertThat(result.meta()).containsEntry("limitReached", true);
    }

    @Test
    void grepLiteralDoesNotMatchRegexMetachars() {
        ToolResult result = grep.execute(call("pattern", "foo.bar", "literal", true), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).contains("notes.txt:2: foo.bar here");
        assertThat(result.content()).doesNotContain("fooXbar", "keep.java");
    }

    @Test
    void grepRegexMatchesDotAsAnyChar() {
        ToolResult result = grep.execute(call("pattern", "foo.bar"), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).contains("notes.txt:2: foo.bar here");
        assertThat(result.content()).contains("keep.java:2:   String s = \"fooXbar\";");
    }

    @Test
    void grepIgnoreCaseMatches() {
        ToolResult result =
                grep.execute(call("pattern", "needle", "ignoreCase", true, "literal", true), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).contains("keep.java:3:   int NEEDLE = 1;");

        ToolResult caseSensitive = grep.execute(call("pattern", "needle", "literal", true), ctx());

        assertThat(caseSensitive.error()).isFalse();
        assertThat(caseSensitive.content()).isEmpty();
    }

    @Test
    void grepContextIncludesNeighbourLines() {
        ToolResult result = grep.execute(call("pattern", "foo.bar", "context", 1), ctx());

        assertThat(result.content())
                .contains("notes.txt-1- line one", "notes.txt:2: foo.bar here", "notes.txt-3- line three");
    }

    @Test
    void grepMatchLimitStopsEarlyAndFlags() throws IOException {
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 75; i++) {
            many.append("match line\n");
        }
        Files.writeString(workdir.resolve("many1.txt"), many.toString());
        Files.writeString(workdir.resolve("many2.txt"), many.toString());

        ToolResult result = grep.execute(call("pattern", "match", "limit", 100), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.meta()).containsEntry("matchLimitReached", true);
        assertThat(result.meta()).containsEntry("linesTruncated", false);
        assertThat(result.content().split("\n", -1)).hasSize(100);
    }

    @Test
    void grepTruncatesLongLinesAndFlags() throws IOException {
        String longLine = "x".repeat(1500) + "UNIQUE_TOKEN" + "y".repeat(1500);
        Files.writeString(workdir.resolve("long.txt"), longLine + "\n");

        ToolResult result = grep.execute(call("pattern", "UNIQUE_TOKEN", "literal", true), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.meta()).containsEntry("linesTruncated", true);
        assertThat(result.content()).startsWith("long.txt:1: ");
        assertThat(result.content()).contains("UNIQUE_TOKEN");
        assertThat(result.content()).hasSize("long.txt:1: ".length() + 2000);
    }

    @Test
    void grepDoesNotSeeMatchesBeyondLineWindow() throws IOException {
        String longLine = "x".repeat(2500) + "UNIQUE_TOKEN" + "y".repeat(100);
        Files.writeString(workdir.resolve("long2.txt"), longLine + "\n");

        ToolResult result = grep.execute(call("pattern", "UNIQUE_TOKEN", "literal", true), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEmpty();
        assertThat(result.meta()).containsEntry("linesTruncated", true);
    }

    @Test
    void grepSkipsGitignoredAndBinaryFiles() throws IOException {
        Files.write(workdir.resolve("bin.dat"), new byte[] {1, 0, 2, 3, 'f', 'o', 'o'});

        ToolResult result = grep.execute(call("pattern", "foo"), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).doesNotContain("a.log", "gen.java", "bin.dat", "build");
        assertThat(result.content()).contains("keep.java", "notes.txt", "src/deep/x.java");
    }

    @Test
    void lsListsDirsFirstAndSkipsIgnored() {
        ToolResult result = ls.execute(call(), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content().split("\n", -1))
                .containsExactly("src/", ".gitignore", "keep.java", "notes.txt");
        assertThat(result.truncated()).isFalse();
    }

    @Test
    void lsLimitCapsOutputAndFlagsTruncated() {
        ToolResult result = ls.execute(call("limit", 1), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("src/");
        assertThat(result.truncated()).isTrue();
    }

    @Test
    void toolsScopeToSubdirPathArgument() {
        ToolResult findResult = find.execute(call("pattern", "*", "path", "src"), ctx());
        assertThat(findResult.error()).isFalse();
        assertThat(findResult.content()).isEqualTo("src/deep/\nsrc/deep/x.java");

        ToolResult grepResult = grep.execute(call("pattern", "foo.bar", "path", "src"), ctx());
        assertThat(grepResult.error()).isFalse();
        assertThat(grepResult.content()).isEqualTo("src/deep/x.java:2: foo.bar in deep");

        ToolResult lsResult = ls.execute(call("path", "src"), ctx());
        assertThat(lsResult.error()).isFalse();
        assertThat(lsResult.content()).isEqualTo("src/deep/");
    }

    @Test
    void missingPatternAndBadArgsError() {
        assertThat(find.execute(call(), ctx()).error()).isTrue();
        assertThat(grep.execute(call(), ctx()).error()).isTrue();
        assertThat(grep.execute(call("pattern", "x", "context", -1), ctx()).error()).isTrue();
        assertThat(grep.execute(call("pattern", "(", "literal", false), ctx()).error()).isTrue();
    }

    private ToolContext ctx() {
        return new ToolContext(workdir, "s1", "r1", "a1");
    }

    private static ToolCall call(Object... kv) {
        Map<String, Object> args = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            args.put((String) kv[i], kv[i + 1]);
        }
        return new ToolCall("search", args, "c1");
    }
}
