/**
 * Plugin-facing HTTP extension point: routes, filters, TLS.
 *
 * <p>Compile-time placeholder so that {@link com.astroreen.jhin.sdk.PluginContext#http()}
 * compiles against its final signature; the authoritative contract is
 * transcribed in T6. Obtained from the plugin context and called during
 * {@link com.astroreen.jhin.sdk.JhinPlugin#start}.
 */
package com.astroreen.jhin.sdk.http;

public interface HttpRegistry {}
