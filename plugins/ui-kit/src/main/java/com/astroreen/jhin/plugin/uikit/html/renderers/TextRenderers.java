/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html.renderers;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import com.astroreen.jhin.plugin.uikit.html.PropReflection;
import com.astroreen.jhin.plugin.uikit.html.TokenCss;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Text primitives (docs/sdui.md section 9.1): {@code text}, {@code rich_text},
 * {@code markdown} and {@code code_block}.
 *
 * <p>{@code text} is a {@code <span>}, or a {@code <p>} when its
 * {@code style} prop is block-ish ({@code h1}/{@code h2}/{@code h3}/
 * {@code body}); an absent {@code style} stays inline so the text shorthand
 * nests legally inside buttons, rows and labels. {@code rich_text} is the
 * inline {@code <span class="jhin-rich-text">} run of styled spans (section
 * 2.6: {@code text}, {@code style}, {@code action}, {@code tooltip},
 * {@code icon}, {@code chip}, {@code image} per span).
 * {@code markdown} is the server-rendered block container
 * ({@link MarkdownRenderer}); {@code code_block} is
 * {@code <pre><code class="language-x">}.
 */
public final class TextRenderers {

    /** Typography tokens that select the block element for {@code text}. */
    private static final Set<String> BLOCK_STYLES = Set.of("h1", "h2", "h3", "body");

    /** The {@code text} props the renderer reflects itself (T206). */
    private static final Set<String> TEXT_HANDLED = Set.of("text", "style", "bold", "italic",
            "maxLines", "softWrap");

    /** The {@code rich_text} props the renderer reflects itself. */
    private static final Set<String> RICH_HANDLED = Set.of("spans");

    /** The {@code code_block} props the renderer reflects itself. */
    private static final Set<String> CODE_HANDLED = Set.of(
            "code", "language", "wrap", "copyable", "lineNumbers");

    /** One {@code rich_text} span's props (section 2.6). */
    private static final Set<String> SPAN_HANDLED = Set.of(
            "text", "style", "action", "tooltip", "icon", "chip", "image");

    /** TextStyle map keys (section 2.6 {@code rich_text} span {@code style}), in emission order. */
    private static final List<String> TEXT_STYLE_KEYS = List.of(
            "fontFamily", "fontSize", "fontWeight", "fontStyle",
            "letterSpacing", "wordSpacing", "color", "height");

    /** TextStyle map keys to CSS properties (section 2.6 span {@code style}). */
    private static final Map<String, String> TEXT_STYLE_CSS = Map.ofEntries(
            Map.entry("fontFamily", "font-family"),
            Map.entry("fontSize", "font-size"),
            Map.entry("fontWeight", "font-weight"),
            Map.entry("fontStyle", "font-style"),
            Map.entry("letterSpacing", "letter-spacing"),
            Map.entry("wordSpacing", "word-spacing"),
            Map.entry("color", "color"),
            Map.entry("height", "line-height"));

    private TextRenderers() {
    }

    public static Map<String, NodeRenderer> renderers() {
        Map<String, NodeRenderer> map = new LinkedHashMap<>();
        map.put("text", text());
        map.put("rich_text", richText());
        map.put("markdown", new MarkdownRenderer());
        map.put("code_block", codeBlock());
        return map;
    }

    private static NodeRenderer text() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                Object style = node.props().get("style");
                return style != null && BLOCK_STYLES.contains(String.valueOf(style))
                        ? "p" : "span";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                Object style = node.props().get("style");
                StringBuilder classes = new StringBuilder("jhin-text");
                if (style != null) {
                    classes.append(" jhin-text-").append(String.valueOf(style));
                }
                element.attr("class", classes.toString());
                StringBuilder extras = new StringBuilder();
                if (Boolean.TRUE.equals(node.props().get("bold"))) {
                    LayoutRenderers.appendDecl(extras, "font-weight", "700");
                }
                if (Boolean.TRUE.equals(node.props().get("italic"))) {
                    LayoutRenderers.appendDecl(extras, "font-style", "italic");
                }
                if (extras.length() > 0) {
                    LayoutRenderers.composeStyle(node, element, extras.toString());
                }
                Object text = node.props().get("text");
                if (text != null) {
                    element.textChild(String.valueOf(text));
                }
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, TEXT_HANDLED);
            }
        };
    }

    /**
     * {@code rich_text}: one inline {@code <span class="jhin-rich-text">}
     * per node, each {@code spans} entry a styled inline
     * {@code <span class="jhin-rich-span">} (T206). A span with an
     * {@code action} becomes a tappable {@code role="button"} span carrying
     * the action protocol attributes; {@code icon} renders the registry
     * glyph instead of text, {@code chip} an inline {@code jhin-chip} pill
     * and {@code image} an inline {@code <img>} staying in the sentence.
     */
    private static NodeRenderer richText() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "span";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-rich-text");
                if (node.props().get("spans") instanceof List<?> spans) {
                    for (Object span : spans) {
                        appendSpan(element, span);
                    }
                }
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, RICH_HANDLED);
            }
        };
    }

    /**
     * One {@code rich_text} span ({@code text, style?, action?, tooltip?,
     * icon?, chip?, image?}) as a {@code <span class="jhin-rich-span">};
     * non-map entries degrade through the content recursion (section 2.4).
     */
    private static void appendSpan(HtmlNode parent, Object span) {
        if (!(span instanceof Map<?, ?> map)) {
            HtmlRenderer.appendContent(parent, span);
            return;
        }
        HtmlNode element = new HtmlNode("span").attr("class", spanClass(map));
        Object style = map.get("style");
        if (style instanceof Map<?, ?> styleMap) {
            String decls = spanStyle(styleMap);
            if (!decls.isEmpty()) {
                element.attr("style", decls);
            }
        }
        if (map.get("tooltip") != null) {
            element.attr("title", String.valueOf(map.get("tooltip")));
        }
        if (map.get("action") != null) {
            element.attr("class", spanClass(map) + " jhin-rich-action");
            element.attr("role", "button");
            element.attr("tabindex", "0");
            HtmlRenderer.applyActionAttrs(element, map.get("action"), map.get("confirm"));
        }
        if (map.get("icon") instanceof String icon) {
            element.child(ControlRenderers.iconElement(icon, null));
        }
        if (map.get("chip") instanceof Map<?, ?> chip) {
            HtmlNode pill = new HtmlNode("span").attr("class", "jhin-badge jhin-chip"
                    + (chip.get("kind") != null ? " jhin-chip-" + chip.get("kind") : ""));
            if (chip.get("label") != null) {
                pill.textChild(String.valueOf(chip.get("label")));
            }
            element.child(pill);
        }
        if (map.get("image") instanceof Map<?, ?> image) {
            HtmlNode img = new HtmlNode("img").attr("class", "jhin-rich-image");
            img.attr("src", image.get("src") == null ? "" : String.valueOf(image.get("src")));
            img.attr("alt", image.get("semanticsLabel") == null
                    ? "" : String.valueOf(image.get("semanticsLabel")));
            element.child(img);
        }
        if (map.get("text") != null) {
            element.textChild(String.valueOf(map.get("text")));
        }
        PropReflection.reflect(map, element, SPAN_HANDLED);
        parent.child(element);
    }

    /** The span class: a typography token styles through the text classes. */
    private static String spanClass(Map<?, ?> map) {
        Object style = map.get("style");
        if (style instanceof String token) {
            return "jhin-rich-span jhin-text jhin-text-" + token;
        }
        return "jhin-rich-span";
    }

    /** The TextStyle map (section 2.6) as inline declarations, in key order. */
    private static String spanStyle(Map<?, ?> style) {
        StringBuilder out = new StringBuilder();
        for (String key : TEXT_STYLE_KEYS) {
            Object value = style.get(key);
            if (value == null) {
                continue;
            }
            String css = String.valueOf(value);
            if (value instanceof String text && text.startsWith("$")) {
                // Token references resolve through the shared indirection.
                css = TokenCss.resolveReference(text);
            }
            LayoutRenderers.appendDecl(out, TEXT_STYLE_CSS.get(key), css);
        }
        if (style.get("textDecoration") != null) {
            String decoration = String.valueOf(style.get("textDecoration"));
            LayoutRenderers.appendDecl(out, "text-decoration",
                    "lineThrough".equals(decoration) ? "line-through" : decoration);
        }
        return out.toString();
    }

    private static NodeRenderer codeBlock() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "pre";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-code-block");
                HtmlNode code = new HtmlNode("code");
                Object language = node.props().get("language");
                if (language != null) {
                    code.attr("class", "language-" + language);
                }
                if (Boolean.TRUE.equals(node.props().get("copyable"))) {
                    element.attr("data-jhin-copyable", "true");
                }
                if (Boolean.TRUE.equals(node.props().get("lineNumbers"))) {
                    element.attr("data-jhin-line-numbers", "true");
                }
                if (Boolean.TRUE.equals(node.props().get("wrap"))) {
                    LayoutRenderers.composeStyle(node, element, "white-space: pre-wrap");
                }
                Object codeText = node.props().get("code");
                code.textChild(codeText == null ? "" : String.valueOf(codeText));
                element.child(code);
                PropReflection.reflect(node, element, CODE_HANDLED);
            }
        };
    }
}
