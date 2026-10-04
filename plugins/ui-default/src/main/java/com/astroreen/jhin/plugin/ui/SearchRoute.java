/**
 * {@code POST /ui/action/search} — the command-palette search (T69): session
 * titles plus the {@code user_message} / {@code message_end} payloads of the
 * session event log.
 *
 * <p>Request body {@code {"query": "…"}}; answer {@code {"results": […]}}
 * whose entries are {@code {id, title, kind, action}} — {@code kind} is the
 * matched source ({@code session}, {@code user_message}, {@code message_end})
 * and {@code action} is a section-4 {@code navigate} directive to the owning
 * chat screen. A query shorter than two characters answers an empty list
 * without reading the store; a blank or non-string query is empty as well.
 * The route never answers 500.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

final class SearchRoute {

    /** Queries shorter than this answer an empty list (the T3 rule). */
    private static final int MIN_QUERY = 2;

    /** Upper bound on one answer; the palette never pages. */
    private static final int LIMIT = 20;

    /** Characters of one message snippet shown as the entry title. */
    private static final int SNIPPET = 80;

    private final SessionStore store;
    private final EventLog events;

    SearchRoute(SessionStore store, EventLog events) {
        this.store = store;
        this.events = events;
    }

    /**
     * Answers the palette search for one {@code {"query": …}} body.
     *
     * @param req the request carrying the JSON body
     * @return {@code {"results": […]}} or a JSON {@code 400} for a body that
     *         is not a JSON object
     */
    HttpResponse handle(HttpRequest req) {
        Map<String, Object> body;
        try {
            body = parseBody(req.bodyAsString());
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
        Object raw = body.get("query");
        String query = raw instanceof String text ? text.trim() : "";
        List<Map<String, Object>> results = new ArrayList<>();
        if (query.length() >= MIN_QUERY) {
            search(req, query.toLowerCase(Locale.ROOT), results);
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("results", results);
        return HttpResponse.json(200, response);
    }

    /** Collects the matching entries in session-list order, capped at LIMIT. */
    private void search(HttpRequest req, String needle, List<Map<String, Object>> out) {
        Optional<String> account = Principals.accountId(req);
        List<Session> sessions = account.map(store::list).orElseGet(store::list);
        for (Session session : sessions) {
            if (out.size() >= LIMIT) {
                return;
            }
            if (contains(session.title(), needle)) {
                out.add(entry(session.id(), session.title(), "session", session.id()));
            }
            for (EventRecord event : events.list(session.id(), 0)) {
                if (out.size() >= LIMIT) {
                    return;
                }
                if (event.type() != EventType.USER_MESSAGE
                        && event.type() != EventType.MESSAGE_END) {
                    continue;
                }
                String text = text(event.payload());
                if (contains(text, needle)) {
                    out.add(entry(
                            session.id() + "#" + event.seq(),
                            snippet(text),
                            event.type().wire(),
                            session.id()));
                }
            }
        }
    }

    /** One result entry: identity, display title, matched kind and action. */
    private static Map<String, Object> entry(
            String id, String title, String kind, String sessionId) {
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("op", "navigate");
        action.put("screen", "chat:" + sessionId);
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("id", id);
        entry.put("title", title);
        entry.put("kind", kind);
        entry.put("action", action);
        return entry;
    }

    /** The {@code text} field of an event payload, or null when absent. */
    private static String text(String payload) {
        if (payload == null || payload.isBlank()) {
            return null;
        }
        try {
            Object value = Json.readMap(payload).get("text");
            return value instanceof String text && !text.isBlank() ? text : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Case-insensitive substring test; null text never matches. */
    private static boolean contains(String text, String needle) {
        return text != null && text.toLowerCase(Locale.ROOT).contains(needle);
    }

    /** The entry title of a message hit: the matched text, shortened. */
    private static String snippet(String text) {
        String flat = text.strip().replaceAll("\\s+", " ");
        return flat.length() <= SNIPPET ? flat : flat.substring(0, SNIPPET - 1) + "…";
    }

    /** Parses the search body; blank bodies search with an empty query. */
    private static Map<String, Object> parseBody(String text) {
        if (text == null || text.isBlank()) {
            return Map.of();
        }
        try {
            return Json.readMap(text);
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("body must be a JSON object", e);
        }
    }
}