package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolUpdate;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Minimal test double of {@link ToolContext}: {@code resolvePath} delegates to
 * the REAL {@link PathSandbox} confinement of the temp workdir (so the
 * workspace-escape failure case is genuinely produced), read tracking is real,
 * published updates and cancellation are recorded for assertions.
 */
final class FakeToolContext implements ToolContext {

    private final Path workdir;
    private final Set<Path> read = new LinkedHashSet<>();
    private final List<ToolUpdate> updates = new ArrayList<>();
    private boolean cancelled;

    FakeToolContext(Path workdir) {
        this.workdir = workdir.toAbsolutePath().normalize();
    }

    @Override
    public Path workdir() {
        return workdir;
    }

    @Override
    public String sessionId() {
        return "s-test";
    }

    @Override
    public String runId() {
        return "r-test";
    }

    @Override
    public String accountId() {
        return "a-test";
    }

    @Override
    public Path resolvePath(String userPath) {
        return PathSandbox.resolve(workdir, userPath);
    }

    @Override
    public List<Path> readPaths() {
        return List.copyOf(read);
    }

    @Override
    public void markRead(Path path) {
        read.add(path);
    }

    @Override
    public boolean hasRead(Path path) {
        return read.contains(path);
    }

    @Override
    public boolean isCancelled() {
        return cancelled;
    }

    @Override
    public void cancel() {
        cancelled = true;
    }

    @Override
    public void publish(ToolUpdate update) {
        updates.add(update);
    }

    List<ToolUpdate> updates() {
        return updates;
    }
}
