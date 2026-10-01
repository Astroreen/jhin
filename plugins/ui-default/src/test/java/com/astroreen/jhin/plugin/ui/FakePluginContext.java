/**
 * Minimal test double of {@link PluginContext} driving the real sessions and
 * UI plugins: a SQLite-backed database, the recording stream registry, a
 * recording {@link HttpRegistry} so tests can dispatch the registered routes
 * and a recording {@link ServiceRegistry} so the session services published by
 * the sessions plugin flow into the UI plugin. Unused registries throw.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.ConfigView;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginManifest;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.http.HttpRegistry;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class FakePluginContext implements PluginContext {

    private final Path home;
    private final String pluginId;
    private final Logger log;
    private final FakeServices services;
    private final FakeHttp http = new FakeHttp();
    private final TestDbAccess db;
    private final RecordingStreamRegistry streams;
    private final List<Runnable> shutdownHooks = new ArrayList<>();

    FakePluginContext(Path home, String pluginId, TestDbAccess db,
                      RecordingStreamRegistry streams, FakeServices services) {
        this.home = home;
        this.pluginId = pluginId;
        this.log = LoggerFactory.getLogger("plugin." + pluginId);
        this.db = db;
        this.streams = streams;
        this.services = services;
    }

    @Override
    public PluginManifest manifest() {
        return new PluginManifest(pluginId, "0.2.0", ApiVersion.CURRENT, pluginId, "test",
                UiPlugin.class.getName(), List.of(), List.of());
    }

    @Override
    public Logger log() {
        return log;
    }

    @Override
    public Path dataDir() {
        return home.resolve("data").resolve(pluginId);
    }

    @Override
    public ConfigView config() {
        return new FakeConfig();
    }

    @Override
    public ServiceRegistry services() {
        return services;
    }

    @Override
    public HttpRegistry http() {
        return http;
    }

    @Override
    public com.astroreen.jhin.sdk.db.DbAccess db() {
        return db;
    }

    @Override
    public com.astroreen.jhin.sdk.stream.StreamRegistry streams() {
        return streams;
    }

    @Override
    public com.astroreen.jhin.sdk.cli.CliRegistry cli() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public KernelInfo kernel() {
        return new FakeKernel(home);
    }

    @Override
    public void onStarted(Runnable hook) {
        // recorded but never run in these tests
    }

    @Override
    public void onShutdown(Runnable hook) {
        shutdownHooks.add(hook);
    }

    /** Runs the registered shutdown hooks, reverse order. */
    void runShutdownHooks() {
        for (int i = shutdownHooks.size() - 1; i >= 0; i--) {
            shutdownHooks.get(i).run();
        }
    }

    /** The routes registered through {@link #http()}, in registration order. */
    List<RouteSpec> routes() {
        return http.routes;
    }

    /** Recording service registry: keeps every publish, resolves by type. */
    static final class FakeServices implements ServiceRegistry {

        private final Map<Class<?>, List<Object>> published = new LinkedHashMap<>();

        @Override
        public <T> void publish(Class<T> type, T instance) {
            published.computeIfAbsent(type, key -> new ArrayList<>()).add(instance);
        }

        @Override
        public <T> void publish(Class<T> type, String qualifier, T instance) {
            publish(type, instance);
        }

        @Override
        public <T> Optional<T> find(Class<T> type) {
            List<T> all = findAll(type);
            return all.isEmpty() ? Optional.empty() : Optional.of(all.get(0));
        }

        @Override
        public <T> Optional<T> find(Class<T> type, String qualifier) {
            return find(type);
        }

        @Override
        @SuppressWarnings("unchecked")
        public <T> List<T> findAll(Class<T> type) {
            List<T> all = new ArrayList<>();
            for (Object instance : published.getOrDefault(type, List.of())) {
                all.add((T) instance);
            }
            return List.copyOf(all);
        }
    }

    /** Recording HTTP registry: captures routes; filters and TLS are unused. */
    private static final class FakeHttp implements HttpRegistry {

        private final List<RouteSpec> routes = new ArrayList<>();

        @Override
        public void route(RouteSpec spec) {
            routes.add(spec);
        }

        @Override
        public void filter(com.astroreen.jhin.sdk.http.FilterSpec spec) {
            throw new UnsupportedOperationException("not under test");
        }

        @Override
        public void tls(com.astroreen.jhin.sdk.http.TlsProvider provider) {
            throw new UnsupportedOperationException("not under test");
        }
    }

    /** Configuration that resolves nothing and honours the passed defaults. */
    private static final class FakeConfig implements ConfigView {

        @Override
        public Optional<String> get(String key) {
            return Optional.empty();
        }

        @Override
        public String get(String key, String def) {
            return def;
        }

        @Override
        public int getInt(String key, int def) {
            return def;
        }

        @Override
        public long getLong(String key, long def) {
            return def;
        }

        @Override
        public boolean getBool(String key, boolean def) {
            return def;
        }

        @Override
        public Map<String, String> all() {
            return Map.of();
        }
    }

    /** Kernel facts: no plugins are reported beyond the boot under test. */
    private record FakeKernel(Path home) implements KernelInfo {

        @Override
        public String version() {
            return "0.2.0";
        }

        @Override
        public int apiVersion() {
            return ApiVersion.CURRENT;
        }

        @Override
        public Path home() {
            return home;
        }

        @Override
        public List<Loaded> plugins() {
            return List.of();
        }
    }
}
