/**
 * Plugin-facing event-stream extension point: publish, subscribe and SSE.
 *
 * <p>Obtained from {@link com.astroreen.jhin.sdk.PluginContext#streams()} and
 * used whenever a plugin emits or consumes live session events. The kernel
 * owns the subscriber lists and the SSE connections; the plugin only produces
 * events and, when it serves an SSE endpoint, replays its own history through
 * the preamble.
 */
package com.astroreen.jhin.sdk.stream;

import com.astroreen.jhin.sdk.http.HttpResponse;
import java.util.function.Consumer;

public interface StreamRegistry {

    /**
     * Publishes one event on a topic. Fan-out to the current subscribers;
     * non-blocking, drops to slow consumers are logged and never back-pressure
     * the publisher.
     *
     * @param topic the topic to publish on
     * @param event the event to publish
     */
    void publish(String topic, StreamEvent event);

    /**
     * Builds an SSE response for a topic. The kernel subscribes and buffers
     * live events FIRST, then runs {@code preamble} (where the plugin replays
     * its own history), then flushes the buffer and live-tails. Consequence:
     * the plugin MUST de-duplicate by its own monotonic id. The kernel sends a
     * {@code :heartbeat} comment every 15 s and closes the connection on
     * client disconnect.
     *
     * @param topic    the topic to stream
     * @param preamble the callback that replays the plugin's history first
     * @return the SSE response to send
     */
    HttpResponse sse(String topic, SsePreamble preamble);

    /**
     * Subscribes to a topic. Called by a plugin that wants every event
     * published on the topic from now on; the kernel invokes {@code sink} on
     * each event until the returned subscription is closed.
     *
     * @param topic the topic to subscribe to
     * @param sink  the consumer invoked for every event
     * @return the subscription handle; close it to stop receiving events
     */
    Subscription subscribe(String topic, Consumer<StreamEvent> sink);
}
