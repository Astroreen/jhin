/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html;

import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The universal-prop surface of docs/sdui.md section 2.1 applied to ONE
 * element, in the fixed application order of section 2.3.
 *
 * <p>The 15-step Flutter wrapping order collapses into properties of a single
 * box: decoration &rarr; padding &rarr; min/max/width/height &rarr;
 * aspect-ratio &rarr; opacity &rarr; transform &rarr; clip(overflow) &rarr;
 * align(justify/self) &rarr; {@code title} (tooltip) &rarr; pointer/keyboard
 * handlers &rarr; ARIA &rarr; flex ({@code flex}/{@code fit} map to
 * {@code flex-grow}/{@code flex}) &rarr; margin. The order is normative and
 * tested: the emitted {@code style} attribute carries its declarations in
 * exactly this order (declaration order = application order), and every
 * attribute ({@code title}, {@code tabindex}, the ARIA set, the
 * {@code data-jhin-*} meta) is written in its step. No wrapper elements are
 * ever introduced.
 *
 * <p>Attribute values are escaped by {@link HtmlEsc} through
 * {@link HtmlNode#attr(String, String)}; nothing here concatenates raw
 * markup. Values interpolated into the {@code style} attribute additionally
 * have the CSS declaration-separators ({@code ;}, {@code {@}, {@code }})
 * neutralized as CSS hex escapes, so a prop value can never smuggle extra
 * declarations. {@code data-jhin-action} wiring is deliberately absent: the
 * action attributes are a later chunk.
 *
 * <p>Meta protocol (section 9.2): {@code id} sets both the HTML {@code id}
 * attribute and {@code data-jhin-id}; {@code when} becomes
 * {@code data-jhin-when} and the node <em>stays visible</em> (the client
 * evaluates the expression and only an explicit {@code false} hides); the
 * first string prop carrying a {@code ${&hellip;}} template becomes
 * {@code data-jhin-template}. {@code visible: false} is NOT applied here —
 * the caller must omit the element entirely and query
 * {@link #isVisible(UiNode)} first.
 *
 * <p>{@code $family.key} token references in structural props resolve to
 * {@code var(--family-key)} through {@link TokenCss#resolveReference(String)};
 * text-content props ({@code text}, {@code label}, {@code title},
 * {@code subtitle}, {@code message}, {@code placeholder}, {@code hint},
 * {@code id}, {@code when}, {@code pattern}) keep a leading {@code $} as
 * literal content (a price, a mention). Unknown references render as the
 * literal string (section 2.4 degradation).
 *
 * <p>This class is stateless and thread-safe.
 */
public final class UniversalProps {

    /**
     * Props whose string value is content, never a token reference — a
     * leading {@code $} there is literal text. Mirrors the level-3 client's
     * exempt set.
     */
    private static final Set<String> TOKEN_EXEMPT = Set.of(
            "id", "when", "pattern", "text", "label", "title", "subtitle",
            "message", "placeholder", "hint");

    /** Primitives whose {@code color} is the foreground/text color, not a background. */
    private static final Set<String> COLOR_BEARING =
            Set.of("text", "markdown", "rich_text", "icon", "icon_button");

    /** Primitives whose {@code height} is the line-height multiple (section 2.1 Text). */
    private static final Set<String> TEXT_BEARING = Set.of("text", "markdown", "rich_text");

    /** Primitives whose {@code alignment} is their own layout prop (section 2.6), never the universal alias. */
    private static final Set<String> OWN_ALIGNMENT = Set.of("stack", "wrap", "icon_button");

    /**
     * Type-specific roles of the universal {@code color} (section 2.6 gives
     * the prop a per-primitive meaning): {@code divider} paints its line,
     * {@code progress} its bar; everything else keeps the group default
     * (foreground on {@link #COLOR_BEARING}, background elsewhere).
     */
    private static final Map<String, String> COLOR_PROPERTY = Map.of(
            "divider", "border-top-color",
            "progress", "accent-color");

    /** The shared {@code demo} tooltip (section 2.1 level 3). */
    private static final String DEMO_TOOLTIP = "Preview only — not available in this build";

    /** {@code clip} literals (section 2.1) to CSS {@code overflow}. */
    private static final Map<String, String> CLIP_OVERFLOW = Map.of(
            "none", "visible",
            "hardEdge", "hidden",
            "softEdge", "hidden",
            "antiAlias", "hidden",
            "antiAliasWithSaveLayer", "hidden");

    /** {@code cursor} literals (section 2.1) to CSS {@code cursor} values. */
    private static final Map<String, String> CURSOR_CSS = Map.ofEntries(
            Map.entry("system", "default"),
            Map.entry("none", "none"),
            Map.entry("click", "pointer"),
            Map.entry("text", "text"),
            Map.entry("forbidden", "not-allowed"),
            Map.entry("grab", "grab"),
            Map.entry("grabbing", "grabbing"),
            Map.entry("wait", "wait"),
            Map.entry("precise", "crosshair"),
            Map.entry("allScroll", "all-scroll"),
            Map.entry("resizeUpDown", "ns-resize"),
            Map.entry("resizeLeftRight", "ew-resize"),
            Map.entry("alias", "alias"),
            Map.entry("cell", "cell"),
            Map.entry("contextMenu", "context-menu"),
            Map.entry("copy", "copy"),
            Map.entry("help", "help"),
            Map.entry("move", "move"),
            Map.entry("noDrop", "no-drop"),
            Map.entry("progress", "progress"),
            Map.entry("zoomIn", "zoom-in"),
            Map.entry("zoomOut", "zoom-out"));

    /** Alignment literals (section 2.1) to {@code {justify-self, align-self}} pairs. */
    private static final Map<String, String[]> ALIGN_SELF = Map.ofEntries(
            Map.entry("topLeft", new String[] {"start", "start"}),
            Map.entry("topCenter", new String[] {"center", "start"}),
            Map.entry("topRight", new String[] {"end", "start"}),
            Map.entry("centerLeft", new String[] {"start", "center"}),
            Map.entry("center", new String[] {"center", "center"}),
            Map.entry("centerRight", new String[] {"end", "center"}),
            Map.entry("bottomLeft", new String[] {"start", "end"}),
            Map.entry("bottomCenter", new String[] {"center", "end"}),
            Map.entry("bottomRight", new String[] {"end", "end"}));

    private UniversalProps() {
    }

    /**
     * Applies the universal surface of one node to one element: the meta
     * attributes ({@code id}/{@code data-jhin-id}/{@code data-jhin-when}/
     * {@code data-jhin-template}) first, then the thirteen application steps
     * of section 2.3. The type-aware rules follow the node type: {@code color}
     * is a foreground on {@code text}/{@code markdown}/{@code rich_text}/
     * {@code icon}/{@code icon_button} and a background elsewhere; {@code height}
     * is the line-height multiple on text-bearing nodes and a box constraint
     * elsewhere.
     *
     * <p>The caller must omit the element entirely when {@link #isVisible(UiNode)}
     * is {@code false}; this method applies the surface regardless (a
     * {@code visible: false} node that is still rendered is a caller bug).
     *
     * <p>Writes the single {@code style} attribute (declarations in
     * application order); a renderer that needs additional inline
     * declarations composes the final value through {@link #styleOf(UiNode)}
     * and sets the attribute itself.
     *
     * @param node     the node whose universal props to apply
     * @param element  the element to apply them to
     */
    public static void apply(UiNode node, HtmlNode element) {
        apply(node.type(), node.props(), element);
    }

    /**
     * Applies a universal prop map with generic box semantics (no type is
     * known, so {@code color} is a background and {@code height} a box
     * constraint). See {@link #apply(UiNode, HtmlNode)} for the protocol.
     *
     * @param props    the universal props
     * @param element  the element to apply them to
     */
    public static void apply(Map<String, Object> props, HtmlNode element) {
        apply(null, props, element);
    }

    /**
     * The style declarations of the universal surface, in the application
     * order of section 2.3, or the empty string when the props carry none.
     * Public so a renderer can compose extra inline declarations around the
     * universal ones (the {@code style} attribute is single-valued).
     *
     * @param node the node
     * @return the declarations, {@code prop: value} joined by {@code "; "}
     */
    public static String styleOf(UiNode node) {
        return styleOf(node.type(), node.props());
    }

    /**
     * The style declarations of a universal prop map with generic box
     * semantics; see {@link #styleOf(UiNode)}.
     *
     * @param props the universal props
     * @return the declarations, or the empty string
     */
    public static String styleOf(Map<String, Object> props) {
        return styleOf(null, props);
    }

    /**
     * Whether the node renders at all: {@code visible} defaults to
     * {@code true} and only an explicit {@code false} (boolean or the string
     * {@code "false"}) omits the element. {@code when} never hides here —
     * the client evaluates it at runtime and a parse failure keeps the node
     * visible (section 2.4).
     *
     * @param node the node
     * @return {@code true} when the renderer must emit the element
     */
    public static boolean isVisible(UiNode node) {
        return isVisible(node.props());
    }

    /**
     * Whether a universal prop map renders at all; see
     * {@link #isVisible(UiNode)}.
     *
     * @param props the universal props
     * @return {@code true} when the renderer must emit the element
     */
    public static boolean isVisible(Map<String, Object> props) {
        Object value = props.get("visible");
        if (value instanceof Boolean flag) {
            return flag;
        }
        if (value instanceof String text) {
            return !text.equalsIgnoreCase("false");
        }
        return true;
    }

    // --- application ------------------------------------------------------

    private static void apply(String type, Map<String, Object> props, HtmlNode element) {
        meta(props, element);
        title(props, element);
        handlers(props, element);
        aria(props, element);
        level3(props, element);
        String style = styleOf(type, props);
        if (!style.isEmpty()) {
            element.attr("style", style);
        }
    }

    private static String styleOf(String type, Map<String, Object> props) {
        StringBuilder style = new StringBuilder();
        decoration(props, type, style);
        edge(props, "padding", "padding", style);
        constraints(props, type, style);
        aspectRatio(props, style);
        opacity(props, style);
        transform(props, style);
        clip(props, style);
        align(props, type, style);
        cursor(props, style);
        flex(props, style);
        edge(props, "margin", "margin", style);
        return style.toString();
    }

    private static void meta(Map<String, Object> props, HtmlNode element) {
        Object id = props.get("id");
        if (id != null) {
            String value = String.valueOf(id);
            element.attr("id", value);
            element.attr("data-jhin-id", value);
        }
        Object when = props.get("when");
        if (when != null) {
            element.attr("data-jhin-when", String.valueOf(when));
        }
        for (Map.Entry<String, Object> entry : props.entrySet()) {
            if (Set.of("id", "when", "pattern").contains(entry.getKey())) {
                continue;
            }
            Object value = entry.getValue();
            if (value instanceof String text && text.contains("${")) {
                element.attr("data-jhin-template", text);
                break;
            }
        }
    }

    /** Step 1 — decoration, plus the text style on text-bearing nodes. */
    private static void decoration(Map<String, Object> props, String type, StringBuilder style) {
        boolean textBearing = type != null && TEXT_BEARING.contains(type);
        String colorProperty = colorProperty(type);
        Object color = props.get("color");
        // The divider line color lands after the border shorthand below so
        // the shorthand cannot clobber it.
        if (color != null && !"border-top-color".equals(colorProperty)) {
            decl(style, colorProperty, cssText(color, "color"));
        }
        if (props.get("gradient") instanceof Map<?, ?> gradient) {
            String value = gradientImage(gradient);
            if (value != null) {
                decl(style, "background-image", value);
            }
        }
        Object border = props.get("border");
        Object borderWidth = props.get("borderWidth");
        Object borderStyle = props.get("borderStyle");
        if (border != null || borderWidth != null || borderStyle != null) {
            String width = borderWidth != null ? cssLength(borderWidth, "borderWidth") : "1px";
            String borderType = borderStyle != null ? cssText(borderStyle, "borderStyle") : "solid";
            String borderColor = border != null ? cssText(border, "border") : "currentColor";
            decl(style, "border", width + " " + borderType + " " + borderColor);
        }
        if (color != null && "border-top-color".equals(colorProperty)) {
            decl(style, colorProperty, cssText(color, "color"));
        }
        if (props.get("borderRadius") != null) {
            decl(style, "border-radius", cssLength(props.get("borderRadius"), "borderRadius"));
        }
        if (props.get("shadow") != null) {
            String value = shadow(props.get("shadow"));
            if (value != null) {
                decl(style, "box-shadow", value);
            }
        }
        if (textBearing) {
            textStyle(props, style);
        }
    }

    /** The CSS property the universal {@code color} writes for this type. */
    private static String colorProperty(String type) {
        String role = type == null ? null : COLOR_PROPERTY.get(type);
        if (role != null) {
            return role;
        }
        return type != null && COLOR_BEARING.contains(type) ? "color" : "background-color";
    }

    private static void textStyle(Map<String, Object> props, StringBuilder style) {
        if (props.get("fontFamily") != null) {
            decl(style, "font-family", cssText(props.get("fontFamily"), "fontFamily"));
        }
        if (props.get("fontSize") != null) {
            decl(style, "font-size", cssLength(props.get("fontSize"), "fontSize"));
        }
        if (props.get("fontWeight") != null) {
            decl(style, "font-weight", cssPlain(props.get("fontWeight"), "fontWeight"));
        }
        if (props.get("fontStyle") != null) {
            decl(style, "font-style", cssText(props.get("fontStyle"), "fontStyle"));
        }
        if (props.get("letterSpacing") != null) {
            decl(style, "letter-spacing", cssLength(props.get("letterSpacing"), "letterSpacing"));
        }
        if (props.get("wordSpacing") != null) {
            decl(style, "word-spacing", cssLength(props.get("wordSpacing"), "wordSpacing"));
        }
        if (props.get("height") != null) {
            decl(style, "line-height", cssPlain(props.get("height"), "height"));
        }
        if (props.get("textAlign") != null) {
            decl(style, "text-align", cssText(props.get("textAlign"), "textAlign"));
        }
        if (props.get("textDecoration") != null) {
            String value = cssText(props.get("textDecoration"), "textDecoration");
            decl(style, "text-decoration", "lineThrough".equals(value) ? "line-through" : value);
        }
        String overflow = null;
        if (props.get("textOverflow") != null) {
            overflow = cssText(props.get("textOverflow"), "textOverflow");
        } else if (Boolean.TRUE.equals(props.get("ellipsis"))) {
            overflow = "ellipsis";
        }
        if (overflow != null && !"visible".equals(overflow)) {
            decl(style, "text-overflow", overflow);
        }
        if (props.get("softWrap") instanceof Boolean softWrap) {
            decl(style, "white-space", softWrap ? "normal" : "nowrap");
        }
        if (props.get("maxLines") instanceof Number lines) {
            // The line-clamp recipe: the -webkit-box display pair is what
            // makes -webkit-line-clamp take effect (T206).
            decl(style, "display", "-webkit-box");
            decl(style, "-webkit-box-orient", "vertical");
            decl(style, "-webkit-line-clamp", cssPlain(lines, "maxLines"));
            decl(style, "overflow", "hidden");
        }
    }

    /** Step 3 — the constraints, in the order min/max then width/height. */
    private static void constraints(Map<String, Object> props, String type, StringBuilder style) {
        if (props.get("minWidth") != null) {
            decl(style, "min-width", cssLength(props.get("minWidth"), "minWidth"));
        }
        if (props.get("maxWidth") != null) {
            decl(style, "max-width", cssLength(props.get("maxWidth"), "maxWidth"));
        }
        if (props.get("minHeight") != null) {
            decl(style, "min-height", cssLength(props.get("minHeight"), "minHeight"));
        }
        if (props.get("maxHeight") != null) {
            decl(style, "max-height", cssLength(props.get("maxHeight"), "maxHeight"));
        }
        if (props.get("width") != null) {
            decl(style, "width", cssLength(props.get("width"), "width"));
        }
        // On text-bearing nodes `height` is the line-height multiple and was
        // consumed by the decoration step (section 2.1 Text group); on
        // `scroll_fade` it is the fade extent (section 2.6), which the
        // gradient reads through the --jhin-fade-height custom property.
        if (props.get("height") != null && !(type != null && TEXT_BEARING.contains(type))) {
            if ("scroll_fade".equals(type)) {
                decl(style, "--jhin-fade-height", cssLength(props.get("height"), "height"));
            } else {
                decl(style, "height", cssLength(props.get("height"), "height"));
            }
        }
    }

    private static void aspectRatio(Map<String, Object> props, StringBuilder style) {
        Object ratio = props.get("aspectRatio");
        if (ratio instanceof Number number && number.doubleValue() > 0) {
            decl(style, "aspect-ratio", number(number));
        }
    }

    private static void opacity(Map<String, Object> props, StringBuilder style) {
        Object opacity = props.get("opacity");
        if (opacity instanceof Number number) {
            double clamped = Math.min(1.0, Math.max(0.0, number.doubleValue()));
            decl(style, "opacity", number(clamped));
        } else if (opacity instanceof String text) {
            decl(style, "opacity", cssText(text, "opacity"));
        }
    }

    /** Step 6 — {@code transform}: a 16-number matrix or a translate/rotate/scale object. */
    private static void transform(Map<String, Object> props, StringBuilder style) {
        Object value = props.get("transform");
        if (value instanceof List<?> matrix && matrix.size() == 16) {
            StringBuilder out = new StringBuilder("matrix3d(");
            for (int i = 0; i < 16; i++) {
                if (i > 0) {
                    out.append(", ");
                }
                Object component = matrix.get(i);
                out.append(component instanceof Number number ? number(number)
                        : cssPlain(component, "transform"));
            }
            out.append(')');
            decl(style, "transform", out.toString());
            return;
        }
        if (value instanceof Map<?, ?> parts) {
            StringBuilder out = new StringBuilder();
            if (parts.get("translate") instanceof List<?> translate
                    && (translate.size() == 2 || translate.size() == 3)) {
                out.append("translate3d(")
                        .append(cssLength(translate.get(0), "transform")).append(", ")
                        .append(cssLength(translate.get(1), "transform")).append(", ")
                        .append(translate.size() == 3
                                ? cssLength(translate.get(2), "transform") : "0px")
                        .append(')');
            }
            if (parts.get("rotate") instanceof Number rotate) {
                if (out.length() > 0) {
                    out.append(' ');
                }
                out.append("rotate(").append(number(rotate)).append("rad)");
            }
            if (parts.get("scale") instanceof List<?> scale
                    && (scale.size() == 1 || scale.size() == 2)) {
                if (out.length() > 0) {
                    out.append(' ');
                }
                out.append("scale(").append(cssPlain(scale.get(0), "transform"));
                if (scale.size() == 2) {
                    out.append(", ").append(cssPlain(scale.get(1), "transform"));
                }
                out.append(')');
            }
            if (out.length() > 0) {
                decl(style, "transform", out.toString());
            }
        }
    }

    /** Step 7 — {@code clip}/{@code clipBehavior} as {@code overflow}. */
    private static void clip(Map<String, Object> props, StringBuilder style) {
        Object value = props.get("clip");
        if (value == null) {
            value = props.get("clipBehavior");
        }
        if (value == null) {
            return;
        }
        String literal = String.valueOf(value);
        String overflow = CLIP_OVERFLOW.get(literal);
        if (overflow != null) {
            decl(style, "overflow", overflow);
        }
    }

    /** Step 8 — {@code align}/{@code alignment} as {@code justify-self}/{@code align-self}. */
    private static void align(Map<String, Object> props, String type, StringBuilder style) {
        Object value = props.get("align");
        if (value == null && (type == null || !OWN_ALIGNMENT.contains(type))) {
            value = props.get("alignment");
        }
        if (value == null) {
            return;
        }
        String[] pair = ALIGN_SELF.get(String.valueOf(value));
        if (pair != null) {
            decl(style, "justify-self", pair[0]);
            decl(style, "align-self", pair[1]);
        }
    }

    /** Step 9 — {@code tooltip} as the HTML {@code title} attribute. */
    private static void title(Map<String, Object> props, HtmlNode element) {
        Object tooltip = props.get("tooltip");
        if (tooltip != null) {
            element.attr("title", String.valueOf(tooltip));
        } else if (Boolean.TRUE.equals(props.get("demo"))) {
            // Section 2.1 level 3: the demo marker carries the shared
            // tooltip when the node has none of its own.
            element.attr("title", DEMO_TOOLTIP);
        }
    }

    /** Step 10 attributes — {@code focusable} as {@code tabindex}. */
    private static void handlers(Map<String, Object> props, HtmlNode element) {
        Object focusable = props.get("focusable");
        if (focusable instanceof Boolean flag) {
            element.attr("tabindex", flag ? "0" : "-1");
        }
    }

    /** Step 11 — the ARIA set of section 2.3. */
    private static void aria(Map<String, Object> props, HtmlNode element) {
        if (props.get("semanticsLabel") != null) {
            element.attr("aria-label", String.valueOf(props.get("semanticsLabel")));
        }
        if (props.get("semanticsHint") != null) {
            element.attr("aria-description", String.valueOf(props.get("semanticsHint")));
        }
        if (props.get("semanticsValue") != null) {
            element.attr("aria-valuetext", String.valueOf(props.get("semanticsValue")));
        }
        if (Boolean.TRUE.equals(props.get("excludeSemantics"))) {
            element.attr("aria-hidden", "true");
        }
        if (Boolean.FALSE.equals(props.get("enabled"))) {
            element.attr("aria-disabled", "true");
        }
    }

    /**
     * The level-3 universal additions (section 2.1) as inert
     * {@code data-jhin-*} attributes: {@code demo} marks the decorative
     * affordance ({@code app.css} paints the corner badge off
     * {@code data-jhin-demo}), {@code glass}/{@code glassTint} carry the
     * glass treatment identity for the five glass-capable surfaces and
     * {@code safeArea} the per-edge inset request. Values the client cannot
     * honour stay inert (section 2.4).
     */
    private static void level3(Map<String, Object> props, HtmlNode element) {
        if (Boolean.TRUE.equals(props.get("demo"))) {
            element.attr("data-jhin-demo", "true");
        }
        if (Boolean.TRUE.equals(props.get("glass"))) {
            element.attr("data-jhin-glass", "true");
        }
        if (props.get("glassTint") != null) {
            element.attr("data-jhin-glass-tint", String.valueOf(props.get("glassTint")));
        }
        Object safeArea = props.get("safeArea");
        if (safeArea instanceof Boolean flag) {
            element.attr("data-jhin-safe-area", flag ? "true" : "false");
        } else if (safeArea != null) {
            element.attr("data-jhin-safe-area", HtmlRenderer.actionJson(safeArea));
        }
    }

    /** Step 10 style — {@code cursor}. */
    private static void cursor(Map<String, Object> props, StringBuilder style) {
        Object cursor = props.get("cursor");
        if (cursor != null) {
            String value = CURSOR_CSS.get(String.valueOf(cursor));
            if (value != null) {
                decl(style, "cursor", value);
            }
        }
    }

    /** Step 12 — {@code flex} as {@code flex-grow}, {@code fit} as {@code flex}. */
    private static void flex(Map<String, Object> props, StringBuilder style) {
        Object flex = props.get("flex");
        if (flex instanceof Number number) {
            decl(style, "flex-grow", number(number));
        }
        Object fit = props.get("fit");
        if (fit != null) {
            String literal = String.valueOf(fit);
            if ("tight".equals(literal)) {
                decl(style, "flex", "1 1 0%");
            } else if ("loose".equals(literal)) {
                decl(style, "flex", "0 1 auto");
            }
        }
    }

    /** Steps 2 + 13 — {@code padding}/{@code margin} in their CSS shorthand order. */
    private static void edge(Map<String, Object> props, String key, String property, StringBuilder style) {
        Object value = props.get(key);
        if (value == null) {
            return;
        }
        String sides = edgeInsets(value, key);
        if (sides != null) {
            decl(style, property, sides);
        }
    }

    /**
     * A {@code padding}/{@code margin} value as a CSS shorthand: a number or
     * 1-4 component list ({@code [all]}, {@code [vertical,horizontal]},
     * {@code [top,horizontal,bottom]}, {@code [top,right,bottom,left]}) or a
     * {@code {top,right,bottom,left}} map; every component may be a token
     * reference. Malformed shapes degrade the whole declaration away
     * (section 2.4).
     */
    private static String edgeInsets(Object value, String key) {
        if (value instanceof Number number) {
            return number(number) + "px";
        }
        if (value instanceof String text) {
            return cssText(text, key);
        }
        if (value instanceof List<?> list && !list.isEmpty() && list.size() <= 4) {
            StringBuilder out = new StringBuilder();
            for (Object item : list) {
                String component = component(item, key);
                if (component == null) {
                    return null;
                }
                if (out.length() > 0) {
                    out.append(' ');
                }
                out.append(component);
            }
            return out.toString();
        }
        if (value instanceof Map<?, ?> map) {
            StringBuilder out = new StringBuilder();
            for (String side : new String[] {"top", "right", "bottom", "left"}) {
                Object item = map.get(side);
                String component = item == null ? "0px" : component(item, key);
                if (component == null) {
                    return null;
                }
                if (out.length() > 0) {
                    out.append(' ');
                }
                out.append(component);
            }
            return out.toString();
        }
        return null;
    }

    private static String component(Object value, String key) {
        if (value instanceof Number number) {
            return number(number) + "px";
        }
        if (value instanceof String text) {
            return cssText(text, key);
        }
        return null;
    }

    // --- value mapping ----------------------------------------------------

    /** A {@code shadow} spec or token reference as a {@code box-shadow} value. */
    private static String shadow(Object value) {
        if (value instanceof String text) {
            return cssText(text, "shadow");
        }
        if (!(value instanceof Map<?, ?> map)) {
            return null;
        }
        Object offset = map.get("offset");
        String offsetX = "0px";
        String offsetY = "0px";
        if (offset instanceof List<?> pair && pair.size() == 2) {
            offsetX = cssLength(pair.get(0), "shadow");
            offsetY = cssLength(pair.get(1), "shadow");
        }
        String blur = map.get("blur") != null ? cssLength(map.get("blur"), "shadow") : "0px";
        String spread = map.get("spread") != null ? cssLength(map.get("spread"), "shadow") : "0px";
        String color = map.get("color") != null ? cssText(map.get("color"), "shadow") : "currentColor";
        return offsetX + " " + offsetY + " " + blur + " " + spread + " " + color;
    }

    /** A {@code gradient} spec as a {@code background-image} value. */
    private static String gradientImage(Map<?, ?> gradient) {
        Object rawColors = gradient.get("colors");
        if (!(rawColors instanceof List<?> colors) || colors.isEmpty()) {
            return null;
        }
        StringBuilder stops = new StringBuilder();
        Object rawStops = gradient.get("stops");
        List<?> positions = rawStops instanceof List<?> list && list.size() == colors.size()
                ? list : null;
        for (int i = 0; i < colors.size(); i++) {
            if (i > 0) {
                stops.append(", ");
            }
            stops.append(cssText(colors.get(i), "gradient"));
            if (positions != null) {
                stops.append(' ').append(cssText(positions.get(i), "gradient"));
            }
        }
        String type = gradient.get("type") == null
                ? "linear" : String.valueOf(gradient.get("type"));
        return switch (type) {
            case "linear" -> "linear-gradient(" + gradientAngle(gradient) + ", " + stops + ")";
            case "radial" -> "radial-gradient(" + stops + ")";
            case "sweep" -> "conic-gradient(" + stops + ")";
            default -> null;
        };
    }

    /**
     * The CSS angle of a {@code linear} gradient from its {@code begin}/
     * {@code end} alignment literals (default {@code centerLeft} &rarr;
     * {@code centerRight}, which is {@code 90deg}).
     */
    private static String gradientAngle(Map<?, ?> gradient) {
        int[] begin = alignmentPoint(gradient.get("begin"));
        int[] end = alignmentPoint(gradient.get("end"));
        double dx = end[0] - begin[0];
        double dy = end[1] - begin[1];
        if (dx == 0 && dy == 0) {
            return "90deg";
        }
        double degrees = Math.toDegrees(Math.atan2(dx, -dy));
        if (degrees < 0) {
            degrees += 360.0;
        }
        return number(degrees) + "deg";
    }

    private static int[] alignmentPoint(Object literal) {
        String[] pair = ALIGN_SELF.get(literal == null ? "" : String.valueOf(literal));
        if (pair == null) {
            return new int[] {0, 0};
        }
        int x = "start".equals(pair[0]) ? -1 : "end".equals(pair[0]) ? 1 : 0;
        int y = "start".equals(pair[1]) ? -1 : "end".equals(pair[1]) ? 1 : 0;
        return new int[] {x, y};
    }

    /** A CSS length: numbers are logical px, strings pass token resolution. */
    private static String cssLength(Object value, String key) {
        if (value instanceof Number number) {
            return number(number) + "px";
        }
        return cssText(value, key);
    }

    /** A unitless CSS value: numbers pass through, strings pass token resolution. */
    private static String cssPlain(Object value, String key) {
        if (value instanceof Number number) {
            return number(number);
        }
        return cssText(value, key);
    }

    /**
     * A CSS value from a string: {@code $token} references resolve to
     * {@code var(--&hellip;)} (unknown references stay literal), everything
     * else is used as-is. Text-content props never resolve (section 2.2).
     */
    private static String cssText(Object value, String key) {
        if (value == null) {
            return null;
        }
        String text = String.valueOf(value);
        if (text.startsWith("$") && !TOKEN_EXEMPT.contains(key)) {
            return TokenCss.resolveReference(text);
        }
        return text;
    }

    /** Appends one declaration in application order. */
    private static void decl(StringBuilder style, String property, String value) {
        if (value == null) {
            return;
        }
        if (style.length() > 0) {
            style.append("; ");
        }
        style.append(property).append(": ").append(cssSafe(value));
    }

    /**
     * Neutralizes the CSS declaration separators ({@code ;}, {@code {@},
     * {@code }}) of a style value as CSS hex escapes, so a prop value cannot
     * smuggle extra declarations into the {@code style} attribute. HTML
     * escaping of the whole attribute is {@link HtmlEsc}'s job at render time.
     */
    private static String cssSafe(String value) {
        if (value.indexOf(';') < 0 && value.indexOf('{') < 0 && value.indexOf('}') < 0) {
            return value;
        }
        StringBuilder out = new StringBuilder(value.length() + 16);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case ';' -> out.append("\\00003b");
                case '{' -> out.append("\\00007b");
                case '}' -> out.append("\\00007d");
                default -> out.append(c);
            }
        }
        return out.toString();
    }

    /** A compact number: integral values drop their fractional part. */
    private static String number(Number value) {
        return number(value.doubleValue());
    }

    private static String number(double value) {
        if (value == Math.floor(value) && !Double.isInfinite(value) && Math.abs(value) < 1e15) {
            return Long.toString((long) value);
        }
        return Double.toString(value);
    }
}
