/** The Glass prop group of the level-3 universal surface (docs/sdui.md section 2.1). */
package com.astroreen.jhin.plugin.uikit.has;

/**
 * Glass props (contract level 3): the glass treatment of a node's surface —
 * the backdrop blur at the token blur radius, the tinted fill at the token
 * opacity and the token saturation ({@code tokens.glass}). Only the five
 * glass-capable surfaces implement this group — {@code card}, {@code sheet},
 * {@code dialog}, {@code menu} and {@code banner}; every other builder
 * rejects the keys through the escape hatch with the standard
 * {@code unsupported prop} error (a builder bug is a build-time failure).
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasGlass<S> {

    /**
     * The {@code glass} prop: render the node's surface with the glass
     * treatment. Without backdrop support (or below level 3, where the prop
     * is stripped) the surface degrades to a solid fill at the tint colour.
     */
    S glass(boolean value);

    /**
     * The {@code glassTint} prop: the tint colour of the glass fill (the
     * upstream {@code --alert-glass-tint}) — a {@code $color.*} token
     * reference or a hex literal, painted as a 4% wash over the glass fill.
     */
    S glassTint(String value);
}
