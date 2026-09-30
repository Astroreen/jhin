/**
 * Kernel side of the event-stream extension point: topics, subscribers and
 * the SSE hand-off.
 *
 * <p>Implements the SDK {@link com.astroreen.jhin.sdk.stream.StreamRegistry}
 * for publishing and subscribing, and the kernel's
 * {@link com.astroreen.jhin.kernel.http.SseHandoff} seam for streaming. One
 * instance owns the topic map and the shared heartbeat scheduler.
 *
 * <p>Preamble race contract: an SSE request is subscribed and buffering
 * BEFORE its preamble runs, and the buffered events are flushed only after
 * the preamble has finished writing. An event published while the preamble
 * runs is therefore delivered after the preamble output — never lost, never
 * reordered before it. Plugins that replay overlapping history de-duplicate
 * by their own monotonic identifier.
 */
package com.astroreen.jhin.kernel.stream;

import com.astroreen.jhin.kernel.http.SseHandoff;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.stream.SsePreamble;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import com.astroreen.jhin.sdk.stream.Subscription;
import jakarta.servlet.AsyncContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;

public final class StreamRegistryImpl implements StreamRegistry, SseHandoff, SmartLifecycle, AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(StreamRegistryImpl.class);

    /** Stopped before the web server waits for requests; streams are long-lived. */
    private static final int STOP_PHASE = Integer.MAX_VALUE;

    private final ConcurrentMap<String, Topic> topics = new ConcurrentHashMap<>();
    private final Heartbeat heartbeat = new Heartbeat();
    private final AtomicBoolean running = new AtomicBoolean(true);

    /**
     * Publishes one event to every current listener of the topic. Called by
     * plugins; never blocks on slow consumers (see the SDK contract).
     *
     * @param topic the topic to publish on
     * @param event the event to publish
     */
    @Override
    public void publish(String topic, StreamEvent event) {
        Objects.requireNonNull(topic, "topic");
        Objects.requireNonNull(event, "event");
        Topic current = topics.get(topic);
        if (current != null) {
            current.publish(event);
        }
    }

    /**
     * Builds the SSE response for one topic. Called by plugins serving an SSE
     * endpoint; the returned response carries the internal source marker the
     * hand-off below understands.
     *
     * @param topic    the topic to stream
     * @param preamble the callback replaying history first
     * @return the SSE response to send
     */
    @Override
    public HttpResponse sse(String topic, SsePreamble preamble) {
        Objects.requireNonNull(topic, "topic");
        Objects.requireNonNull(preamble, "preamble");
        return new HttpResponse(200, Map.of(), new byte[0], new SseSource(topic, preamble));
    }

    /**
     * Subscribes one sink to a topic. Called by plugins consuming live events;
     * the sink runs on the publishing thread until the subscription closes.
     *
     * @param topic the topic to subscribe to
     * @param sink  the consumer invoked for every event
     * @return the subscription handle
     */
    @Override
    public Subscription subscribe(String topic, Consumer<StreamEvent> sink) {
        Objects.requireNonNull(topic, "topic");
        Objects.requireNonNull(sink, "sink");
        topics.compute(topic, (name, current) -> {
            Topic resolved = (current == null) ? new Topic(name) : current;
            resolved.addSink(sink);
            return resolved;
        });
        return () -> detachSink(topic, sink);
    }

    /**
     * Streams one SSE-marked response to the client. Called by the response
     * writer on the request thread: sets the stream headers, disables the
     * container timeout, subscribes and buffers first, then runs the preamble,
     * flushes the buffer and live-tails until the stream ends.
     *
     * @param request  the raw request
     * @param response the raw response
     * @param sse      the SSE marker carried by the response
     * @throws Exception when streaming cannot start at all
     */
    @Override
    public void handOff(HttpServletRequest request, HttpServletResponse response, Object sse)
            throws Exception {
        if (!(sse instanceof SseSource source)) {
            throw new IllegalStateException("unknown SSE marker: "
                    + (sse == null ? "null" : sse.getClass().getName()));
        }
        response.setContentType("text/event-stream");
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        AsyncContext async = request.startAsync();
        async.setTimeout(0);
        OutputStream out = response.getOutputStream();
        SseConnection connection = new SseConnection(source.topic(), out, this::detach);
        try {
            attach(source.topic(), connection);
            heartbeat.add(connection);
            if (runPreamble(source, connection)) {
                connection.flushBuffered();
                connection.liveTail();
            }
        } finally {
            heartbeat.remove(connection);
            connection.close();
            try {
                out.close();
            } catch (IOException e) {
                LOG.debug("sse stream for topic {} ended on close failure", source.topic());
            }
            async.complete();
        }
    }

    /**
     * Ends every stream before the web server drains its requests: a live SSE
     * request never finishes on its own and would hold the shutdown up.
     * Called by Spring on context shutdown.
     */
    @Override
    public void stop() {
        close();
    }

    @Override
    public void start() {
        running.set(true);
    }

    @Override
    public boolean isRunning() {
        return running.get();
    }

    @Override
    public int getPhase() {
        return STOP_PHASE;
    }

    /**
     * Stops the heartbeat scheduler and closes every live connection. Called
     * by {@link #stop()} and by Spring on bean destruction.
     */
    @Override
    public void close() {
        running.set(false);
        heartbeat.close();
        for (Topic topic : topics.values()) {
            topic.closeAll();
        }
        topics.clear();
    }

    /**
     * Whether the topic is still tracked. Called by tests asserting that an
     * empty topic is dropped.
     *
     * @param topic the topic name
     * @return {@code true} while the topic has listeners
     */
    boolean hasTopic(String topic) {
        return topics.containsKey(topic);
    }

    /**
     * The number of live SSE connections on one topic. Called by tests
     * asserting connection cleanup.
     *
     * @param topic the topic name
     * @return the connection count
     */
    int connectionCount(String topic) {
        Topic current = topics.get(topic);
        return (current == null) ? 0 : current.connectionCount();
    }

    /**
     * Runs the preamble; a replay failure aborts the stream and is logged with
     * its stack trace.
     *
     * @return {@code true} when the preamble finished and the stream may tail
     */
    private boolean runPreamble(SseSource source, SseConnection connection) {
        try {
            source.preamble().write(connection.writer());
            return true;
        } catch (IOException e) {
            LOG.debug("sse preamble for topic {} ended on write failure", source.topic());
            return false;
        } catch (Exception e) {
            LOG.warn("sse preamble failed on topic {}", source.topic(), e);
            return false;
        }
    }

    /** Attaches a connection to its topic, creating the topic on first use. */
    private void attach(String topic, SseConnection connection) {
        topics.compute(topic, (name, current) -> {
            Topic resolved = (current == null) ? new Topic(name) : current;
            resolved.add(connection);
            return resolved;
        });
    }

    /** Detaches a connection and drops its topic when nobody is left. */
    private void detach(SseConnection connection) {
        topics.computeIfPresent(connection.topic(), (name, current) -> {
            current.remove(connection);
            return current.isEmpty() ? null : current;
        });
    }

    /** Detaches one sink and drops its topic when nobody is left. */
    private void detachSink(String topic, Consumer<StreamEvent> sink) {
        topics.computeIfPresent(topic, (name, current) -> {
            current.removeSink(sink);
            return current.isEmpty() ? null : current;
        });
    }
}
