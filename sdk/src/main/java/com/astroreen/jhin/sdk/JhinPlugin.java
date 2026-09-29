/**
 * The entry point every Jhin plugin implements.
 *
 * <p>The kernel instantiates the class named by {@link PluginManifest#mainClass()}
 * (which must implement this interface) through the plugin's class loader and
 * drives its lifecycle.
 */
package com.astroreen.jhin.sdk;

public interface JhinPlugin {

    /**
     * Called once, before the HTTP server starts. Register everything here.
     *
     * <p>Invoked by the kernel right after the manifest is validated and the
     * main class is instantiated; nothing may be registered after the server is
     * listening.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     * @throws Exception when the plugin fails to initialize; the kernel then
     *         treats the plugin as failed to load
     */
    void start(PluginContext ctx) throws Exception;

    /**
     * Called on graceful shutdown, reverse load order. Best effort.
     *
     * <p>Invoked by the kernel while stopping the host; errors are logged and
     * do not stop the remaining plugins from stopping.
     */
    default void stop() {}
}
