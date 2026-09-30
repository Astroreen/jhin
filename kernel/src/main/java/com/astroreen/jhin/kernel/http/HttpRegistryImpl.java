/**
 * Kernel side of the plugin-facing HTTP extension point: routes, filters and
 * TLS material in one registry.
 *
 * <p>The SDK registration methods carry no owner parameter, so the registering
 * plugin is recorded through a thread-local set by
 * {@link #attributedTo(String, Runnable)}: the plugin lifecycle wraps every
 * registration a plugin makes in that call, and the recorded id names the
 * owner in route conflicts and behind {@link #acceptedTls()}. A registration
 * made outside every {@code attributedTo} block belongs to {@link #HOST_OWNER}.
 *
 * <p>Routes land in the {@link RouteTable} and filters in the
 * {@link FilterPipeline}; the host's own provisional routes go through
 * {@link #registerFallback(RouteSpec)} and are replaced silently once a plugin
 * claims the same {@code (method, path)}. TLS material is first-wins: the
 * first registration is kept and its owner recorded, later ones are ignored.
 */
package com.astroreen.jhin.kernel.http;

import com.astroreen.jhin.sdk.http.FilterSpec;
import com.astroreen.jhin.sdk.http.HttpRegistry;
import com.astroreen.jhin.sdk.http.RouteSpec;
import com.astroreen.jhin.sdk.http.TlsProvider;
import java.util.Objects;
import java.util.Optional;

public final class HttpRegistryImpl implements HttpRegistry {

    /** Attribution used for registrations made outside {@link #attributedTo}. */
    public static final String HOST_OWNER = "kernel";

    private final RouteTable routeTable = new RouteTable();
    private final FilterPipeline filterPipeline = new FilterPipeline();

    /** Owner id of the registration block running on this thread. */
    private final ThreadLocal<String> currentOwner = new ThreadLocal<>();

    private final Object tlsLock = new Object();
    private TlsEntry tlsEntry;

    /**
     * Runs {@code action} with {@code pluginId} recorded as the owner of every
     * registration the action makes. The previous attribution is restored
     * afterwards, so nested calls attribute each registration to the innermost
     * id.
     *
     * @param pluginId id recorded for registrations made inside {@code action}
     * @param action   the registration block to run
     */
    public void attributedTo(String pluginId, Runnable action) {
        Objects.requireNonNull(pluginId, "pluginId");
        Objects.requireNonNull(action, "action");
        String previous = currentOwner.get();
        currentOwner.set(pluginId);
        try {
            action.run();
        } finally {
            if (previous == null) {
                currentOwner.remove();
            } else {
                currentOwner.set(previous);
            }
        }
    }

    /**
     * Registers a route on behalf of the currently attributed plugin. A
     * fallback entry under the same {@code (method, path)} is replaced
     * silently; a duplicate non-fallback registration is refused.
     *
     * @param spec the route to register
     */
    @Override
    public void route(RouteSpec spec) {
        routeTable.register(spec, owner());
    }

    /**
     * Registers a filter on behalf of the currently attributed plugin.
     *
     * @param spec the filter to register
     */
    @Override
    public void filter(FilterSpec spec) {
        filterPipeline.add(spec, owner());
    }

    /**
     * Supplies TLS material for the HTTPS listener. First-wins: the first
     * registration is kept together with its owner, every later one is
     * ignored.
     *
     * @param tlsMaterial the TLS material to use
     */
    @Override
    public void tls(TlsProvider tlsMaterial) {
        Objects.requireNonNull(tlsMaterial, "tlsMaterial");
        synchronized (tlsLock) {
            if (tlsEntry == null) {
                tlsEntry = new TlsEntry(tlsMaterial, owner());
            }
        }
    }

    /**
     * Registers one of the host's provisional routes: replaced silently as
     * soon as a plugin claims the same {@code (method, path)}.
     *
     * @param spec the fallback route to register
     */
    public void registerFallback(RouteSpec spec) {
        routeTable.registerFallback(spec, HOST_OWNER);
    }

    /**
     * The route table these registrations build. Called once at startup to
     * resolve incoming requests.
     *
     * @return the route table
     */
    public RouteTable routeTable() {
        return routeTable;
    }

    /**
     * The filter pipeline these registrations build. Called once per request
     * to wrap the matched route handler.
     *
     * @return the filter pipeline
     */
    public FilterPipeline filterPipeline() {
        return filterPipeline;
    }

    /**
     * The accepted TLS material and the plugin that supplied it, read once at
     * server startup. Empty when no plugin supplied TLS, in which case the
     * listener speaks plain HTTP.
     *
     * @return the accepted TLS registration
     */
    public Optional<TlsEntry> acceptedTls() {
        synchronized (tlsLock) {
            return Optional.ofNullable(tlsEntry);
        }
    }

    private String owner() {
        String owner = currentOwner.get();
        return owner == null ? HOST_OWNER : owner;
    }

    /**
     * One accepted TLS registration.
     *
     * <p>Components: {@code source} — the TLS material to configure the
     * listener from; {@code owner} — the id of the plugin that supplied it.
     */
    public record TlsEntry(TlsProvider source, String owner) {}
}
