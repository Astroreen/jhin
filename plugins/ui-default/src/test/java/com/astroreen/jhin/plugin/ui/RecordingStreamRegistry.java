/**
 * Recording {@link StreamRegistry} fake for plugin tests: captures every
 * published event per topic and every SSE request (topic and preamble) and
 * fans out to subscribed sinks. The returned SSE response is a plain
 * {@code 200}; tests replay the captured preamble against their own writer to
 * observe what the route writes.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.stream.SsePreamble;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import com.astroreen.jhin.sdk.stream.Subscription;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

final class RecordingStreamRegistry implements StreamRegistry {

    /** One captured {@link #sse(String, SsePreamble)} call. */
    record SseRequest(String topic, SsePreamble preamble) {}

    private final Map<String, List<StreamEvent>> published = new ConcurrentHashMap<>();
    private final Map<String, List<Consumer<StreamEvent>>> subscribers = new ConcurrentHashMap<>();
    private final List<SseRequest> sseRequests = new CopyOnWriteArrayList<>();

    @Override
    public void publish(String topic, StreamEvent event) {
        published.computeIfAbsent(topic, key -> new CopyOnWriteArrayList<>()).add(event);
        for (Consumer<StreamEvent> sink : subscribers.getOrDefault(topic, List.of())) {
            sink.accept(event);
        }
    }

    @Override
    public HttpResponse sse(String topic, SsePreamble preamble) {
        sseRequests.add(new SseRequest(topic, preamble));
        return HttpResponse.empty(200);
    }

    @Override
    public Subscription subscribe(String topic, Consumer<StreamEvent> sink) {
        subscribers.computeIfAbsent(topic, key -> new CopyOnWriteArrayList<>()).add(sink);
        return () -> subscribers.getOrDefault(topic, List.of()).remove(sink);
    }

    /**
     * Every SSE request seen so far, in call order.
     *
     * @return the captured topic and preamble pairs
     */
    List<SseRequest> sseRequests() {
        return List.copyOf(sseRequests);
    }

    /**
     * Every event published on one topic, in publication order.
     *
     * @param topic the topic to read
     * @return the published events
     */
    List<StreamEvent> publishedOn(String topic) {
        return List.copyOf(published.getOrDefault(topic, new ArrayList<>()));
    }
}
