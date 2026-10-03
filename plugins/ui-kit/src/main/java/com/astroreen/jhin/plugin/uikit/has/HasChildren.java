/** Children-list surface shared by the parent builders. */
package com.astroreen.jhin.plugin.uikit.has;

import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;

/**
 * The {@code children} array of a parent node. A child may be a node or a
 * string (the text shorthand). Single-child primitives ({@code box},
 * {@code expanded}, {@code align}, …) own a {@code child} prop instead and do
 * not implement this interface.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasChildren<S> {

    /** Appends one child node to the {@code children} array. */
    S child(UiNode node);

    /** Appends one string child (the text shorthand). */
    S child(String text);

    /** Appends every entry of the list, nodes and strings alike. */
    S children(List<Object> nodes);
}
