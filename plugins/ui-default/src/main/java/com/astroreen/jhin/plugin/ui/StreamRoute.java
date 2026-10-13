/**
 * {@code GET /ui/stream/session/{id}}: the SSE endpoint the {@code stream_view}
 * nodes point at. It proxies the sessions topic {@code sessions/<id>},
 * translating every stored event into SDUI frames (see
 * {@link EventFrames}; {@code text_delta} events coalesce into batched
 * {@code patch} frames) and emitting the {@code {node:…}}/{@code {patch:…}}
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
 *
 * <p><b>Sessions overview.</b> {@code GET /ui/stream/sessions-overview} is the
 * live list stream: every {@code session_updated} event of every known session
 * is translated into the sidebar-row {@code patch} frame and republished on
 * the internal topic {@code ui/frames/sessions-overview}. One relay per
 * session feeds it (the same forwarder pattern, one raw-topic subscription
 * each); relays are attached for every session in the store when the overview
 * stream is opened and whenever a per-session forwarder starts, so a sidebar
 * stays live without a full refresh. The overview stream has no preamble — it
 * broadcasts live updates only.
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
import java.util.function.LongSupplier;

final class StreamRoute {

    /** Topic prefix published by the sessions plugin. */
    private static final String RAW_TOPIC_PREFIX = "sessions/";

    /** Topic prefix of the translated frames, internal to this plugin. */
    private static final String FRAMES_TOPIC_PREFIX = "ui/frames/";

    /** The translated topic carrying the sidebar-row patch frames. */
    static final String OVERVIEW_TOPIC = FRAMES_TOPIC_PREFIX + "sessions-overview";

    private final SessionStore store;
    private final EventLog events;
    private final StreamRegistry streams;
    private final LongSupplier clock;
    private final Map<String, Forwarder> forwarders = new ConcurrentHashMap<>();
    private final Map<String, OverviewRelay> relays = new ConcurrentHashMap<>();

    StreamRoute(SessionStore store, EventLog events, StreamRegistry streams) {
        this(store, events, streams, System::currentTimeMillis);
    }

    /**
     * Creates the route on the given wall clock (epoch milliseconds); tests
     * inject a fixed clock so the delta flush window of the translators is
     * deterministic.
     */
    StreamRoute(SessionStore store, EventLog events, StreamRegistry streams, LongSupplier clock) {
        this.store = store;
        this.events = events;
        this.streams = streams;
        this.clock = clock;
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
                EventFrames.Translator translator = new EventFrames.Translator(sessionId, clock);
                // Seed the translation state from everything before the
                // replay window, so a window that starts mid-message still
                // patches the open message instead of opening a new one.
                for (EventRecord record : events.list(sessionId, 0)) {
                    if (record.seq() <= fromSeq) {
                        translator.absorb(record.type().wire(), record.payload(), record.seq());
                    } else if (seen.add(record.seq())) {
                        for (Map<String, Object> frame : translator.frames(
                                record.type().wire(), record.payload(), record.seq())) {
                            writer.event(EventFrames.FRAME_EVENT, frame);
                        }
                    }
                }
                // Close of the replay window: flush the trailing delta batch
                // so a message still streaming is never lost (T205).
                for (Map<String, Object> frame : translator.flush()) {
                    writer.event(EventFrames.FRAME_EVENT, frame);
                }
            } finally {
                observed.close();
            }
        });
    }

    /**
     * Streams the sessions overview: live {@code session_updated} sidebar-row
     * patch frames on {@link #OVERVIEW_TOPIC}. Every session known to the
     * store gets a relay attached first, so sessions created since the last
     * overview connection are covered too.
     *
     * @param req the request (used to scope the session scan by account)
     * @return the SSE response
     */
    HttpResponse handleOverview(HttpRequest req) {
        Optional<String> account = account(req);
        List<Session> sessions = account.map(store::list).orElseGet(store::list);
        for (Session session : sessions) {
            relay(session.id());
        }
        return streams.sse(OVERVIEW_TOPIC, writer -> {
        });
    }

    /**
     * Closes every live forwarder and overview relay. Called from the plugin
     * shutdown hook; the subscriptions would otherwise outlive the plugin.
     */
    void shutdown() {
        for (Forwarder forwarder : forwarders.values()) {
            forwarder.close();
        }
        forwarders.clear();
        for (OverviewRelay relay : relays.values()) {
            relay.close();
        }
        relays.clear();
    }

    /** The forwarder of one session, created on first use. */
    private Forwarder forwarder(String sessionId) {
        relay(sessionId);
        return forwarders.computeIfAbsent(sessionId, Forwarder::new);
    }

    /** The overview relay of one session, created on first use. */
    private OverviewRelay relay(String sessionId) {
        return relays.computeIfAbsent(sessionId, OverviewRelay::new);
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
     * continue a full replay seamlessly) and then republishes every live
     * event on the translated topic. Seeding and delivery are serialized on
     * this object so no event is dropped or reordered around the hand-over.
     * The delta batch of the open message flushes here — at most one
     * {@code patch} per {@link EventFrames#DELTA_FLUSH_WINDOW_MILLIS} —
     * before any other frame so the topic order matches the event order.
     */
    private final class Forwarder {

        private final String sessionId;
        private final EventFrames.Translator translator;
        private final Queue<StreamEvent> pending = new ConcurrentLinkedQueue<>();
        private final Subscription subscription;
        private boolean live;

        private Forwarder(String sessionId) {
            this.sessionId = sessionId;
            this.translator = new EventFrames.Translator(sessionId, clock);
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
            for (Map<String, Object> frame
                    : translator.frames(type, payloadJson, seq)) {
                streams.publish(FRAMES_TOPIC_PREFIX + sessionId,
                        new StreamEvent(EventFrames.FRAME_EVENT, frame));
            }
        }

        private void close() {
            subscription.close();
        }
    }

    /**
     * The per-session relay feeding the overview topic: every live
     * {@code session_updated} event becomes one sidebar-row {@code patch}
     * frame on {@link #OVERVIEW_TOPIC}; all other event kinds are ignored.
     */
    private final class OverviewRelay {

        private final Subscription subscription;

        private OverviewRelay(String sessionId) {
            this.subscription = streams.subscribe(RAW_TOPIC_PREFIX + sessionId, this::onEvent);
        }

        private void onEvent(StreamEvent event) {
            if (!(event.payload() instanceof Map<?, ?> body)) {
                return;
            }
            if (!EventType.SESSION_UPDATED.wire().equals(String.valueOf(body.get("type")))) {
                return;
            }
            Object payload = body.get("payload");
            String payloadJson = (payload instanceof String text) ? text : Json.write(payload);
            streams.publish(OVERVIEW_TOPIC, new StreamEvent(EventFrames.FRAME_EVENT,
                    EventFrames.sessionUpdatedFrame(payloadJson)));
        }

        private void close() {
            subscription.close();
        }
    }
}
