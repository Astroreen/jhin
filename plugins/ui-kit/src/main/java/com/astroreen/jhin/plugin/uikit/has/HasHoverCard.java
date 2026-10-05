package com.astroreen.jhin.plugin.uikit.has;

import com.astroreen.jhin.plugin.uikit.UiNode;

/**
 * The prop group of the level-3 {@code hover_card} primitive (docs/sdui.md
 * section 2.6): the trigger and content slots, the hover delay and the card
 * placement. Only {@code hover_card} implements this group; every other
 * builder rejects the keys through the escape hatch with the standard
 * {@code unsupported prop} error (a builder bug is a build-time failure).
 *
 * <p>The client opens the card after {@code delay} ms of hover (tap-and-hold
 * on touch) and degrades a missing content to the bare trigger — the
 * universal {@code tooltip} prop then still shows.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasHoverCard<S> {

    /** The node that opens the card on hover (required). */
    S trigger(UiNode node);

    /** The trigger as a string (the text shorthand). */
    S trigger(String text);

    /** The card content (required; a missing content degrades to the trigger). */
    S content(UiNode node);

    /** The content as a string (the text shorthand). */
    S content(String text);

    /** The hover delay in ms before the card opens (default 500). */
    S delay(Number value);

    /** The card placement: {@code top}, {@code bottom}, {@code left} or {@code right} (default {@code top}). */
    S placement(String value);
}
