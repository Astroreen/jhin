/** Items-list surface shared by the builders whose primitive takes {@code items}. */
package com.astroreen.jhin.plugin.uikit.has;

import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.Map;

/**
 * The {@code items} prop of the item-taking primitives ({@code list},
 * {@code nav}, {@code dropdown}, …). Entries append to the prop's array;
 * structured entries are plain maps shaped per the item tables of
 * docs/sdui.md section 2.6.
 *
 * @param <S> the builder self type, so chains keep their concrete type
 */
public interface HasItems<S> {

    /** Appends one item node. */
    S item(UiNode node);

    /** Appends one string item (the text shorthand). */
    S item(String text);

    /** Appends one structured item entry (nav, dropdown, menu, tabs, tree shapes). */
    S item(Map<String, Object> entry);
}
