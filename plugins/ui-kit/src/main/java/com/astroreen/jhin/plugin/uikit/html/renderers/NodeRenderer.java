/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html.renderers;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlNode;

/**
 * One primitive family's contribution to the HTML pipeline: the semantic
 * element of a node and its type-specific content.
 *
 * <p>The contract with {@code HtmlRenderer} is narrow on purpose. The
 * pipeline owns the attribute protocol ({@code data-jhin-type},
 * {@code data-jhin-id}, {@code data-jhin-action}, …), the universal-prop pass
 * ({@link com.astroreen.jhin.plugin.uikit.html.UniversalProps}) and the
 * meta pass ({@code visible}, {@code when}); a renderer owns exactly two
 * things:
 *
 * <ol>
 *   <li>{@link #tag(UiNode)} — the element name, free to depend on props
 *       (the {@code text} style picks {@code <span>} or {@code <p>});</li>
 *   <li>{@link #fill(UiNode, HtmlNode)} — the type-specific attributes
 *       ({@code class}, {@code role}, {@code type}, …) and the children,
 *       built through {@code HtmlRenderer.appendNode}/{@code appendContent}
 *       so every nested node takes the same pipeline.</li>
 * </ol>
 *
 * <p>Ordering guarantee: {@code fill} runs <em>after</em> the universal-prop
 * pass, so a renderer that needs extra inline declarations composes them via
 * {@code UniversalProps.styleOf(node)} and re-sets the {@code style}
 * attribute; renderers that do not touch {@code style} leave the universal
 * declarations in place. No renderer may concatenate a prop into markup by
 * hand — everything goes through {@link HtmlNode} and
 * {@code com.astroreen.jhin.plugin.uikit.html.HtmlEsc}.
 */
public interface NodeRenderer {

    /**
     * The semantic element name for this node.
     *
     * @param node the node (never {@code null})
     * @return a lowercase HTML tag name
     */
    String tag(UiNode node);

    /**
     * Fills the element with the type-specific attributes and children.
     *
     * @param node    the node (never {@code null})
     * @param element the element to fill (already carries the protocol and
     *                universal attributes)
     */
    void fill(UiNode node, HtmlNode element);
}
