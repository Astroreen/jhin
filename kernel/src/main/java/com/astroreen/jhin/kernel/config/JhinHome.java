/**
 * Home layout of the installation: one root directory holding the extension,
 * state, log and key-material directories.
 *
 * <p>The root comes from the environment variable {@code JHIN_HOME} and falls
 * back to {@code .jhin} under the user home. {@link #resolve()} creates the
 * root and its four subdirectories on demand and marks them readable by the
 * owner only ({@code rwx------}) where the file store supports POSIX
 * permissions; on stores without POSIX attributes the step is skipped silently.
 */
package com.astroreen.jhin.kernel.config;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;
import java.util.function.Function;

public final class JhinHome {

    /** Environment variable overriding the default root. */
    private static final String ENV_HOME = "JHIN_HOME";

    /** Subdirectories created under the root. */
    private static final String[] SUBDIRS = {"plugins", "data", "logs", "keystore"};

    /** Owner-only permission bits applied when the file store allows them. */
    private static final Set<PosixFilePermission> OWNER_ONLY = PosixFilePermissions.fromString("rwx------");

    /** Not instantiable; all access is static. */
    private JhinHome() {
    }

    /**
     * Resolves and materializes the home layout using the real environment.
     *
     * @return the home root directory
     */
    public static Path resolve() {
        return resolve(System::getenv);
    }

    /**
     * Resolves and materializes the home layout using the given environment
     * lookup. Exists so tests can point the layout at a temporary directory.
     *
     * @param env lookup returning the value of an environment variable, or
     *            {@code null} when it is not set
     * @return the home root directory
     */
    public static Path resolve(Function<String, String> env) {
        String override = env.apply(ENV_HOME);
        Path home = (override == null || override.isBlank())
                ? Path.of(System.getProperty("user.home"), ".jhin")
                : Path.of(override);
        createDir(home);
        for (String name : SUBDIRS) {
            createDir(home.resolve(name));
        }
        return home;
    }

    private static void createDir(Path dir) {
        try {
            Files.createDirectories(dir);
            restrict(dir);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot create directory " + dir, e);
        }
    }

    private static void restrict(Path dir) {
        if (!FileSystems.getDefault().supportedFileAttributeViews().contains("posix")) {
            return;
        }
        try {
            Files.setPosixFilePermissions(dir, OWNER_ONLY);
        } catch (UnsupportedOperationException | IOException e) {
            // Permission bits are best effort; never fail the layout on them.
        }
    }
}
