/**
 * Catalog of one plugin load pass: the plugins that started and the plugins
 * that were rejected, every rejection with its reason.
 *
 * <p>Built by {@link PluginLifecycle} while it starts plugins and read by the
 * kernel's {@code /_jhin/health} answer through the
 * {@link KernelRoutes.PluginCatalog} seam. The payload entries follow the
 * health contract — {@code {"id","version","name"}} for the loaded ones and
 * {@code {"id","reason"}} for the rejected ones — while the typed accessors
 * additionally carry the declared exports ({@link KernelInfo.Loaded}) and the
 * failures as records. Loaded entries stay in load order; failures come back * sorted by plugin id, so a fixed load pass always yields the same answer.
 */
package com.astroreen.jhin.kernel.loader;

import com.astroreen.jhin.kernel.KernelRoutes;
import com.astroreen.jhin.sdk.KernelInfo;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class PluginRegistry implements KernelRoutes.PluginCatalog {

    /**
     * One plugin that cannot be loaded or started.
     *
     * @param id     the plugin id
     * @param reason why the plugin was rejected
     */
    public record Failure(String id, String reason) {}

    /** Started plugins in load order. */
    private final List<KernelInfo.Loaded> loaded = new ArrayList<>();

    /** Rejected plugins in the order they were rejected. */
    private final List<Failure> rejected = new ArrayList<>();

    /**
     * Records one started plugin. Called by {@link PluginLifecycle} after a
     * successful {@code start}.
     *
     * @param entry the loaded plugin summary
     */
    void addLoaded(KernelInfo.Loaded entry) {
        Objects.requireNonNull(entry, "entry");
        synchronized (loaded) {
            loaded.add(entry);
        }
    }

    /**
     * Records one rejected plugin. Called by {@link PluginLifecycle} for
     * graph failures, start failures and cascade failures alike.
     *
     * @param id     the plugin id
     * @param reason why the plugin was rejected
     */
    void addFailed(String id, String reason) {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(reason, "reason");
        synchronized (rejected) {
            rejected.add(new Failure(id, reason));
        }
    }

    /**
     * The started plugins, in load order.
     *
     * @return one summary per started plugin
     */
    public List<KernelInfo.Loaded> loadedPlugins() {
        synchronized (loaded) {
            return List.copyOf(loaded);
        }
    }

    /**
     * The rejected plugins, sorted by plugin id.
     *
     * @return one failure per rejected plugin
     */
    public List<Failure> failures() {
        synchronized (rejected) {
            return rejected.stream()
                    .sorted(Comparator.comparing(Failure::id))
                    .toList();
        }
    }

    /**
     * The health payload of the started plugins, in load order.
     *
     * @return {@code {"id","version","name"}} per started plugin
     */
    @Override
    public List<Map<String, Object>> loaded() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (KernelInfo.Loaded entry : loadedPlugins()) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("id", entry.id());
            payload.put("version", entry.version());
            payload.put("name", entry.name());
            out.add(Collections.unmodifiableMap(payload));
        }
        return List.copyOf(out);
    }

    /**
     * The health payload of the rejected plugins, sorted by plugin id.
     *
     * @return {@code {"id","reason"}} per rejected plugin
     */
    @Override
    public List<Map<String, Object>> failed() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Failure failure : failures()) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("id", failure.id());
            payload.put("reason", failure.reason());
            out.add(Collections.unmodifiableMap(payload));
        }
        return List.copyOf(out);
    }
}
