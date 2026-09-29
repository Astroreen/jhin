/**
 * This plugin's configuration section.
 *
 * <p>Obtained from {@link PluginContext#config()} and called by the plugin
 * whenever it reads a setting. Resolution order per key: environment variable
 * {@code JHIN_<ID_UPPER_UNDERSCORED>_<KEY_UPPER_UNDERSCORED>} → the
 * {@code "<plugin id>"} object inside {@code config.json} → the default passed
 * to the getter.
 */
package com.astroreen.jhin.sdk;

public interface ConfigView {

    /**
     * Looks up a key without a fallback. Called when the value may legitimately
     * be absent; empty when the key resolves in no source.
     */
    java.util.Optional<String> get(String key);

    /**
     * Looks up a key with a string fallback. Called for ordinary settings;
     * returns {@code def} when the key resolves in no source.
     */
    String get(String key, String def);

    /**
     * Looks up a key as an {@code int}. Called for numeric settings; returns
     * {@code def} when the key resolves in no source.
     */
    int getInt(String key, int def);

    /**
     * Looks up a key as a {@code long}. Called for large numeric settings;
     * returns {@code def} when the key resolves in no source.
     */
    long getLong(String key, long def);

    /**
     * Looks up a key as a {@code boolean}. Called for feature switches;
     * returns {@code def} when the key resolves in no source.
     */
    boolean getBool(String key, boolean def);

    /**
     * Returns every key visible to this plugin with its resolved value, after
     * applying the resolution order above. Called when the plugin needs the
     * whole effective configuration at once (dump, merge, UI).
     */
    java.util.Map<String, String> all();
}
