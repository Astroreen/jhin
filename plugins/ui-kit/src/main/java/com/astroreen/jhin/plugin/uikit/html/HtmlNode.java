/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * A minimal HTML tag builder: one element, ordered attributes, mixed
 * children. Every renderer in the HTML pipeline builds its markup through
 * this class so that escaping cannot be bypassed by accident.
 *
 * <p>Escaping contract: every attribute <em>value</em> passes through
 * {@link HtmlEsc#attr(String)} and is always emitted double-quoted; every
 * text child passes through {@link HtmlEsc#text(String)}. {@code class} and
 * {@code style} are ordinary attributes — their values are escaped, never
 * sanitized. Attribute <em>names</em> are not escaped: they are static
 * literals owned by the renderers, never prop data.
 *
 * <p>{@link #rawChild(String)} is the single unescaped path in the whole
 * renderer; see its Javadoc for the strict rule that governs it.
 *
 * <p>Void elements ({@code br, hr, img, input, meta, link, source, area,
 * base, col, embed, param, track, wbr}) serialize without an end tag
 * ({@code <img src="x">}) and reject children. Attribute order is
 * deterministic and preserved exactly as added ({@link LinkedHashMap}
 * semantics).
 *
 * <p>Instances are mutable builders meant to be assembled and rendered on
 * one thread inside a single request; they are not thread-safe.
 */
public final class HtmlNode {

    /** HTML void elements: self-closing, never take children. */
    private static final Set<String> VOID_TAGS = Set.of(
            "area", "base", "br", "col", "embed", "hr", "img", "input",
            "link", "meta", "param", "source", "track", "wbr");

    private final String tag;
    private final boolean voidElement;
    private final Map<String, Attr> attributes = new LinkedHashMap<>();
    private final List<Object> children = new ArrayList<>();

    /**
     * Creates an empty element.
     *
     * @param tag the element name; expected lowercase HTML ({@code div},
     *        {@code img}, …)
     */
    public HtmlNode(String tag) {
        this.tag = Objects.requireNonNull(tag, "tag");
        this.voidElement = VOID_TAGS.contains(tag.toLowerCase(Locale.ROOT));
    }

    /**
     * Adds an attribute, escaped with {@link HtmlEsc#attr(String)} and always
     * emitted double-quoted. Insertion order is preserved; re-adding a name
     * keeps its original position and replaces the value.
     *
     * @param name the attribute name (not escaped — renderer-owned literal)
     * @param value the raw value; {@code null} renders as the empty string
     * @return this node
     */
    public HtmlNode attr(String name, String value) {
        attributes.put(Objects.requireNonNull(name, "name"),
                new Attr(value, false, false));
        return this;
    }

    /**
     * Adds an attribute whose value is emitted <em>single</em>-quoted, escaped
     * with {@link HtmlEsc#attrSingle(String)}. This is the shape of exactly
     * one attribute in the whole renderer — {@code data-jhin-action='<json>'}
     * (docs/sdui.md section 9.2) — where the JSON payload keeps readable
     * double quotes and the apostrophe is the character that must be escaped.
     * Insertion order and replacement semantics match {@link #attr(String,
     * String)}.
     *
     * @param name the attribute name (not escaped — renderer-owned literal)
     * @param value the raw value; {@code null} renders as the empty string
     * @return this node
     */
    public HtmlNode attrSingle(String name, String value) {
        attributes.put(Objects.requireNonNull(name, "name"),
                new Attr(value, true, false));
        return this;
    }

    /**
     * Adds a bare boolean attribute: the name alone, no value and no
     * quoting ({@code <input disabled>}). Used for the HTML boolean
     * attributes whose presence is the value ({@code disabled},
     * {@code checked}) where the exact bare form is part of the rendered
     * shape; everything else keeps the always-quoted {@link #attr(String,
     * String)} form. Insertion order and replacement semantics match
     * {@link #attr(String, String)}.
     *
     * @param name the attribute name (not escaped — renderer-owned literal)
     * @return this node
     */
    public HtmlNode attrFlag(String name) {
        attributes.put(Objects.requireNonNull(name, "name"),
                new Attr(null, false, true));
        return this;
    }

    /**
     * Adds a text child, escaped with {@link HtmlEsc#text(String)} at render
     * time.
     *
     * @param text the raw text
     * @return this node
     */
    public HtmlNode textChild(String text) {
        requireNonVoid();
        children.add(Objects.requireNonNull(text, "text"));
        return this;
    }

    /**
     * Adds a nested element, rendered recursively.
     *
     * @param node the child element
     * @return this node
     */
    public HtmlNode child(HtmlNode node) {
        requireNonVoid();
        children.add(Objects.requireNonNull(node, "node"));
        return this;
    }

    /**
     * Adds a verbatim child: the string is emitted exactly as given, with no
     * escaping. This is the single unescaped path in the entire HTML
     * renderer, and the only thing that may feed it is the {@code Ui.raw}
     * escape hatch — trusted, server-authored chrome only (hand-tuned SVG
     * art, shell decorations). No product screen, prop value, LLM output or
     * file content may ever reach this method; {@code RawEscapeSweepTest}
     * fails the build when product screens use the hatch.
     *
     * @param html the already-safe markup
     * @return this node
     */
    public HtmlNode rawChild(String html) {
        requireNonVoid();
        children.add(new Raw(Objects.requireNonNull(html, "html")));
        return this;
    }

    /**
     * Renders this element and its children to an HTML fragment.
     *
     * @return {@code <tag a="escaped">children</tag>} for normal elements,
     *         {@code <tag a="escaped">} for void elements
     */
    public String render() {
        StringBuilder out = new StringBuilder();
        renderTo(out);
        return out.toString();
    }

    private void renderTo(StringBuilder out) {
        out.append('<').append(tag);
        for (Map.Entry<String, Attr> attribute : attributes.entrySet()) {
            Attr value = attribute.getValue();
            out.append(' ').append(attribute.getKey());
            if (value.bare()) {
                continue;
            }
            if (value.singleQuoted()) {
                out.append("='").append(HtmlEsc.attrSingle(value.value())).append('\'');
            } else {
                out.append("=\"").append(HtmlEsc.attr(value.value())).append('"');
            }
        }
        out.append('>');
        if (voidElement) {
            return;
        }
        for (Object child : children) {
            switch (child) {
                case Raw raw -> out.append(raw.html());
                case HtmlNode node -> node.renderTo(out);
                case String text -> out.append(HtmlEsc.text(text));
                default -> throw new IllegalStateException(
                        "Unknown child kind: " + child.getClass().getName());
            }
        }
        out.append("</").append(tag).append('>');
    }

    private void requireNonVoid() {
        if (voidElement) {
            throw new IllegalStateException(
                    "Void element <" + tag + "> cannot have children");
        }
    }

    /**
     * A verbatim child; see {@link #rawChild(String)} for the rule.
     */
    private record Raw(String html) {
    }

    /** One attribute value and its quoting shape ({@code bare} = name only). */
    private record Attr(String value, boolean singleQuoted, boolean bare) {
    }
}
