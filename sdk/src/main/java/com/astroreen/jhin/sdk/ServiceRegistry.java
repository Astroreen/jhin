/**
 * Cross-plugin service exchange.
 *
 * <p>Obtained from {@link PluginContext#services()}. A plugin calls
 * {@code publish} to expose an instance; any plugin calls {@code find} or
 * {@code findAll} to consume published instances.
 *
 * <p>Rules the implementations must follow:
 * <ul>
 *   <li>{@code publish} of a duplicate {@code (type, qualifier)} pair throws
 *       {@link PluginException}.</li>
 *   <li>{@code find*} is resolved by the <em>exact</em> {@link Class} object,
 *       so the type must come from an exported package of a common ancestor
 *       loader.</li>
 *   <li>Lookups are always live — a plugin loaded later is visible to
 *       {@link #findAll(Class)} called at request time.</li>
 * </ul>
 */
package com.astroreen.jhin.sdk;

public interface ServiceRegistry {

    /**
     * Publishes an instance under its own type with the default (empty)
     * qualifier. Called by a plugin during
     * {@link JhinPlugin#start(PluginContext)} to expose a service.
     *
     * @throws PluginException if this {@code (type, qualifier)} pair is already
     *         published by anyone
     */
    <T> void publish(Class<T> type, T instance);

    /**
     * Publishes an instance under its own type and a named qualifier. Called
     * when several implementations of one type must coexist.
     *
     * @throws PluginException if this {@code (type, qualifier)} pair is already
     *         published by anyone
     */
    <T> void publish(Class<T> type, String qualifier, T instance);

    /**
     * Looks up an instance published under exactly this type and the default
     * qualifier. Called by consumers; empty when nobody published it (yet) —
     * the lookup is live, so a later publish becomes visible.
     */
    <T> java.util.Optional<T> find(Class<T> type);

    /**
     * Looks up an instance published under exactly this type and the given
     * qualifier. Called by consumers of named services; empty when nobody
     * published it (yet).
     */
    <T> java.util.Optional<T> find(Class<T> type, String qualifier);

    /**
     * Live view: returns everything published so far, in publish order.
     *
     * <p>Called at request time when every implementation matters (fan-out,
     * interceptor chains); instances published later appear in subsequent calls.
     */
    <T> java.util.List<T> findAll(Class<T> type);
}
