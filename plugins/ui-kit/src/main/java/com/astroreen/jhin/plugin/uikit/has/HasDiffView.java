package com.astroreen.jhin.plugin.uikit.has;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;
import java.util.Map;

/**
 * The prop group of the level-3 {@code diff_view} primitive (docs/sdui.md
 * section 2.6): the file path, the language label, the hunks, the layout
 * view, the colour scheme and the stat header counts. Only
 * {@code diff_view} implements this group; every other builder rejects the
 * keys through the escape hatch with the standard {@code unsupported prop}
 * error (a builder bug is a build-time failure).
 *
 * <p>The primitive is decorative and always carries the universal
 * {@code demo} marker — {@link #demo(boolean)} is part of this group and
 * {@code Ui.DiffViewBuilder.build()} fails with {@code demo marker required}
 * when it was never set to {@code true}.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasDiffView<S> {

    /** The file path shown in the stat header. */
    S file(String value);

    /** The language label (a plain label, like the {@code code_block} language). */
    S language(String value);

    /** The layout: {@code unified} (default) or {@code split}. */
    S view(String value);

    /** The colour scheme: {@code default} or {@code blue-orange} (the {@code data-diff-color-scheme} mapping). */
    S colorScheme(String value);

    /** The stat header counts ({@code {additions, deletions}}), rendered green {@code +n} / red {@code -n}. */
    S stats(Number additions, Number deletions);

    /** Appends one hunk spec ({@code {header, lines}}). */
    S hunk(Map<String, Object> hunk);

    /** Appends one hunk built through {@link Ui#diffHunk(String)}. */
    S hunk(Ui.DiffHunkBuilder hunk);

    /** The universal {@code demo} marker — mandatory and {@code true} on this primitive. */
    S demo(boolean value);

    /** The hunks as a raw list (wholesale setter; the appenders extend it in place). */
    S hunks(List<Object> hunks);
}
