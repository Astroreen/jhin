/**
 * Recording {@link com.astroreen.jhin.sdk.ServiceRegistry} fake: captures
 * every publication in call order and serves {@code find}/{@code findAll} from
 * the recording, so a test can assert exactly what a plugin published and
 * under which qualifier.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.ServiceRegistry;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class RecordingServiceRegistry implements ServiceRegistry {

    /** One publication: the exact type, the qualifier and the instance. */
    record Publication(Class<?> type, String qualifier, Object instance) {}

    private final List<Publication> publications = new ArrayList<>();
    private final Map<String, Object> byKey = new LinkedHashMap<>();

    @Override
    public <T> void publish(Class<T> type, T instance) {
        publish(type, "", instance);
    }

    @Override
    public <T> void publish(Class<T> type, String qualifier, T instance) {
        String key = type.getName() + "#" + qualifier;
        if (byKey.containsKey(key)) {
            throw new PluginException("duplicate publication of " + key);
        }
        byKey.put(key, instance);
        publications.add(new Publication(type, qualifier, instance));
    }

    @Override
    public <T> Optional<T> find(Class<T> type) {
        return find(type, "");
    }

    @Override
    public <T> Optional<T> find(Class<T> type, String qualifier) {
        Object instance = byKey.get(type.getName() + "#" + qualifier);
        return instance == null ? Optional.empty() : Optional.of(type.cast(instance));
    }

    @Override
    public <T> List<T> findAll(Class<T> type) {
        List<T> found = new ArrayList<>();
        for (Publication publication : publications) {
            if (publication.type().equals(type)) {
                found.add(type.cast(publication.instance()));
            }
        }
        return List.copyOf(found);
    }

    /** Every publication in call order. */
    List<Publication> publications() {
        return List.copyOf(publications);
    }
}
