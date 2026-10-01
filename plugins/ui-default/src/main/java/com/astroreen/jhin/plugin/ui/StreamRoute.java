/**
 * {@code GET /ui/stream/session/{id}}: the SSE endpoint the {@code stream_view}
 * nodes point at. It proxies the sessions topic {@code sessions/<id>},
 * translating every stored event into one SDUI frame (see
 * {@link EventFrames}) and emitting the {@code {node:…}}/{@code {patch:…}}
 * frames of the streams contract.
 *
 * <p><b>Replay and live tail.</b> The endpoint follows the sessions replay
 * pattern: history comes from {@code EventLog.list} (honouring the
 * {@code fromSeq} query parameter), live events from a long-lived forwarder
 * that subscribes to {@code sessions/<id>} once per session and republishes
 * translated frames on the internal topic {@code ui/frames/<id>}. The SSE
 * stream runs on the translated topic, so both the replayed backlog and the
 * live tail are frames. A per-connection observer on the raw topic de-duplicates
 * the preamble race exactly like the sessions event route: a row whose sequence
 * number was already observed live is skipped by the replay (the live copy
 * wins), so each sequence number is written at most once per connection.
 *
 * <p>An unknown session id is a JSON {@code 404} carrying
 * {@code unknown_session} (never an SSE response); a malformed {@code fromSeq}
 * is a JSON {@code 400} whose body names {@code fromSeq}.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import com.astroreen.jhin.sdk.stream.Subscription;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

final class StreamRoute {

    /** Topic prefix published by the sessions plugin. */
    private static final String RAW_TOPIC_PREFIX = "sessions/";

    /** Topic prefix of the translated frames, internal to this plugin. */
    private static final String FRAMES_TOPIC_PREFIX = "ui/frames/";

    private final SessionStore store;
    private final EventLog events;
    private final StreamRegistry streams;
    private final Map<String, Forwarder> forwarders = new ConcurrentHashMap<>();

    StreamRoute(SessionStore store, EventLog events, StreamRegistry streams) {
        this.store = store;
        this.events = events;
        this.streams = streams;
    }

    /**
     * Streams one session as SDUI frames: {@code fromSeq} (default {@code 0})
     * is an exclusive lower bound on the replay, the live tail keeps appending
     * translated frames, and each sequence number is emitted at most once per
     * connection.
     *
     * @param req the request carrying the {@code id} path capture and the
     *            optional {@code fromSeq} query parameter
     * @return the SSE response, a JSON {@code 404} for an unknown session or a
     *         JSON {@code 400} naming {@code fromSeq} when malformed
     */
    HttpResponse handle(HttpRequest req) {
        String sessionId = req.pathParams().getOrDefault("id", "");
        Optional<String> account = account(req);
        Optional<Session> session = account
                .map(owner -> store.get(owner, sessionId))
                .orElseGet(() -> store.get(sessionId));
        if (session.isEmpty()) {
            return HttpResponse.error(404, "unknown_session", "no session with id " + sessionId);
        }
        long fromSeq;
        try {
            fromSeq = parseFromSeq(req);
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }

        forwarder(sessionId);
        Set<Long> seen = ConcurrentHashMap.newKeySet();
        String rawTopic = RAW_TOPIC_PREFIX + sessionId;
        Subscription observed = streams.subscribe(rawTopic, event -> {
            Long seq = seqOf(event);
            if (seq != null) {
                seen.add(seq);
            }
        });
        return streams.sse(FRAMES_TOPIC_PREFIX + sessionId, writer -> {
            try {
                EventFrames.Translator translator = new EventFrames.Translator();
                for (EventRecord record : events.list(sessionId, fromSeq)) {
                    if (seen.add(record.seq())) {
                        writer.event(EventFrames.FRAME_EVENT, translator.frame(
                                record.type().wire(), record.payload(), record.seq()));
                    }
                }
            } finally {
                observed.close();
            }
        });
    }

    /**
     * Closes every live forwarder. Called from the plugin shutdown hook; the
     * subscriptions would otherwise outlive the plugin.
     */
    void shutdown() {
        for (Forwarder forwarder : forwarders.values()) {
            forwarder.close();
        }
        forwarders.clear();
    }

    /** The forwarder of one session, created on first use. */
    private Forwarder forwarder(String sessionId) {
        return forwarders.computeIfAbsent(sessionId, Forwarder::new);
    }

    private static Optional<String> account(HttpRequest req) {
        try {
            return Principals.accountId(req);
        } catch (RuntimeException e) {
            return Optional.empty();
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

    private static Long seqOf(StreamEvent event) {
        if (event.payload() instanceof Map<?, ?> body && body.get("seq") instanceof Number seq) {
            return seq.longValue();
        }
        return null;
    }

    /**
     * The per-session translator from raw session events to SDUI frames. It
     * seeds its state from the persisted history at creation (so its frames
     * match a full replay event for event) and then republishes every live
     * event on the translated topic. Seeding and delivery are serialized on
     * this object so no event is dropped or reordered around the hand-over.
     */
    private final class Forwarder {

        private final String sessionId;
        private final EventFrames.Translator translator = new EventFrames.Translator();
        private final Queue<StreamEvent> pending = new ConcurrentLinkedQueue<>();
        private final Subscription subscription;
        private boolean live;

        private Forwarder(String sessionId) {
            this.sessionId = sessionId;
            this.subscription = streams.subscribe(RAW_TOPIC_PREFIX + sessionId, this::onEvent);
            for (EventRecord record : events.list(sessionId, 0)) {
                translator.absorb(record.type().wire(), record.payload(), record.seq());
            }
            synchronized (this) {
                live = true;
                for (StreamEvent event : pending) {
                    deliver(event);
                }
                pending.clear();
            }
        }

        private synchronized void onEvent(StreamEvent event) {
            if (live) {
                deliver(event);
            } else {
                pending.add(event);
            }
        }

        private void deliver(StreamEvent event) {
            if (!(event.payload() instanceof Map<?, ?> body)) {
                return;
            }
            long seq = (body.get("seq") instanceof Number number) ? number.longValue() : 0;
            String type = String.valueOf(body.get("type"));
            Object payload = body.get("payload");
            String payloadJson = (payload instanceof String text) ? text : Json.write(payload);
            Map<String, Object> frame = translator.frame(type, payloadJson, seq);
            streams.publish(FRAMES_TOPIC_PREFIX + sessionId,
                    new StreamEvent(EventFrames.FRAME_EVENT, frame));
        }

        private void close() {
            subscription.close();
        }
    }
}
