/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html.renderers;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Text primitives (docs/sdui.md section 9.1): {@code text}, {@code markdown}
 * and {@code code_block}. {@code rich_text} is deliberately absent — it is a
 * T206 renderer and takes the {@code jhin-unsupported} placeholder until
 * then.
 *
 * <p>{@code text} is a {@code <span>}, or a {@code <p>} when its
 * {@code style} prop is block-ish ({@code h1}/{@code h2}/{@code h3}/
 * {@code body}); an absent {@code style} stays inline so the text shorthand
 * nests legally inside buttons, rows and labels. {@code markdown} is the
 * server-rendered block container ({@link MarkdownRenderer});
 * {@code code_block} is {@code <pre><code class="language-x">}.
 */
public final class TextRenderers {

    /** Typography tokens that select the block element for {@code text}. */
    private static final Set<String> BLOCK_STYLES = Set.of("h1", "h2", "h3", "body");

    private TextRenderers() {
    }

    public static Map<String, NodeRenderer> renderers() {
        Map<String, NodeRenderer> map = new LinkedHashMap<>();
        map.put("text", text());
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
            }
        };
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
                Object codeText = node.props().get("code");
                code.textChild(codeText == null ? "" : String.valueOf(codeText));
                element.child(code);
            }
        };
    }
}