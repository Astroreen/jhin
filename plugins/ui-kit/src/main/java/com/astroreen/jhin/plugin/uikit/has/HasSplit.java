/** The Split prop group of the level-3 {@code split} primitive (docs/sdui.md section 2.6). */
package com.astroreen.jhin.plugin.uikit.has;

import com.astroreen.jhin.plugin.uikit.UiNode;

/**
 * The resizable two-pane props of the level-3 {@code split} primitive
 * (docs/sdui.md section 2.6): the two pane slots, the axis, the divider
 * metrics ({@code initial}/{@code min}/{@code max}/{@code minSecond}), the
 * client store key the divider position persists under and the drag-handle
 * look. Only {@code split} implements this group; every other builder
 * rejects the keys through the escape hatch with the standard
 * {@code unsupported prop} error (a builder bug is a build-time failure).
 *
 * <p>The client defaults come from the layout token family: {@code initial}
 * falls back to {@code layout.sidebarWidth} (256), {@code min} to
 * {@code layout.sidebarMinWidth} (208) and {@code minSecond} to
 * {@code layout.mainMinWidth} (640) — the upstream thread sidebar metrics.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasSplit<S> {

    /** The leading pane (required on the wire; the client degrades a missing pane visibly). */
    S first(UiNode node);

    /** The trailing pane (required on the wire; the client degrades a missing pane visibly). */
    S second(UiNode node);

    /** The pane direction: {@code horizontal} or {@code vertical} (default {@code horizontal}). */
    S axis(String value);

    /** The initial divider position in px from the leading edge. */
    S initial(Number value);

    /** The minimum first-pane extent in px. */
    S min(Number value);

    /** The maximum first-pane extent in px. */
    S max(Number value);

    /** The minimum second-pane extent in px (the 640 main-content minimum upstream). */
    S minSecond(Number value);

    /** The client store key the divider position persists under (written at drag end). */
    S persistKey(String value);

    /** The drag-handle look: {@code rail}, {@code grip} or {@code invisible} (default {@code rail}). */
    S handleStyle(String value);
}
