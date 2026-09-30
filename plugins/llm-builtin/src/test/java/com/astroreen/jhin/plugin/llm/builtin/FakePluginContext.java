/**
 * Minimal {@link com.astroreen.jhin.sdk.PluginContext} fake for entry-point
 * tests: only the service registry answers (the recorder under test), every
 * other accessor fails the test the moment the plugin touches it.
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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class FakePluginContext implements PluginContext {

    private static final Logger LOG = LoggerFactory.getLogger(FakePluginContext.class);

    private final ServiceRegistry services;

    FakePluginContext(ServiceRegistry services) {
        this.services = services;
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
        throw new UnsupportedOperationException("config is not used by LlmBuiltinPlugin");
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
}
