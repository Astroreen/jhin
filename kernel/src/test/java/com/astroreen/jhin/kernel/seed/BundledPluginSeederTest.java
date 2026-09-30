package com.astroreen.jhin.kernel.seed;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.astroreen.jhin.kernel.db.Database;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.HexFormat;
import java.util.List;
import java.util.function.Function;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Exercises every row of the bundled-seeding decision table plus the
 * permanent-deletion scenario, against a temp home and a temp bundle
 * directory. Jar fixtures are plain byte blobs: the seeder never opens them.
 */
class BundledPluginSeederTest {

    /** The jar exercised by every case. */
    private static final String JAR = "demo.jar";

    private final ListAppender<ILoggingEvent> capture = new ListAppender<>();

    @BeforeEach
    void attachCapture() {
        capture.start();
        logger().addAppender(capture);
    }

    @AfterEach
    void detachCapture() {
        logger().detachAppender(capture);
    }

    // decision-table row 1: no record, no file -> copy and record
    @Test
    void freshJarIsCopiedAndRecorded(@TempDir Path tmp) throws Exception {
        Path home = tmp.resolve("home");
        Path bundle = Files.createDirectories(tmp.resolve("bundle"));
        writeJar(bundle, "v1");
        try (Database database = Database.open(env(home, bundle))) {
            new BundledPluginSeeder(database, env(home, bundle), tmp.resolve("dist")).seed();
            assertThat(Files.readString(home.resolve("plugins").resolve(JAR))).isEqualTo("v1");
            assertThat(recordedSha(database, JAR)).isEqualTo(sha("v1"));
            assertThat(events(Level.WARN)).isEmpty();
            assertThat(events(Level.INFO)).anyMatch(e -> e.getFormattedMessage().startsWith("seeded "));
        }
    }

    // decision-table row 2: no record, file exists -> skip with WARN
    @Test
    void existingFileIsLeftAloneWithWarning(@TempDir Path tmp) throws Exception {
        Path home = tmp.resolve("home");
        Path bundle = Files.createDirectories(tmp.resolve("bundle"));
        writeJar(bundle, "v1");
        try (Database database = Database.open(env(home, bundle))) {
            Path target = home.resolve("plugins").resolve(JAR);
            Files.writeString(target, "user");
            new BundledPluginSeeder(database, env(home, bundle), tmp.resolve("dist")).seed();
            assertThat(Files.readString(target)).isEqualTo("user");
            assertThat(recordedSha(database, JAR)).isNull();
            assertThat(events(Level.WARN)).hasSize(1);
            assertThat(events(Level.WARN).get(0).getFormattedMessage())
                    .contains(JAR).contains("already in the plugin directory");
        }
    }

    // decision-table row 3: record and file agree -> skip; second run idempotent
    @Test
    void unchangedJarIsSkipped(@TempDir Path tmp) throws Exception {
        Path home = tmp.resolve("home");
        Path bundle = Files.createDirectories(tmp.resolve("bundle"));
        writeJar(bundle, "v1");
        try (Database database = Database.open(env(home, bundle))) {
            BundledPluginSeeder seeder = new BundledPluginSeeder(database, env(home, bundle), tmp.resolve("dist"));
            seeder.seed();
            long seededAt = seededAt(database, JAR);
            capture.list.clear();
            seeder.seed();
            assertThat(Files.readString(home.resolve("plugins").resolve(JAR))).isEqualTo("v1");
            assertThat(recordedSha(database, JAR)).isEqualTo(sha("v1"));
            assertThat(seededAt(database, JAR)).isEqualTo(seededAt);
            assertThat(events(Level.WARN)).isEmpty();
            assertThat(events(Level.INFO)).anyMatch(e -> e.getFormattedMessage().startsWith("skipping "));
        }
    }

    // decision-table row 4 and the failure scenario: the deletion is final,
    // asserted twice in a row (seed, delete, re-seed, re-seed) and against a
    // changed bundle digest
    @Test
    void deletedCopyStaysDeletedForever(@TempDir Path tmp) throws Exception {
        Path home = tmp.resolve("home");
        Path bundle = Files.createDirectories(tmp.resolve("bundle"));
        writeJar(bundle, "v1");
        try (Database database = Database.open(env(home, bundle))) {
            BundledPluginSeeder seeder = new BundledPluginSeeder(database, env(home, bundle), tmp.resolve("dist"));
            seeder.seed();
            Path target = home.resolve("plugins").resolve(JAR);
            assertThat(target).exists();
            Files.delete(target);
            seeder.seed();
            assertThat(target).doesNotExist();
            writeJar(bundle, "v2");
            seeder.seed();
            seeder.seed();
            assertThat(target).doesNotExist();
            assertThat(recordedSha(database, JAR)).isEqualTo(sha("v1"));
            assertThat(events(Level.WARN)).isEmpty();
        }
    }

    // decision-table row 5: record and bundled digest differ, the copy is the
    // recorded one -> overwrite and update the record (clean upgrade)
    @Test
    void untouchedCopyIsOverwrittenOnUpgrade(@TempDir Path tmp) throws Exception {
        Path home = tmp.resolve("home");
        Path bundle = Files.createDirectories(tmp.resolve("bundle"));
        writeJar(bundle, "v1");
        try (Database database = Database.open(env(home, bundle))) {
            BundledPluginSeeder seeder = new BundledPluginSeeder(database, env(home, bundle), tmp.resolve("dist"));
            seeder.seed();
            writeJar(bundle, "v2");
            seeder.seed();
            assertThat(Files.readString(home.resolve("plugins").resolve(JAR))).isEqualTo("v2");
            assertThat(recordedSha(database, JAR)).isEqualTo(sha("v2"));
            assertThat(events(Level.WARN)).isEmpty();
            assertThat(events(Level.INFO)).anyMatch(e -> e.getFormattedMessage().startsWith("upgraded "));
        }
    }

    // decision-table row 6: record and bundled digest differ, the copy matches
    // neither -> skip with WARN (user modified it)
    @Test
    void userModifiedCopyIsSkippedWithWarning(@TempDir Path tmp) throws Exception {
        Path home = tmp.resolve("home");
        Path bundle = Files.createDirectories(tmp.resolve("bundle"));
        writeJar(bundle, "v1");
        try (Database database = Database.open(env(home, bundle))) {
            BundledPluginSeeder seeder = new BundledPluginSeeder(database, env(home, bundle), tmp.resolve("dist"));
            seeder.seed();
            Path target = home.resolve("plugins").resolve(JAR);
            Files.writeString(target, "user-edit");
            writeJar(bundle, "v2");
            capture.list.clear();
            seeder.seed();
            assertThat(Files.readString(target)).isEqualTo("user-edit");
            assertThat(recordedSha(database, JAR)).isEqualTo(sha("v1"));
            assertThat(events(Level.WARN)).hasSize(1);
            assertThat(events(Level.WARN).get(0).getFormattedMessage())
                    .contains(JAR).contains("modified by the user");
        }
    }

    // source resolution: an absent bundle directory is a no-op, both for the
    // environment override and for the jar-sibling default
    @Test
    void absentBundleDirectoryIsNoOp(@TempDir Path tmp) throws Exception {
        Path home = tmp.resolve("home");
        Path missing = tmp.resolve("not-there");
        try (Database database = Database.open(env(home, missing))) {
            new BundledPluginSeeder(database, env(home, missing), tmp.resolve("dist")).seed();
        }
        Function<String, String> withoutOverride = env(home, null);
        try (Database database = Database.open(withoutOverride)) {
            new BundledPluginSeeder(database, withoutOverride, tmp.resolve("dist")).seed();
            assertThat(recordedSha(database, JAR)).isNull();
            try (Stream<Path> files = Files.list(home.resolve("plugins"))) {
                assertThat(files.filter(Files::isRegularFile).toList()).isEmpty();
            }
        }
    }

    // source resolution: without the override the bundle is the
    // plugins-default directory next to the kernel jar
    @Test
    void defaultBundleDirectoryIsNextToKernelJar(@TempDir Path tmp) throws Exception {
        Path home = tmp.resolve("home");
        Path dist = Files.createDirectories(tmp.resolve("dist"));
        writeJar(Files.createDirectories(dist.resolve("plugins-default")), "v1");
        Function<String, String> withoutOverride = env(home, null);
        try (Database database = Database.open(withoutOverride)) {
            new BundledPluginSeeder(database, withoutOverride, dist).seed();
            assertThat(Files.readString(home.resolve("plugins").resolve(JAR))).isEqualTo("v1");
            assertThat(recordedSha(database, JAR)).isEqualTo(sha("v1"));
        }
    }

    private static Function<String, String> env(Path home, Path bundle) {
        return k -> switch (k) {
            case "JHIN_HOME" -> home.toString();
            case "JHIN_BUNDLED_PLUGINS" -> bundle == null ? null : bundle.toString();
            default -> null;
        };
    }

    private static void writeJar(Path dir, String content) throws Exception {
        Files.write(dir.resolve(JAR), content.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha(String content) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return HexFormat.of().formatHex(digest.digest(content.getBytes(StandardCharsets.UTF_8)));
    }

    private static String recordedSha(Database database, String jarName) throws Exception {
        return database.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT sha256 FROM _jhin_seeded_plugins WHERE jar_name = ?")) {
                query.setString(1, jarName);
                try (ResultSet rs = query.executeQuery()) {
                    return rs.next() ? rs.getString(1) : null;
                }
            }
        });
    }

    private static long seededAt(Database database, String jarName) throws Exception {
        return database.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT seeded_at FROM _jhin_seeded_plugins WHERE jar_name = ?")) {
                query.setString(1, jarName);
                try (ResultSet rs = query.executeQuery()) {
                    return rs.next() ? rs.getLong(1) : -1;
                }
            }
        });
    }

    private List<ILoggingEvent> events(Level level) {
        return capture.list.stream().filter(e -> e.getLevel() == level).toList();
    }

    private static Logger logger() {
        return (Logger) org.slf4j.LoggerFactory.getLogger(BundledPluginSeeder.class);
    }
}
