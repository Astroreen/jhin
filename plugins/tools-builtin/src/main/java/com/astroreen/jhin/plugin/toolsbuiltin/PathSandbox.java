/**
 * Workspace path confinement helpers shared by the built-in tools and their
 * tests.
 *
 * <p>Consistent with {@link com.astroreen.jhin.plugin.agent.api.ToolContext#resolvePath}:
 * any path whose real location leaves the workdir fails with
 * {@code ToolException("Path goes outside of workspace")} - symlinks included.
 * The tools resolve user-supplied paths through the tool context; this class
 * supplies the same confinement to code without a context (test doubles) and
 * the {@link #realPath} normalisation used when relativizing walk results.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;

public final class PathSandbox {

    /** The exact failure text the tool SPI documents for a path escape. */
    public static final String OUTSIDE_MESSAGE = "Path goes outside of workspace";

    private static final int MAX_SYMLINK_DEPTH = 32;

    private PathSandbox() {}

    /**
     * Resolves a user-supplied path against the workdir and confines it to the
     * workdir. Relative and absolute paths are both accepted; anything whose
     * real location leaves the workdir is rejected.
     *
     * @param workdir the session working directory
     * @param path    the path as written by the model
     * @return the resolved real path, guaranteed inside the workdir
     * @throws ToolException when the path is blank, unresolvable or escapes
     */
    public static Path resolve(Path workdir, String path) {
        Objects.requireNonNull(workdir, "workdir");
        if (path == null || path.isBlank()) {
            throw new ToolException("Path must not be empty");
        }
        Path workdirReal = realPath(workdir.toAbsolutePath().normalize());
        Path target = workdir.resolve(path).normalize();
        Path targetReal = realPath(target);
        if (!targetReal.startsWith(workdirReal)) {
            throw new ToolException(OUTSIDE_MESSAGE);
        }
        return targetReal;
    }

    /**
     * Real path for existing and non-existing targets alike: symlink chains
     * are followed to their final target, a missing tail is appended to the
     * real path of the deepest existing ancestor.
     *
     * @param path the path to resolve
     * @return the real path
     * @throws ToolException when the path cannot be resolved
     */
    public static Path realPath(Path path) {
        return realPath(path.toAbsolutePath().normalize(), 0);
    }

    private static Path realPath(Path path, int linkDepth) {
        if (Files.isSymbolicLink(path)) {
            if (linkDepth >= MAX_SYMLINK_DEPTH) {
                throw new ToolException("Too many levels of symbolic links: " + path);
            }
            Path linkTarget = readLink(path);
            Path resolved =
                    path.getParent() == null ? linkTarget : path.getParent().resolve(linkTarget);
            return realPath(resolved.normalize(), linkDepth + 1);
        }
        if (Files.exists(path)) {
            try {
                return path.toRealPath();
            } catch (IOException e) {
                throw new ToolException("Cannot resolve path: " + path, e);
            }
        }
        Path parent = path.getParent();
        if (parent == null) {
            return path;
        }
        return realPath(parent, linkDepth).resolve(path.getFileName());
    }

    private static Path readLink(Path path) {
        try {
            return Files.readSymbolicLink(path);
        } catch (IOException e) {
            throw new ToolException("Cannot resolve path: " + path, e);
        }
    }
}
