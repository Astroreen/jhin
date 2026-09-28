package com.astroreen.jhin.core.tools.spi;

import com.astroreen.jhin.core.tools.PathSandbox;
import java.nio.file.Path;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Контекст одного исполнения тула (не Spring-бин).
 *
 * <p>readPaths — normalized real path строки прочитанных путей (write-guard в T15);
 * resolvePath — path sandbox: выход за workdir (включая symlink-escape) → ToolException.
 */
public class ToolContext {

    private final Path workdir;
    private final String sessionId;
    private final String runId;
    private final String accountId;
    private final Set<String> readPaths = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private volatile Consumer<ToolUpdate> onUpdate;

    public ToolContext(Path workdir, String sessionId, String runId, String accountId) {
        this.workdir = workdir.toAbsolutePath().normalize();
        this.sessionId = sessionId;
        this.runId = runId;
        this.accountId = accountId;
    }

    public Path workdir() {
        return workdir;
    }

    public String sessionId() {
        return sessionId;
    }

    public String runId() {
        return runId;
    }

    public String accountId() {
        return accountId;
    }

    public Set<String> readPaths() {
        return readPaths;
    }

    public Path resolvePath(String path) {
        return PathSandbox.resolve(workdir, path);
    }

    public void markRead(Path p) {
        readPaths.add(PathSandbox.realPath(p).toString());
    }

    public boolean hasRead(Path p) {
        return readPaths.contains(PathSandbox.realPath(p).toString());
    }

    public boolean isCancelled() {
        return cancelled.get();
    }

    public void cancel() {
        cancelled.set(true);
    }

    /** Стриминг апдейтов (T14); без подписчика — no-op. */
    public void publish(ToolUpdate u) {
        Consumer<ToolUpdate> sink = onUpdate;
        if (sink != null && u != null) {
            sink.accept(u);
        }
    }

    public void setOnUpdate(Consumer<ToolUpdate> onUpdate) {
        this.onUpdate = onUpdate;
    }
}
