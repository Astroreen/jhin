/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html;

import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.Map;
import java.util.Set;

/**
 * The prop-completeness backstop of the HTML renderer (T206): every
 * documented prop that has no richer HTML mapping still reaches the wire as
 * a {@code data-jhin-<kebab-name>} attribute, so that a prop can never be
 * silently dropped between docs/sdui.md section 2.6 and the emitted element.
 *
 * <p>Policy (the two tiers the {@code HtmlConformanceTest} probe enforces):
 *
 * <ol>
 *   <li><b>semantic mapping</b> — a prop with an HTML counterpart is
 *       consumed by its renderer (or by {@link UniversalProps}): a native
 *       attribute ({@code min}, {@code pattern}, {@code required}), a style
 *       declaration, a class, text content or child structure;</li>
 *   <li><b>reflection</b> — everything else lands as
 *       {@code data-jhin-<kebab-name>="…"}: scalars verbatim, maps and lists
 *       as JSON (the {@link HtmlRenderer} JSON writer), {@link UiNode}
 *       values as their wire JSON. Unknown markup is inert (section 2.4), so
 *       the attribute is always safe to carry and always observable.</li>
 * </ol>
 *
 * <p>The universal surface (section 2.1) is not reflected again: the names
 * {@link #UNIVERSAL} lists are already applied by {@link UniversalProps} or
 * by the node-level action protocol, per type. A renderer therefore calls
 * {@link #reflect(Map, HtmlNode, Set)} with the extra names <em>it</em>
 * consumed, and only props with no channel at all stay invisible — which is
 * exactly what {@code unknown-props.txt} must never contain.
 *
 * <p>Attribute values are escaped by {@link HtmlEsc} through
 * {@link HtmlNode#attr(String, String)}; nothing here concatenates raw
 * markup. Attribute names are derived from the contract's prop identifiers
 * (lowercase ASCII), never from prop <em>values</em>.
 *
 * <p>This class is stateless and thread-safe.
 */
public final class PropReflection {

    /**
     * The universal names (docs/sdui.md section 2.1) already reflected by
     * other channels for every type: {@link UniversalProps} (meta, box, text,
     * interaction, ARIA, level-3) and the node-level action protocol of
     * {@code HtmlRenderer.applyNodeAction}. {@code alignment} is deliberately
     * absent — {@link UniversalProps} only consumes it on non-{@code stack}/
     * {@code wrap}/{@code icon_button} types, so those renderers handle it
     * themselves; {@code maxLines}/{@code softWrap} are absent for the same
     * type-conditional reason (text-bearing only).
     */
    public static final Set<String> UNIVERSAL = Set.of(
            "id", "when", "visible",
            "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
            "aspectRatio", "padding", "margin",
            "color", "gradient", "border", "borderWidth", "borderStyle",
            "borderRadius", "shadow", "opacity", "transform", "clip", "clipBehavior",
            "align",
            "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
            "wordSpacing", "textDecoration", "textOverflow", "ellipsis",
            "flex", "fit",
            "action", "onTap", "onLongPress", "confirm", "tooltip", "cursor",
            "enabled", "focusable",
            "semanticsLabel", "semanticsHint", "semanticsValue", "excludeSemantics",
            "glass", "glassTint", "demo", "safeArea");

    private PropReflection() {
    }

    /**
     * Reflects every prop of a node that no other channel consumed, as
     * {@code data-jhin-<kebab-name>} attributes in prop order.
     *
     * @param node     the node whose props to reflect
     * @param element  the element to write the attributes to
     * @param handled  the names this call site already reflected (renderer
     *                 semantics plus {@link #UNIVERSAL})
     */
    public static void reflect(UiNode node, HtmlNode element, Set<String> handled) {
        reflect(node.props(), element, handled);
    }

    /**
     * Reflects every entry of a prop map that no other channel consumed —
     * the node surface above and the item shapes ({@code nav} items,
     * {@code list} sections, {@code rich_text} spans, …) below, so that a
     * documented item prop cannot be dropped either.
     *
     * @param props    the props (a node prop map or an item map)
     * @param element  the element to write the attributes to
     * @param handled  the names this call site already reflected
     */
    public static void reflect(Map<?, ?> props, HtmlNode element, Set<String> handled) {
        for (Map.Entry<?, ?> entry : props.entrySet()) {
            String name = String.valueOf(entry.getKey());
            if (handled.contains(name) || UNIVERSAL.contains(name)) {
                continue;
            }
            element.attr("data-jhin-" + kebab(name), value(entry.getValue()));
        }
    }

    /**
     * The wire value of one reflected prop: scalars verbatim (numbers keep
     * their {@link Number#toString()} form, which is locale-independent),
     * maps, lists and nodes as JSON.
     */
    private static String value(Object value) {
        if (value instanceof String text) {
            return text;
        }
        if (value instanceof Number || value instanceof Boolean) {
            return String.valueOf(value);
        }
        return HtmlRenderer.actionJson(value);
    }

    /**
     * The attribute-name form of a prop identifier: camelCase folds to
     * kebab-case ({@code maxLines} &rarr; {@code max-lines}), digits and
     * existing hyphens pass through.
     */
    static String kebab(String name) {
        StringBuilder out = new StringBuilder(name.length() + 4);
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (Character.isUpperCase(c)) {
                out.append('-').append(Character.toLowerCase(c));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }
}
