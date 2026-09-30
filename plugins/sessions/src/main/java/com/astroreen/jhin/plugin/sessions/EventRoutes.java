/**
 * SSE replay and live-tail route for one session's event log.
 *
 * <p>{@code GET /sessions/{id}/events?fromSeq=N} streams the session topic
 * through the SDK {@code StreamRegistry.sse} contract. The kernel subscribes
 * and buffers live events first and only then runs the preamble, so the replay
 * window and the live buffer can overlap; the route de-duplicates by {@code
 * seq}: a replay row whose {@code seq} was already observed on the live feed is
 * skipped (the live copy wins), so every {@code seq} is written at most once
 * per connection. The observer subscription starts on the request thread,
 * before the stream is built, and closes when the preamble finishes.
 *
 * <p>An unknown session id is a JSON {@code 404} containing {@code not_found}
 * (never an SSE response); a malformed {@code fromSeq} is a JSON {@code 400}
 * whose body names {@code fromSeq}.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import com.astroreen.jhin.sdk.stream.Subscription;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

final class EventRoutes {

    private final SessionStore store;
    private final EventLog eventLog;
    private final StreamRegistry streams;

    EventRoutes(SessionStore store, EventLog eventLog, StreamRegistry streams) {
        this.store = store;
        this.eventLog = eventLog;
        this.streams = streams;
    }

    /**
     * Streams one session's events: {@code fromSeq} (default {@code 0}) is an
     * exclusive lower bound on {@code seq}, so the preamble replays rows with
     * {@code seq > fromSeq} and the live tail keeps appending. Each {@code seq}
     * is emitted at most once even when the live buffer races the replay
     * window.
     *
     * @param req the request carrying the {@code id} path capture and the
     *            optional {@code fromSeq} query parameter
     * @return the SSE response, a JSON {@code 404} for an unknown session or a
     *         JSON {@code 400} naming {@code fromSeq} when malformed
     */
    HttpResponse stream(HttpRequest req) {
        String sessionId = req.pathParams().getOrDefault("id", "");
        Optional<String> account = Principals.accountId(req);
        Optional<Session> session = account
                .map(owner -> store.get(owner, sessionId))
                .orElseGet(() -> store.get(sessionId));
        if (session.isEmpty()) {
            return SessionRoutes.notFound(sessionId);
        }
        long fromSeq;
        try {
            fromSeq = parseFromSeq(req);
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }

        Set<Long> seen = ConcurrentHashMap.newKeySet();
        Subscription observed = streams.subscribe(EventLogImpl.topic(sessionId), event -> {
            Long seq = seqOf(event);
            if (seq != null) {
                seen.add(seq);
            }
        });
        return streams.sse(EventLogImpl.topic(sessionId), writer -> {
            try {
                for (EventRecord record : eventLog.list(sessionId, fromSeq)) {
                    if (seen.add(record.seq())) {
                        writer.event(record.type().wire(), EventLogImpl.body(record));
                    }
                }
            } finally {
                observed.close();
            }
        });
    }

    /**
     * QA helper: appends exactly one event to a session from a JSON body
     * {@code {"type":"<wire name>","payload":<json>}} and answers
     * {@code 201} with the persisted row. The payload is either a JSON object
     * given inline or a string holding JSON text; it defaults to {@code {}}.
     *
     * <p>This route exists so the QA script can produce deterministic event
     * sequences without an agent run behind them. It is registered only when
     * the {@code qa} configuration flag is enabled (environment variable
     * {@code JHIN_SESSIONS_QA}); by default the endpoint does not exist at all.
     *
     * @param req the request carrying the {@code id} path capture and the JSON
     *            body
     * @return {@code 201} with the appended event, {@code 400} naming the
     *         offending field, or {@code 404} containing {@code not_found}
     */
    HttpResponse appendOne(HttpRequest req) {
        String sessionId = req.pathParams().getOrDefault("id", "");
        Optional<String> account = Principals.accountId(req);
        Optional<Session> session = account
                .map(owner -> store.get(owner, sessionId))
                .orElseGet(() -> store.get(sessionId));
        if (session.isEmpty()) {
            return SessionRoutes.notFound(sessionId);
        }
        try {
            Map<String, Object> body = SessionRoutes.parseBody(req);
            String wire = SessionRoutes.requireText(body, "type");
            EventType type;
            try {
                type = EventType.fromWire(wire);
            } catch (PluginException e) {
                throw new IllegalArgumentException("type is not a known event type: " + wire, e);
            }
            EventRecord record;
            try {
                record = eventLog.append(sessionId, type, payloadOf(body));
            } catch (PluginException e) {
                return SessionRoutes.notFound(sessionId);
            }
            return HttpResponse.json(201, body(record));
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
    }

    private static long parseFromSeq(HttpRequest req) {
        List<String> values = req.query().get("fromSeq");
        if (values == null || values.isEmpty()) {
            return 0;
        }
        String raw = values.get(0) == null ? "" : values.get(0).trim();
        try {
            long fromSeq = Long.parseLong(raw);
            if (fromSeq < 0) {
                throw new NumberFormatException();
            }
            return fromSeq;
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("fromSeq must be a non-negative integer", e);
        }
    }

    private static String payloadOf(Map<String, Object> body) {
        Object payload = body.get("payload");
        if (payload == null) {
            return "{}";
        }
        return (payload instanceof String text) ? text : Json.write(payload);
    }

    private static Long seqOf(StreamEvent event) {
        if (event.payload() instanceof Map<?, ?> body && body.get("seq") instanceof Number seq) {
            return seq.longValue();
        }
        return null;
    }

    private static Map<String, Object> body(EventRecord record) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", record.sessionId());
        body.putAll(EventLogImpl.body(record));
        return body;
    }
}
