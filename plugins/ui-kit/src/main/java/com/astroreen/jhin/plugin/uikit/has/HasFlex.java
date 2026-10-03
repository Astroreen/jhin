/** The Flex prop group of the universal surface (docs/sdui.md section 2.1). */
package com.astroreen.jhin.plugin.uikit.has;

/**
 * Flex props: how a node participates in (and how a flex container lays out)
 * its parent axis. Every node accepts them.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasFlex<S> {

    /** The {@code flex} prop: wraps the node in {@code Expanded}. */
    S flex(int value);

    /** The {@code fit} prop: {@code loose} or {@code tight}; validated. */
    S fit(String value);

    /** The {@code mainAxisSize} prop: {@code min} or {@code max}; validated. */
    S mainAxisSize(String value);

    /** The {@code mainAxisAlignment} prop: {@code start/end/center/spaceBetween/spaceAround/spaceEvenly}; validated. */
    S mainAxisAlignment(String value);

    /** The {@code crossAxisAlignment} prop: {@code start/end/center/stretch/baseline}; validated. */
    S crossAxisAlignment(String value);

    /** The {@code direction} prop: {@code row} or {@code column}; validated. */
    S direction(String value);

    /** The {@code gap} prop: manual interleave space between children. */
    S gap(Number value);

    /** The {@code spacing} prop: flex spacing, preferred over {@code gap} where both are set. */
    S spacing(Number value);

    /** The {@code scroll} prop: legacy {@code container} scrollable. */
    S scroll(boolean value);

    /** The {@code textDirection} prop: {@code ltr} or {@code rtl}; validated. */
    S textDirection(String value);

    /** The {@code verticalDirection} prop: {@code up} or {@code down}; validated. */
    S verticalDirection(String value);

    /** The {@code textBaseline} prop: {@code alphabetic} or {@code ideographic}; validated. */
    S textBaseline(String value);

    /** The {@code overflow} prop: {@code visible/clip/fade/ellipsis}; validated. */
    S overflow(String value);

    /** The {@code clipBehavior} prop: {@code none/hardEdge/softEdge/antiAlias/antiAliasWithSaveLayer}; validated. */
    S clipBehavior(String value);
}
