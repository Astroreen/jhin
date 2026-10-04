/**
 * JSON CRUD routes over the session store plus the lifecycle endpoints.
 *
 * <p>Endpoints: {@code GET /sessions} (list), {@code POST /sessions} (create),
 * {@code GET /sessions/{id}}, {@code PATCH /sessions/{id}} (partial update),
 * {@code DELETE /sessions/{id}} (204) and the lifecycle actions
 * {@code POST /sessions/{id}/settle|unsettle|pin|unpin|snooze|wake|archive|restore|auto-settle|title}
 * with {@code POST /sessions/reorder} (see {@link SessionLifecycleService} for
 * the transition matrix). An unknown or foreign session id is a {@code 404}
 * whose body contains {@code not_found}; a malformed body is a {@code 400}
 * whose body names the offending field; an invalid transition is a
 * {@code 409 invalid_transition}; title regeneration without a title service
 * is a {@code 503 title_service_unavailable}. Every request is scoped to the
 * account resolved from the request principal (see {@link Principals});
 * without a security plugin the store falls back to its implicit account
 * {@code local}.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.LifecycleException;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.SettleReason;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

final class SessionRoutes {

    private final SessionStore store;
    private final SessionLifecycleService lifecycle;

    SessionRoutes(SessionStore store, SessionLifecycleService lifecycle) {
        this.store = store;
        this.lifecycle = lifecycle;
    }

    /**
     * Lists the sessions of the caller, newest first. Unscoped when no
     * principal is present.
     *
     * @param req the request
     * @return the session list
     */
    HttpResponse list(HttpRequest req) {
        Optional<String> account = Principals.accountId(req);
        List<Session> sessions = account.map(store::list).orElseGet(store::list);
        return HttpResponse.json(200, sessions);
    }

    /**
     * Creates a session from a JSON body: {@code title} and {@code workdir} are
     * required non-blank strings, {@code model} and {@code providerId} are
     * optional. {@code workdir} is validated first, so a body without any
     * field is rejected naming {@code workdir}.
     *
     * @param req the request carrying the JSON body
     * @return {@code 201} with the created session, or {@code 400} naming the
     *         offending field
     */
    HttpResponse create(HttpRequest req) {
        try {
            Map<String, Object> body = parseBody(req);
            String workdir = requireText(body, "workdir");
            String title = requireText(body, "title");
            Optional<String> model = optionalText(body, "model");
            Optional<String> providerId = optionalText(body, "providerId");
            Optional<String> account = Principals.accountId(req);
            Session created = account
                    .map(id -> store.create(id, title, workdir))
                    .orElseGet(() -> store.create(title, workdir));
            if (model.isPresent() || providerId.isPresent()) {
                SessionStore.Patch patch = new SessionStore.Patch(
                        null, null, model.orElse(null), providerId.orElse(null), null);
                String id = created.id();
                Session updated = account
                        .map(owner -> store.patch(owner, id, patch))
                        .orElseGet(() -> store.patch(id, patch));
                return HttpResponse.json(201, updated);
            }
            return HttpResponse.json(201, created);
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
    }

    /**
     * Fetches one session by id.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the session, or {@code 404} containing
     *         {@code not_found}
     */
    HttpResponse get(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        Optional<String> account = Principals.accountId(req);
        Optional<Session> session = account
                .map(owner -> store.get(owner, id))
                .orElseGet(() -> store.get(id));
        return session
                .map(found -> HttpResponse.json(200, found))
                .orElseGet(() -> notFound(id));
    }

    /**
     * Applies a partial update. Fields omitted or {@code null} in the body
     * keep their current values; present string fields must be non-blank.
     *
     * @param req the request carrying the {@code id} path capture and the JSON
     *            body
     * @return {@code 200} with the updated session, {@code 400} naming the
     *         offending field, or {@code 404} containing {@code not_found}
     */
    HttpResponse patch(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        try {
            Map<String, Object> body = parseBody(req);
            SessionStore.Patch patch = new SessionStore.Patch(
                    optionalText(body, "title").orElse(null),
                    optionalText(body, "workdir").orElse(null),
                    optionalText(body, "model").orElse(null),
                    optionalText(body, "providerId").orElse(null),
                    optionalText(body, "status").orElse(null));
            Optional<String> account = Principals.accountId(req);
            Optional<Session> current = account
                    .map(owner -> store.get(owner, id))
                    .orElseGet(() -> store.get(id));
            if (current.isEmpty()) {
                return notFound(id);
            }
            Session updated = account
                    .map(owner -> store.patch(owner, id, patch))
                    .orElseGet(() -> store.patch(id, patch));
            return HttpResponse.json(200, updated);
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
    }

    /**
     * Deletes one session and its events.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 204} on deletion, or {@code 404} containing
     *         {@code not_found}
     */
    HttpResponse delete(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        Optional<String> account = Principals.accountId(req);
        boolean deleted = account
                .map(owner -> store.delete(owner, id))
                .orElseGet(() -> store.delete(id));
        return deleted ? HttpResponse.empty(204) : notFound(id);
    }

    /**
     * Settles a session. The optional body {@code {"reason":"manual|inactive|closed|pr_merged|other"}}
     * defaults to {@code manual}.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the updated session, {@code 400} for a malformed
     *         body, {@code 404} or {@code 409 invalid_transition}
     */
    HttpResponse settle(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        try {
            Map<String, Object> body = parseBody(req);
            SettleReason reason = SettleReason.MANUAL;
            if (body.containsKey("reason")) {
                reason = SettleReason.fromWire(requireText(body, "reason"));
                if (reason == null) {
                    throw new IllegalArgumentException(
                            "reason must be one of manual, inactive, closed, pr_merged, other");
                }
            }
            SettleReason chosen = reason;
            return lifecycleOp(req, id, () -> lifecycle.settle(id, chosen));
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
    }

    /**
     * Un-settles a session: clears the settle time and suppresses auto-settle
     * until new activity.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the updated session, {@code 404} or
     *         {@code 409 invalid_transition}
     */
    HttpResponse unsettle(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        return lifecycleOp(req, id, () -> lifecycle.unsettle(id));
    }

    /**
     * Pins a session. The optional body {@code {"order":3}} sets the position
     * among pinned sessions; omitting it keeps the current order.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the updated session, {@code 400}, {@code 404} or
     *         {@code 409 invalid_transition}
     */
    HttpResponse pin(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        try {
            Map<String, Object> body = parseBody(req);
            Integer order = optionalInt(body, "order");
            return lifecycleOp(req, id, () -> lifecycle.pin(id, order));
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
    }

    /**
     * Unpins a session: clears the pin and its order. No-op success on an
     * already unpinned session.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the (possibly unchanged) session, {@code 404} or
     *         {@code 409 invalid_transition}
     */
    HttpResponse unpin(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        return lifecycleOp(req, id, () -> lifecycle.unpin(id));
    }

    /**
     * Snoozes a session. The body carries exactly one of
     * {@code {"until":<epoch ms>}} (must be in the future) or
     * {@code {"durationMs":<positive ms>}}.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the updated session, {@code 400} for a
     *         malformed or past schedule, {@code 404} or
     *         {@code 409 invalid_transition}
     */
    HttpResponse snooze(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        try {
            Map<String, Object> body = parseBody(req);
            boolean until = body.containsKey("until");
            boolean duration = body.containsKey("durationMs");
            if (until == duration) {
                throw new IllegalArgumentException(
                        "exactly one of until or durationMs is required");
            }
            return lifecycleOp(req, id, until
                    ? () -> lifecycle.snooze(id, requireLong(body, "until"))
                    : () -> lifecycle.snoozeFor(id, requireLong(body, "durationMs")));
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
    }

    /**
     * Wakes a session: clears the snooze. No-op success on a session that is
     * not snoozed.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the (possibly unchanged) session, {@code 404} or
     *         {@code 409 invalid_transition}
     */
    HttpResponse wake(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        return lifecycleOp(req, id, () -> lifecycle.wake(id));
    }

    /**
     * Archives a session.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the updated session, {@code 404} or
     *         {@code 409 invalid_transition}
     */
    HttpResponse archive(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        return lifecycleOp(req, id, () -> lifecycle.archive(id));
    }

    /**
     * Restores a session from the archive.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the updated session, {@code 404} or
     *         {@code 409 invalid_transition}
     */
    HttpResponse restore(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        return lifecycleOp(req, id, () -> lifecycle.restore(id));
    }

    /**
     * Sets the auto-settle flag from the body {@code {"enabled":true|false}}.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the (possibly unchanged) session, {@code 400},
     *         {@code 404} or {@code 409 invalid_transition}
     */
    HttpResponse autoSettle(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        try {
            Map<String, Object> body = parseBody(req);
            Object value = body.get("enabled");
            if (!(value instanceof Boolean enabled)) {
                throw new IllegalArgumentException("enabled must be a boolean");
            }
            return lifecycleOp(req, id, () -> lifecycle.setAutoSettle(id, enabled));
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
    }

    /**
     * Regenerates the session title through the title service seam.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the updated session, {@code 404},
     *         {@code 409 invalid_transition} or
     *         {@code 503 title_service_unavailable}
     */
    HttpResponse regenerateTitle(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        return lifecycleOp(req, id, () -> lifecycle.regenerateTitle(id));
    }

    /**
     * Persists a manual ordering: the body {@code {"ids":["a","b"]}} is the
     * full visible order, top first.
     *
     * @param req the request carrying the JSON body
     * @return {@code 200} with the updated sessions in the given order,
     *         {@code 400} for a malformed body, {@code 404} when any id is
     *         unknown or {@code 409 invalid_transition} when any session is
     *         archived
     */
    HttpResponse reorder(HttpRequest req) {
        try {
            Map<String, Object> body = parseBody(req);
            Object value = body.get("ids");
            if (!(value instanceof List<?> raw)) {
                throw new IllegalArgumentException("ids must be an array of strings");
            }
            List<String> ids = new ArrayList<>();
            for (Object entry : raw) {
                if (!(entry instanceof String text) || text.isBlank()) {
                    throw new IllegalArgumentException("ids must be an array of non-blank strings");
                }
                ids.add(text);
            }
            if (ids.isEmpty()) {
                throw new IllegalArgumentException("ids must not be empty");
            }
            Optional<String> account = Principals.accountId(req);
            for (String id : ids) {
                Optional<Session> current = account
                        .map(owner -> store.get(owner, id))
                        .orElseGet(() -> store.get(id));
                if (current.isEmpty()) {
                    return notFound(id);
                }
            }
            return HttpResponse.json(200, lifecycle.reorder(ids));
        } catch (LifecycleException e) {
            return lifecycleError(e);
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
    }

    /**
     * Runs one lifecycle operation: {@code 404} for an unknown (or foreign)
     * session id before the call, {@code 200} with the updated session on
     * success and the mapped failure statuses otherwise.
     */
    private HttpResponse lifecycleOp(HttpRequest req, String id, Supplier<Session> op) {
        if (id != null) {
            Optional<String> account = Principals.accountId(req);
            Optional<Session> current = account
                    .map(owner -> store.get(owner, id))
                    .orElseGet(() -> store.get(id));
            if (current.isEmpty()) {
                return notFound(id);
            }
        }
        try {
            return HttpResponse.json(200, op.get());
        } catch (LifecycleException e) {
            return lifecycleError(e);
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
    }

    private static HttpResponse lifecycleError(LifecycleException e) {
        return switch (e.failure()) {
            case NOT_FOUND -> HttpResponse.error(404, e.failure().code(), e.getMessage());
            case INVALID_TRANSITION -> HttpResponse.error(409, e.failure().code(), e.getMessage());
            case TITLE_UNAVAILABLE -> HttpResponse.error(503, e.failure().code(), e.getMessage());
        };
    }

    private static Long optionalLong(Map<String, Object> body, String field) {
        Object value = body.get(field);
        if (value == null) {
            return null;
        }
        return requireLong(body, field);
    }

    private static long requireLong(Map<String, Object> body, String field) {
        Object value = body.get(field);
        if (!(value instanceof Number number)) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        long parsed = number.longValue();
        if (parsed != number.doubleValue()) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
        return parsed;
    }

    private static Integer optionalInt(Map<String, Object> body, String field) {
        Long value = optionalLong(body, field);
        if (value == null) {
            return null;
        }
        if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
            throw new IllegalArgumentException(field + " must be a 32-bit integer");
        }
        return value.intValue();
    }

    static HttpResponse notFound(String id) {
        return HttpResponse.error(404, "not_found", "session " + id + " not found");
    }

    static Map<String, Object> parseBody(HttpRequest req) {
        String body = req.bodyAsString();
        if (body == null || body.isBlank()) {
            return Map.of();
        }
        try {
            return Json.readMap(body);
        } catch (PluginException e) {
            throw new IllegalArgumentException("request body is not valid JSON", e);
        }
    }

    static String requireText(Map<String, Object> body, String field) {
        return optionalText(body, field)
                .orElseThrow(() -> new IllegalArgumentException(field + " is required"));
    }

    static Optional<String> optionalText(Map<String, Object> body, String field) {
        Object value = body.get(field);
        if (value == null) {
            return Optional.empty();
        }
        if (!(value instanceof String text)) {
            throw new IllegalArgumentException(field + " must be a string");
        }
        if (text.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return Optional.of(text);
    }
}
