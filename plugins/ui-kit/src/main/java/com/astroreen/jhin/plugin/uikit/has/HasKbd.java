package com.astroreen.jhin.plugin.uikit.has;

/**
 * The prop group of the level-3 {@code kbd} primitive (docs/sdui.md section
 * 2.6): the chord string rendered as key pills. Only {@code kbd} implements
 * this group; every other builder rejects the key through the escape hatch
 * with the standard {@code unsupported prop} error (a builder bug is a
 * build-time failure).
 *
 * <p>The chord splits on {@code +}; {@code mod} resolves per platform
 * (Cmd on macOS, Ctrl elsewhere) and unknown tokens render as literal pills
 * — the client logs and never throws.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasKbd<S> {

    /** The chord to render, modifiers joined with {@code +} (required). */
    S chord(String value);
}
