/**
 * In-memory {@link SessionStore} fake for agent tests: the minimal surface the
 * message routes and the run service touch. The real implementation lives in
 * the sessions plugin and is package-private there, so the agent tests
 * exercise the exported API contract against this fake instead.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.SessionStore.ClearableField;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
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
        return list(null, null);
    }

    @Override
    public List<Session> list(String accountId) {
        return list(accountId, null);
    }

    @Override
    public List<Session> list(StatusFilter filter) {
        return list(null, filter);
    }

    @Override
    public List<Session> list(String accountId, StatusFilter filter) {
        long now = System.currentTimeMillis();
        return sessions.values().stream()
                .filter(session -> accountId == null || session.accountId().equals(accountId))
                .filter(session -> matches(session, filter, now))
                .sorted(Comparator
                        .comparing(Session::pinned, Comparator.reverseOrder())
                        .thenComparing(Session::pinnedOrder,
                                Comparator.nullsFirst(Comparator.naturalOrder()))
                        .thenComparing(Session::sortOrder,
                                Comparator.nullsFirst(Comparator.naturalOrder()))
                        .thenComparing(Session::createdAt, Comparator.reverseOrder())
                        .thenComparing(Session::id))
                .toList();
    }

    private static boolean matches(Session session, StatusFilter filter, long now) {
        if (filter == null) {
            return session.archivedAt() == null;
        }
        return switch (filter) {
            case ACTIVE -> session.settledAt() == null && session.archivedAt() == null
                    && (session.snoozedUntil() == null || session.snoozedUntil() <= now);
            case SNOOZED -> session.snoozedUntil() != null && session.snoozedUntil() > now;
            case SETTLED -> session.settledAt() != null;
            case ARCHIVED -> session.archivedAt() != null;
            case ALL -> true;
        };
    }

    @Override
    public Session patch(String id, Patch patch) {
        return patch(id, patch, Set.of());
    }

    @Override
    public Session patch(String id, Patch patch, Set<ClearableField> clears) {
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
                System.currentTimeMillis(),
                patch.pinned() != null ? patch.pinned() : current.pinned(),
                field(patch.pinnedOrder(), current.pinnedOrder(),
                        clears.contains(ClearableField.PINNED_ORDER)),
                field(patch.settledAt(), current.settledAt(),
                        clears.contains(ClearableField.SETTLED_AT)),
                field(patch.snoozedUntil(), current.snoozedUntil(),
                        clears.contains(ClearableField.SNOOZED_UNTIL)),
                field(patch.archivedAt(), current.archivedAt(),
                        clears.contains(ClearableField.ARCHIVED_AT)),
                patch.autoSettle() != null ? patch.autoSettle() : current.autoSettle(),
                patch.sortOrder() != null ? patch.sortOrder() : current.sortOrder(),
                field(patch.settledReason(), current.settledReason(),
                        clears.contains(ClearableField.SETTLED_REASON)),
                patch.autoSettleSuppressed() != null
                        ? patch.autoSettleSuppressed() : current.autoSettleSuppressed());
        sessions.put(id, updated);
        return updated;
    }

    private static <T> T field(T patched, T base, boolean clear) {
        return clear ? null : (patched != null ? patched : base);
    }

    @Override
    public Session patch(String accountId, String id, Patch patch) {
        Session current = get(accountId, id).orElseThrow(
                () -> new IllegalArgumentException("unknown session id: " + id));
        return patch(current.id(), patch);
    }

    @Override
    public Session patch(String accountId, String id, Patch patch, Set<ClearableField> clears) {
        Session current = get(accountId, id).orElseThrow(
                () -> new IllegalArgumentException("unknown session id: " + id));
        return patch(current.id(), patch, clears);
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
