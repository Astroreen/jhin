/**
 * One node of the server-driven UI tree and its JSON wire shape.
 *
 * <p>A node is a {@code type} discriminator, a {@code props} map and a list of
 * {@code children}. The universal optional fields of the primitive catalog
 * ({@code id}, {@code visible}, {@code padding}, {@code flex}, {@code when}) are
 * ordinary props; nothing about them is special-cased here. {@link #toJson()}
 * produces the wire shape of the SDUI contract: {@code {"type":…, …props…,
 * "children":[…]}} with nested nodes converted recursively. A child may be a
 * string, which is the wire shorthand for {@code {"type":"text","text":"…"}}.
 */
package com.astroreen.jhin.plugin.uikit;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class UiNode {

    private final String type;
    private final Map<String, Object> props;
    private final List<Object> children;

    /**
     * Creates a node, defensively copying the props and the children into
     * immutable structures. Called by the {@link Ui} builders and by tests.
     *
     * @param type     the primitive type name (never {@code null})
     * @param props    the node props; {@code null} means none
     * @param children the child nodes or strings; {@code null} means none
     */
    public UiNode(String type, Map<String, Object> props, List<Object> children) {
        this.type = Objects.requireNonNull(type, "type");
        Map<String, Object> copiedProps = new LinkedHashMap<>();
        if (props != null) {
            for (Map.Entry<String, Object> entry : props.entrySet()) {
                copiedProps.put(Objects.requireNonNull(entry.getKey(), "prop name"), entry.getValue());
            }
        }
        this.props = Collections.unmodifiableMap(copiedProps);
        List<Object> copiedChildren = new ArrayList<>();
        if (children != null) {
            for (Object child : children) {
                copiedChildren.add(Objects.requireNonNull(child, "child"));
            }
        }
        this.children = Collections.unmodifiableList(copiedChildren);
    }

    /**
     * Creates a prop-less, child-less node. Called for the empty primitives
     * ({@code divider}) and by tests.
     *
     * @param type the primitive type name
     * @return the node
     */
    public static UiNode of(String type) {
        return new UiNode(type, Map.of(), List.of());
    }

    /**
     * The primitive type name.
     *
     * @return the type discriminator of the wire shape
     */
    public String type() {
        return type;
    }

    /**
     * The node props, in insertion order.
     *
     * @return an immutable view of the props
     */
    public Map<String, Object> props() {
        return props;
    }

    /**
     * The node children: {@link UiNode} values or plain strings (the text
     * shorthand).
     *
     * @return an immutable view of the children
     */
    public List<Object> children() {
        return children;
    }

    /**
     * The JSON wire shape of this node: {@code type} first, then the props in
     * insertion order, then {@code children} when present. Nested nodes — in
     * the children and inside props like {@code fields}, {@code items} or
     * {@code rows} — convert recursively; strings and numbers stay as they
     * are. Called by the routes that assemble payloads.
     *
     * @return the wire shape as a JSON-serializable map
     */
    public Map<String, Object> toJson() {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("type", type);
        for (Map.Entry<String, Object> entry : props.entrySet()) {
            json.put(entry.getKey(), wireValue(entry.getValue()));
        }
        if (!children.isEmpty()) {
            json.put("children", children.stream().map(UiNode::wireValue).toList());
        }
        return json;
    }

    /**
     * Converts one prop or child value to its wire form: nodes to their maps,
     * lists and maps recursively, everything else untouched.
     *
     * @param value the value to convert
     * @return the wire value
     */
    private static Object wireValue(Object value) {
        if (value instanceof UiNode node) {
            return node.toJson();
        }
        if (value instanceof List<?> list) {
            return list.stream().map(UiNode::wireValue).toList();
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                out.put(String.valueOf(entry.getKey()), wireValue(entry.getValue()));
            }
            return out;
        }
        return value;
    }
}
