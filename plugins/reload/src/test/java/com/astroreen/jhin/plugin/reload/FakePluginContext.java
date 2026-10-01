/**
 * Test double of {@link com.astroreen.jhin.sdk.PluginContext} driving the real
 * {@link ReloadPlugin}: records the registered routes and on-started hooks so
 * tests can invoke the handler and fire the startup guard. Unused registries
 * throw.
 */
package com.astroreen.jhin.plugin.reload;

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
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class FakePluginContext implements PluginContext {

    private final Logger log = LoggerFactory.getLogger("jhin.reload");
    private final List<RouteSpec> routes = new ArrayList<>();
    private final List<Runnable> startedHooks = new ArrayList<>();

    @Override
    public PluginManifest manifest() {
        return new PluginManifest("jhin.reload", "0.2.0", ApiVersion.CURRENT, "Reload", "test",
                ReloadPlugin.class.getName(), List.of(), List.of());
    }

    @Override
    public Logger log() {
        return log;
    }

    @Override
    public Path dataDir() {
        return Path.of("build").resolve("tmp").resolve("jhin.reload");
    }

    @Override
    public ConfigView config() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public ServiceRegistry services() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public HttpRegistry http() {
        return new HttpRegistry() {
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
        };
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

    @Override
    public KernelInfo kernel() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public void onStarted(Runnable hook) {
        startedHooks.add(hook);
    }

    @Override
    public void onShutdown(Runnable hook) {
        throw new UnsupportedOperationException("not under test");
    }

    /** The routes registered so far, in registration order. */
    List<RouteSpec> routes() {
        return List.copyOf(routes);
    }

    /** Runs the collected on-started hooks, as the kernel does after boot. */
    void fireStarted() {
        for (Runnable hook : List.copyOf(startedHooks)) {
            hook.run();
        }
    }
}
