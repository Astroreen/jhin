/**
 * Kernel implementation of the cross-plugin service exchange contract.
 *
 * <p>Every registration is stored in a map keyed by the exact {@link Class}
 * object plus the qualifier (the empty string stands for the default one), and
 * appended to a per-class list that remembers publication order; that list
 * backs {@link #findAll(Class)} and the first-in-publish-order rule of
 * {@link #find(Class)}. Lookups never cache results, so instances published
 * later become visible to the next lookup, while {@link #findAll(Class)}
 * returns a snapshot taken at call time.
 *
 * <p>The SDK interface carries no owner parameter, so the publishing plugin is
 * recorded through a thread-local set by {@link #attributedTo(String, Runnable)}:
 * the plugin lifecycle wraps every registration a plugin makes in that call,
 * and the recorded id names the owner when a duplicate publication is refused
 * and feeds {@link #publishersByPlugin()} for the {@code /_jhin/health}
 * diagnostics. A publication made outside every {@code attributedTo} block is
 * attributed to {@link #HOST_PUBLISHER}.
 */
package com.astroreen.jhin.kernel.services;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.ServiceRegistry;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

public final class ServiceRegistryImpl implements ServiceRegistry {

    /** Attribution used for publications made outside {@link #attributedTo}. */
    public static final String HOST_PUBLISHER = "kernel";

    /** Guards publication so the per-class order matches the publish order. */
    private final Object publishLock = new Object();

    /** Publisher id of the registration block running on this thread. */
    private final ThreadLocal<String> currentPublisher = new ThreadLocal<>();

    /** Exact type plus qualifier to the single registration under that key. */
    private final ConcurrentHashMap<Key, Entry> byKey = new ConcurrentHashMap<>();

    /** Exact type to its registrations, in publication order. */
    private final ConcurrentHashMap<Class<?>, CopyOnWriteArrayList<Entry>> byType =
            new ConcurrentHashMap<>();

    /**
     * Runs {@code action} with {@code pluginId} recorded as the publisher of
     * every instance the action publishes. The previous attribution is
     * restored afterwards, so nested calls attribute each publication to the
     * innermost id.
     *
     * @param pluginId id recorded for publications made inside {@code action}
     * @param action   the registration block to run
     */
    public void attributedTo(String pluginId, Runnable action) {
        Objects.requireNonNull(pluginId, "pluginId");
        Objects.requireNonNull(action, "action");
        String previous = currentPublisher.get();
        currentPublisher.set(pluginId);
        try {
            action.run();
        } finally {
            if (previous == null) {
                currentPublisher.remove();
            } else {
                currentPublisher.set(previous);
            }
        }
    }

    /**
     * Attribution of every publication, for the {@code /_jhin/health}
     * diagnostics.
     *
     * @return plugin id to the keys it published ({@code type} for the default
     *         qualifier, {@code type#qualifier} otherwise); keys of one plugin
     *         are listed in publication order within one type, types in name
     *         order
     */
    public Map<String, List<String>> publishersByPlugin() {
        List<Entry> ordered = new ArrayList<>();
        byType.keySet().stream()
                .sorted(Comparator.comparing(Class::getName))
                .forEach(type -> ordered.addAll(byType.get(type)));
        Map<String, List<String>> grouped = new LinkedHashMap<>();
        for (Entry entry : ordered) {
            grouped.computeIfAbsent(entry.publisherId(), id -> new ArrayList<>()).add(entry.describe());
        }
        Map<String, List<String>> snapshot = new LinkedHashMap<>();
        grouped.forEach((id, keys) -> snapshot.put(id, List.copyOf(keys)));
        return Collections.unmodifiableMap(snapshot);
    }

    @Override
    public <T> void publish(Class<T> type, T instance) {
        publish(type, "", instance);
    }

    @Override
    public <T> void publish(Class<T> type, String qualifier, T instance) {
        Objects.requireNonNull(type, "type");
        Objects.requireNonNull(instance, "instance");
        Key key = new Key(type, qualifier);
        String publisherId = currentPublisher.get();
        Entry entry = new Entry(type, key.qualifier(), instance,
                publisherId == null ? HOST_PUBLISHER : publisherId);
        synchronized (publishLock) {
            Entry owner = byKey.putIfAbsent(key, entry);
            if (owner != null) {
                throw new PluginException("duplicate publication of " + entry.describe()
                        + " already published by plugin " + owner.publisherId()
                        + ", attempted by plugin " + entry.publisherId());
            }
            byType.computeIfAbsent(type, ignored -> new CopyOnWriteArrayList<>()).add(entry);
        }
    }

    @Override
    public <T> Optional<T> find(Class<T> type) {
        return find(type, "");
    }

    @Override
    public <T> Optional<T> find(Class<T> type, String qualifier) {
        Objects.requireNonNull(type, "type");
        Entry entry = byKey.get(new Key(type, qualifier));
        return entry == null ? Optional.empty() : Optional.of(type.cast(entry.instance()));
    }

    @Override
    public <T> List<T> findAll(Class<T> type) {
        Objects.requireNonNull(type, "type");
        CopyOnWriteArrayList<Entry> entries = byType.get(type);
        if (entries == null) {
            return List.of();
        }
        List<T> snapshot = new ArrayList<>(entries.size());
        for (Entry entry : entries) {
            snapshot.add(type.cast(entry.instance()));
        }
        return List.copyOf(snapshot);
    }

    /** Map key: the exact type plus the qualifier, never {@code null}. */
    private record Key(Class<?> type, String qualifier) {

        private Key {
            Objects.requireNonNull(type, "type");
            qualifier = qualifier == null ? "" : qualifier;
        }
    }

    /** One published instance together with its publisher attribution. */
    private record Entry(Class<?> type, String qualifier, Object instance, String publisherId) {

        private String describe() {
            return qualifier.isEmpty() ? type.getName() : type.getName() + "#" + qualifier;
        }
    }
}
