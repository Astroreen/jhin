/**
 * Default {@link SessionLifecycleService}: the transition matrix, the
 * clear-aware store writes and the {@code session_updated} emission.
 *
 * <p>Every successful operation bumps {@code updatedAt} through the store
 * write and appends one {@link EventType#SESSION_UPDATED} event (payload: the
 * updated session as JSON) to the session's event log, which publishes it on
 * {@code sessions/<id>} after the write. The two no-op successes — {@code wake}
 * on a session without a snooze and {@code unpin} on a session that is already
 * fully unpinned — return the unchanged session and emit nothing.
 *
 * <p>Archived sessions are sealed: every operation except {@code restore} is
 * rejected with {@link LifecycleException.Failure#INVALID_TRANSITION}. The
 * rest of the matrix lives on {@link SessionLifecycleService}.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.LifecycleException;
import com.astroreen.jhin.plugin.sessions.api.LifecycleException.Failure;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.SessionStore.ClearableField;
import com.astroreen.jhin.plugin.sessions.api.SessionStore.Patch;
import com.astroreen.jhin.plugin.sessions.api.SettleReason;
import com.astroreen.jhin.plugin.sessions.api.TitleService;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

final class SessionLifecycleServiceImpl implements SessionLifecycleService {

    private final SessionStore store;
    private final EventLog eventLog;
    private final ServiceRegistry services;

    SessionLifecycleServiceImpl(SessionStore store, EventLog eventLog, ServiceRegistry services) {
        this.store = store;
        this.eventLog = eventLog;
        this.services = services;
    }

    @Override
    public Session settle(String id, SettleReason reason) {
        if (reason == null) {
            throw new IllegalArgumentException("reason must not be null");
        }
        Session current = requireOpen(id);
        if (current.settledAt() != null) {
            throw new LifecycleException(Failure.INVALID_TRANSITION,
                    "session " + id + " is already settled");
        }
        Patch patch = new Patch(null, null, null, null, null,
                false, null, System.currentTimeMillis(), null, null,
                null, null, reason.wire(), null);
        return emit(store.patch(id, patch,
                Set.of(ClearableField.PINNED_ORDER, ClearableField.SNOOZED_UNTIL)));
    }

    @Override
    public Session unsettle(String id) {
        Session current = requireOpen(id);
        if (current.settledAt() == null) {
            throw new LifecycleException(Failure.INVALID_TRANSITION,
                    "session " + id + " is not settled");
        }
        Patch patch = new Patch(null, null, null, null, null,
                null, null, null, null, null,
                null, null, null, true);
        return emit(store.patch(id, patch,
                Set.of(ClearableField.SETTLED_AT, ClearableField.SETTLED_REASON)));
    }

    @Override
    public Session pin(String id, Integer order) {
        requireOpen(id);
        Patch patch = new Patch(null, null, null, null, null,
                true, order, null, null, null,
                null, null, null, null);
        return emit(store.patch(id, patch));
    }

    @Override
    public Session unpin(String id) {
        Session current = requireOpen(id);
        if (!current.pinned() && current.pinnedOrder() == null) {
            return current;
        }
        Patch patch = new Patch(null, null, null, null, null,
                false, null, null, null, null,
                null, null, null, null);
        return emit(store.patch(id, patch, Set.of(ClearableField.PINNED_ORDER)));
    }

    @Override
    public Session snooze(String id, long untilTs) {
        requireOpen(id);
        if (untilTs <= System.currentTimeMillis()) {
            throw new IllegalArgumentException("snoozedUntil must be in the future");
        }
        Patch patch = new Patch(null, null, null, null, null,
                null, null, null, untilTs, null,
                null, null, null, null);
        return emit(store.patch(id, patch));
    }

    @Override
    public Session snoozeFor(String id, long durationMs) {
        if (durationMs <= 0) {
            throw new IllegalArgumentException("durationMs must be positive");
        }
        return snooze(id, System.currentTimeMillis() + durationMs);
    }

    @Override
    public Session wake(String id) {
        Session current = requireOpen(id);
        if (current.snoozedUntil() == null) {
            return current;
        }
        Patch patch = new Patch(null, null, null, null, null,
                null, null, null, null, null,
                null, null, null, null);
        return emit(store.patch(id, patch, Set.of(ClearableField.SNOOZED_UNTIL)));
    }

    @Override
    public Session archive(String id) {
        requireOpen(id);
        Patch patch = new Patch(null, null, null, null, null,
                null, null, null, null, System.currentTimeMillis(),
                null, null, null, null);
        return emit(store.patch(id, patch));
    }

    @Override
    public Session restore(String id) {
        Session current = require(id);
        if (current.archivedAt() == null) {
            throw new LifecycleException(Failure.INVALID_TRANSITION,
                    "session " + id + " is not archived");
        }
        Patch patch = new Patch(null, null, null, null, null,
                null, null, null, null, null,
                null, null, null, null);
        return emit(store.patch(id, patch, Set.of(ClearableField.ARCHIVED_AT)));
    }

    @Override
    public List<Session> reorder(List<String> ids) {
        List<String> order = validateOrder(ids);
        for (String id : order) {
            Session session = require(id);
            if (session.archivedAt() != null) {
                throw new LifecycleException(Failure.INVALID_TRANSITION,
                        "session " + id + " is archived");
            }
        }
        List<Session> updated = new ArrayList<>();
        for (int i = 0; i < order.size(); i++) {
            String id = order.get(i);
            Patch patch = new Patch(null, null, null, null, null,
                    null, i, null, null, null,
                    null, i, null, null);
            updated.add(emit(store.patch(id, patch)));
        }
        return List.copyOf(updated);
    }

    @Override
    public Session setAutoSettle(String id, boolean enabled) {
        Session current = requireOpen(id);
        if (current.autoSettle() == enabled) {
            return current;
        }
        Patch patch = new Patch(null, null, null, null, null,
                null, null, null, null, null,
                enabled, null, null, null);
        return emit(store.patch(id, patch));
    }

    @Override
    public Session regenerateTitle(String id) {
        Session current = requireOpen(id);
        TitleService titleService = services.find(TitleService.class)
                .orElseThrow(() -> new LifecycleException(Failure.TITLE_UNAVAILABLE,
                        "no title service is published"));
        String title;
        try {
            title = titleService.regenerate(current, eventLog.list(id, 0));
        } catch (RuntimeException e) {
            throw new LifecycleException(Failure.TITLE_UNAVAILABLE,
                    "the title service failed to produce a title", e);
        }
        if (title == null || title.isBlank()) {
            throw new LifecycleException(Failure.TITLE_UNAVAILABLE,
                    "the title service produced no title");
        }
        Patch patch = new Patch(title, null, null, null, null,
                null, null, null, null, null,
                null, null, null, null);
        return emit(store.patch(id, patch));
    }

    /**
     * Appends one {@code session_updated} event carrying the updated session.
     */
    private Session emit(Session session) {
        eventLog.append(session.id(), EventType.SESSION_UPDATED, Json.write(session));
        return session;
    }

    /**
     * Loads one session or fails with {@code not_found}.
     */
    private Session require(String id) {
        return store.get(id).orElseThrow(() -> new LifecycleException(Failure.NOT_FOUND,
                "session " + id + " not found"));
    }

    /**
     * Loads one session and rejects the archived ones: an archived session is
     * sealed for every operation except {@code restore}.
     */
    private Session requireOpen(String id) {
        Session session = require(id);
        if (session.archivedAt() != null) {
            throw new LifecycleException(Failure.INVALID_TRANSITION,
                    "session " + id + " is archived");
        }
        return session;
    }

    /**
     * Validates a reorder list: non-null, non-empty, no blank ids and no
     * duplicates.
     */
    private static List<String> validateOrder(List<String> ids) {
        if (ids == null || ids.isEmpty()) {
            throw new IllegalArgumentException("ids must not be empty");
        }
        Set<String> seen = new LinkedHashSet<>();
        for (String id : ids) {
            if (id == null || id.isBlank()) {
                throw new IllegalArgumentException("ids must not contain blank ids");
            }
            if (!seen.add(id)) {
                throw new IllegalArgumentException("ids must not contain duplicates: " + id);
            }
        }
        return List.copyOf(seen);
    }
}
