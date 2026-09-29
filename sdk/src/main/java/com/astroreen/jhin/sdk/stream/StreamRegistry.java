/**
 * Plugin-facing event-stream extension point.
 *
 * <p>Compile-time placeholder so that {@link com.astroreen.jhin.sdk.PluginContext#streams()}
 * compiles against its final signature; the authoritative contract is
 * transcribed in T7. Obtained from the plugin context and called when the
 * plugin publishes or consumes session streams.
 */
package com.astroreen.jhin.sdk.stream;

public interface StreamRegistry {}
