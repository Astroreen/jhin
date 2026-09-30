/**
 * Seeds the bundled plugin jars of the distribution into the home plugin
 * directory on start: one copy per jar, remembered in
 * {@code _jhin_seeded_plugins} by jar name and SHA-256, so a later run acts
 * only where the state changed.
 *
 * <p>The source directory is {@code JHIN_BUNDLED_PLUGINS} when set and the
 * {@code plugins-default} directory next to the running jar otherwise; when
 * neither exists, seeding does nothing. For each jar the recorded state and
 * the file in the home plugin directory decide: an unrecorded jar is copied
 * unless a file of that name is already there (put there by the user and left
 * alone); a recorded jar whose copy is gone stays gone, deletion is final; a
 * recorded jar matching its recorded digest is left as is; a changed jar
 * overwrites its untouched copy (clean upgrade) and is skipped with a warning
 * when the copy was changed by the user. Every decision is logged on one
 * line, and every database write goes through the shared write lane.
 */
package com.astroreen.jhin.kernel.seed;

import com.astroreen.jhin.kernel.config.JhinHome;
import com.astroreen.jhin.kernel.db.Database;
import com.astroreen.jhin.sdk.db.SqlWork;
import java.io.IOException;
import java.io.InputStream;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.function.Function;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class BundledPluginSeeder {

    private static final Logger log = LoggerFactory.getLogger(BundledPluginSeeder.class);

    /** Environment variable overriding the bundled source directory. */
    private static final String ENV_BUNDLED = "JHIN_BUNDLED_PLUGINS";

    /** Sibling directory of the running jar holding the shipped bundle. */
    private static final String DEFAULT_DIR = "plugins-default";

    /** Home subdirectory receiving the seeded jars. */
    private static final String PLUGINS_DIR = "plugins";

    /** Table holding the seeded jar names and digests. */
    private static final String TABLE = "_jhin_seeded_plugins";

    private final Function<String, String> env;
    private final Path kernelJarDir;
    private final Database database;

    /**
     * Creates a seeder over the shared database, the real environment and the
     * directory of the running jar.
     *
     * @param database the shared database holding {@code _jhin_seeded_plugins}
     */
    public BundledPluginSeeder(Database database) {
        this(database, System::getenv, ownJarDir());
    }

    /**
     * Creates a seeder over an explicit environment lookup and kernel jar
     * directory. The seam used by tests.
     *
     * @param database     the shared database holding {@code _jhin_seeded_plugins}
     * @param env          lookup returning the value of an environment variable,
     *                     or {@code null} when it is not set
     * @param kernelJarDir directory holding the running jar, or {@code null}
     *                     when it cannot be resolved
     */
    public BundledPluginSeeder(Database database, Function<String, String> env, Path kernelJarDir) {
        this.database = database;
        this.env = env;
        this.kernelJarDir = kernelJarDir;
    }

    /**
     * Seeds every bundled jar according to the decision table. Idempotent:
     * a second run over unchanged inputs changes nothing. A jar that cannot
     * be read or copied is logged and skipped; a database failure aborts the
     * run.
     */
    public void seed() {
        Path source = sourceDir();
        if (source == null) {
            log.info("no bundled plugin directory; nothing to seed");
            return;
        }
        Path targetDir = JhinHome.resolve(env).resolve(PLUGINS_DIR);
        for (Path jar : listJars(source)) {
            try {
                seedOne(jar, targetDir);
            } catch (IOException e) {
                log.error("cannot seed {}: {}", jar, e.toString());
            } catch (SQLException e) {
                throw new IllegalStateException("cannot record seeding of " + jar, e);
            }
        }
    }

    /**
     * Applies the decision table to one bundled jar.
     *
     * @param jar       the bundled jar
     * @param targetDir the home plugin directory receiving the copies
     * @throws IOException  when the jar or the installed copy cannot be read
     *                      or written
     * @throws SQLException when the recorded state cannot be read or written
     */
    private void seedOne(Path jar, Path targetDir) throws IOException, SQLException {
        String name = jar.getFileName().toString();
        Path target = targetDir.resolve(name);
        String bundledSha = sha256(jar);
        String recorded = recordedSha(name);
        boolean present = Files.isRegularFile(target);
        if (recorded == null) {
            if (present) {
                log.warn("skipping {}: a file of that name is already in the plugin directory", name);
                return;
            }
            Files.copy(jar, target);
            insertRow(name, bundledSha);
            log.info("seeded {} ({})", name, bundledSha);
            return;
        }
        if (!present) {
            log.info("skipping {}: the seeded copy was removed and stays removed", name);
            return;
        }
        if (recorded.equals(bundledSha)) {
            log.info("skipping {}: already seeded and unchanged", name);
            return;
        }
        if (sha256(target).equals(recorded)) {
            Files.copy(jar, target, StandardCopyOption.REPLACE_EXISTING);
            updateRow(name, bundledSha);
            log.info("upgraded {} to ({})", name, bundledSha);
            return;
        }
        log.warn("skipping {}: the seeded copy was modified by the user", name);
    }

    /**
     * Resolves the bundled source directory: the environment override when
     * set, else {@code plugins-default} next to the running jar. A candidate
     * that is not a directory resolves to {@code null}, which makes the run a
     * no-op.
     *
     * @return the source directory, or {@code null} when there is none
     */
    private Path sourceDir() {
        String override = env.apply(ENV_BUNDLED);
        Path candidate = (override == null || override.isBlank())
                ? (kernelJarDir == null ? null : kernelJarDir.resolve(DEFAULT_DIR))
                : Path.of(override);
        return candidate != null && Files.isDirectory(candidate) ? candidate : null;
    }

    /**
     * Reads the digest recorded for one jar name.
     *
     * @param jarName the jar file name
     * @return the recorded SHA-256, or {@code null} when the jar is unrecorded
     * @throws SQLException when the read fails
     */
    private String recordedSha(String jarName) throws SQLException {
        return database.read(connection -> {
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT sha256 FROM " + TABLE + " WHERE jar_name = ?")) {
                query.setString(1, jarName);
                try (ResultSet rs = query.executeQuery()) {
                    return rs.next() ? rs.getString(1) : null;
                }
            }
        });
    }

    /**
     * Records a freshly seeded jar on the write lane.
     *
     * @param jarName the jar file name
     * @param sha     the jar digest
     * @throws SQLException when the write fails
     */
    private void insertRow(String jarName, String sha) throws SQLException {
        database.write((SqlWork<Void>) connection -> {
            try (PreparedStatement record = connection.prepareStatement(
                    "INSERT INTO " + TABLE + " (jar_name, sha256, seeded_at) VALUES (?, ?, ?)")) {
                record.setString(1, jarName);
                record.setString(2, sha);
                record.setLong(3, System.currentTimeMillis());
                record.executeUpdate();
            }
            return null;
        });
    }

    /**
     * Updates the record of an upgraded jar on the write lane.
     *
     * @param jarName the jar file name
     * @param sha     the new jar digest
     * @throws SQLException when the write fails
     */
    private void updateRow(String jarName, String sha) throws SQLException {
        database.write((SqlWork<Void>) connection -> {
            try (PreparedStatement record = connection.prepareStatement(
                    "UPDATE " + TABLE + " SET sha256 = ?, seeded_at = ? WHERE jar_name = ?")) {
                record.setString(1, sha);
                record.setLong(2, System.currentTimeMillis());
                record.setString(3, jarName);
                record.executeUpdate();
            }
            return null;
        });
    }

    /**
     * Lists every {@code *.jar} directly inside the given directory, in file
     * name order. A directory that cannot be listed logs and scans as empty.
     *
     * @param dir the directory to scan
     * @return the jar files in order
     */
    private static List<Path> listJars(Path dir) {
        try (Stream<Path> files = Files.list(dir)) {
            return files.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".jar"))
                    .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                    .toList();
        } catch (IOException e) {
            log.error("cannot list {}", dir, e);
            return List.of();
        }
    }

    /**
     * Computes the SHA-256 of one file as lowercase hex.
     *
     * @param file the file to digest
     * @return the digest
     * @throws IOException when the file cannot be read
     */
    private static String sha256(Path file) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is not available", e);
        }
        try (InputStream in = Files.newInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    /**
     * Resolves the directory holding the running jar. The default source
     * directory hangs off it.
     *
     * @return the jar directory, or {@code null} when it cannot be resolved
     */
    private static Path ownJarDir() {
        try {
            Path location = Path.of(BundledPluginSeeder.class.getProtectionDomain()
                    .getCodeSource().getLocation().toURI());
            return location.toAbsolutePath().getParent();
        } catch (URISyntaxException | RuntimeException e) {
            log.warn("cannot resolve the kernel jar directory: {}", e.toString());
            return null;
        }
    }
}
