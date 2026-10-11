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
 * Control primitives (docs/sdui.md section 9.1): {@code button, icon_button,
 * icon, input, textarea, dropdown, checkbox, switch, slider, form, segmented,
 * menu, tabs, kbd, scroll_fade}.
 *
 * <p>Every control renders its real element ({@code <button type="button">},
 * {@code <input>}, {@code <select>}, {@code <textarea>}) so the accessibility
 * tree and native behaviour come free; {@code checkbox} and {@code switch}
 * are the {@code <label>&gt;<input>} pair (the label wraps the input, so the
 * node's HTML {@code id} can live on the root without breaking
 * association); {@code icon} is an empty {@code <svg data-jhin-icon="…">} —
 * the inline-SVG registry lands in T206 and an unknown name must never
 * crash. {@code form} and {@code segmented} are semantic {@code <div>}s per
 * the section 9.1 table. The action protocol ({@code data-jhin-action})
 * attaches to the control element itself — these primitives never receive a
 * second handler (section 2.3 step 10).
 */
public final class ControlRenderers {

    private ControlRenderers() {
    }

    public static Map<String, NodeRenderer> renderers() {
        Map<String, NodeRenderer> map = new LinkedHashMap<>();
        map.put("button", button());
        map.put("icon_button", iconButton());
        map.put("icon", icon());
        map.put("input", input());
        map.put("textarea", textarea());
        map.put("dropdown", dropdown());
        map.put("checkbox", checkbox("checkbox", null));
        map.put("switch", checkbox("switch", "switch"));
        map.put("slider", slider());
        map.put("form", form());
        map.put("segmented", segmented());
        map.put("menu", menu());
        map.put("tabs", tabs());
        map.put("kbd", kbd());
        map.put("scroll_fade", scrollFade());
        return map;
    }

    // --- buttons / icons --------------------------------------------------

    private static NodeRenderer button() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "button";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("type", "button");
                Object style = node.props().get("style");
                element.attr("class", "jhin-button"
                        + (style != null ? " jhin-button-" + style : " jhin-button-primary"));
                Object icon = node.props().get("icon");
                if (icon != null) {
                    element.child(iconElement(String.valueOf(icon), null));
                }
                Object label = node.props().get("label");
                if (label != null) {
                    element.textChild(String.valueOf(label));
                }
            }
        };
    }

    private static NodeRenderer iconButton() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "button";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("type", "button");
                element.attr("class", "jhin-icon-button");
                Object icon = node.props().get("icon");
                if (icon != null) {
                    element.child(iconElement(String.valueOf(icon), node.props().get("iconSize")));
                    if (node.props().get("semanticsLabel") == null) {
                        element.attr("aria-label", String.valueOf(icon));
                    }
                }
                if (Boolean.TRUE.equals(node.props().get("isSelected"))) {
                    element.attr("aria-pressed", "true");
                }
            }
        };
    }

    private static NodeRenderer icon() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "svg";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-icon");
                Object name = node.props().get("icon");
                element.attr("data-jhin-icon", name == null ? "" : String.valueOf(name));
                element.attr("aria-hidden", "true");
                Object size = node.props().get("size");
                if (size != null) {
                    String px = LayoutRenderers.px(size);
                    element.attr("width", px);
                    element.attr("height", px);
                }
                if (node.props().get("semanticLabel") != null) {
                    element.attr("aria-hidden", "false");
                    element.attr("aria-label", String.valueOf(node.props().get("semanticLabel")));
                }
            }
        };
    }

    /**
     * The shared {@code <svg data-jhin-icon="…">} placeholder: empty content
     * until the T206 inline-SVG registry; an unknown name is an empty svg,
     * never a crash (section 2.4).
     */
    static HtmlNode iconElement(String name, Object size) {
        HtmlNode svg = new HtmlNode("svg")
                .attr("class", "jhin-icon")
                .attr("data-jhin-icon", name);
        if (size != null) {
            String px = LayoutRenderers.px(size);
            svg.attr("width", px);
            svg.attr("height", px);
        }
        return svg;
    }

    // --- text inputs ------------------------------------------------------

    private static NodeRenderer input() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return Boolean.TRUE.equals(node.props().get("multiline"))
                        || Boolean.TRUE.equals(node.props().get("expands"))
                        ? "textarea" : "input";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-input");
                if (isMultiline(node)) {
                    fillTextarea(node, element);
                    return;
                }
                element.attr("type", inputType(node));
                if (node.props().get("value") != null) {
                    element.attr("value", String.valueOf(node.props().get("value")));
                }
                commonInputAttrs(node, element);
            }
        };
    }

    private static NodeRenderer textarea() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "textarea";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-input jhin-textarea");
                fillTextarea(node, element);
            }
        };
    }

    private static boolean isMultiline(UiNode node) {
        return Boolean.TRUE.equals(node.props().get("multiline"))
                || Boolean.TRUE.equals(node.props().get("expands"));
    }

    private static void fillTextarea(UiNode node, HtmlNode element) {
        Object value = node.props().get("value");
        element.textChild(value == null ? "" : String.valueOf(value));
        commonInputAttrs(node, element);
    }

    /** The shared input/textarea attribute surface. */
    private static void commonInputAttrs(UiNode node, HtmlNode element) {
        if (node.props().get("placeholder") != null) {
            element.attr("placeholder", String.valueOf(node.props().get("placeholder")));
        }
        if (node.props().get("label") != null && node.props().get("semanticsLabel") == null) {
            element.attr("aria-label", String.valueOf(node.props().get("label")));
        }
        if (node.props().get("maxLength") instanceof Number number) {
            element.attr("maxlength", String.valueOf(number.intValue()));
        }
        if (Boolean.TRUE.equals(node.props().get("required"))) {
            element.attr("required", "required");
        }
        if (Boolean.TRUE.equals(node.props().get("readOnly"))) {
            element.attr("readonly", "readonly");
        }
        if (Boolean.FALSE.equals(node.props().get("enabled"))) {
            element.attr("disabled", "disabled");
        }
    }

    /** The {@code keyboardType}/{@code obscure} literal to an input type. */
    private static String inputType(UiNode node) {
        if (Boolean.TRUE.equals(node.props().get("obscure"))) {
            return "password";
        }
        Object keyboard = node.props().get("keyboardType");
        if (keyboard == null) {
            keyboard = node.props().get("keyboard");
        }
        return switch (keyboard == null ? "text" : String.valueOf(keyboard)) {
            case "number" -> "number";
            case "phone" -> "tel";
            case "email" -> "email";
            case "url" -> "url";
            default -> "text";
        };
    }

    // --- choice controls --------------------------------------------------

    private static NodeRenderer dropdown() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "select";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-dropdown");
                if (node.props().get("label") != null && node.props().get("semanticsLabel") == null) {
                    element.attr("aria-label", String.valueOf(node.props().get("label")));
                }
                if (Boolean.FALSE.equals(node.props().get("enabled"))) {
                    element.attr("disabled", "disabled");
                }
                Object value = node.props().get("value");
                if (node.props().get("hint") != null) {
                    HtmlNode hint = new HtmlNode("option")
                            .attr("value", "")
                            .textChild(String.valueOf(node.props().get("hint")));
                    if (value == null) {
                        hint.attr("selected", "selected");
                    }
                    element.child(hint);
                }
                if (node.props().get("items") instanceof List<?> items) {
                    for (Object item : items) {
                        element.child(option(item, value));
                    }
                }
            }
        };
    }

    private static HtmlNode option(Object item, Object selected) {
        HtmlNode option = new HtmlNode("option");
        Object label = item;
        Object value = item;
        if (item instanceof Map<?, ?> map) {
            label = map.get("label");
            value = map.get("value");
        }
        option.attr("value", value == null ? "" : String.valueOf(value));
        option.textChild(label == null ? "" : String.valueOf(label));
        if (selected != null && String.valueOf(selected).equals(String.valueOf(value))) {
            option.attr("selected", "selected");
        }
        return option;
    }

    /** {@code checkbox} and {@code switch}: a label-wrapped input pair. */
    private static NodeRenderer checkbox(String type, String inputRole) {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "label";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", HtmlRenderer.typeClass(type));
                HtmlNode input = new HtmlNode("input").attr("type", "checkbox");
                if (inputRole != null) {
                    input.attr("role", inputRole);
                }
                if (Boolean.TRUE.equals(node.props().get("value"))) {
                    input.attr("checked", "checked");
                }
                if (Boolean.FALSE.equals(node.props().get("enabled"))) {
                    input.attr("disabled", "disabled");
                }
                element.child(input);
                if (node.props().get("label") != null) {
                    element.child(new HtmlNode("span")
                            .attr("class", "jhin-control-label")
                            .textChild(String.valueOf(node.props().get("label"))));
                }
            }
        };
    }

    private static NodeRenderer slider() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "input";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-slider");
                element.attr("type", "range");
                element.attr("min", number(node.props().getOrDefault("min", 0)));
                element.attr("max", number(node.props().getOrDefault("max", 1)));
                if (node.props().get("step") != null) {
                    element.attr("step", number(node.props().get("step")));
                }
                if (node.props().get("value") != null) {
                    element.attr("value", number(node.props().get("value")));
                }
                if (node.props().get("label") != null && node.props().get("semanticsLabel") == null) {
                    element.attr("aria-label", String.valueOf(node.props().get("label")));
                }
                if (Boolean.FALSE.equals(node.props().get("enabled"))) {
                    element.attr("disabled", "disabled");
                }
            }
        };
    }

    private static String number(Object value) {
        return value instanceof Number number ? number.toString() : String.valueOf(value);
    }

    // --- composites -------------------------------------------------------

    private static NodeRenderer form() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-form");
                element.attr("role", "form");
                HtmlRenderer.appendProp(element, node, "fields");
                Object submit = node.props().get("submit");
                if (submit instanceof Map<?, ?> map) {
                    HtmlNode button = new HtmlNode("button")
                            .attr("type", "button")
                            .attr("class", "jhin-button jhin-button-primary");
                    Object label = map.get("label");
                    if (label != null) {
                        button.textChild(String.valueOf(label));
                    }
                    HtmlRenderer.applyActionAttrs(button, map.get("action"), map.get("confirm"));
                    element.child(button);
                }
                HtmlRenderer.appendChildren(element, node);
            }
        };
    }

    private static NodeRenderer segmented() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-segmented");
                element.attr("role", "radiogroup");
                Object value = node.props().get("value");
                if (node.props().get("segments") instanceof List<?> segments) {
                    for (Object segment : segments) {
                        if (!(segment instanceof Map<?, ?> map)) {
                            continue;
                        }
                        HtmlNode button = new HtmlNode("button")
                                .attr("type", "button")
                                .attr("class", "jhin-segment")
                                .attr("role", "radio");
                        Object segmentValue = map.get("value");
                        button.attr("data-jhin-value",
                                segmentValue == null ? "" : String.valueOf(segmentValue));
                        if (value != null && String.valueOf(value).equals(String.valueOf(segmentValue))) {
                            button.attr("aria-checked", "true");
                        } else {
                            button.attr("aria-checked", "false");
                        }
                        if (map.get("icon") instanceof String icon) {
                            button.child(iconElement(icon, null));
                        }
                        if (map.get("label") != null) {
                            button.textChild(String.valueOf(map.get("label")));
                        }
                        element.child(button);
                    }
                }
            }
        };
    }

    private static NodeRenderer menu() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-menu");
                element.attr("role", "menu");
                HtmlRenderer.appendProp(element, node, "trigger");
                if (node.props().get("items") instanceof List<?> items) {
                    for (Object item : items) {
                        appendMenuItem(element, item);
                    }
                }
            }
        };
    }

    /**
     * One {@code menu} entry ({@code label, icon?, action?, confirm?,
     * disabled?, divider?, danger?, checked?, children?}): a
     * {@code <button role="menuitem">} carrying the item action, or an
     * {@code <hr>} for a divider. The submenu renders as nested items.
     */
    private static void appendMenuItem(HtmlNode parent, Object item) {
        if (!(item instanceof Map<?, ?> map)) {
            HtmlRenderer.appendContent(parent, item);
            return;
        }
        if (Boolean.TRUE.equals(map.get("divider"))
                || Boolean.TRUE.equals(map.get("separatorBefore"))) {
            parent.child(new HtmlNode("hr").attr("class", "jhin-menu-divider"));
            if (Boolean.TRUE.equals(map.get("divider"))) {
                return;
            }
        }
        HtmlNode button = new HtmlNode("button")
                .attr("type", "button")
                .attr("role", "menuitem")
                .attr("class", "jhin-menu-item"
                        + (Boolean.TRUE.equals(map.get("danger")) ? " jhin-danger" : ""));
        if (Boolean.TRUE.equals(map.get("disabled"))) {
            button.attr("disabled", "disabled");
        }
        if (Boolean.TRUE.equals(map.get("checked"))) {
            button.attr("aria-checked", "true");
            button.attr("role", "menuitemradio");
        }
        HtmlRenderer.applyActionAttrs(button, map.get("action"), map.get("confirm"));
        if (map.get("icon") instanceof String icon) {
            button.child(iconElement(icon, null));
        }
        if (map.get("label") != null) {
            button.textChild(String.valueOf(map.get("label")));
        }
        parent.child(button);
        if (map.get("children") instanceof List<?> nested) {
            HtmlNode submenu = new HtmlNode("div")
                    .attr("class", "jhin-menu-submenu")
                    .attr("role", "menu");
            for (Object child : nested) {
                appendMenuItem(submenu, child);
            }
            parent.child(submenu);
        }
    }

    private static NodeRenderer tabs() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-tabs");
                element.attr("role", "tablist");
                int active = node.props().get("activeIndex") instanceof Number number
                        ? number.intValue() : 0;
                if (node.props().get("items") instanceof List<?> items) {
                    for (int i = 0; i < items.size(); i++) {
                        if (!(items.get(i) instanceof Map<?, ?> map)) {
                            continue;
                        }
                        HtmlNode tab = new HtmlNode("button")
                                .attr("type", "button")
                                .attr("class", "jhin-tab")
                                .attr("role", "tab")
                                .attr("aria-selected", i == active ? "true" : "false");
                        if (map.get("icon") instanceof String icon) {
                            tab.child(iconElement(icon, null));
                        }
                        if (map.get("label") != null) {
                            tab.textChild(String.valueOf(map.get("label")));
                        }
                        HtmlRenderer.applyActionAttrs(tab, map.get("closeAction"), null);
                        element.child(tab);
                    }
                    // Panel nodes stay addressable inside the tablist root:
                    // one node, one element (section 2.3); T206 refines the
                    // tablist/tabpanel split.
                    for (Object item : items) {
                        if (item instanceof Map<?, ?> map && map.get("panel") instanceof UiNode panel) {
                            HtmlNode panelElement = new HtmlNode("div")
                                    .attr("class", "jhin-tabpanel")
                                    .attr("role", "tabpanel");
                            HtmlRenderer.appendNode(panelElement, panel);
                            element.child(panelElement);
                        }
                    }
                }
            }
        };
    }

    private static NodeRenderer kbd() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "kbd";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-kbd");
                Object chord = node.props().get("chord");
                if (chord == null) {
                    return;
                }
                String[] tokens = String.valueOf(chord).split("\\+", -1);
                for (int i = 0; i < tokens.length; i++) {
                    if (i > 0) {
                        element.textChild("+");
                    }
                    element.child(new HtmlNode("kbd")
                            .attr("class", "jhin-kbd-key")
                            .textChild(tokens[i]));
                }
            }
        };
    }

    private static NodeRenderer scrollFade() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-scroll-fade");
                if (node.props().get("edge") != null) {
                    element.attr("data-jhin-edge", String.valueOf(node.props().get("edge")));
                }
                if (node.props().get("mode") != null) {
                    element.attr("data-jhin-mode", String.valueOf(node.props().get("mode")));
                }
                HtmlRenderer.appendProp(element, node, "child");
                HtmlRenderer.appendChildren(element, node);
            }
        };
    }
}