package com.astroreen.jhin.core.tools;

import com.astroreen.jhin.core.tools.spi.ToolException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;

/**
 * Path sandbox: резолв пути против workdir с контролем реального местоположения.
 *
 * <p>Любой путь (относительный или абсолютный), чей real-path выходит за workdir —
 * ToolException. Symlink, указывающий наружу — всегда escape, даже сам по себе.
 * Несуществующие цели резолвятся как real-path глубайшего существующего предка + остаток.
 */
public final class PathSandbox {

    public static final String OUTSIDE_MESSAGE = "Path goes outside of workspace";

    private static final int MAX_SYMLINK_DEPTH = 32;

    private PathSandbox() {}

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

    /** Real-path для существующих и несуществующих путей; symlink-цепочки резолвятся в цель. */
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
