/**
 * Minimal {@link com.astroreen.jhin.sdk.ServiceRegistry} fake for plugin
 * tests: an in-memory publish/find table keyed by the exact {@link Class} and
 * qualifier pair, matching the kernel's resolution rules.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.ServiceRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

final class FakeServiceRegistry implements ServiceRegistry {

    private final Map<Key, Object> published = new ConcurrentHashMap<>();

    @Override
    public <T> void publish(Class<T> type, T instance) {
        publish(type, "", instance);
    }

    @Override
    public <T> void publish(Class<T> type, String qualifier, T instance) {
        Key key = new Key(type, qualifier == null ? "" : qualifier);
        if (published.putIfAbsent(key, instance) != null) {
            throw new PluginException("service already published: " + type.getName());
        }
    }

    @Override
    public <T> Optional<T> find(Class<T> type) {
        return find(type, "");
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> Optional<T> find(Class<T> type, String qualifier) {
        return Optional.ofNullable((T) published.get(new Key(type, qualifier == null ? "" : qualifier)));
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> List<T> findAll(Class<T> type) {
        List<T> out = new ArrayList<>();
        for (Map.Entry<Key, Object> entry : published.entrySet()) {
            if (entry.getKey().type() == type) {
                out.add((T) entry.getValue());
            }
        }
        return List.copyOf(out);
    }

    private record Key(Class<?> type, String qualifier) {}
}
