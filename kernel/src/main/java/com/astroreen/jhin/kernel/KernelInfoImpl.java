/**
 * The kernel facts handed to plugins: identity, home and the live list of
 * plugins that started in the current load pass.
 *
 * <p>Built once per load pass by the boot sequence and by the default factory
 * of {@link com.astroreen.jhin.kernel.loader.PluginLifecycle}. The plugin list
 * is read live from the registry of that pass, so it grows while plugins come
 * up and is complete afterwards.
 */
package com.astroreen.jhin.kernel;

import com.astroreen.jhin.kernel.loader.PluginRegistry;
import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.KernelInfo;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;

public final class KernelInfoImpl implements KernelInfo {

    /** The kernel version reported to plugins and in the health answer. */
    public static final String VERSION = "0.2.0";

    private final Path home;
    private final PluginRegistry registry;

    /**
     * Creates the facts of the running kernel.
     *
     * @param home     the installation root ({@code JHIN_HOME})
     * @param registry the catalog of the current load pass
     */
    public KernelInfoImpl(Path home, PluginRegistry registry) {
        this.home = Objects.requireNonNull(home, "home");
        this.registry = Objects.requireNonNull(registry, "registry");
    }

    @Override
    public String version() {
        return VERSION;
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
        return registry.loadedPlugins();
    }
}
