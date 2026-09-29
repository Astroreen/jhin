/**
 * The single contract level plugins compile against.
 *
 * <p>Read by the kernel to answer {@link KernelInfo#apiVersion()} and copied by
 * plugin authors into {@link PluginManifest#apiVersion()}. A manifest whose
 * {@code apiVersion} is not {@link #CURRENT} is rejected at load time by
 * {@link PluginManifest#validate(PluginManifest)}.
 */
package com.astroreen.jhin.sdk;

public final class ApiVersion {

    /**
     * The one supported contract level, bumped on every breaking SDK change.
     * Compared against {@link PluginManifest#apiVersion()} by the kernel when a
     * plugin is loaded.
     */
    public static final int CURRENT = 1;

    private ApiVersion() {}
}
