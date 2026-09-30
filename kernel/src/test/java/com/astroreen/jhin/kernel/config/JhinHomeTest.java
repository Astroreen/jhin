package com.astroreen.jhin.kernel.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JhinHomeTest {

    @Test
    void createsLayoutWithOwnerOnlyPermissions(@TempDir Path tmp) throws IOException {
        Path target = tmp.resolve("home");
        Path home = JhinHome.resolve(k -> "JHIN_HOME".equals(k) ? target.toString() : null);
        assertThat(home).isEqualTo(target);
        assertThat(home).isDirectory();
        for (String name : new String[] {"plugins", "data", "logs", "keystore"}) {
            Path dir = home.resolve(name);
            assertThat(dir).isDirectory();
            if (FileSystems.getDefault().supportedFileAttributeViews().contains("posix")) {
                assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(dir)))
                        .isEqualTo("rwx------");
            }
        }
    }

    @Test
    void secondResolveKeepsLayout(@TempDir Path tmp) throws IOException {
        Path target = tmp.resolve("home");
        JhinHome.resolve(k -> "JHIN_HOME".equals(k) ? target.toString() : null);
        Path home = JhinHome.resolve(k -> "JHIN_HOME".equals(k) ? target.toString() : null);
        assertThat(home.resolve("plugins")).isDirectory();
        assertThat(home.resolve("data")).isDirectory();
        assertThat(home.resolve("logs")).isDirectory();
        assertThat(home.resolve("keystore")).isDirectory();
    }
}
