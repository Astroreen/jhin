package com.astroreen.jhin.core.tools.impl;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FileToolsTest {

    @TempDir
    Path workdir;

    private final ReadTool read = new ReadTool();
    private final WriteTool write = new WriteTool();
    private final EditTool edit = new EditTool();
    private final EditDiffTool editDiff = new EditDiffTool();

    @Test
    void readOffsetAndLimitReturnsOnlyRequestedLines() throws Exception {
        Files.writeString(
                workdir.resolve("ten.txt"),
                "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");

        ToolResult result = read.execute(call("path", "ten.txt", "offset", 3, "limit", 2), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).contains("   3| line3", "   4| line4");
        assertThat(result.content()).doesNotContain("line2", "line5");
    }

    @Test
    void readTruncationCapsOutputAndFlagsTruncated() throws Exception {
        StringBuilder builder = new StringBuilder();
        for (int i = 1; i <= 3000; i++) {
            builder.append("line").append(i).append('\n');
        }
        Files.writeString(workdir.resolve("big.txt"), builder.toString());

        ToolResult result = read.execute(call("path", "big.txt"), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.truncated()).isTrue();
        assertThat(result.content().split("\n", -1).length).isLessThanOrEqualTo(2000);
    }

    @Test
    void readImageReturnsBase64Structured() throws Exception {
        byte[] png = new byte[] {(byte) 0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4};
        Files.write(workdir.resolve("img.png"), png);

        ToolResult result = read.execute(call("path", "img.png"), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("[image: image/png, 8 bytes]");
        assertThat(result.structured()).isInstanceOf(Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> structured = (Map<String, Object>) result.structured();
        assertThat(structured)
                .containsEntry("type", "image")
                .containsEntry("mimeType", "image/png")
                .containsEntry("data", Base64.getEncoder().encodeToString(png));
    }

    @Test
    void writeGuardRequiresPriorRead() throws Exception {
        Path file = workdir.resolve("guard.txt");
        Files.writeString(file, "original");
        ToolContext ctx = ctx();

        ToolResult denied = write.execute(call("path", "guard.txt", "content", "updated"), ctx);

        assertThat(denied.error()).isTrue();
        assertThat(denied.content()).isEqualTo("Read the file first before writing");
        assertThat(Files.readString(file)).isEqualTo("original");

        ToolResult readResult = read.execute(call("path", "guard.txt"), ctx);
        assertThat(readResult.error()).isFalse();

        ToolResult allowed = write.execute(call("path", "guard.txt", "content", "updated"), ctx);

        assertThat(allowed.error()).isFalse();
        assertThat(Files.readString(file)).isEqualTo("updated");
    }

    @Test
    void writeNewFileNeedsNoReadAndCreatesParentDirs() throws Exception {
        ToolContext ctx = ctx();

        ToolResult result = write.execute(call("path", "nested/dir/fresh.txt", "content", "hello"), ctx);

        assertThat(result.error()).isFalse();
        assertThat(result.meta()).containsEntry("bytes", 5).containsEntry("lines", 1);
        assertThat(Files.readString(workdir.resolve("nested/dir/fresh.txt"))).isEqualTo("hello");
    }

    @Test
    void editReplacesFirstOccurrenceOrAll() throws Exception {
        Path file = workdir.resolve("aaa.txt");
        Files.writeString(file, "a-a-a");

        ToolResult first = edit.execute(call("path", "aaa.txt", "oldString", "a", "newString", "b"), ctx());

        assertThat(first.error()).isFalse();
        assertThat(first.content()).isEqualTo("replaced 1 occurrence(s)");
        assertThat(Files.readString(file)).isEqualTo("b-a-a");

        Files.writeString(file, "a-a-a");
        ToolResult all =
                edit.execute(
                        call("path", "aaa.txt", "oldString", "a", "newString", "b", "replaceAll", true), ctx());

        assertThat(all.error()).isFalse();
        assertThat(all.content()).isEqualTo("replaced 3 occurrence(s)");
        assertThat(Files.readString(file)).isEqualTo("b-b-b");
    }

    @Test
    void editNoMatchReturnsExactError() throws Exception {
        Files.writeString(workdir.resolve("x.txt"), "hello");

        ToolResult result = edit.execute(call("path", "x.txt", "oldString", "zzz", "newString", "y"), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("No matches found for oldString");
    }

    @Test
    void editDiffShowsUnifiedDiffWithoutWriting() throws Exception {
        Path file = workdir.resolve("d.txt");
        String original = "line1\nline2\nline3\n";
        Files.writeString(file, original);

        ToolResult result =
                editDiff.execute(call("path", "d.txt", "oldString", "line2", "newString", "line2mod"), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).contains("@@", "-line2", "+line2mod");
        assertThat(result.content()).contains("--- a/d.txt", "+++ b/d.txt");
        assertThat(Files.readString(file)).isEqualTo(original);
    }

    @Test
    void readMissingFileAndDirectoryError() throws Exception {
        assertThat(read.execute(call("path", "missing.txt"), ctx()).content())
                .isEqualTo("File not found: missing.txt");
        Files.createDirectory(workdir.resolve("somedir"));
        assertThat(read.execute(call("path", "somedir"), ctx()).content()).isEqualTo("Is a directory");
    }

    private ToolContext ctx() {
        return new ToolContext(workdir, "s1", "r1", "a1");
    }

    private static ToolCall call(Object... kv) {
        Map<String, Object> args = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            args.put((String) kv[i], kv[i + 1]);
        }
        return new ToolCall("files", args, "c1");
    }
}
