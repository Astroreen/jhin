/**
 * The Interaction and A11y prop groups of the universal surface
 * (docs/sdui.md section 2.1).
 */
package com.astroreen.jhin.plugin.uikit.has;

import java.util.Map;

/**
 * Interaction props: gestures, confirmation, tooltip, cursor and the
 * semantics wiring. Every node accepts them.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasInteraction<S> {

    /** The {@code action} prop: the action object of the action protocol. */
    S action(Map<String, Object> value);

    /** The {@code onTap} prop: tap gesture action. */
    S onTap(Map<String, Object> value);

    /** The {@code onLongPress} prop: long-press gesture action. */
    S onLongPress(Map<String, Object> value);

    /** The {@code confirm} prop: confirmation prompt shown before the action dispatches. */
    S confirm(String value);

    /** The {@code tooltip} prop: hover tooltip. */
    S tooltip(String value);

    /** The {@code cursor} prop: mouse cursor literal ({@code system} … {@code zoomOut}); validated. */
    S cursor(String value);

    /** The {@code enabled} prop: disabled nodes keep layout and drop interaction. */
    S enabled(boolean value);

    /** The {@code semanticsLabel} prop. */
    S semanticsLabel(String value);

    /** The {@code semanticsHint} prop. */
    S semanticsHint(String value);

    /** The {@code semanticsValue} prop. */
    S semanticsValue(String value);

    /** The {@code focusable} prop: participates in focus traversal. */
    S focusable(boolean value);

    /** The {@code excludeSemantics} prop: exclude descendant semantics. */
    S excludeSemantics(boolean value);
}
