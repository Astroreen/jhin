/**
 * The per-run {@link com.astroreen.jhin.plugin.agent.api.ToolContext} the agent
 * hands to every tool body: workspace confinement, read tracking, cancellation
 * and live tool updates.
 *
 * <p>Path confinement: {@link #resolvePath(String)} resolves symlinks (chains
 * and broken links included) before the containment check, so no link can
 * escape the session workdir. An escaping path fails with
 * {@code ToolException("Path goes outside of workspace")} — the exact message
 * the tool SPI documents.
 *
 * <p>Tool updates: {@link #publish} forwards an incremental chunk to the
 * {@code sessions/<id>} stream topic as a best-effort {@code tool_update}
 * event that is never persisted and never enters the model conversation —
 * live UI only, exactly as the SPI documents.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.plugin.agent.api.ToolUpdate;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

final class ToolContextImpl implements ToolContext {

    /** The exact failure text the tool SPI documents for a path escape. */
    static final String ESCAPE_MESSAGE = "Path goes outside of workspace";

    private static final int MAX_LINK_DEPTH = 40;

    private final Path workdir;
    private final String sessionId;
    private final String runId;
    private final String accountId;
    private final StreamRegistry streams;
    private final Set<Path> read = new LinkedHashSet<>();
    private final AtomicBoolean cancelled = new AtomicBoolean();

    ToolContextImpl(Path workdir, String sessionId, String runId, String accountId,
                    StreamRegistry streams) {
        this.workdir = workdir.toAbsolutePath().normalize();
        this.sessionId = sessionId;
        this.runId = runId;
        this.accountId = accountId;
        this.streams = streams;
    }

    @Override
    public Path workdir() {
        return workdir;
    }

    @Override
    public String sessionId() {
        return sessionId;
    }

    @Override
    public String runId() {
        return runId;
    }

    @Override
    public String accountId() {
        return accountId;
    }

    @Override
    public Path resolvePath(String userPath) {
        if (userPath == null || userPath.isBlank()) {
            throw new ToolException("path must not be null or blank");
        }
        Path requested;
        try {
            requested = Path.of(userPath.trim());
        } catch (InvalidPathException e) {
            throw new ToolException("path is invalid: " + userPath, e);
        }
        Path base = realWorkdir();
        Path joined = requested.isAbsolute() ? requested : base.resolve(requested);
        Path normalized = joined.normalize();
        if (!normalized.startsWith(base)) {
            throw new ToolException(ESCAPE_MESSAGE);
        }
        Path resolved = followLinks(normalized, 0);
        if (!resolved.startsWith(base)) {
            throw new ToolException(ESCAPE_MESSAGE);
        }
        return resolved;
    }

    @Override
    public List<Path> readPaths() {
        synchronized (read) {
            return List.copyOf(new ArrayList<>(read));
        }
    }

    @Override
    public void markRead(Path path) {
        synchronized (read) {
            read.add(path);
        }
    }

    @Override
    public boolean hasRead(Path path) {
        synchronized (read) {
            return read.contains(path);
        }
    }

    @Override
    public boolean isCancelled() {
        return cancelled.get();
    }

    @Override
    public void cancel() {
        cancelled.set(true);
    }

    @Override
    public void publish(ToolUpdate update) {
        if (update == null || update.text() == null) {
            return;
        }
        streams.publish(topic(sessionId), new StreamEvent("tool_update",
                Map.of("runId", runId, "text", update.text())));
    }

    private Path realWorkdir() {
        try {
            return workdir.toRealPath();
        } catch (IOException e) {
            return workdir;
        }
    }

    /**
     * Resolves every symlink component of an already lexically contained path.
     * The deepest existing prefix is resolved with {@code toRealPath} (which
     * follows whole link chains); a broken link is followed textually and the
     * walk restarts at its target. The tail that does not exist yet is
     * appended lexically — it cannot contain links, because no directory entry
     * exists there.
     */
    private static Path followLinks(Path path, int depth) {
        if (depth > MAX_LINK_DEPTH) {
            throw new ToolException("too many levels of symbolic links: " + path);
        }
        ArrayDeque<Path> tail = new ArrayDeque<>();
        Path cursor = path;
        while (cursor != null && !Files.exists(cursor, LinkOption.NOFOLLOW_LINKS)) {
            Path name = cursor.getFileName();
            if (name != null) {
                tail.addFirst(name);
            }
            cursor = cursor.getParent();
        }
        if (cursor == null) {
            return path;
        }
        Path real;
        try {
            real = cursor.toRealPath();
        } catch (IOException e) {
            if (!Files.isSymbolicLink(cursor)) {
                throw new ToolException("cannot resolve path: " + path, e);
            }
            try {
                Path target = Files.readSymbolicLink(cursor);
                Path jumped = target.isAbsolute() ? target : cursor.getParent().resolve(target);
                Path combined = jumped;
                for (Path name : tail) {
                    combined = combined.resolve(name);
                }
                return followLinks(combined.normalize(), depth + 1);
            } catch (IOException linkFailure) {
                throw new ToolException("cannot resolve path: " + path, linkFailure);
            }
        }
        Path result = real;
        for (Path name : tail) {
            result = result.resolve(name);
        }
        return result.normalize();
    }

    /**
     * The stream topic of one session, the same convention the sessions
     * plugin publishes its persisted events on.
     */
    private static String topic(String sessionId) {
        return "sessions/" + sessionId;
    }
}
