/**
 * Recording {@link StreamRegistry} fake for plugin tests: captures every
 * published event per topic and fans out to subscribed sinks. The SSE builder
 * is not exercised by unit tests and throws {@link UnsupportedOperationException}.
 */
package com.astroreen.jhin.plugin.sessions;

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

    private final Map<String, List<StreamEvent>> published = new ConcurrentHashMap<>();
    private final Map<String, List<Consumer<StreamEvent>>> subscribers = new ConcurrentHashMap<>();

    @Override
    public void publish(String topic, StreamEvent event) {
        published.computeIfAbsent(topic, key -> new CopyOnWriteArrayList<>()).add(event);
        for (Consumer<StreamEvent> sink : subscribers.getOrDefault(topic, List.of())) {
            sink.accept(event);
        }
    }

    @Override
    public HttpResponse sse(String topic, SsePreamble preamble) {
        throw new UnsupportedOperationException("sse is not exercised by unit tests");
    }

    @Override
    public Subscription subscribe(String topic, Consumer<StreamEvent> sink) {
        subscribers.computeIfAbsent(topic, key -> new CopyOnWriteArrayList<>()).add(sink);
        return () -> subscribers.getOrDefault(topic, List.of()).remove(sink);
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

    /**
     * Every event published on any topic, in publication order.
     *
     * @return the published events
     */
    List<StreamEvent> allPublished() {
        List<StreamEvent> out = new ArrayList<>();
        published.values().forEach(out::addAll);
        return List.copyOf(out);
    }
}
