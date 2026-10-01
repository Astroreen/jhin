package com.astroreen.jhin.plugin.mcp;

import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolUpdate;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Minimal test double of {@link ToolContext} for executing remote tool
 * definitions: the MCP tools use no workdir paths, so read tracking,
 * cancellation and published updates are simple recordings.
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
        return workdir.resolve(userPath).normalize();
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
        return List.copyOf(updates);
    }
}
