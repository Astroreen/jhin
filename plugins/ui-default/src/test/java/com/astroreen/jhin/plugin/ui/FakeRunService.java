/**
 * {@link com.astroreen.jhin.plugin.agent.api.RunService} fake for action
 * tests: records every start and cancel, and can be told to refuse either
 * with a typed failure.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.agent.api.RunService;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.sdk.PluginException;
import java.util.ArrayList;
import java.util.List;

final class FakeRunService implements RunService {

    /** One recorded {@link #start}. */
    record Started(String sessionId, String text) {
    }

    private final List<Started> started = new ArrayList<>();
    private final List<String> cancelled = new ArrayList<>();

    @Override
    public String start(Session session, String text) {
        if (session == null || session.id() == null || text == null || text.isBlank()) {
            throw new IllegalArgumentException("session and text are required");
        }
        started.add(new Started(session.id(), text));
        return "run-" + started.size();
    }

    @Override
    public void cancel(String sessionId) {
        if (sessionId.startsWith("idle-")) {
            throw new PluginException("session " + sessionId + " has no active run");
        }
        cancelled.add(sessionId);
    }

    List<Started> started() {
        return List.copyOf(started);
    }

    List<String> cancelled() {
        return List.copyOf(cancelled);
    }
}
