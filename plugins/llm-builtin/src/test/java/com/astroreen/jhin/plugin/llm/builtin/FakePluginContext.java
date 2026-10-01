/**
 * Minimal {@link com.astroreen.jhin.sdk.PluginContext} fake for entry-point
 * tests: the service registry (the recorder under test) and the configuration
 * section answer, every other accessor fails the test the moment the plugin
 * touches it.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import com.astroreen.jhin.sdk.ConfigView;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginManifest;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.cli.CliRegistry;
import com.astroreen.jhin.sdk.db.DbAccess;
import com.astroreen.jhin.sdk.http.HttpRegistry;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class FakePluginContext implements PluginContext {

    private static final Logger LOG = LoggerFactory.getLogger(FakePluginContext.class);

    private final ServiceRegistry services;
    private final Map<String, String> configValues;

    FakePluginContext(ServiceRegistry services) {
        this(services, Map.of());
    }

    FakePluginContext(ServiceRegistry services, Map<String, String> configValues) {
        this.services = services;
        this.configValues = Map.copyOf(configValues);
    }

    @Override
    public PluginManifest manifest() {
        return new PluginManifest("jhin.llm-builtin", "0.2.0", 1, "LLM Built-in",
                "test fake", "com.astroreen.jhin.plugin.llm.builtin.LlmBuiltinPlugin",
                List.of(), List.of());
    }

    @Override
    public Logger log() {
        return LOG;
    }

    @Override
    public Path dataDir() {
        throw new UnsupportedOperationException("dataDir is not used by LlmBuiltinPlugin");
    }

    @Override
    public ConfigView config() {
        return new FakeConfig(configValues);
    }

    @Override
    public ServiceRegistry services() {
        return services;
    }

    @Override
    public HttpRegistry http() {
        throw new UnsupportedOperationException("http is not used by LlmBuiltinPlugin");
    }

    @Override
    public DbAccess db() {
        throw new UnsupportedOperationException("db is not used by LlmBuiltinPlugin");
    }

    @Override
    public StreamRegistry streams() {
        throw new UnsupportedOperationException("streams is not used by LlmBuiltinPlugin");
    }

    @Override
    public CliRegistry cli() {
        throw new UnsupportedOperationException("cli is not used by LlmBuiltinPlugin");
    }

    @Override
    public KernelInfo kernel() {
        throw new UnsupportedOperationException("kernel is not used by LlmBuiltinPlugin");
    }

    @Override
    public void onStarted(Runnable hook) {
        throw new UnsupportedOperationException("onStarted is not used by LlmBuiltinPlugin");
    }

    @Override
    public void onShutdown(Runnable hook) {
        throw new UnsupportedOperationException("onShutdown is not used by LlmBuiltinPlugin");
    }

    /** Configuration resolving the supplied values and honouring defaults. */
    private record FakeConfig(Map<String, String> values) implements ConfigView {

        @Override
        public Optional<String> get(String key) {
            return Optional.ofNullable(values.get(key));
        }

        @Override
        public String get(String key, String def) {
            return values.getOrDefault(key, def);
        }

        @Override
        public int getInt(String key, int def) {
            String value = values.get(key);
            return (value == null) ? def : Integer.parseInt(value);
        }

        @Override
        public long getLong(String key, long def) {
            String value = values.get(key);
            return (value == null) ? def : Long.parseLong(value);
        }

        @Override
        public boolean getBool(String key, boolean def) {
            String value = values.get(key);
            return (value == null) ? def : Boolean.parseBoolean(value);
        }

        @Override
        public Map<String, String> all() {
            return values;
        }
    }
}
