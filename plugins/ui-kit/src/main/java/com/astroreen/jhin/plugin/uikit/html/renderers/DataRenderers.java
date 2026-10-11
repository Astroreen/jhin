/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html.renderers;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import com.astroreen.jhin.plugin.uikit.html.PropReflection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Data primitives (docs/sdui.md section 9.1): {@code stream_view},
 * {@code diff_view} and — through {@link ChartRenderers} — the three chart
 * primitives {@code chart_line}, {@code chart_bar} and {@code chart_pie}.
 *
 * <p>{@code stream_view} is the {@code <div role="log" aria-live="polite">}
 * SSE target; {@code diff_view} is the decorative {@code <div class="jhin-diff">}
 * with {@code <ins>}/{@code <del>} lines — it renders exactly the
 * server-authored hunks and computes nothing (section 2.6). The charts are
 * server-computed inline SVG (T206, {@link ChartRenderers}).
 */
public final class DataRenderers {

    /** The {@code stream_view} props with a semantic mapping. */
    private static final Set<String> STREAM_HANDLED = Set.of(
            "id", "topic", "mode", "autoScroll", "empty", "items");

    /** The {@code diff_view} props with a semantic mapping. */
    private static final Set<String> DIFF_HANDLED = Set.of(
            "file", "language", "hunks", "view", "colorScheme", "stats");

    /** One {@code diff_view} hunk's props with a semantic mapping. */
    private static final Set<String> HUNK_HANDLED = Set.of("header", "lines");

    /** One diff line's props with a semantic mapping. */
    private static final Set<String> LINE_HANDLED = Set.of("kind", "oldNo", "newNo", "text");

    private DataRenderers() {
    }

    public static Map<String, NodeRenderer> renderers() {
        Map<String, NodeRenderer> map = new LinkedHashMap<>();
        map.put("stream_view", streamView());
        map.put("diff_view", diffView());
        map.putAll(ChartRenderers.renderers());
        return map;
    }

    private static NodeRenderer streamView() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-stream-view");
                element.attr("role", "log");
                element.attr("aria-live", "polite");
                if (node.props().get("topic") != null) {
                    element.attr("data-jhin-topic", String.valueOf(node.props().get("topic")));
                }
                if (node.props().get("mode") != null) {
                    element.attr("data-jhin-mode", String.valueOf(node.props().get("mode")));
                }
                if (Boolean.TRUE.equals(node.props().get("autoScroll"))) {
                    element.attr("data-jhin-auto-scroll", "true");
                }
                HtmlRenderer.appendProp(element, node, "empty");
                HtmlRenderer.appendProp(element, node, "items");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, STREAM_HANDLED);
            }
        };
    }

    private static NodeRenderer diffView() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-diff");
                if (node.props().get("view") != null) {
                    element.attr("data-jhin-view", String.valueOf(node.props().get("view")));
                }
                if (node.props().get("colorScheme") != null) {
                    element.attr("data-diff-color-scheme",
                            String.valueOf(node.props().get("colorScheme")));
                }
                HtmlNode header = new HtmlNode("div").attr("class", "jhin-diff-header");
                if (node.props().get("file") != null) {
                    header.child(new HtmlNode("span").attr("class", "jhin-diff-file")
                            .textChild(String.valueOf(node.props().get("file"))));
                }
                if (node.props().get("language") != null) {
                    header.child(new HtmlNode("span").attr("class", "jhin-diff-language")
                            .textChild(String.valueOf(node.props().get("language"))));
                }
                if (node.props().get("stats") instanceof Map<?, ?> stats) {
                    HtmlNode stat = new HtmlNode("span").attr("class", "jhin-diff-stats");
                    if (stats.get("additions") != null) {
                        stat.child(new HtmlNode("ins").textChild("+" + stats.get("additions")));
                    }
                    if (stats.get("deletions") != null) {
                        stat.child(new HtmlNode("del").textChild("-" + stats.get("deletions")));
                    }
                    header.child(stat);
                }
                element.child(header);
                if (node.props().get("hunks") instanceof List<?> hunks) {
                    for (Object hunk : hunks) {
                        appendHunk(element, hunk);
                    }
                }
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, DIFF_HANDLED);
            }
        };
    }

    /** One {@code diff_view} hunk ({@code header, lines:[{kind, oldNo, newNo, text}]}). */
    private static void appendHunk(HtmlNode parent, Object hunk) {
        if (!(hunk instanceof Map<?, ?> map)) {
            HtmlRenderer.appendContent(parent, hunk);
            return;
        }
        HtmlNode element = new HtmlNode("div").attr("class", "jhin-diff-hunk");
        if (map.get("header") != null) {
            element.child(new HtmlNode("div").attr("class", "jhin-diff-hunk-header")
                    .textChild(String.valueOf(map.get("header"))));
        }
        if (map.get("lines") instanceof List<?> lines) {
            for (Object line : lines) {
                appendLine(element, line);
            }
        }
        PropReflection.reflect(map, element, HUNK_HANDLED);
        parent.child(element);
    }

    /**
     * One diff line: {@code add} &rarr; {@code <ins>}, {@code del} &rarr;
     * {@code <del>}, {@code ctx}/{@code meta} &rarr; {@code <span>}; the
     * line-number gutters are plain spans.
     */
    private static void appendLine(HtmlNode parent, Object line) {
        if (!(line instanceof Map<?, ?> map)) {
            HtmlRenderer.appendContent(parent, line);
            return;
        }
        HtmlNode row = new HtmlNode("div").attr("class", "jhin-diff-line");
        row.child(new HtmlNode("span").attr("class", "jhin-diff-no jhin-diff-no-old")
                .textChild(map.get("oldNo") == null ? "" : String.valueOf(map.get("oldNo"))));
        row.child(new HtmlNode("span").attr("class", "jhin-diff-no jhin-diff-no-new")
                .textChild(map.get("newNo") == null ? "" : String.valueOf(map.get("newNo"))));
        String kind = map.get("kind") == null ? "ctx" : String.valueOf(map.get("kind"));
        HtmlNode body = switch (kind) {
            case "add" -> new HtmlNode("ins").attr("class", "jhin-diff-add");
            case "del" -> new HtmlNode("del").attr("class", "jhin-diff-del");
            default -> new HtmlNode("span").attr("class", "jhin-diff-ctx");
        };
        body.textChild(map.get("text") == null ? "" : String.valueOf(map.get("text")));
        row.child(body);
        PropReflection.reflect(map, row, LINE_HANDLED);
        parent.child(row);
    }
}
