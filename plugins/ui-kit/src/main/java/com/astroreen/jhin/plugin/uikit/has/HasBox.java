/** The Box prop group of the universal surface (docs/sdui.md section 2.1). */
package com.astroreen.jhin.plugin.uikit.has;

import java.util.Map;

/**
 * Box props: sizing, spacing, decoration and clipping. Every node accepts
 * them; the client applies them in the fixed wrapping order before the
 * primitive builder runs.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasBox<S> {

    /** The {@code width} prop: logical px or a {@code $size} token. */
    S width(Number value);

    /** The {@code height} prop: logical px or a token. On text-bearing nodes the same wire key is the line-height multiple (see {@link HasText}). */
    S height(Number value);

    /** The {@code minWidth} constraint. */
    S minWidth(Number value);

    /** The {@code maxWidth} constraint. */
    S maxWidth(Number value);

    /** The {@code minHeight} constraint. */
    S minHeight(Number value);

    /** The {@code maxHeight} constraint. */
    S maxHeight(Number value);

    /** The {@code aspectRatio} prop: width / height ratio. */
    S aspectRatio(double value);

    /** The {@code padding} prop: num, {@code [all]}, {@code [v,h]}, {@code [t,h,b]}, {@code [t,r,b,l]} or {@code {top,right,bottom,left}}; components may be tokens. */
    S padding(Object value);

    /** The {@code margin} prop: same shapes as padding. */
    S margin(Object value);

    /** The {@code color} prop: background color ({@code #RRGGBB}, {@code #AARRGGBB}, {@code 0xFFRRGGBB}) or a {@code $color} token. */
    S color(String value);

    /** The {@code gradient} prop: {@code {type, begin, end, colors, stops?}} — see the {@code Ui.gradient} / {@code UiTokens.gradient} helpers. */
    S gradient(Map<String, Object> value);

    /** The {@code border} prop: border color or token (width and style are separate props). */
    S border(String value);

    /** The {@code borderWidth} prop. */
    S borderWidth(Number value);

    /** The {@code borderStyle} prop: {@code solid} or {@code none}; validated. */
    S borderStyle(String value);

    /** The {@code borderRadius} prop as a number of logical px. */
    S borderRadius(Number value);

    /** The {@code borderRadius} prop as a {@code $radius} token reference; anything not starting with {@code $} is a builder bug and throws. */
    S borderRadius(String token);

    /** The {@code shadow} prop as {@code {color, blur, spread, offset}} — see the {@code Ui.shadow} helper. */
    S shadow(Map<String, Object> value);

    /** The {@code shadow} prop as a {@code $color} style token reference. */
    S shadow(String token);

    /** The {@code opacity} prop: 0.0–1.0. */
    S opacity(double value);

    /** The {@code clip} prop: {@code none/hardEdge/softEdge/antiAlias/antiAliasWithSaveLayer}; validated. */
    S clip(String value);

    /** The {@code transform} prop: a 16-number column-major matrix or {@code {translate, rotate, scale}}. */
    S transform(Object value);

    /** The {@code align} prop: an alignment literal ({@code topLeft} … {@code bottomRight}); validated. */
    S align(String value);
}
