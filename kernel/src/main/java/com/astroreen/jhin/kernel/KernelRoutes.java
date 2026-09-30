/**
 * The two HTTP fallbacks the kernel owns.
 *
 * <p>Registered as fallbacks before anything else loads: a plugin route on the
 * same {@code (method, path)} replaces them silently, so the answers below are
 * what a fresh installation without a user-interface plugin serves. The health
 * answer reports the kernel identity and the plugin catalog and is what the
 * client's add-server probe hits first; the bootstrap answer tells the client
 * that no user-interface plugin is installed.
 */
package com.astroreen.jhin.kernel;

import com.astroreen.jhin.kernel.http.HttpRegistryImpl;
import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class KernelRoutes {

    /** Path of the health fallback. */
    public static final String HEALTH_PATH = "/_jhin/health";

    /** Path of the bootstrap fallback. */
    public static final String BOOTSTRAP_PATH = "/_jhin/bootstrap";

    /** Kernel identity shown by both answers until the boot sequence owns it. */
    private static final String KERNEL_VERSION = "0.2.0";

    /**
     * The plugin catalog shown by the two answers. The entries follow the
     * health payload of the plan: {@code {"id","version","name"}} for
     * {@link #loaded()} and {@code {"id","reason"}} for {@link #failed()}.
     * Wired to the lifecycle registry once that registry exists; the empty
     * catalog is the honest answer until then.
     */
    public interface PluginCatalog {

        /**
         * The plugins that started, in load order.
         *
         * @return one payload entry per loaded plugin
         */
        List<Map<String, Object>> loaded();

        /**
         * The plugins that failed to load or start, with their reasons.
         *
         * @return one payload entry per failed plugin
         */
        List<Map<String, Object>> failed();
    }

    /** The empty catalog used while no lifecycle registry exists. */
    private static final PluginCatalog EMPTY_CATALOG = new PluginCatalog() {

        @Override
        public List<Map<String, Object>> loaded() {
            return List.of();
        }

        @Override
        public List<Map<String, Object>> failed() {
            return List.of();
        }
    };

    /** Not instantiable; all access is static. */
    private KernelRoutes() {
    }

    /**
     * Installs both fallbacks with the empty plugin catalog. Called at boot
     * while plugin loading does not exist yet.
     *
     * @param registry the registry to install the fallbacks into
     */
    public static void install(HttpRegistryImpl registry) {
        install(registry, EMPTY_CATALOG);
    }

    /**
     * Installs both fallbacks. Called at boot before any plugin route can
     * claim the two paths.
     *
     * @param registry the registry to install the fallbacks into
     * @param catalog  the plugin catalog to report in the answers
     */
    public static void install(HttpRegistryImpl registry, PluginCatalog catalog) {
        Objects.requireNonNull(registry, "registry");
        Objects.requireNonNull(catalog, "catalog");
        registry.registerFallback(new RouteSpec("GET", HEALTH_PATH, request -> health(catalog)));
        registry.registerFallback(new RouteSpec("GET", BOOTSTRAP_PATH, request -> bootstrap(catalog)));
    }

    /** The health answer: kernel identity plus the plugin catalog. */
    private static HttpResponse health(PluginCatalog catalog) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("status", "ok");
        payload.put("kernel", KERNEL_VERSION);
        payload.put("api", ApiVersion.CURRENT);
        payload.put("plugins", catalog.loaded());
        payload.put("failed", catalog.failed());
        return HttpResponse.json(200, payload);
    }

    /** The bootstrap answer of a kernel without a user-interface plugin. */
    private static HttpResponse bootstrap(PluginCatalog catalog) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("api", ApiVersion.CURRENT);
        payload.put("empty", true);
        payload.put("kernel", KERNEL_VERSION);
        payload.put("plugins", catalog.loaded());
        payload.put("message", "This server has no UI plugin installed.");
        return HttpResponse.json(200, payload);
    }
}
