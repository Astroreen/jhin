/**
 * Recording {@link StreamRegistry} fake for agent tests: captures every
 * published event per topic. Used to observe the best-effort {@code tool_update}
 * events the tool context publishes.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.stream.SsePreamble;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import com.astroreen.jhin.sdk.stream.Subscription;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

final class RecordingStreamRegistry implements StreamRegistry {

    private final Map<String, List<StreamEvent>> published = new ConcurrentHashMap<>();

    @Override
    public void publish(String topic, StreamEvent event) {
        published.computeIfAbsent(topic, key -> new CopyOnWriteArrayList<>()).add(event);
    }

    @Override
    public HttpResponse sse(String topic, SsePreamble preamble) {
        throw new UnsupportedOperationException();
    }

    @Override
    public Subscription subscribe(String topic, java.util.function.Consumer<StreamEvent> sink) {
        throw new UnsupportedOperationException();
    }

    List<StreamEvent> published(String topic) {
        return List.copyOf(published.getOrDefault(topic, List.of()));
    }
}
