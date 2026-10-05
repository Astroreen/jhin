package com.astroreen.jhin.plugin.uikit.has;

import java.util.Map;

/**
 * The prop group of the level-3 {@code toast_stack} primitive (docs/sdui.md
 * section 2.6): the transient notices and the screen edge the stack grows
 * from. Only {@code toast_stack} implements this group; every other builder
 * rejects the keys through the escape hatch with the standard
 * {@code unsupported prop} error (a builder bug is a build-time failure).
 *
 * <p>Each item is {@code {text, style?, action?, duration?}} — the 5 s undo
 * pattern is an item with an inline {@code action} and the default 5000 ms
 * window. A level-2 client receives the node degraded to a {@code column} of
 * plain texts by the server's downgrade map.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasToastStack<S> {

    /** Appends one item spec ({@code {text, style?, action?, duration?}}). */
    S item(Map<String, Object> entry);

    /** Appends one text-only item. */
    S item(String text);

    /** Appends one item built through {@link com.astroreen.jhin.plugin.uikit.Ui#toastItem(String)}. */
    S item(com.astroreen.jhin.plugin.uikit.Ui.ToastItemBuilder entry);

    /** The screen edge the stack grows from: {@code top} or {@code bottom} (default {@code bottom}). */
    S direction(String value);
}
