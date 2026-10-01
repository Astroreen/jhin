/**
 * In-memory {@link SessionStore} fake for agent tests: the minimal surface the
 * message routes and the run service touch. The real implementation lives in
 * the sessions plugin and is package-private there, so the agent tests
 * exercise the exported API contract against this fake instead.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

final class FakeSessionStore implements SessionStore {

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    /**
     * Registers one session with the given fields as-is.
     *
     * @param session the session to register
     * @return the registered session
     */
    Session put(Session session) {
        sessions.put(session.id(), session);
        return session;
    }

    @Override
    public Session create(String accountId, String title, String workdir) {
        long now = System.currentTimeMillis();
        Session session = new Session(UUID.randomUUID().toString(), accountId, title, workdir,
                null, null, "active", now, now);
        return put(session);
    }

    @Override
    public Session create(String title, String workdir) {
        return create(LOCAL_ACCOUNT, title, workdir);
    }

    @Override
    public Optional<Session> get(String id) {
        return Optional.ofNullable(sessions.get(id));
    }

    @Override
    public Optional<Session> get(String accountId, String id) {
        return get(id).filter(session -> session.accountId().equals(accountId));
    }

    @Override
    public List<Session> list() {
        return List.copyOf(sessions.values());
    }

    @Override
    public List<Session> list(String accountId) {
        return list().stream().filter(session -> session.accountId().equals(accountId)).toList();
    }

    @Override
    public Session patch(String id, Patch patch) {
        Session current = sessions.get(id);
        if (current == null) {
            throw new IllegalArgumentException("unknown session id: " + id);
        }
        Session updated = new Session(
                current.id(),
                current.accountId(),
                patch.title() == null ? current.title() : patch.title(),
                patch.workdir() == null ? current.workdir() : patch.workdir(),
                patch.model() == null ? current.model() : patch.model(),
                patch.providerId() == null ? current.providerId() : patch.providerId(),
                patch.status() == null ? current.status() : patch.status(),
                current.createdAt(),
                System.currentTimeMillis());
        sessions.put(id, updated);
        return updated;
    }

    @Override
    public Session patch(String accountId, String id, Patch patch) {
        Session current = get(accountId, id).orElseThrow(
                () -> new IllegalArgumentException("unknown session id: " + id));
        return patch(current.id(), patch);
    }

    @Override
    public boolean delete(String id) {
        return sessions.remove(id) != null;
    }

    @Override
    public boolean delete(String accountId, String id) {
        return get(accountId, id).isPresent() && delete(id);
    }
}
