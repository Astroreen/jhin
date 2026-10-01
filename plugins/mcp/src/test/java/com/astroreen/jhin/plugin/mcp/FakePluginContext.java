package com.astroreen.jhin.plugin.mcp;

import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.ConfigView;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginManifest;
import com.astroreen.jhin.sdk.ServiceRegistry;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;

/**
 * Minimal test double of {@link PluginContext} driving the real
 * {@link McpPlugin}: a temp {@code JHIN_HOME} for {@code mcp.json}, the test
 * logger for log capture and a recording {@link ServiceRegistry} so tests can
 * assert what the plugin published. Unused registries throw.
 */
final class FakePluginContext implements PluginContext {

    private final Path home;
    private final Logger log;
    private final FakeServices services = new FakeServices();

    FakePluginContext(Path home, Logger log) {
        this.home = home;
        this.log = log;
    }

    @Override
    public PluginManifest manifest() {
        return new PluginManifest("jhin.mcp", "0.2.0", ApiVersion.CURRENT, "MCP", "test",
                McpPlugin.class.getName(), List.of(), List.of());
    }

    @Override
    public Logger log() {
        return log;
    }

    @Override
    public Path dataDir() {
        return home.resolve("data").resolve("jhin.mcp");
    }

    @Override
    public ConfigView config() {
        return new EmptyConfigView();
    }

    @Override
    public ServiceRegistry services() {
        return services;
    }

    @Override
    public KernelInfo kernel() {
        return new FakeKernelInfo(home);
    }

    @Override
    public void onStarted(Runnable hook) {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public void onShutdown(Runnable hook) {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public com.astroreen.jhin.sdk.http.HttpRegistry http() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public com.astroreen.jhin.sdk.db.DbAccess db() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public com.astroreen.jhin.sdk.stream.StreamRegistry streams() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public com.astroreen.jhin.sdk.cli.CliRegistry cli() {
        throw new UnsupportedOperationException("not under test");
    }

    /**
     * The first instance published under the given type, or {@code null}.
     *
     * @param type the service type
     * @return the published instance
     */
    <T> T published(Class<T> type) {
        List<T> all = services.findAll(type);
        return all.isEmpty() ? null : all.get(0);
    }

    /** Recording registry: keeps every publish in order. */
    private static final class FakeServices implements ServiceRegistry {

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
            List<Object> all = published.getOrDefault(type, List.of());
            return (List<T>) all;
        }
    }

    /** Config view resolving nothing: the plugin falls back to its defaults. */
    private static final class EmptyConfigView implements ConfigView {

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

    /** Kernel info exposing the temp home and nothing else under test. */
    private record FakeKernelInfo(Path home) implements KernelInfo {

        @Override
        public String version() {
            return "0.2.0-test";
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
