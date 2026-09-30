/**
 * Kernel implementation of the plugin-facing context: one instance per
 * plugin, handing out the plugin's own identity and configuration plus
 * owner-tagged views of the shared extension registries.
 *
 * <p>Every registration a plugin makes through this context is tagged with the
 * plugin id: the HTTP and service views run the call inside the shared
 * registry's {@code attributedTo} block, so route conflicts and refused
 * duplicate publications name the plugin, and the CLI view records the owner
 * in the shared command book. The stream view delegates to the shared stream
 * registry, whose contract carries no owner. Hooks registered through
 * {@link #onStarted(Runnable)} and {@link #onShutdown(Runnable)} are collected
 * here for {@link PluginLifecycle} to run at the right moments.
 */
package com.astroreen.jhin.kernel.loader;

import com.astroreen.jhin.kernel.http.HttpRegistryImpl;
import com.astroreen.jhin.kernel.services.ServiceRegistryImpl;
import com.astroreen.jhin.kernel.stream.StreamRegistryImpl;
import com.astroreen.jhin.sdk.ConfigView;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginManifest;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;
import com.astroreen.jhin.sdk.cli.CliRegistry;
import com.astroreen.jhin.sdk.db.DbAccess;
import com.astroreen.jhin.sdk.http.FilterSpec;
import com.astroreen.jhin.sdk.http.HttpRegistry;
import com.astroreen.jhin.sdk.http.RouteSpec;
import com.astroreen.jhin.sdk.http.TlsProvider;
import com.astroreen.jhin.sdk.stream.SsePreamble;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import com.astroreen.jhin.sdk.stream.Subscription;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Consumer;
import org.slf4j.Logger;

/**
 * The context handed to one plugin for its whole lifetime. See the package
 * statement for the attribution rules.
 */
public final class PluginContextImpl implements PluginContext {

    private final PluginManifest manifest;
    private final Logger log;
    private final Path dataDir;
    private final ConfigView config;
    private final DbAccess db;
    private final ServiceRegistry services;
    private final HttpRegistry http;
    private final StreamRegistry streams;
    private final CliRegistry cli;
    private final KernelInfo kernel;
    private final List<Runnable> startedHooks = new ArrayList<>();
    private final List<Runnable> shutdownHooks = new ArrayList<>();

    /**
     * Builds the context of one plugin from the shared kernel pieces. Called
     * once per plugin by {@link PluginLifecycle} right before {@code start}.
     *
     * @param manifest      the plugin's own manifest
     * @param log           the per-plugin logger ({@code plugin.<id>})
     * @param dataDir       the per-plugin data directory
     * @param config        the per-plugin config section
     * @param serviceRegistry the shared service registry
     * @param httpRegistry  the shared HTTP registry
     * @param db            database access bound to the plugin's table prefix
     * @param streamRegistry the shared stream registry
     * @param commandBook   the shared CLI command book
     * @param kernel        the kernel facts handed to the plugin
     */
    PluginContextImpl(PluginManifest manifest, Logger log, Path dataDir, ConfigView config,
            ServiceRegistryImpl serviceRegistry, HttpRegistryImpl httpRegistry, DbAccess db,
            StreamRegistryImpl streamRegistry, PluginLifecycle.CommandBook commandBook,
            KernelInfo kernel) {
        this.manifest = Objects.requireNonNull(manifest, "manifest");
        this.log = Objects.requireNonNull(log, "log");
        this.dataDir = Objects.requireNonNull(dataDir, "dataDir");
        this.config = Objects.requireNonNull(config, "config");
        this.db = Objects.requireNonNull(db, "db");
        this.services = new ServicesFacade(serviceRegistry);
        this.http = new HttpFacade(httpRegistry);
        this.streams = new StreamsFacade(streamRegistry);
        this.cli = new CliFacade(commandBook);
        this.kernel = Objects.requireNonNull(kernel, "kernel");
    }

    @Override
    public PluginManifest manifest() {
        return manifest;
    }

    @Override
    public Logger log() {
        return log;
    }

    @Override
    public Path dataDir() {
        return dataDir;
    }

    @Override
    public ConfigView config() {
        return config;
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
    public DbAccess db() {
        return db;
    }

    @Override
    public StreamRegistry streams() {
        return streams;
    }

    @Override
    public CliRegistry cli() {
        return cli;
    }

    @Override
    public KernelInfo kernel() {
        return kernel;
    }

    @Override
    public void onStarted(Runnable hook) {
        startedHooks.add(Objects.requireNonNull(hook, "hook"));
    }

    @Override
    public void onShutdown(Runnable hook) {
        shutdownHooks.add(Objects.requireNonNull(hook, "hook"));
    }

    /**
     * The hooks registered through {@link #onStarted(Runnable)}, in
     * registration order. Called by {@link PluginLifecycle} after a successful
     * start.
     *
     * @return the collected hooks
     */
    List<Runnable> startedHooks() {
        return List.copyOf(startedHooks);
    }

    /**
     * The hooks registered through {@link #onShutdown(Runnable)}, in
     * registration order. Called by {@link PluginLifecycle} after a successful
     * start.
     *
     * @return the collected hooks
     */
    List<Runnable> shutdownHooks() {
        return List.copyOf(shutdownHooks);
    }

    /** Service view tagging every publication with this plugin. */
    private final class ServicesFacade implements ServiceRegistry {

        private final ServiceRegistryImpl delegate;

        private ServicesFacade(ServiceRegistryImpl delegate) {
            this.delegate = Objects.requireNonNull(delegate, "delegate");
        }

        @Override
        public <T> void publish(Class<T> type, T instance) {
            delegate.attributedTo(manifest.id(), () -> delegate.publish(type, instance));
        }

        @Override
        public <T> void publish(Class<T> type, String qualifier, T instance) {
            delegate.attributedTo(manifest.id(), () -> delegate.publish(type, qualifier, instance));
        }

        @Override
        public <T> Optional<T> find(Class<T> type) {
            return delegate.find(type);
        }

        @Override
        public <T> Optional<T> find(Class<T> type, String qualifier) {
            return delegate.find(type, qualifier);
        }

        @Override
        public <T> List<T> findAll(Class<T> type) {
            return delegate.findAll(type);
        }
    }

    /** HTTP view tagging every registration with this plugin. */
    private final class HttpFacade implements HttpRegistry {

        private final HttpRegistryImpl delegate;

        private HttpFacade(HttpRegistryImpl delegate) {
            this.delegate = Objects.requireNonNull(delegate, "delegate");
        }

        @Override
        public void route(RouteSpec spec) {
            delegate.attributedTo(manifest.id(), () -> delegate.route(spec));
        }

        @Override
        public void filter(FilterSpec spec) {
            delegate.attributedTo(manifest.id(), () -> delegate.filter(spec));
        }

        @Override
        public void tls(TlsProvider tlsMaterial) {
            delegate.attributedTo(manifest.id(), () -> delegate.tls(tlsMaterial));
        }
    }

    /** Stream view: the shared registry, its contract carries no owner. */
    private final class StreamsFacade implements StreamRegistry {

        private final StreamRegistryImpl delegate;

        private StreamsFacade(StreamRegistryImpl delegate) {
            this.delegate = Objects.requireNonNull(delegate, "delegate");
        }

        @Override
        public void publish(String topic, StreamEvent event) {
            delegate.publish(topic, event);
        }

        @Override
        public com.astroreen.jhin.sdk.http.HttpResponse sse(String topic, SsePreamble preamble) {
            return delegate.sse(topic, preamble);
        }

        @Override
        public Subscription subscribe(String topic, Consumer<StreamEvent> sink) {
            return delegate.subscribe(topic, sink);
        }
    }

    /** CLI view tagging every command with this plugin. */
    private final class CliFacade implements CliRegistry {

        private final PluginLifecycle.CommandBook delegate;

        private CliFacade(PluginLifecycle.CommandBook delegate) {
            this.delegate = Objects.requireNonNull(delegate, "delegate");
        }

        @Override
        public void command(CliCommandSpec spec) {
            delegate.attributedTo(manifest.id(), () -> delegate.command(spec));
        }
    }
}
