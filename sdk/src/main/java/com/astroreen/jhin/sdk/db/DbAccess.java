/**
 * Plugin-facing database extension point.
 *
 * <p>Compile-time placeholder so that {@link com.astroreen.jhin.sdk.PluginContext#db()}
 * compiles against its final signature; the authoritative contract is
 * transcribed in T7. Obtained from the plugin context and called when the
 * plugin needs persistent storage.
 */
package com.astroreen.jhin.sdk.db;

public interface DbAccess {}
