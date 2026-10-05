package com.astroreen.jhin.plugin.uikit.has;

import com.astroreen.jhin.plugin.uikit.UiNode;

/**
 * The prop group of the level-3 {@code scroll_fade} primitive (docs/sdui.md
 * section 2.6): the wrapped scrollable, the scrolled edge the gradient
 * paints at, the fade extent and the recipe. Only {@code scroll_fade}
 * implements this group; every other builder rejects the keys through the
 * escape hatch with the standard {@code unsupported prop} error (a builder
 * bug is a build-time failure).
 *
 * <p>The {@code child} setter lands the {@code child} wire prop (the
 * wrapped node), not the {@code children} array — unlike
 * {@link HasChildren#child(UiNode)}.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasScrollFade<S> {

    /** The scrollable the fade wraps (required; the client degrades a missing child visibly). */
    S child(UiNode node);

    /** The scrolled edge: {@code top} (default), {@code bottom}, {@code start} or {@code end}. */
    S edge(String value);

    /** The fade extent in px (default 24 — the 1.5rem titlebar fade height). */
    S height(Number value);

    /** The recipe: {@code topbar} (static band, default) or {@code virtualized} (scroll-aware). */
    S mode(String value);
}
