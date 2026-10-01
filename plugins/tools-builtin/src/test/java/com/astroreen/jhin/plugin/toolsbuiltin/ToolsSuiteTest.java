package com.astroreen.jhin.plugin.toolsbuiltin;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The T34 QA matrix in a temp workdir: the happy path of every tool asserted
 * on content AND on the documented {@code structured} card shape (including
 * {@code bash echo}), plus the five failure cases with their exact stable
 * messages.
 */
class ToolsSuiteTest {

    @TempDir
    Path workdir;

    private FakeToolContext ctx() {
        return new FakeToolContext(workdir);
    }

    private static ToolCall call(String name, Map<String, Object> arguments) {
        return new ToolCall("c-test", name, Json.write(arguments));
    }

    /** Asserts the documented card shape: kind, title and {label, value} rows. */
    private static void assertCard(String structured, String title) {
        Map<String, Object> card = Json.readMap(structured);
        assertThat(card).containsEntry("kind", "card").containsEntry("title", title);
        assertThat(card.get("rows")).isInstanceOf(List.class);
        for (Object rawRow : (List<?>) card.get("rows")) {
            assertThat(rawRow).isInstanceOf(Map.class);
            @SuppressWarnings("unchecked")
            Map<String, String> row = (Map<String, String>) rawRow;
            assertThat(row).containsOnlyKeys("label", "value");
            assertThat(row.get("label")).isInstanceOf(String.class);
            assertThat(row.get("value")).isInstanceOf(String.class);
        }
    }

    private static String rowValue(String structured, String label) {
        for (Object rawRow : (List<?>) Json.readMap(structured).get("rows")) {
            Map<?, ?> row = (Map<?, ?>) rawRow;
            if (label.equals(row.get("label"))) {
                return (String) row.get("value");
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- happy

    @Test
    void lsListsEntriesWithNameTypeAndSize() throws Exception {
        Files.createDirectories(workdir.resolve("sub"));
        Files.writeString(workdir.resolve("a.txt"), "hello");
        Files.writeString(workdir.resolve("b.log"), "noise");
        Files.writeString(workdir.resolve(".gitignore"), "*.log\n");

        ToolResult result = new LsTool().execute(call("ls", Map.of()), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content())
                .contains("dir  sub/")
                .contains("file a.txt  5")
                .contains("file .gitignore")
                .doesNotContain("b.log");
        assertCard(result.structured(), "ls");
        assertThat(rowValue(result.structured(), "entries")).isEqualTo("3");
        assertThat(rowValue(result.structured(), "truncated")).isEqualTo("false");
    }

    @Test
    void writeCreatesFileAndReturnsCard() throws Exception {
        ToolResult result = new WriteTool().execute(
                call("write", Map.of("path", "notes.txt", "content", "hello\nworld\n")), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("Wrote 12 bytes, 2 line(s)");
        assertThat(workdir.resolve("notes.txt")).hasContent("hello\nworld\n");
        assertCard(result.structured(), "write");
        assertThat(rowValue(result.structured(), "path")).isEqualTo("notes.txt");
        assertThat(rowValue(result.structured(), "bytes")).isEqualTo("12");
        assertThat(rowValue(result.structured(), "lines")).isEqualTo("2");
    }

    @Test
    void readReturnsNumberedTextAndCard() throws Exception {
        Files.writeString(workdir.resolve("hello.txt"), "hello\nworld\n");
        FakeToolContext ctx = ctx();

        ToolResult result = new ReadTool().execute(call("read", Map.of("path", "hello.txt")), ctx);

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("   1| hello\n   2| world");
        assertCard(result.structured(), "read");
        assertThat(rowValue(result.structured(), "lines")).isEqualTo("2");
        assertThat(rowValue(result.structured(), "total")).isEqualTo("2");
        assertThat(ctx.readPaths()).containsExactly(workdir.resolve("hello.txt").toRealPath());
    }

    @Test
    void editReplacesLiteralAndReturnsCard() throws Exception {
        Files.writeString(workdir.resolve("hello.txt"), "hello world\n");
        FakeToolContext ctx = ctx();
        new ReadTool().execute(call("read", Map.of("path", "hello.txt")), ctx);

        ToolResult result = new EditTool().execute(
                call("edit", Map.of("path", "hello.txt", "oldString", "world", "newString", "jhin")), ctx);

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("replaced 1 occurrence(s)");
        assertThat(workdir.resolve("hello.txt")).hasContent("hello jhin\n");
        assertCard(result.structured(), "edit");
        assertThat(rowValue(result.structured(), "replacements")).isEqualTo("1");
    }

    @Test
    void editDiffReturnsUnifiedDiffAndCard() throws Exception {
        Files.writeString(workdir.resolve("hello.txt"), "hello world\n");

        ToolResult result = new EditDiffTool().execute(
                call("edit-diff", Map.of("path", "hello.txt", "oldString", "world", "newString", "jhin")),
                ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).contains("--- a/hello.txt").contains("+++ b/hello.txt").contains("+hello jhin");
        assertThat(workdir.resolve("hello.txt")).hasContent("hello world\n");
        assertCard(result.structured(), "edit-diff");
        assertThat(rowValue(result.structured(), "diffLines")).isEqualTo("5");
    }

    @Test
    void findListsGlobMatches() throws Exception {
        Files.createDirectories(workdir.resolve("sub"));
        Files.writeString(workdir.resolve("a.txt"), "a");
        Files.writeString(workdir.resolve("sub/b.txt"), "b");
        Files.writeString(workdir.resolve("c.md"), "c");

        ToolResult result = new FindTool().execute(call("find", Map.of("pattern", "*.txt")), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("a.txt\nsub/b.txt");
        assertCard(result.structured(), "find");
        assertThat(rowValue(result.structured(), "limitReached")).isEqualTo("false");
        assertThat(rowValue(result.structured(), "sub/b.txt")).isEqualTo("file");
    }

    @Test
    void grepFindsMatchesAndCard() throws Exception {
        Files.writeString(workdir.resolve("a.txt"), "hello jhin\nfoo\n");
        Files.writeString(workdir.resolve("b.md"), "hello docs\n");

        ToolResult result = new GrepTool().execute(
                call("grep", Map.of("pattern", "hello", "glob", "*.txt")), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("a.txt:1: hello jhin");
        assertCard(result.structured(), "grep");
        assertThat(rowValue(result.structured(), "matches")).isEqualTo("1");
        assertThat(rowValue(result.structured(), "limitReached")).isEqualTo("false");
        assertThat(rowValue(result.structured(), "a.txt:1")).isEqualTo("hello jhin");
    }

    @Test
    void bashEchoReturnsOutputAndCard() throws Exception {
        ToolResult result = new BashTool().execute(call("bash", Map.of("command", "echo hi")), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("hi");
        assertCard(result.structured(), "bash");
        assertThat(rowValue(result.structured(), "command")).isEqualTo("echo hi");
        assertThat(rowValue(result.structured(), "exitCode")).isEqualTo("0");
        assertThat(Long.parseLong(rowValue(result.structured(), "durationMs"))).isNotNegative();
    }

    // -------------------------------------------------------------- failure

    @Test
    void readMissingFileFails() {
        ToolResult result = new ReadTool().execute(call("read", Map.of("path", "missing.txt")), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("File not found: missing.txt");
    }

    @Test
    void editWithoutPriorReadFails() throws Exception {
        Files.writeString(workdir.resolve("hello.txt"), "hello world\n");

        ToolResult result = new EditTool().execute(
                call("edit", Map.of("path", "hello.txt", "oldString", "world", "newString", "jhin")), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("Read the file first before editing");
        assertThat(workdir.resolve("hello.txt")).hasContent("hello world\n");
    }

    @Test
    void writeOutsideWorkdirFails() {
        ToolResult result = new WriteTool().execute(
                call("write", Map.of("path", "../outside.txt", "content", "x")), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("Path goes outside of workspace");
    }

    @Test
    void grepInvalidRegexFails() {
        ToolResult result = new GrepTool().execute(call("grep", Map.of("pattern", "(")), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("Invalid pattern: Unclosed group");
    }

    @Test
    void bashNonZeroExitFails() {
        ToolResult result = new BashTool().execute(call("bash", Map.of("command", "exit 3")), ctx());

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("Command failed with exit code 3");
    }

    // ---------------------------------------------------------------- bonus

    @Test
    void editWithoutMatchFails() throws Exception {
        Files.writeString(workdir.resolve("hello.txt"), "hello world\n");
        FakeToolContext ctx = ctx();
        new ReadTool().execute(call("read", Map.of("path", "hello.txt")), ctx);

        ToolResult result = new EditTool().execute(
                call("edit", Map.of("path", "hello.txt", "oldString", "absent", "newString", "x")), ctx);

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("No matches found for oldString");
    }

    @Test
    void editAmbiguousMatchFails() throws Exception {
        Files.writeString(workdir.resolve("hello.txt"), "foo bar foo\n");
        FakeToolContext ctx = ctx();
        new ReadTool().execute(call("read", Map.of("path", "hello.txt")), ctx);

        ToolResult result = new EditTool().execute(
                call("edit", Map.of("path", "hello.txt", "oldString", "foo", "newString", "x")), ctx);

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("oldString is ambiguous: found 2 matches; add context or set replaceAll=true");
    }

    @Test
    void readImageReturnsImagePayload() throws Exception {
        byte[] png = new byte[] {(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0};
        Files.write(workdir.resolve("pic.png"), png);

        ToolResult result = new ReadTool().execute(call("read", Map.of("path", "pic.png")), ctx());

        assertThat(result.error()).isFalse();
        Map<String, Object> image = Json.readMap(result.structured());
        assertThat(image)
                .containsEntry("kind", "image")
                .containsEntry("mimeType", "image/png")
                .containsEntry("title", "pic.png");
        assertThat(image.get("data")).isInstanceOf(String.class);
    }

    @Test
    void cancelledRunFailsFast() throws Exception {
        FakeToolContext ctx = ctx();
        ctx.cancel();

        ToolResult result = new BashTool().execute(call("bash", Map.of("command", "echo hi")), ctx);

        assertThat(result.error()).isTrue();
        assertThat(result.content()).isEqualTo("cancelled");
    }
}
