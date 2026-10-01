package com.astroreen.jhin.plugin.toolsbuiltin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.agent.api.ToolException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PathSandboxTest {

    private static final String OUTSIDE = "Path goes outside of workspace";

    @TempDir
    Path workdir;

    @TempDir
    Path outside;

    @Test
    void resolvesSimpleFileInsideWorkdir() throws IOException {
        Path resolved = PathSandbox.resolve(workdir, "file.txt");

        assertThat(resolved).isEqualTo(workdir.toRealPath().resolve("file.txt"));
    }

    @Test
    void resolvesNestedRelativePath() throws IOException {
        Path resolved = PathSandbox.resolve(workdir, "sub/file.txt");

        assertThat(resolved).isEqualTo(workdir.toRealPath().resolve("sub/file.txt"));
    }

    @Test
    void absolutePathInsideWorkdirAllowed() throws IOException {
        String abs = workdir.toRealPath().resolve("f.txt").toString();

        assertThat(PathSandbox.resolve(workdir, abs)).isEqualTo(workdir.toRealPath().resolve("f.txt"));
    }

    @Test
    void parentEscapeRejected() {
        assertThatThrownBy(() -> PathSandbox.resolve(workdir, "../outside.txt"))
                .isInstanceOf(ToolException.class)
                .hasMessage(OUTSIDE);
    }

    @Test
    void absoluteOutsideRejected() {
        assertThatThrownBy(() -> PathSandbox.resolve(workdir, "/etc/passwd"))
                .isInstanceOf(ToolException.class)
                .hasMessage(OUTSIDE);
    }

    @Test
    void emptyPathRejected() {
        assertThatThrownBy(() -> PathSandbox.resolve(workdir, "  "))
                .isInstanceOf(ToolException.class)
                .hasMessage("Path must not be empty");
    }

    @Test
    void normalizedPathStaysInside() throws IOException {
        Files.writeString(workdir.resolve("file.txt"), "x");
        Files.createDirectories(workdir.resolve("sub"));

        Path resolved = PathSandbox.resolve(workdir, "sub/../file.txt");

        assertThat(resolved).isEqualTo(workdir.toRealPath().resolve("file.txt"));
    }

    @Test
    void symlinkEscapeRejectedEvenForLinkItself() throws IOException {
        Files.writeString(outside.resolve("secret.txt"), "s");
        Files.createSymbolicLink(workdir.resolve("link"), outside);

        assertThatThrownBy(() -> PathSandbox.resolve(workdir, "link/secret.txt"))
                .isInstanceOf(ToolException.class)
                .hasMessage(OUTSIDE);

        // edge: a symlink pointing outside is always an escape, even by itself
        assertThatThrownBy(() -> PathSandbox.resolve(workdir, "link"))
                .isInstanceOf(ToolException.class)
                .hasMessage(OUTSIDE);
    }

    @Test
    void symlinkInsideWorkdirResolvesToRealTarget() throws IOException {
        Files.createDirectories(workdir.resolve("sub"));
        Files.writeString(workdir.resolve("sub/f.txt"), "x");
        Files.createSymbolicLink(workdir.resolve("link"), workdir.resolve("sub"));

        Path resolved = PathSandbox.resolve(workdir, "link/f.txt");

        assertThat(resolved).isEqualTo(workdir.toRealPath().resolve("sub").resolve("f.txt"));
    }
}
