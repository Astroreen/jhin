/**
 * Lists the plugin jars of one directory and reads each jar's root-level
 * {@code jhin-plugin.json} for {@link ManifestParser}.
 *
 * <p>The scan never throws for a bad jar: a file that is not a readable zip or
 * a jar without the manifest entry is logged as an error and dropped from the
 * result, so one broken artifact cannot block the rest. Jars are visited in
 * file-name order, which keeps the scan deterministic.
 */
package com.astroreen.jhin.kernel.loader;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class PluginScanner {

    private static final Logger log = LoggerFactory.getLogger(PluginScanner.class);

    /** The mandatory manifest entry at the root of every plugin jar. */
    private static final String MANIFEST_ENTRY = "jhin-plugin.json";

    private final List<Path> jars;

    /**
     * Creates a scanner over every {@code *.jar} directly inside the given
     * directory. A missing directory is not an error: it scans as empty.
     *
     * @param pluginsDir directory holding the plugin jars
     */
    public PluginScanner(Path pluginsDir) {
        this(listJars(pluginsDir));
    }

    /**
     * Creates a scanner over an explicit jar list. The seam used by tests and
     * by callers that already know the candidate files.
     *
     * @param jarPaths the jars to scan, in any order
     */
    public PluginScanner(List<Path> jarPaths) {
        this.jars = jarPaths.stream()
                .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                .toList();
    }

    /**
     * Scans every jar in order. Broken jars and jars without
     * {@code jhin-plugin.json} are logged and skipped.
     *
     * @return one entry per readable jar, in file-name order
     */
    public List<ScannedJar> scan() {
        List<ScannedJar> scanned = new ArrayList<>();
        for (Path jar : jars) {
            String manifestJson = readManifest(jar);
            if (manifestJson != null) {
                scanned.add(new ScannedJar(jar, manifestJson));
            }
        }
        return List.copyOf(scanned);
    }

    /**
     * One jar that passed the scan: the file and its raw manifest text.
     *
     * @param jar          the scanned jar file
     * @param manifestJson the raw {@code jhin-plugin.json} text
     */
    public record ScannedJar(Path jar, String manifestJson) {}

    private static List<Path> listJars(Path pluginsDir) {
        if (!Files.isDirectory(pluginsDir)) {
            log.warn("no plugin directory at {}", pluginsDir);
            return List.of();
        }
        try (Stream<Path> files = Files.list(pluginsDir)) {
            return files.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".jar"))
                    .toList();
        } catch (IOException e) {
            log.error("cannot list {}", pluginsDir, e);
            return List.of();
        }
    }

    private String readManifest(Path jar) {
        try (JarFile jarFile = new JarFile(jar.toFile())) {
            JarEntry entry = jarFile.getJarEntry(MANIFEST_ENTRY);
            if (entry == null) {
                log.error("skipping {}: no {} at the jar root", jar, MANIFEST_ENTRY);
                return null;
            }
            try (InputStream in = jarFile.getInputStream(entry)) {
                return new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
        } catch (IOException e) {
            log.error("skipping {}: not a readable jar: {}", jar, e.toString());
            return null;
        }
    }
}