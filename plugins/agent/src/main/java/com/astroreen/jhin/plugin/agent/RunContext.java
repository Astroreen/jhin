/**
 * The state of one agent run: identity, the triggering user message and the
 * tool context that carries workdir confinement, read tracking and the
 * cancellation flag.
 *
 * <p>One instance exists per run, created by {@link RunServiceImpl} before the
 * loop starts and kept in the active-run map until the run finishes. The
 * cancel route flips {@link #cancel()}; the loop and the tool bodies observe
 * it through {@link #isCancelled()}.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.sessions.api.Session;

final class RunContext {

    private final String runId;
    private final Session session;
    private final String text;
    private final ToolContextImpl toolContext;

    RunContext(String runId, Session session, String text, ToolContextImpl toolContext) {
        this.runId = runId;
        this.session = session;
        this.text = text;
        this.toolContext = toolContext;
    }

    String runId() {
        return runId;
    }

    Session session() {
        return session;
    }

    String text() {
        return text;
    }

    ToolContext toolContext() {
        return toolContext;
    }

    boolean isCancelled() {
        return toolContext.isCancelled();
    }

    void cancel() {
        toolContext.cancel();
    }
}
