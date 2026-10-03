/**
 * The prop sink every builder implements: the escape hatch and the live props
 * view (plan section 5).
 */
package com.astroreen.jhin.plugin.uikit;

import java.util.Map;

/**
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface PropSink<S> {

    /**
     * Escape hatch: stores any value under any key, bypassing the typed
     * setters. Documented as unstable — the conformance test cannot know the
     * keys used here, so prefer a typed setter whenever one exists.
     *
     * @param key   the wire key
     * @param value the wire value
     * @return the builder
     */
    S set(String key, Object value);

    /**
     * The live props view, in insertion order. For tests and for callers that
     * need to inspect what the setters collected so far.
     *
     * @return the mutable props map of the builder
     */
    Map<String, Object> props();
}
