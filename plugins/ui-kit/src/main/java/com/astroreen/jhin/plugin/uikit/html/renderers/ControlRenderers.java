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
 * the inline-SVG registry lands later and an unknown name must never crash.
 * {@code form} and {@code segmented} are semantic {@code <div>}s per the
 * section 9.1 table. The action protocol ({@code data-jhin-action}) attaches
 * to the control element itself — these primitives never receive a second
 * handler (section 2.3 step 10).
 *
 * <p>T206 prop completeness: the text inputs emit the validation surface the
 * client dispatcher reads off the DOM ({@code required}, {@code min},
 * {@code max}, {@code pattern}, {@code data-jhin-error-text}); {@code tabs}
 * splits into a {@code role="tablist"} and {@code role="tabpanel"} regions
 * (a11y); every remaining documented prop reaches the wire through
 * {@link PropReflection}.
 */
public final class ControlRenderers {

    /** The {@code input} props with a semantic mapping (T206). */
    private static final Set<String> INPUT_HANDLED = Set.of(
            "value", "label", "placeholder", "multiline", "expands", "obscure",
            "keyboard", "keyboardType", "required", "min", "max", "pattern",
            "errorText", "maxLength", "readOnly", "enabled", "textAlign", "autofocus");

    /** The {@code textarea} props with a semantic mapping (it forces its tag). */
    private static final Set<String> TEXTAREA_HANDLED = Set.of(
            "value", "label", "placeholder", "required", "min", "max", "pattern",
            "errorText", "maxLength", "readOnly", "enabled", "textAlign", "autofocus");

    /** One {@code menu} item's props with a semantic mapping. */
    private static final Set<String> MENU_ITEM_HANDLED = Set.of(
            "label", "icon", "action", "confirm", "disabled", "divider", "danger",
            "children", "checked", "separatorBefore");

    /**
     * One {@code tabs} item's props with a semantic mapping. {@code closable}
     * and {@code closeAction} are deliberately absent: their rendering is
     * conditional on {@code hasClose}, so they always travel as reflected
     * {@code data-jhin-*} attributes and the probe sees them standalone.
     */
    private static final Set<String> TAB_ITEM_HANDLED = Set.of(
            "label", "icon", "badge", "panel");

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
                PropReflection.reflect(node, element,
                        Set.of("label", "style", "icon", "confirm"));
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
                if (node.props().get("alignment") != null) {
                    LayoutRenderers.composeStyle(node, element,
                            "display: flex; align-items: center; justify-content: center");
                }
                if (Boolean.TRUE.equals(node.props().get("autofocus"))) {
                    element.attr("autofocus", "autofocus");
                }
                Object icon = node.props().get("icon");
                boolean selected = Boolean.TRUE.equals(node.props().get("isSelected"));
                if (selected && node.props().get("selectedIcon") instanceof String selectedIcon) {
                    icon = selectedIcon;
                }
                if (icon != null) {
                    element.child(iconElement(String.valueOf(icon), node.props().get("iconSize")));
                    if (node.props().get("semanticsLabel") == null) {
                        element.attr("aria-label", String.valueOf(node.props().get("icon")));
                    }
                }
                if (selected) {
                    element.attr("aria-pressed", "true");
                }
                PropReflection.reflect(node, element, Set.of(
                        "icon", "iconSize", "isSelected", "alignment", "autofocus"));
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
                if (node.props().get("textDirection") != null) {
                    element.attr("dir", String.valueOf(node.props().get("textDirection")));
                }
                PropReflection.reflect(node, element,
                        Set.of("icon", "size", "semanticLabel", "textDirection"));
            }
        };
    }

    /**
     * The shared {@code <svg data-jhin-icon="…">} placeholder: empty content
     * until the inline-SVG registry; an unknown name is an empty svg, never a
     * crash (section 2.4).
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
                    PropReflection.reflect(node, element, INPUT_HANDLED);
                    return;
                }
                element.attr("type", inputType(node));
                if (node.props().get("value") != null) {
                    element.attr("value", String.valueOf(node.props().get("value")));
                }
                commonInputAttrs(node, element);
                PropReflection.reflect(node, element, INPUT_HANDLED);
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
                PropReflection.reflect(node, element, TEXTAREA_HANDLED);
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

    /**
     * The shared input/textarea attribute surface, including the validation
     * attributes the client dispatcher reads off the DOM (T204/T206):
     * {@code required}, {@code min}, {@code max}, {@code pattern} and the
     * failure text in {@code data-jhin-error-text}.
     */
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
        if (node.props().get("min") != null) {
            element.attr("min", String.valueOf(node.props().get("min")));
        }
        if (node.props().get("max") != null) {
            element.attr("max", String.valueOf(node.props().get("max")));
        }
        if (node.props().get("pattern") != null) {
            element.attr("pattern", String.valueOf(node.props().get("pattern")));
        }
        if (node.props().get("errorText") != null) {
            element.attr("data-jhin-error-text", String.valueOf(node.props().get("errorText")));
        }
        if (node.props().get("textAlign") != null) {
            LayoutRenderers.composeStyle(node, element,
                    "text-align: " + node.props().get("textAlign"));
        }
        if (Boolean.TRUE.equals(node.props().get("autofocus"))) {
            element.attr("autofocus", "autofocus");
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
                if (Boolean.TRUE.equals(node.props().get("isExpanded"))) {
                    LayoutRenderers.composeStyle(node, element, "width: 100%");
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
                PropReflection.reflect(node, element,
                        Set.of("label", "items", "value", "hint", "isExpanded", "enabled"));
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
                if (node.props().get("tristate") != null) {
                    input.attr("data-jhin-tristate",
                            String.valueOf(node.props().get("tristate")));
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
                PropReflection.reflect(node, element, Set.of("label", "value", "enabled", "tristate"));
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
                if (node.props().get("semanticFormatterCallback") instanceof String template
                        && node.props().get("value") != null) {
                    element.attr("aria-valuetext", template.replace(
                            "{value}", number(node.props().get("value"))));
                }
                if (Boolean.FALSE.equals(node.props().get("enabled"))) {
                    element.attr("disabled", "disabled");
                }
                PropReflection.reflect(node, element, Set.of(
                        "min", "max", "step", "value", "label",
                        "semanticFormatterCallback", "enabled"));
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
                    PropReflection.reflect(map, button, Set.of("label", "action", "confirm"));
                    element.child(button);
                }
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, Set.of("fields", "submit"));
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
                        HtmlRenderer.applyActionAttrs(button, map.get("action"), map.get("confirm"));
                        PropReflection.reflect(map, button,
                                Set.of("value", "icon", "label", "action", "confirm"));
                        element.child(button);
                    }
                }
                PropReflection.reflect(node, element, Set.of("segments", "value"));
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
                PropReflection.reflect(node, element, Set.of("trigger", "items"));
            }
        };
    }

    /**
     * One {@code menu} entry ({@code label, icon?, action?, confirm?,
     * disabled?, divider?, danger?, checked?, separatorBefore?, children?}):
     * a {@code <button role="menuitem">} carrying the item action, or an
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
        PropReflection.reflect(map, button, MENU_ITEM_HANDLED);
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

    /**
     * {@code tabs} (T206 a11y split): the root {@code <div class="jhin-tabs">}
     * holds a {@code <div class="jhin-tabs-list" role="tablist">} of
     * {@code <button role="tab">} entries and one
     * {@code <div class="jhin-tabpanel" role="tabpanel">} per panel
     * <em>outside</em> the tablist — never inside it. Tabs carry
     * {@code aria-selected} (and {@code aria-controls}/{@code aria-labelledby}
     * when the node {@code id} makes the pairing addressable); with
     * {@code hasClose} every closable tab gets its close button carrying the
     * item {@code closeAction}, and {@code closeAction} of the node itself
     * rides on the root (the last-closable-tab lifecycle).
     */
    private static NodeRenderer tabs() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                Object variant = node.props().get("variant");
                element.attr("class", "jhin-tabs"
                        + (variant != null ? " jhin-tabs-" + variant : " jhin-tabs-underline"));
                HtmlNode list = new HtmlNode("div")
                        .attr("class", "jhin-tabs-list")
                        .attr("role", "tablist");
                HtmlNode panels = new HtmlNode("div").attr("class", "jhin-tabs-panels");
                boolean hasPanels = false;
                int active = node.props().get("activeIndex") instanceof Number number
                        ? number.intValue() : 0;
                boolean hasClose = Boolean.TRUE.equals(node.props().get("hasClose"));
                String baseId = node.props().get("id") == null
                        ? null : String.valueOf(node.props().get("id"));
                if (node.props().get("items") instanceof List<?> items) {
                    for (int i = 0; i < items.size(); i++) {
                        if (!(items.get(i) instanceof Map<?, ?> map)) {
                            continue;
                        }
                        String tabId = baseId == null ? null : baseId + "-tab-" + i;
                        String panelId = baseId == null ? null : baseId + "-panel-" + i;
                        list.child(tab(map, i == active, hasClose, tabId, panelId));
                        if (map.get("panel") != null) {
                            panels.child(panel(map, panelId, tabId, i == active));
                            hasPanels = true;
                        }
                    }
                }
                element.child(list);
                if (hasPanels) {
                    element.child(panels);
                }
                PropReflection.reflect(node, element,
                        Set.of("items", "activeIndex", "variant", "hasClose"));
            }
        };
    }

    /** One {@code role="tab"} button (section 2.6 tabs item). */
    private static HtmlNode tab(Map<?, ?> map, boolean active, boolean hasClose,
            String tabId, String panelId) {
        HtmlNode button = new HtmlNode("button")
                .attr("type", "button")
                .attr("class", "jhin-tab")
                .attr("role", "tab")
                .attr("aria-selected", active ? "true" : "false");
        if (tabId != null) {
            button.attr("id", tabId);
            if (panelId != null) {
                button.attr("aria-controls", panelId);
            }
        }
        boolean closable = hasClose && !Boolean.FALSE.equals(map.get("closable"));
        if (hasClose && !closable) {
            button.attr("class", "jhin-tab jhin-tab-pinned");
        }
        if (map.get("icon") instanceof String icon) {
            button.child(iconElement(icon, null));
        }
        if (map.get("label") != null) {
            button.textChild(String.valueOf(map.get("label")));
        }
        if (map.get("badge") != null) {
            HtmlRenderer.appendContent(button, map.get("badge"));
        }
        if (closable) {
            HtmlNode close = new HtmlNode("span")
                    .attr("class", "jhin-tab-close")
                    .attr("role", "button")
                    .attr("aria-label", "Close");
            HtmlRenderer.applyActionAttrs(close, map.get("closeAction"), null);
            button.child(close);
        }
        PropReflection.reflect(map, button, TAB_ITEM_HANDLED);
        return button;
    }

    /** One {@code role="tabpanel"} region; the active tab is the visible one. */
    private static HtmlNode panel(Map<?, ?> map, String panelId, String tabId, boolean active) {
        HtmlNode panelElement = new HtmlNode("div")
                .attr("class", "jhin-tabpanel")
                .attr("role", "tabpanel");
        if (panelId != null) {
            panelElement.attr("id", panelId);
            if (tabId != null) {
                panelElement.attr("aria-labelledby", tabId);
            }
        }
        if (!active) {
            panelElement.attr("hidden", "hidden");
        }
        HtmlRenderer.appendContent(panelElement, map.get("panel"));
        return panelElement;
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
                    PropReflection.reflect(node, element, Set.of("chord"));
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
                PropReflection.reflect(node, element, Set.of("chord"));
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
                PropReflection.reflect(node, element, Set.of("child", "edge", "mode"));
            }
        };
    }
}
