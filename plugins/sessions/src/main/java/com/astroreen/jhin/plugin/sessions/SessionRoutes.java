/**
 * JSON CRUD routes over the session store.
 *
 * <p>Endpoints: {@code GET /sessions} (list), {@code POST /sessions} (create),
 * {@code GET /sessions/{id}}, {@code PATCH /sessions/{id}} (partial update),
 * {@code DELETE /sessions/{id}} (204). An unknown or foreign session id is a
 * {@code 404} whose body contains {@code not_found}; a malformed body is a
 * {@code 400} whose body names the offending field. Every request is scoped to
 * the account resolved from the request principal (see {@link Principals});
 * without a security plugin the store falls back to its implicit account
 * {@code local}.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class SessionRoutes {

    private final SessionStore store;

    SessionRoutes(SessionStore store) {
        this.store = store;
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
