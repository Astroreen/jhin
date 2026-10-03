/** The Text prop group of the universal surface (docs/sdui.md section 2.1). */
package com.astroreen.jhin.plugin.uikit.has;

/**
 * Text-style props, applied by the client when the built widget is
 * text-bearing and ignored elsewhere. The legacy level-1 text props
 * ({@code style}, {@code bold}, {@code italic}, {@code color}) stay on the
 * text-bearing builders that own them.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasText<S> {

    /** The {@code fontFamily} prop. */
    S fontFamily(String value);

    /** The {@code fontSize} prop. */
    S fontSize(Number value);

    /** The {@code fontWeight} prop: 100–900. */
    S fontWeight(int value);

    /** The {@code fontStyle} prop: {@code normal} or {@code italic}; validated. */
    S fontStyle(String value);

    /** The {@code letterSpacing} prop. */
    S letterSpacing(Number value);

    /** The {@code wordSpacing} prop. */
    S wordSpacing(Number value);

    /** The {@code height} prop: line-height multiple. On non-text nodes the same wire key is the box height (see {@link HasBox}). */
    S height(Number value);

    /** The {@code textAlign} prop: {@code left/right/center/justify/start/end}; validated. */
    S textAlign(String value);

    /** The {@code textDecoration} prop: {@code none/underline/overline/lineThrough}; validated. */
    S textDecoration(String value);

    /** The {@code textOverflow} prop: {@code clip/fade/ellipsis/visible}; validated. */
    S textOverflow(String value);

    /** The {@code maxLines} prop. */
    S maxLines(int value);

    /** The {@code softWrap} prop. */
    S softWrap(boolean value);

    /** The {@code ellipsis} prop: shorthand for {@code textOverflow: ellipsis}. */
    S ellipsis(boolean value);
}
