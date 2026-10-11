/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html.renderers;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code nav} primitive (docs/sdui.md section 9.1): {@code <nav>} with
 * {@code <button>} items and {@code aria-current="page"} on the active one.
 * The {@code kind} ({@code tabs/bottom/drawer/rail/sidebar}) is a class; the
 * {@code activeId} literal wins over {@code activeIndex}, a miss falls back
 * to {@code activeIndex} (or {@code 0}) — the section 2.6 rule.
 */
public final class NavRenderers {

    private NavRenderers() {
    }

    public static Map<String, NodeRenderer> renderers() {
        return Map.of("nav", nav());
    }

    private static NodeRenderer nav() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "nav";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                String kind = node.props().get("kind") == null
                        ? "tabs" : String.valueOf(node.props().get("kind"));
                element.attr("class", "jhin-nav jhin-nav-" + kind);
                int active = activeIndex(node);
                if (node.props().get("items") instanceof List<?> items) {
                    for (int i = 0; i < items.size(); i++) {
                        if (!(items.get(i) instanceof Map<?, ?> map)) {
                            HtmlRenderer.appendContent(element, items.get(i));
                            continue;
                        }
                        if (map.get("section") != null) {
                            element.child(new HtmlNode("div")
                                    .attr("class", "jhin-nav-section")
                                    .textChild(String.valueOf(map.get("section"))));
                        }
                        element.child(item(map, i == active));
                    }
                }
                HtmlRenderer.appendChildren(element, node);
            }
        };
    }

    /**
     * The active index: {@code activeId} matched against the item ids first
     * (section 2.6: an id match wins, a miss falls back to
     * {@code activeIndex} or 0).
     */
    private static int activeIndex(UiNode node) {
        List<?> items = node.props().get("items") instanceof List<?> list ? list : List.of();
        Object activeId = node.props().get("activeId");
        if (activeId != null) {
            for (int i = 0; i < items.size(); i++) {
                if (items.get(i) instanceof Map<?, ?> map
                        && String.valueOf(activeId).equals(String.valueOf(map.get("id")))) {
                    return i;
                }
            }
        }
        return node.props().get("activeIndex") instanceof Number number ? number.intValue() : 0;
    }

    /** One {@code nav} item ({@code label, icon?, screen?, action?, badge?, count?, enabled?}). */
    private static HtmlNode item(Map<?, ?> map, boolean active) {
        HtmlNode button = new HtmlNode("button")
                .attr("type", "button")
                .attr("class", "jhin-nav-item")
                .attr("role", "link");
        if (active) {
            button.attr("aria-current", "page");
            button.attr("class", "jhin-nav-item jhin-nav-item-active");
        }
        if (Boolean.FALSE.equals(map.get("enabled"))) {
            button.attr("disabled", "disabled");
        }
        if (map.get("screen") != null) {
            button.attr("data-jhin-screen", String.valueOf(map.get("screen")));
        }
        HtmlRenderer.applyActionAttrs(button, map.get("action"), map.get("confirm"));
        if (map.get("icon") instanceof String icon) {
            button.child(ControlRenderers.iconElement(icon, null));
        }
        if (map.get("label") != null) {
            button.textChild(String.valueOf(map.get("label")));
        }
        if (map.get("count") instanceof Number number) {
            button.child(new HtmlNode("span").attr("class", "jhin-nav-count")
                    .textChild(String.valueOf(number)));
        }
        if (map.get("badge") instanceof UiNode badge) {
            HtmlRenderer.appendNode(button, badge);
        }
        return button;
    }
}