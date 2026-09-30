package com.astroreen.jhin.kernel.loader;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PluginScannerTest {

    @TempDir
    Path dir;

    @Test
    void listsJarsSortedByFileName() throws IOException {
        writeJar("c.jar", "jhin-plugin.json", "{}");
        writeJar("a.jar", "jhin-plugin.json", "{}");
        writeJar("b.jar", "jhin-plugin.json", "{}");
        Files.writeString(dir.resolve("notes.txt"), "not a jar");

        PluginScanner scanner = new PluginScanner(dir);

        assertThat(scanner.scan())
                .extracting(entry -> entry.jar().getFileName().toString())
                .containsExactly("a.jar", "b.jar", "c.jar");
    }

    @Test
    void skipsBrokenZip() throws IOException {
        writeJar("good.jar", "jhin-plugin.json", "{\"id\":\"demo.one\"}");
        Files.writeString(dir.resolve("broken.jar"), "this is not a zip archive");

        List<PluginScanner.ScannedJar> scanned = new PluginScanner(dir).scan();

        assertThat(scanned).hasSize(1);
        assertThat(scanned.get(0).jar()).isEqualTo(dir.resolve("good.jar"));
    }

    @Test
    void skipsJarWithoutManifestEntry() throws IOException {
        writeJar("good.jar", "jhin-plugin.json", "{\"id\":\"demo.one\"}");
        writeJar("bare.jar", "other.txt", "payload");

        List<PluginScanner.ScannedJar> scanned = new PluginScanner(dir).scan();

        assertThat(scanned).hasSize(1);
        assertThat(scanned.get(0).jar()).isEqualTo(dir.resolve("good.jar"));
    }

    @Test
    void readsManifestTextFromJarRoot() throws IOException {
        writeJar("one.jar", "jhin-plugin.json", "{\"id\":\"demo.one\"}");

        List<PluginScanner.ScannedJar> scanned = new PluginScanner(dir).scan();

        assertThat(scanned).hasSize(1);
        assertThat(scanned.get(0).manifestJson()).isEqualTo("{\"id\":\"demo.one\"}");
    }

    private void writeJar(String name, String entryName, String content) throws IOException {
        try (JarOutputStream out = new JarOutputStream(Files.newOutputStream(dir.resolve(name)))) {
            out.putNextEntry(new JarEntry(entryName));
            out.write(content.getBytes(StandardCharsets.UTF_8));
            out.closeEntry();
        }
    }
}