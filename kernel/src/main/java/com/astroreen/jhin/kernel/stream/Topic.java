/**
 * One stream topic: the SSE connections and plain sinks listening to it.
 *
 * <p>Kept by {@link StreamRegistryImpl} under the topic name and dropped as
 * soon as it is empty. Publishing fans out to every listener without ever
 * blocking the publisher: connections buffer the event and report an overflow
 * when they fall too far behind, sinks are invoked inline.
 */
package com.astroreen.jhin.kernel.stream;

import com.astroreen.jhin.sdk.stream.StreamEvent;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class Topic {

    private static final Logger LOG = LoggerFactory.getLogger(Topic.class);

    private final String name;
    private final CopyOnWriteArrayList<SseConnection> connections = new CopyOnWriteArrayList<>();
    private final CopyOnWriteArrayList<Consumer<StreamEvent>> sinks = new CopyOnWriteArrayList<>();

    /**
     * Creates an empty topic. Called by the registry when the first listener
     * for a name appears.
     *
     * @param name the topic name
     */
    Topic(String name) {
        this.name = name;
    }

    /**
     * The topic name. Called by the registry on lookups and detach.
     *
     * @return the name
     */
    String name() {
        return name;
    }

    /**
     * Adds one SSE connection to the fan-out. Called by the registry when an
     * SSE request subscribes.
     *
     * @param connection the connection to add
     */
    void add(SseConnection connection) {
        connections.add(connection);
    }

    /**
     * Removes one SSE connection from the fan-out. Called by the registry
     * when the connection closes.
     *
     * @param connection the connection to remove
     */
    void remove(SseConnection connection) {
        connections.remove(connection);
    }

    /**
     * Adds one plain sink to the fan-out. Called by the registry when a
     * subscriber appears.
     *
     * @param sink the sink to add
     */
    void addSink(Consumer<StreamEvent> sink) {
        sinks.add(sink);
    }

    /**
     * Removes one plain sink from the fan-out. Called by the registry when the
     * subscription closes.
     *
     * @param sink the sink to remove
     */
    void removeSink(Consumer<StreamEvent> sink) {
        sinks.remove(sink);
    }

    /**
     * Whether nobody is listening anymore. Called by the registry to decide
     * when to drop the topic.
     *
     * @return {@code true} when no connection and no sink is left
     */
    boolean isEmpty() {
        return connections.isEmpty() && sinks.isEmpty();
    }

    /**
     * The number of live SSE connections. Called by tests asserting connection
     * cleanup.
     *
     * @return the connection count
     */
    int connectionCount() {
        return connections.size();
    }

    /**
     * Fans one event out to every listener. Called by the registry on every
     * publish; a connection whose buffer is full is closed with a warning
     * naming the topic, so the publisher is never back-pressured.
     *
     * @param event the event to deliver
     */
    void publish(StreamEvent event) {
        for (SseConnection connection : connections) {
            if (!connection.offer(event)) {
                LOG.warn("sse buffer overflow on topic {}; closing connection", name);
                connection.close();
            }
        }
        for (Consumer<StreamEvent> sink : sinks) {
            try {
                sink.accept(event);
            } catch (RuntimeException e) {
                LOG.warn("event sink failed on topic {}", name, e);
            }
        }
    }

    /**
     * Closes every listener of the topic. Called by the registry on shutdown.
     */
    void closeAll() {
        for (SseConnection connection : connections) {
            connection.close();
        }
        sinks.clear();
    }
}
