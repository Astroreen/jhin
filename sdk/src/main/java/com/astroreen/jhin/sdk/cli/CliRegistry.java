/**
 * Plugin-facing CLI extension point.
 *
 * <p>Compile-time placeholder so that {@link com.astroreen.jhin.sdk.PluginContext#cli()}
 * compiles against its final signature; the authoritative contract is
 * transcribed in T7. Obtained from the plugin context and called when the
 * plugin adds host commands.
 */
package com.astroreen.jhin.sdk.cli;

public interface CliRegistry {}
