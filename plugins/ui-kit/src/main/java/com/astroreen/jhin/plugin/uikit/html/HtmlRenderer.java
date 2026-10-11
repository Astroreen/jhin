/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.renderers.ControlRenderers;
import com.astroreen.jhin.plugin.uikit.html.renderers.DataRenderers;
import com.astroreen.jhin.plugin.uikit.html.renderers.LayoutRenderers;
import com.astroreen.jhin.plugin.uikit.html.renderers.NavRenderers;
import com.astroreen.jhin.plugin.uikit.html.renderers.NodeRenderer;
import com.astroreen.jhin.plugin.uikit.html.renderers.SurfaceRenderers;
import com.astroreen.jhin.plugin.uikit.html.renderers.TextRenderers;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The {@code UiNode} &rarr; HTML serializer of the SDUI contract
 * (docs/sdui.md section 9): one pure function from a node tree to an HTML
 * fragment, with no {@code <html>} document wrapper and no per-request state.
 *
 * <p>Pipeline per node (docs/sdui.md sections 2.3, 9.1, 9.2):
 *
 * <ol>
 *   <li>meta pass — {@code visible: false} omits the element entirely;
 *       {@code when} stays visible and becomes {@code data-jhin-when}
 *       (the client re-evaluates the expression);</li>
 *   <li>element choice — the per-family {@link NodeRenderer} for the type,
 *       or the {@code jhin-unsupported} placeholder card for an unknown type
 *       (the level-4 degradation rule: an unknown type renders a placeholder,
 *       the client never crashes);</li>
 *   <li>attribute protocol — {@code data-jhin-type} always,
 *       {@code data-jhin-id} + HTML {@code id} when the node has an
 *       {@code id} prop, {@code data-jhin-action='<json>'} (the one
 *       single-quoted attribute) plus {@code data-jhin-confirm};</li>
 *   <li>universal-prop pass — {@link UniversalProps} in the section 2.3
 *       order;</li>
 *   <li>family content — the renderer's attributes and children; nested
 *       nodes (children and node-valued props like {@code items},
 *       {@code fields}, {@code rows}) recurse through this same pipeline,
 *       mirroring {@code UiNode.toJson()}'s {@code wireValue()} recursion;
 *       a plain {@code String} in a content position is the wire text
 *       shorthand and renders as a {@code text} node.</li>
 * </ol>
 *
 * <p>Escaping: every attribute value and every text child goes through
 * {@link HtmlNode}, which escapes via {@link HtmlEsc}. The single unescaped
 * path in the whole renderer is {@code Ui.raw(String)} &rarr; the {@code raw}
 * node below &rarr; {@link HtmlNode#rawChild(String)}, reserved for trusted,
 * server-authored chrome ({@code RawEscapeSweepTest} enforces that product
 * screens never use it).
 *
 * <p>Entry points {@link #render(UiNode)} and {@link #renderFragment(UiNode)}
 * are pure and thread-safe; {@link HtmlNode} instances are per-render.
 */
public final class HtmlRenderer {

    /** The type of the {@code Ui.raw} escape-hatch node. */
    public static final String RAW_TYPE = "raw";

    /** The class of the unsupported-type placeholder card (section 2.4). */
    public static final String UNSUPPORTED_CLASS = "jhin-unsupported";

    /**
     * The {@code Ui.raw} escape hatch: a {@code raw} node emits its
     * {@code html} prop verbatim through {@link HtmlNode#rawChild(String)} —
     * the single unescaped path in the renderer, trusted server-authored
     * chrome only (docs/web-client.md section 3). Declared before
     * {@link #REGISTRY} so static initialization order is safe.
     */
    private static final NodeRenderer RAW_RENDERER = new NodeRenderer() {
        @Override
        public String tag(UiNode node) {
            return "div";
        }

        @Override
        public void fill(UiNode node, HtmlNode element) {
            element.attr("class", "jhin-raw");
            Object html = node.props().get("html");
            if (html != null) {
                element.rawChild(String.valueOf(html));
            }
        }
    };

    /**
     * The per-type renderer registry: one renderer per primitive family,
     * keyed by wire type name. Unmodifiable and built once.
     */
    private static final Map<String, NodeRenderer> REGISTRY = registry();

    private HtmlRenderer() {
    }

    // --- entry points -----------------------------------------------------

    /**
     * Renders one node to an HTML fragment. No {@code <html>} document
     * wrapper — the shell document is a separate concern (the web client
     * plan, T202).
     *
     * @param node the node; {@code null} renders as the empty string
     * @return the HTML fragment, or the empty string when the node is
     *         {@code visible: false}
     */
    public static String render(UiNode node) {
        if (node == null || !UniversalProps.isVisible(node)) {
            return "";
        }
        return element(node).render();
    }

    /**
     * Renders one node to an HTML fragment, named for the patch/frame call
     * sites that consume fragments (identical semantics to
     * {@link #render(UiNode)}: a node &rarr; an element, never a document).
     *
     * @param node the node; {@code null} renders as the empty string
     * @return the HTML fragment
     */
    public static String renderFragment(UiNode node) {
        return render(node);
    }

    // --- recursion surface for the family renderers -----------------------

    /**
     * Appends one nested node through the full pipeline. An invisible node
     * ({@code visible: false}) appends nothing.
     *
     * @param target the parent element
     * @param node   the nested node; {@code null} is ignored
     */
    public static void appendNode(HtmlNode target, UiNode node) {
        if (node == null || !UniversalProps.isVisible(node)) {
            return;
        }
        target.child(element(node));
    }

    /**
     * Appends a prop or child value through the wire-value recursion of
     * {@code UiNode.toJson()}'s {@code wireValue()}: nodes render through the
     * full pipeline, lists and maps recurse element-wise (map values, keys
     * are structure), and a plain string is the wire text shorthand &rarr; a
     * {@code text} node. Anything else becomes escaped text.
     *
     * @param target the parent element
     * @param value  the value to render
     */
    public static void appendContent(HtmlNode target, Object value) {
        if (value == null) {
            return;
        }
        if (value instanceof UiNode node) {
            appendNode(target, node);
            return;
        }
        if (value instanceof List<?> list) {
            for (Object item : list) {
                appendContent(target, item);
            }
            return;
        }
        if (value instanceof Map<?, ?> map) {
            for (Object item : map.values()) {
                appendContent(target, item);
            }
            return;
        }
        if (value instanceof String text) {
            appendNode(target, textNode(text));
            return;
        }
        target.textChild(String.valueOf(value));
    }

    /**
     * Appends one prop of a node through {@link #appendContent(HtmlNode,
     * Object)}; absent props append nothing.
     *
     * @param target the parent element
     * @param node   the node whose prop to render
     * @param key    the prop name
     */
    public static void appendProp(HtmlNode target, UiNode node, String key) {
        appendContent(target, node.props().get(key));
    }

    /**
     * Appends the children list of a node (the wire {@code children} key):
     * nested nodes through the pipeline, strings as text shorthand.
     *
     * @param target the parent element
     * @param node   the node whose children to render
     */
    public static void appendChildren(HtmlNode target, UiNode node) {
        for (Object child : node.children()) {
            appendContent(target, child);
        }
    }

    /**
     * The wire text shorthand: a plain string as a {@code text} node.
     *
     * @param text the string
     * @return the {@code text} node
     */
    public static UiNode textNode(String text) {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("text", text);
        return new UiNode("text", props, List.of());
    }

    /**
     * The primitive class name of a type: {@code jhin-} + the type with
     * underscores folded to hyphens ({@code list_row} &rarr;
     * {@code jhin-list-row}).
     *
     * @param type the wire type name
     * @return the class name
     */
    public static String typeClass(String type) {
        return "jhin-" + type.replace('_', '-');
    }

    /**
     * Writes the action protocol attributes onto an element:
     * {@code data-jhin-action='<json>'} (the one single-quoted attribute, the
     * JSON escaped by {@link HtmlEsc#attrSingle(String)}) and
     * {@code data-jhin-confirm="<message>"} when a confirm is present. Used
     * by the pipeline for node-level actions and by the family renderers for
     * item-level actions (menu entries, nav items, …).
     *
     * @param element the element
     * @param action  the action descriptor (map, {@code {"client":[…]}}
     *                composite or any wire value); {@code null} writes
     *                nothing
     * @param confirm the confirmation message; {@code null} writes nothing
     */
    public static void applyActionAttrs(HtmlNode element, Object action, Object confirm) {
        if (action != null) {
            element.attrSingle("data-jhin-action", actionJson(action));
        }
        if (confirm != null) {
            element.attr("data-jhin-confirm", String.valueOf(confirm));
        }
    }

    /**
     * Serializes an action descriptor to the JSON of
     * {@code data-jhin-action}: maps, lists, strings, numbers and booleans
     * recurse, strings are quoted and escaped, anything else degrades to its
     * string form.
     *
     * @param value the action descriptor
     * @return the JSON text
     */
    public static String actionJson(Object value) {
        StringBuilder out = new StringBuilder();
        writeJson(value, out);
        return out.toString();
    }

    // --- the pipeline -----------------------------------------------------

    /**
     * The element of one <em>visible</em> node: protocol, universal props and
     * family content. Callers must have checked {@link
     * UniversalProps#isVisible(UiNode)} first.
     */
    private static HtmlNode element(UiNode node) {
        NodeRenderer renderer = REGISTRY.get(node.type());
        HtmlNode element = new HtmlNode(renderer != null ? renderer.tag(node) : "div");
        element.attr("data-jhin-type", node.type());
        if (renderer == null) {
            element.attr("class", UNSUPPORTED_CLASS);
        }
        UniversalProps.apply(node, element);
        if (renderer != null) {
            renderer.fill(node, element);
        }
        applyNodeAction(node, element);
        return element;
    }

    /**
     * The node-level action protocol: {@code action}, falling back to
     * {@code onTap} and {@code onLongPress} (the section 2.1 interaction
     * group), plus the {@code confirm} prompt.
     */
    private static void applyNodeAction(UiNode node, HtmlNode element) {
        Object action = node.props().get("action");
        if (action == null) {
            action = node.props().get("onTap");
        }
        if (action == null) {
            action = node.props().get("onLongPress");
        }
        applyActionAttrs(element, action, node.props().get("confirm"));
    }

    private static Map<String, NodeRenderer> registry() {
        Map<String, NodeRenderer> registry = new LinkedHashMap<>();
        registry.putAll(LayoutRenderers.renderers());
        registry.putAll(TextRenderers.renderers());
        registry.putAll(ControlRenderers.renderers());
        registry.putAll(SurfaceRenderers.renderers());
        registry.putAll(DataRenderers.renderers());
        registry.putAll(NavRenderers.renderers());
        registry.put(RAW_TYPE, RAW_RENDERER);
        return Collections.unmodifiableMap(registry);
    }

    // --- JSON for the action attribute ------------------------------------

    private static void writeJson(Object value, StringBuilder out) {
        if (value == null) {
            out.append("null");
            return;
        }
        switch (value) {
            case Map<?, ?> map -> {
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    writeJson(String.valueOf(entry.getKey()), out);
                    out.append(':');
                    writeJson(entry.getValue(), out);
                }
                out.append('}');
            }
            case List<?> list -> {
                out.append('[');
                for (int i = 0; i < list.size(); i++) {
                    if (i > 0) {
                        out.append(',');
                    }
                    writeJson(list.get(i), out);
                }
                out.append(']');
            }
            case String text -> writeJsonString(text, out);
            case Boolean flag -> out.append(flag ? "true" : "false");
            case Number number -> out.append(number.toString());
            default -> writeJsonString(String.valueOf(value), out);
        }
    }

    private static void writeJsonString(String text, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }
}
