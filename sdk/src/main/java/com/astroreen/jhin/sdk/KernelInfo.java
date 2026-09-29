/**
 * Read-only view of the running kernel.
 *
 * <p>Implemented by the kernel and handed to plugins via
 * {@link PluginContext#kernel()}; called by plugins during
 * {@link JhinPlugin#start(PluginContext)} or later to discover the host
 * version, {@code JHIN_HOME} and what else is loaded.
 */
package com.astroreen.jhin.sdk;

public interface KernelInfo {

    /**
     * The kernel version string. Called by plugins that gate features on the
     * host revision.
     */
    String version();

    /**
     * The contract level the kernel implements ({@link ApiVersion#CURRENT}).
     * Called at plugin start for runtime compatibility checks.
     */
    int apiVersion();

    /**
     * Root of the installation ({@code JHIN_HOME}). Called when a plugin needs
     * host-level paths outside its own data directory.
     */
    java.nio.file.Path home();

    /**
     * Summaries of the loaded plugins, in load order. Called for cross-plugin
     * discovery at any time.
     */
    java.util.List<Loaded> plugins();

    /**
     * Summary of one loaded plugin, as reported to dependants.
     *
     * @param id      manifest id ({@link PluginManifest#id()})
     * @param version manifest version ({@link PluginManifest#version()})
     * @param name    human-readable name ({@link PluginManifest#name()})
     * @param exports package names visible to dependants
     */
    record Loaded(String id, String version, String name, java.util.List<String> exports) {}
}
