/**
 * The two run routes of the agent plugin: {@code POST
 * /sessions/{id}/messages} starts a run and {@code POST /sessions/{id}/cancel}
 * cancels the active one.
 *
 * <p>Validation follows the sessions plugin style: a malformed body is a
 * {@code 400} whose {@code error} is {@code invalid_request} and whose message
 * names the offending field, an unknown or foreign session is a {@code 404}
 * containing {@code not_found}. Run-lifecycle conflicts keep their typed
 * codes: {@code run_active} (409) when a run is already live and
 * {@code no_active_run} (404) when nothing can be cancelled. Every request is
 * scoped to the account resolved from the request principal (see
 * {@link Principals}); without a security plugin the store falls back to its
 * implicit account {@code local}.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.agent.api.RunService;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.util.Map;
import java.util.Optional;

final class MessageRoutes {

    private final SessionStore sessions;
    private final RunService runs;

    MessageRoutes(SessionStore sessions, RunService runs) {
        this.sessions = sessions;
        this.runs = runs;
    }

    /**
     * Starts one agent run from a JSON body: {@code text} is the required
     * non-blank user message. The run starts asynchronously; the response
     * carries its id.
     *
     * @param req the request carrying the {@code id} path capture and the JSON
     *            body
     * @return {@code 202} with {@code {"runId"}}, {@code 400} naming the
     *         offending field, {@code 404} for an unknown session or
     *         {@code 409} when a run is already active
     */
    HttpResponse messages(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        try {
            Map<String, Object> body = parseBody(req);
            String text = requireText(body, "text");
            Session session = lookup(req, id);
            if (session == null) {
                return notFound(id);
            }
            return HttpResponse.json(202, Map.of("runId", runs.start(session, text)));
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        } catch (RunException e) {
            return HttpResponse.error(e.httpStatus(), e.code(), e.getMessage());
        }
    }

    /**
     * Cancels the active run of one session.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 204} when cancellation was requested, {@code 404} for an
     *         unknown session or a session without an active run
     */
    HttpResponse cancel(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        Session session = lookup(req, id);
        if (session == null) {
            return notFound(id);
        }
        try {
            runs.cancel(id);
            return HttpResponse.empty(204);
        } catch (RunException e) {
            return HttpResponse.error(e.httpStatus(), e.code(), e.getMessage());
        }
    }

    private Session lookup(HttpRequest req, String id) {
        Optional<String> account = Principals.accountId(req);
        return account
                .map(owner -> sessions.get(owner, id))
                .orElseGet(() -> sessions.get(id))
                .orElse(null);
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
