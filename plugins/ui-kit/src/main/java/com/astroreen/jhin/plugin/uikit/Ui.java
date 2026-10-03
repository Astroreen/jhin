/**
 * Fluent builder over the primitive catalog of the SDUI contract.
 *
 * <p>One factory per primitive, each returning a small builder whose typed
 * setters mirror the prop list of that primitive (docs/sdui.md section 2.6)
 * plus the full universal surface of section 2.1. The universal surface is
 * implemented once in {@link NodeBuilder} through the {@code Has*} lattice of
 * the {@code has} package (Box, Text, Flex, Interaction); parent builders add
 * {@code children} ({@link ParentBuilder}) and item-taking builders add
 * {@code items} ({@link ItemBuilder}). Every Flutter parameter of the widget
 * a primitive renders has exactly one typed setter; unset params are simply
 * absent from the emitted JSON so the client uses its token defaults.
 *
 * <p>Builders validate enum-typed literals immediately ({@code
 * IllegalArgumentException} on an unknown value — a builder bug is a
 * build-time failure, never a silent render-time degradation) and pass
 * everything else through to the wire shape; the client degrades malformed
 * props per node, never per screen. Token references ({@code $spacing.md},
 * {@code $color.accent}, …) are emitted as literal strings — see
 * {@link UiTokens}; resolution is client-side only.
 *
 * <p>Usage:
 * <pre>{@code
 * UiNode screen = Ui.screen()
 *     .title("Jhin")
 *     .body(Ui.container()
 *         .direction("column")
 *         .gap(UiTokens.spacing.md())
 *         .padding(UiTokens.spacing.lg())
 *         .child(Ui.text("Hello").style("h2"))
 *         .child("plain string child"))
 *     .build();
 * }</pre>
 */
package com.astroreen.jhin.plugin.uikit;

import com.astroreen.jhin.plugin.uikit.has.HasBox;
import com.astroreen.jhin.plugin.uikit.has.HasChildren;
import com.astroreen.jhin.plugin.uikit.has.HasFlex;
import com.astroreen.jhin.plugin.uikit.has.HasInteraction;
import com.astroreen.jhin.plugin.uikit.has.HasItems;
import com.astroreen.jhin.plugin.uikit.has.HasText;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Ui {

    private Ui() {
    }

    // --- value helpers (forward to UiTokens; see plan section 5) ---

    /**
     * A color value: hex strings and {@code $color} tokens pass through
     * unchanged (the client resolves tokens).
     *
     * @param value the color or token
     * @return the value unchanged
     */
    public static String color(String value) {
        return value;
    }

    /**
     * A {@code gradient} spec; see {@link UiTokens#gradient}.
     *
     * @param type   the gradient type ({@code linear/radial/sweep})
     * @param colors the color stops
     * @param stops  the stop positions, or null for none
     * @param begin  the start alignment literal
     * @param end    the end alignment literal
     * @return the gradient spec map
     */
    public static Map<String, Object> gradient(
            String type, List<String> colors, List<String> stops, String begin, String end) {
        return UiTokens.gradient(type, colors, stops, begin, end);
    }

    /**
     * A {@code shadow} spec; see {@link UiTokens#shadow}.
     *
     * @param color   the shadow color or token
     * @param blur    the blur radius
     * @param spread  the spread
     * @param offsetX the x offset
     * @param offsetY the y offset
     * @return the shadow spec map
     */
    public static Map<String, Object> shadow(String color, Number blur, Number spread, Number offsetX, Number offsetY) {
        return UiTokens.shadow(color, blur, spread, offsetX, offsetY);
    }

    /**
     * A {@code border} value (the color or token; width and style are
     * separate props); see {@link UiTokens#border}.
     *
     * @param colorOrToken the border color or token
     * @return the value unchanged
     */
    public static String border(String colorOrToken) {
        return UiTokens.border(colorOrToken);
    }

    /**
     * A {@code borderRadius} token reference; see {@link UiTokens#radius}.
     *
     * @param token the {@code $radius} token
     * @return the token unchanged
     */
    public static String radius(String token) {
        return UiTokens.radius(token);
    }

    // --- primitive factories ---

    /** A full-screen container: {@code screen}(title?, appBar?, body, floatingAction?). */
    public static ScreenBuilder screen() {
        return new ScreenBuilder();
    }

    /** A navigation control: {@code nav}(kind, items). */
    public static NavBuilder nav() {
        return new NavBuilder();
    }

    /** A layout box: {@code container}(children, direction?, padding?, gap?, align?, scroll?). */
    public static ContainerBuilder container() {
        return new ContainerBuilder();
    }

    /** A titled surface: {@code card}(title?, children). */
    public static CardBuilder card() {
        return new CardBuilder();
    }

    /** A text run: {@code text}(text, style?, bold?, color?). */
    public static TextBuilder text(String text) {
        return new TextBuilder(text);
    }

    /** A markdown block: {@code markdown}(text). */
    public static MarkdownBuilder markdown(String text) {
        return new MarkdownBuilder(text);
    }

    /** A button: {@code button}(label, style?, action?, icon?, confirm?). */
    public static ButtonBuilder button(String label) {
        return new ButtonBuilder(label);
    }

    /** A text field: {@code input}(id, label?, value?, placeholder?, …). */
    public static InputBuilder input(String id) {
        return new InputBuilder(id);
    }

    /** A select control: {@code dropdown}(id, items, value?, action?). */
    public static DropdownBuilder dropdown(String id) {
        return new DropdownBuilder(id);
    }

    /** A check box: {@code checkbox}(id, label, value?). */
    public static CheckboxBuilder checkbox(String id, String label) {
        return new CheckboxBuilder(id, label);
    }

    /** The {@code switch} primitive (named {@code toggle} because {@code switch} is a Java keyword). */
    public static ToggleBuilder toggle(String id, String label) {
        return new ToggleBuilder(id, label);
    }

    /** A range input: {@code slider}(id, label?, min, max, step?, value?). */
    public static SliderBuilder slider(String id, double min, double max) {
        return new SliderBuilder(id, min, max);
    }

    /** A submission form: {@code form}(fields, submit). */
    public static FormBuilder form() {
        return new FormBuilder();
    }

    /** A vertical list: {@code list}(items, maxHeight?). */
    public static ListBuilder list() {
        return new ListBuilder();
    }

    /** A live stream surface: {@code stream_view}(id, topic, mode?, itemLimit?, autoScroll?, empty?). */
    public static StreamViewBuilder streamView(String id, String topic) {
        return new StreamViewBuilder(id, topic);
    }

    /** A tabular grid: {@code table}(columns, rows). */
    public static TableBuilder table() {
        return new TableBuilder();
    }

    /** A horizontal rule: {@code divider}. */
    public static DividerBuilder divider() {
        return new DividerBuilder();
    }

    /** An empty gap: {@code spacer}(size?). */
    public static SpacerBuilder spacer() {
        return new SpacerBuilder();
    }

    /** A progress indicator: {@code progress}(kind?, value?). */
    public static ProgressBuilder progress() {
        return new ProgressBuilder();
    }

    /** A raster image: {@code image}(src|dataUri, width?, height?, fit?). */
    public static ImageBuilder image() {
        return new ImageBuilder();
    }

    /** A vector shape: {@code figure}(shape, color, width, height). */
    public static FigureBuilder figure() {
        return new FigureBuilder();
    }

    /** A line chart: {@code chart_line}(series). */
    public static ChartLineBuilder chartLine() {
        return new ChartLineBuilder();
    }

    /** A bar chart: {@code chart_bar}(items|series). */
    public static ChartBarBuilder chartBar() {
        return new ChartBarBuilder();
    }

    /** A pie chart: {@code chart_pie}(items). */
    public static ChartPieBuilder chartPie() {
        return new ChartPieBuilder();
    }

    /** A side drawer: {@code drawer}(title?, children). */
    public static DrawerBuilder drawer() {
        return new DrawerBuilder();
    }

    /**
     * Base of every builder: the universal optional fields of docs/sdui.md
     * section 2.1 (Meta, Box, Text, Flex, Interaction/A11y groups) through
     * the {@code Has*} lattice, the {@link PropSink} escape hatch and
     * {@link #build()}.
     *
     * @param <B> the concrete builder self type
     */
    public abstract static class NodeBuilder<B extends NodeBuilder<B>>
            implements PropSink<B>, HasBox<B>, HasText<B>, HasFlex<B>, HasInteraction<B> {

        /** The props collected so far, in insertion order. */
        protected final Map<String, Object> props = new LinkedHashMap<>();

        @SuppressWarnings("unchecked")
        protected B self() {
            return (B) this;
        }

        /** The primitive type name this builder produces. */
        abstract String type();

        @Override
        public B set(String key, Object value) {
            props.put(key, value);
            return self();
        }

        @Override
        public Map<String, Object> props() {
            return props;
        }

        // --- Meta group ---

        /** Sets the universal {@code id} prop. */
        public B id(String value) {
            props.put("id", value);
            return self();
        }

        /** Sets the universal {@code visible} prop. */
        public B visible(boolean value) {
            props.put("visible", value);
            return self();
        }

        /** Sets the universal {@code when} prop (a local boolean expression). */
        public B when(String expression) {
            props.put("when", expression);
            return self();
        }

        // --- Box group ---

        @Override
        public B width(Number value) {
            props.put("width", value);
            return self();
        }

        /**
         * The {@code height} prop: the box height on non-text nodes, the
         * line-height multiple on text-bearing nodes (same wire key).
         */
        @Override
        public B height(Number value) {
            props.put("height", value);
            return self();
        }

        @Override
        public B minWidth(Number value) {
            props.put("minWidth", value);
            return self();
        }

        @Override
        public B maxWidth(Number value) {
            props.put("maxWidth", value);
            return self();
        }

        @Override
        public B minHeight(Number value) {
            props.put("minHeight", value);
            return self();
        }

        @Override
        public B maxHeight(Number value) {
            props.put("maxHeight", value);
            return self();
        }

        @Override
        public B aspectRatio(double value) {
            props.put("aspectRatio", value);
            return self();
        }

        /** Sets the universal {@code padding} prop (a number, an array or a padding map). */
        @Override
        public B padding(Object value) {
            props.put("padding", value);
            return self();
        }

        @Override
        public B margin(Object value) {
            props.put("margin", value);
            return self();
        }

        /**
         * The {@code color} prop: the background color on non-text nodes, the
         * text color on text-bearing nodes (same wire key).
         */
        @Override
        public B color(String value) {
            props.put("color", value);
            return self();
        }

        @Override
        public B gradient(Map<String, Object> value) {
            props.put("gradient", value);
            return self();
        }

        @Override
        public B border(String value) {
            props.put("border", value);
            return self();
        }

        @Override
        public B borderWidth(Number value) {
            props.put("borderWidth", value);
            return self();
        }

        @Override
        public B borderStyle(String value) {
            props.put("borderStyle", UiEnums.require("borderStyle", value, UiEnums.BORDER_STYLE));
            return self();
        }

        @Override
        public B borderRadius(Number value) {
            props.put("borderRadius", value);
            return self();
        }

        @Override
        public B borderRadius(String token) {
            if (token == null || !token.startsWith("$")) {
                throw new IllegalArgumentException(
                        "borderRadius string must be a $radius token reference, got: " + token);
            }
            props.put("borderRadius", token);
            return self();
        }

        @Override
        public B shadow(Map<String, Object> value) {
            props.put("shadow", value);
            return self();
        }

        @Override
        public B shadow(String token) {
            if (token == null || !token.startsWith("$")) {
                throw new IllegalArgumentException(
                        "shadow string must be a token reference, got: " + token);
            }
            props.put("shadow", token);
            return self();
        }

        @Override
        public B opacity(double value) {
            props.put("opacity", value);
            return self();
        }

        @Override
        public B clip(String value) {
            props.put("clip", UiEnums.require("clip", value, UiEnums.CLIP));
            return self();
        }

        @Override
        public B transform(Object value) {
            props.put("transform", value);
            return self();
        }

        @Override
        public B align(String value) {
            props.put("align", UiEnums.require("align", value, UiEnums.ALIGNMENT));
            return self();
        }

        // --- Text group ---

        @Override
        public B fontFamily(String value) {
            props.put("fontFamily", value);
            return self();
        }

        @Override
        public B fontSize(Number value) {
            props.put("fontSize", value);
            return self();
        }

        @Override
        public B fontWeight(int value) {
            props.put("fontWeight", value);
            return self();
        }

        @Override
        public B fontStyle(String value) {
            props.put("fontStyle", UiEnums.require("fontStyle", value, UiEnums.FONT_STYLE));
            return self();
        }

        @Override
        public B letterSpacing(Number value) {
            props.put("letterSpacing", value);
            return self();
        }

        @Override
        public B wordSpacing(Number value) {
            props.put("wordSpacing", value);
            return self();
        }

        @Override
        public B textAlign(String value) {
            props.put("textAlign", UiEnums.require("textAlign", value, UiEnums.TEXT_ALIGN));
            return self();
        }

        @Override
        public B textDecoration(String value) {
            props.put("textDecoration", UiEnums.require("textDecoration", value, UiEnums.TEXT_DECORATION));
            return self();
        }

        @Override
        public B textOverflow(String value) {
            props.put("textOverflow", UiEnums.require("textOverflow", value, UiEnums.TEXT_OVERFLOW));
            return self();
        }

        @Override
        public B maxLines(int value) {
            props.put("maxLines", value);
            return self();
        }

        @Override
        public B softWrap(boolean value) {
            props.put("softWrap", value);
            return self();
        }

        @Override
        public B ellipsis(boolean value) {
            props.put("ellipsis", value);
            return self();
        }

        // --- Flex group ---

        /** Sets the universal {@code flex} prop. */
        @Override
        public B flex(int value) {
            props.put("flex", value);
            return self();
        }

        @Override
        public B fit(String value) {
            props.put("fit", UiEnums.require("fit", value, UiEnums.FLEX_FIT));
            return self();
        }

        @Override
        public B mainAxisSize(String value) {
            props.put("mainAxisSize", UiEnums.require("mainAxisSize", value, UiEnums.MAIN_AXIS_SIZE));
            return self();
        }

        @Override
        public B mainAxisAlignment(String value) {
            props.put("mainAxisAlignment", UiEnums.require("mainAxisAlignment", value, UiEnums.MAIN_AXIS));
            return self();
        }

        @Override
        public B crossAxisAlignment(String value) {
            props.put("crossAxisAlignment", UiEnums.require("crossAxisAlignment", value, UiEnums.CROSS_AXIS));
            return self();
        }

        @Override
        public B direction(String value) {
            props.put("direction", UiEnums.require("direction", value, UiEnums.FLEX_DIRECTION));
            return self();
        }

        @Override
        public B gap(Number value) {
            props.put("gap", value);
            return self();
        }

        @Override
        public B spacing(Number value) {
            props.put("spacing", value);
            return self();
        }

        @Override
        public B scroll(boolean value) {
            props.put("scroll", value);
            return self();
        }

        @Override
        public B textDirection(String value) {
            props.put("textDirection", UiEnums.require("textDirection", value, UiEnums.TEXT_DIRECTION));
            return self();
        }

        @Override
        public B verticalDirection(String value) {
            props.put("verticalDirection", UiEnums.require("verticalDirection", value, UiEnums.VERTICAL_DIRECTION));
            return self();
        }

        @Override
        public B textBaseline(String value) {
            props.put("textBaseline", UiEnums.require("textBaseline", value, UiEnums.TEXT_BASELINE));
            return self();
        }

        @Override
        public B overflow(String value) {
            props.put("overflow", UiEnums.require("overflow", value, UiEnums.OVERFLOW));
            return self();
        }

        @Override
        public B clipBehavior(String value) {
            props.put("clipBehavior", UiEnums.require("clipBehavior", value, UiEnums.CLIP));
            return self();
        }

        // --- Interaction / A11y group ---

        @Override
        public B action(Map<String, Object> value) {
            props.put("action", value);
            return self();
        }

        @Override
        public B onTap(Map<String, Object> value) {
            props.put("onTap", value);
            return self();
        }

        @Override
        public B onLongPress(Map<String, Object> value) {
            props.put("onLongPress", value);
            return self();
        }

        @Override
        public B confirm(String value) {
            props.put("confirm", value);
            return self();
        }

        @Override
        public B tooltip(String value) {
            props.put("tooltip", value);
            return self();
        }

        @Override
        public B cursor(String value) {
            props.put("cursor", UiEnums.require("cursor", value, UiEnums.CURSOR));
            return self();
        }

        @Override
        public B enabled(boolean value) {
            props.put("enabled", value);
            return self();
        }

        @Override
        public B semanticsLabel(String value) {
            props.put("semanticsLabel", value);
            return self();
        }

        @Override
        public B semanticsHint(String value) {
            props.put("semanticsHint", value);
            return self();
        }

        @Override
        public B semanticsValue(String value) {
            props.put("semanticsValue", value);
            return self();
        }

        @Override
        public B focusable(boolean value) {
            props.put("focusable", value);
            return self();
        }

        @Override
        public B excludeSemantics(boolean value) {
            props.put("excludeSemantics", value);
            return self();
        }

        /** Builds the node. */
        public UiNode build() {
            return new UiNode(type(), props, List.of());
        }
    }

    /** Base of the builders whose primitive takes a {@code children} array. */
    public abstract static class ParentBuilder<B extends ParentBuilder<B>> extends NodeBuilder<B>
            implements HasChildren<B> {

        /** The collected children, in insertion order. */
        protected final List<Object> children = new ArrayList<>();

        @Override
        public B child(UiNode node) {
            children.add(node);
            return self();
        }

        @Override
        public B child(String text) {
            children.add(text);
            return self();
        }

        @Override
        public B children(List<Object> nodes) {
            for (Object node : nodes) {
                children.add(node);
            }
            return self();
        }

        @Override
        public UiNode build() {
            return new UiNode(type(), props, children);
        }
    }

    /** Base of the builders whose primitive takes an {@code items} array prop. */
    public abstract static class ItemBuilder<B extends ItemBuilder<B>> extends NodeBuilder<B>
            implements HasItems<B> {

        @Override
        public B item(UiNode node) {
            items().add(node);
            return self();
        }

        @Override
        public B item(String text) {
            items().add(text);
            return self();
        }

        @Override
        public B item(Map<String, Object> entry) {
            items().add(entry);
            return self();
        }

        /** The live {@code items} list inside the props map. */
        @SuppressWarnings("unchecked")
        protected List<Object> items() {
            return (List<Object>) props.computeIfAbsent("items", key -> new ArrayList<>());
        }
    }

    /** {@code screen}(title?, appBar?, body, floatingAction?). */
    public static final class ScreenBuilder extends NodeBuilder<ScreenBuilder> {

        private ScreenBuilder() {
        }

        @Override
        String type() {
            return "screen";
        }

        /** The screen title shown in the app bar. */
        public ScreenBuilder title(String value) {
            props.put("title", value);
            return this;
        }

        /** The app bar node. */
        public ScreenBuilder appBar(UiNode node) {
            props.put("appBar", node);
            return this;
        }

        /** The body node. */
        public ScreenBuilder body(UiNode node) {
            props.put("body", node);
            return this;
        }

        /** The body as a string (the text shorthand). */
        public ScreenBuilder body(String text) {
            props.put("body", text);
            return this;
        }

        /** The floating action button node. */
        public ScreenBuilder floatingAction(UiNode node) {
            props.put("floatingAction", node);
            return this;
        }
    }

    /** {@code nav}(kind, items) with items {@code {label, icon?, screen}}. */
    public static final class NavBuilder extends ItemBuilder<NavBuilder> {

        private NavBuilder() {
        }

        @Override
        String type() {
            return "nav";
        }

        /** The navigation kind: {@code tabs}, {@code bottom}, {@code drawer}, {@code rail} or {@code sidebar}; validated. */
        public NavBuilder kind(String value) {
            props.put("kind", UiEnums.require("kind", value, UiEnums.NAV_KIND));
            return this;
        }

        /** Appends one item pointing at a screen id. */
        public NavBuilder item(String label, String screen) {
            return item(label, null, screen);
        }

        /** Appends one item with an icon name. */
        public NavBuilder item(String label, String icon, String screen) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("label", label);
            if (icon != null) {
                item.put("icon", icon);
            }
            item.put("screen", screen);
            items().add(item);
            return this;
        }

        /** The highlighted item by index. */
        public NavBuilder activeIndex(int value) {
            props.put("activeIndex", value);
            return this;
        }

        /** The highlighted item by id; wins over {@code activeIndex}. */
        public NavBuilder activeId(String value) {
            props.put("activeId", value);
            return this;
        }
    }

    /** {@code container}(children, direction?, padding?, gap?, align?, scroll?) — all props come from the universal lattice. */
    public static final class ContainerBuilder extends ParentBuilder<ContainerBuilder> {

        private ContainerBuilder() {
        }

        @Override
        String type() {
            return "container";
        }
    }

    /** {@code card}(title?, children). */
    public static final class CardBuilder extends ParentBuilder<CardBuilder> {

        private CardBuilder() {
        }

        @Override
        String type() {
            return "card";
        }

        /** The card title. */
        public CardBuilder title(String value) {
            props.put("title", value);
            return this;
        }
    }

    /**
     * {@code text}(text, style?, bold?, italic?, color?) with the full
     * {@code TextStyle} parity of docs/sdui.md section 2.6. The universal
     * Text group arrives from {@link NodeBuilder}; {@code color} (inherited)
     * is the text color on this primitive.
     */
    public static final class TextBuilder extends NodeBuilder<TextBuilder> {

        private TextBuilder(String text) {
            props.put("text", text);
        }

        @Override
        String type() {
            return "text";
        }

        /** The typography token: {@code h1}, {@code h2}, {@code h3}, {@code body}, {@code small}, {@code caption} or {@code mono}; validated. */
        public TextBuilder style(String value) {
            props.put("style", UiEnums.require("style", value, UiEnums.TEXT_STYLE));
            return this;
        }

        /** Whether the text is bold. */
        public TextBuilder bold(boolean value) {
            props.put("bold", value);
            return this;
        }

        /** Whether the text is italic. */
        public TextBuilder italic(boolean value) {
            props.put("italic", value);
            return this;
        }

        /** The text color as an int. */
        public TextBuilder color(int value) {
            props.put("color", value);
            return this;
        }

        /** The {@code strutStyle} prop: {@code {size?, height?, leading?}}. */
        public TextBuilder strutStyle(Map<String, Object> value) {
            props.put("strutStyle", value);
            return this;
        }

        /** The {@code textWidthBasis} prop: {@code parent/longestLine/character}; validated. */
        public TextBuilder textWidthBasis(String value) {
            props.put("textWidthBasis", UiEnums.require("textWidthBasis", value, UiEnums.TEXT_WIDTH_BASIS));
            return this;
        }

        /** The {@code locale} prop: a BCP-47 tag. */
        public TextBuilder locale(String value) {
            props.put("locale", value);
            return this;
        }

        /** The {@code selectionColor} prop. */
        public TextBuilder selectionColor(String value) {
            props.put("selectionColor", value);
            return this;
        }
    }

    /** {@code markdown}(text, codeBlockStyle?, syntax?). */
    public static final class MarkdownBuilder extends NodeBuilder<MarkdownBuilder> {

        private MarkdownBuilder(String text) {
            props.put("text", text);
        }

        @Override
        String type() {
            return "markdown";
        }

        /** The code-fence style name. */
        public MarkdownBuilder codeBlockStyle(String value) {
            props.put("codeBlockStyle", value);
            return this;
        }

        /** Whether fences get syntax highlighting. */
        public MarkdownBuilder syntax(boolean value) {
            props.put("syntax", value);
            return this;
        }
    }

    /** {@code button}(label, style?, action?, icon?, confirm?) — style/action/confirm validated or inherited from the lattice. */
    public static final class ButtonBuilder extends NodeBuilder<ButtonBuilder> {

        private ButtonBuilder(String label) {
            props.put("label", label);
        }

        @Override
        String type() {
            return "button";
        }

        /** The button style: {@code primary}, {@code secondary}, {@code danger} or {@code text}; validated. */
        public ButtonBuilder style(String value) {
            props.put("style", UiEnums.require("style", value, UiEnums.BUTTON_STYLE));
            return this;
        }

        /** The icon name. */
        public ButtonBuilder icon(String value) {
            props.put("icon", value);
            return this;
        }
    }

    /**
     * {@code input}(id, …) with the full {@code InputDecoration}/{@code
     * FormField} parity of docs/sdui.md section 2.6. {@code maxLines} and
     * {@code textAlign} come from the universal Text group; {@code border}
     * and friends are overridden with the input border spec literals
     * ({@code underline/outline/none}).
     */
    public static final class InputBuilder extends NodeBuilder<InputBuilder> {

        private InputBuilder(String id) {
            props.put("id", id);
        }

        @Override
        String type() {
            return "input";
        }

        /** The field label. */
        public InputBuilder label(String value) {
            props.put("label", value);
            return this;
        }

        /** The current value. */
        public InputBuilder value(String value) {
            props.put("value", value);
            return this;
        }

        /** The placeholder text. */
        public InputBuilder placeholder(String value) {
            props.put("placeholder", value);
            return this;
        }

        /** Whether the field accepts several lines. */
        public InputBuilder multiline(boolean value) {
            props.put("multiline", value);
            return this;
        }

        /** Whether the field obscures its content. */
        public InputBuilder obscure(boolean value) {
            props.put("obscure", value);
            return this;
        }

        /** The legacy spelling of {@code keyboardType}; validated. */
        public InputBuilder keyboard(String value) {
            props.put("keyboard", UiEnums.require("keyboard", value, UiEnums.KEYBOARD_TYPE));
            return this;
        }

        /** Whether the field must be filled before dispatch. */
        public InputBuilder required(boolean value) {
            props.put("required", value);
            return this;
        }

        /** The minimum value or length. */
        public InputBuilder min(Number value) {
            props.put("min", value);
            return this;
        }

        /** The maximum value or length. */
        public InputBuilder max(Number value) {
            props.put("max", value);
            return this;
        }

        /** The regular expression the value must match. */
        public InputBuilder pattern(String value) {
            props.put("pattern", value);
            return this;
        }

        /** The inline error text shown when validation fails. */
        public InputBuilder errorText(String value) {
            props.put("errorText", value);
            return this;
        }

        /** The keyboard kind: {@code text/number/phone/email/url/visiblePassword/multiline}; validated. */
        public InputBuilder keyboardType(String value) {
            props.put("keyboardType", UiEnums.require("keyboardType", value, UiEnums.KEYBOARD_TYPE));
            return this;
        }

        /** The IME action; validated. */
        public InputBuilder textInputAction(String value) {
            props.put("textInputAction", UiEnums.require("textInputAction", value, UiEnums.TEXT_INPUT_ACTION));
            return this;
        }

        /** The capitalization; validated. */
        public InputBuilder textCapitalization(String value) {
            props.put("textCapitalization",
                    UiEnums.require("textCapitalization", value, UiEnums.TEXT_CAPITALIZATION));
            return this;
        }

        /** The length limit. */
        public InputBuilder maxLength(int value) {
            props.put("maxLength", value);
            return this;
        }

        /** The limit enforcement; validated. */
        public InputBuilder maxLengthEnforcement(String value) {
            props.put("maxLengthEnforcement",
                    UiEnums.require("maxLengthEnforcement", value, UiEnums.MAX_LENGTH_ENFORCEMENT));
            return this;
        }

        /** The minimum line count. */
        public InputBuilder minLines(int value) {
            props.put("minLines", value);
            return this;
        }

        /** Whether the field fills its parent. */
        public InputBuilder expands(boolean value) {
            props.put("expands", value);
            return this;
        }

        /** Whether autocorrect is on. */
        public InputBuilder autocorrect(boolean value) {
            props.put("autocorrect", value);
            return this;
        }

        /** Whether suggestions are on. */
        public InputBuilder enableSuggestions(boolean value) {
            props.put("enableSuggestions", value);
            return this;
        }

        /** The obscuring character. */
        public InputBuilder obscuringCharacter(String value) {
            props.put("obscuringCharacter", value);
            return this;
        }

        /** Whether selection gestures are enabled. */
        public InputBuilder enableInteractiveSelection(boolean value) {
            props.put("enableInteractiveSelection", value);
            return this;
        }

        /** Whether the field is read-only. */
        public InputBuilder readOnly(boolean value) {
            props.put("readOnly", value);
            return this;
        }

        /** Whether the cursor is visible. */
        public InputBuilder showCursor(boolean value) {
            props.put("showCursor", value);
            return this;
        }

        /** Whether the field autofocuses. */
        public InputBuilder autofocus(boolean value) {
            props.put("autofocus", value);
            return this;
        }

        /** The cursor width. */
        public InputBuilder cursorWidth(Number value) {
            props.put("cursorWidth", value);
            return this;
        }

        /** The cursor height. */
        public InputBuilder cursorHeight(Number value) {
            props.put("cursorHeight", value);
            return this;
        }

        /** The cursor radius. */
        public InputBuilder cursorRadius(Number value) {
            props.put("cursorRadius", value);
            return this;
        }

        /** The cursor color. */
        public InputBuilder cursorColor(String value) {
            props.put("cursorColor", value);
            return this;
        }

        /** The mouse cursor; validated. */
        public InputBuilder mouseCursor(String value) {
            props.put("mouseCursor", UiEnums.require("mouseCursor", value, UiEnums.CURSOR));
            return this;
        }

        /** The decoration hint. */
        public InputBuilder hintText(String value) {
            props.put("hintText", value);
            return this;
        }

        /** The decoration helper. */
        public InputBuilder helperText(String value) {
            props.put("helperText", value);
            return this;
        }

        /** The decoration label. */
        public InputBuilder labelText(String value) {
            props.put("labelText", value);
            return this;
        }

        /** The decoration prefix icon. */
        public InputBuilder prefixIcon(String value) {
            props.put("prefixIcon", value);
            return this;
        }

        /** The decoration suffix icon. */
        public InputBuilder suffixIcon(String value) {
            props.put("suffixIcon", value);
            return this;
        }

        /** The decoration counter. */
        public InputBuilder counterText(String value) {
            props.put("counterText", value);
            return this;
        }

        /** The decoration fill color. */
        public InputBuilder fillColor(String value) {
            props.put("fillColor", value);
            return this;
        }

        /** Whether the decoration is filled. */
        public InputBuilder filled(boolean value) {
            props.put("filled", value);
            return this;
        }

        /** The decoration hover color. */
        public InputBuilder hoverColor(String value) {
            props.put("hoverColor", value);
            return this;
        }

        /** The decoration focus color. */
        public InputBuilder focusColor(String value) {
            props.put("focusColor", value);
            return this;
        }

        /**
         * The input border spec: {@code underline/outline/none} (overrides
         * the universal decoration on this node); validated.
         */
        @Override
        public InputBuilder border(String value) {
            props.put("border", UiEnums.require("border", value, UiEnums.INPUT_BORDER));
            return this;
        }

        /** The border when enabled; validated like {@link #border(String)}. */
        public InputBuilder enabledBorder(String value) {
            props.put("enabledBorder", UiEnums.require("enabledBorder", value, UiEnums.INPUT_BORDER));
            return this;
        }

        /** The border when focused; validated like {@link #border(String)}. */
        public InputBuilder focusedBorder(String value) {
            props.put("focusedBorder", UiEnums.require("focusedBorder", value, UiEnums.INPUT_BORDER));
            return this;
        }

        /** The border on error; validated like {@link #border(String)}. */
        public InputBuilder errorBorder(String value) {
            props.put("errorBorder", UiEnums.require("errorBorder", value, UiEnums.INPUT_BORDER));
            return this;
        }

        /** The decoration content padding. */
        public InputBuilder contentPadding(Object value) {
            props.put("contentPadding", value);
            return this;
        }

        /** Whether the decoration is dense. */
        public InputBuilder isDense(boolean value) {
            props.put("isDense", value);
            return this;
        }

        /** Whether the decoration is collapsed. */
        public InputBuilder isCollapsed(boolean value) {
            props.put("isCollapsed", value);
            return this;
        }

        /** Whether the layout is dense. */
        public InputBuilder dense(boolean value) {
            props.put("dense", value);
            return this;
        }

        /** Whether the label aligns with the hint. */
        public InputBuilder alignLabelWithHint(boolean value) {
            props.put("alignLabelWithHint", value);
            return this;
        }

        /** The decoration constraints. */
        public InputBuilder constraints(Map<String, Object> value) {
            props.put("constraints", value);
            return this;
        }

        /** The {@code TextStyle} map. */
        public InputBuilder style(Map<String, Object> value) {
            props.put("style", value);
            return this;
        }

        /** The toolbar options: {@code {copy, cut, paste, selectAll}} bools. */
        public InputBuilder toolbarOptions(Map<String, Object> value) {
            props.put("toolbarOptions", value);
            return this;
        }

        /** Smart dashes. */
        public InputBuilder smartDashesType(boolean value) {
            props.put("smartDashesType", value);
            return this;
        }

        /** Smart quotes. */
        public InputBuilder smartQuotesType(boolean value) {
            props.put("smartQuotesType", value);
            return this;
        }

        /** The editing-state change action. */
        public InputBuilder onEditingChanged(Map<String, Object> value) {
            props.put("onEditingChanged", value);
            return this;
        }

        /** The text-appended action. */
        public InputBuilder onAppended(Map<String, Object> value) {
            props.put("onAppended", value);
            return this;
        }

        /** The text-removed action. */
        public InputBuilder onRemoved(Map<String, Object> value) {
            props.put("onRemoved", value);
            return this;
        }

        /** The full {@code InputDecoration} map; the flattened keys win when both are present. */
        public InputBuilder decoration(Map<String, Object> value) {
            props.put("decoration", value);
            return this;
        }
    }

    /** {@code dropdown}(id, items, value?, action?) with the full dropdown parity. */
    public static final class DropdownBuilder extends ItemBuilder<DropdownBuilder> {

        private DropdownBuilder(String id) {
            props.put("id", id);
        }

        @Override
        String type() {
            return "dropdown";
        }

        /** Appends one item. */
        public DropdownBuilder item(String label, Object value) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("label", label);
            item.put("value", value);
            items().add(item);
            return this;
        }

        /** The selected value. */
        public DropdownBuilder value(Object value) {
            props.put("value", value);
            return this;
        }

        /** The placeholder. */
        public DropdownBuilder hint(String value) {
            props.put("hint", value);
            return this;
        }

        /** Whether the dropdown expands to full width. */
        public DropdownBuilder isExpanded(boolean value) {
            props.put("isExpanded", value);
            return this;
        }

        /** Whether the dropdown is dense. */
        public DropdownBuilder isDense(boolean value) {
            props.put("isDense", value);
            return this;
        }

        /** The menu elevation. */
        public DropdownBuilder elevation(Number value) {
            props.put("elevation", value);
            return this;
        }

        /** The trailing icon name. */
        public DropdownBuilder icon(String value) {
            props.put("icon", value);
            return this;
        }

        /** The icon size. */
        public DropdownBuilder iconSize(Number value) {
            props.put("iconSize", value);
            return this;
        }

        /** The alignment; validated. */
        public DropdownBuilder alignment(String value) {
            props.put("alignment", UiEnums.require("alignment", value, UiEnums.ALIGNMENT));
            return this;
        }

        /** The item height. */
        public DropdownBuilder itemHeight(Number value) {
            props.put("itemHeight", value);
            return this;
        }

        /** Custom selected rendering nodes. */
        public DropdownBuilder selectedItemBuilder(List<Object> nodes) {
            props.put("selectedItemBuilder", nodes);
            return this;
        }

        /** The menu height limit. */
        public DropdownBuilder menuMaxHeight(Number value) {
            props.put("menuMaxHeight", value);
            return this;
        }

        /** The focus color. */
        public DropdownBuilder focusColor(String value) {
            props.put("focusColor", value);
            return this;
        }

        /** The menu color. */
        public DropdownBuilder dropdownColor(String value) {
            props.put("dropdownColor", value);
            return this;
        }
    }

    /** {@code checkbox}(id, label, value?) with the full checkbox parity. */
    public static final class CheckboxBuilder extends NodeBuilder<CheckboxBuilder> {

        private CheckboxBuilder(String id, String label) {
            props.put("id", id);
            props.put("label", label);
        }

        @Override
        String type() {
            return "checkbox";
        }

        /** The checked state. */
        public CheckboxBuilder value(boolean value) {
            props.put("value", value);
            return this;
        }

        /** Whether the null state is allowed. */
        public CheckboxBuilder tristate(boolean value) {
            props.put("tristate", value);
            return this;
        }

        /** The fill color. */
        public CheckboxBuilder fillColor(String value) {
            props.put("fillColor", value);
            return this;
        }

        /** The hover color. */
        public CheckboxBuilder hoverColor(String value) {
            props.put("hoverColor", value);
            return this;
        }

        /** The focus color. */
        public CheckboxBuilder focusColor(String value) {
            props.put("focusColor", value);
            return this;
        }

        /** The disabled color. */
        public CheckboxBuilder disabledColor(String value) {
            props.put("disabledColor", value);
            return this;
        }

        /** The check icon name. */
        public CheckboxBuilder thumbIcon(String value) {
            props.put("thumbIcon", value);
            return this;
        }

        /** The track color. */
        public CheckboxBuilder trackColor(String value) {
            props.put("trackColor", value);
            return this;
        }

        /** The mouse cursor; validated. */
        public CheckboxBuilder mouseCursor(String value) {
            props.put("mouseCursor", UiEnums.require("mouseCursor", value, UiEnums.CURSOR));
            return this;
        }

        /** The splash radius. */
        public CheckboxBuilder splashRadius(Number value) {
            props.put("splashRadius", value);
            return this;
        }

        /** Whether the layout is dense. */
        public CheckboxBuilder dense(boolean value) {
            props.put("dense", value);
            return this;
        }
    }

    /** {@code switch}(id, label, value?) with the full switch parity. */
    public static final class ToggleBuilder extends NodeBuilder<ToggleBuilder> {

        private ToggleBuilder(String id, String label) {
            props.put("id", id);
            props.put("label", label);
        }

        @Override
        String type() {
            return "switch";
        }

        /** The on/off state. */
        public ToggleBuilder value(boolean value) {
            props.put("value", value);
            return this;
        }

        /** The thumb color when on. */
        public ToggleBuilder activeColor(String value) {
            props.put("activeColor", value);
            return this;
        }

        /** The track color when on. */
        public ToggleBuilder activeTrackColor(String value) {
            props.put("activeTrackColor", value);
            return this;
        }

        /** The thumb color when off. */
        public ToggleBuilder inactiveThumbColor(String value) {
            props.put("inactiveThumbColor", value);
            return this;
        }

        /** The track color when off. */
        public ToggleBuilder inactiveTrackColor(String value) {
            props.put("inactiveTrackColor", value);
            return this;
        }

        /** The thumb color. */
        public ToggleBuilder thumbColor(String value) {
            props.put("thumbColor", value);
            return this;
        }

        /** The track color. */
        public ToggleBuilder trackColor(String value) {
            props.put("trackColor", value);
            return this;
        }

        /** The thumb icon name. */
        public ToggleBuilder thumbIcon(String value) {
            props.put("thumbIcon", value);
            return this;
        }

        /** The mouse cursor; validated. */
        public ToggleBuilder mouseCursor(String value) {
            props.put("mouseCursor", UiEnums.require("mouseCursor", value, UiEnums.CURSOR));
            return this;
        }

        /** The splash radius. */
        public ToggleBuilder splashRadius(Number value) {
            props.put("splashRadius", value);
            return this;
        }

        /** The focus color. */
        public ToggleBuilder focusColor(String value) {
            props.put("focusColor", value);
            return this;
        }

        /** The hover color. */
        public ToggleBuilder hoverColor(String value) {
            props.put("hoverColor", value);
            return this;
        }

        /** Whether the layout is dense. */
        public ToggleBuilder dense(boolean value) {
            props.put("dense", value);
            return this;
        }
    }

    /** {@code slider}(id, label?, min, max, step?, value?) with the full slider parity. */
    public static final class SliderBuilder extends NodeBuilder<SliderBuilder> {

        private SliderBuilder(String id, double min, double max) {
            props.put("id", id);
            props.put("min", min);
            props.put("max", max);
        }

        @Override
        String type() {
            return "slider";
        }

        /** The slider label. */
        public SliderBuilder label(String value) {
            props.put("label", value);
            return this;
        }

        /** The step granularity. */
        public SliderBuilder step(double value) {
            props.put("step", value);
            return this;
        }

        /** The current value. */
        public SliderBuilder value(double value) {
            props.put("value", value);
            return this;
        }

        /** The active color. */
        public SliderBuilder activeColor(String value) {
            props.put("activeColor", value);
            return this;
        }

        /** The inactive color. */
        public SliderBuilder inactiveColor(String value) {
            props.put("inactiveColor", value);
            return this;
        }

        /** The thumb color. */
        public SliderBuilder thumbColor(String value) {
            props.put("thumbColor", value);
            return this;
        }

        /** The overlay color. */
        public SliderBuilder overlayColor(String value) {
            props.put("overlayColor", value);
            return this;
        }

        /** The mouse cursor; validated. */
        public SliderBuilder mouseCursor(String value) {
            props.put("mouseCursor", UiEnums.require("mouseCursor", value, UiEnums.CURSOR));
            return this;
        }

        /** The drag-start action. */
        public SliderBuilder onChangeStart(Map<String, Object> value) {
            props.put("onChangeStart", value);
            return this;
        }

        /** The drag-end action. */
        public SliderBuilder onChangeEnd(Map<String, Object> value) {
            props.put("onChangeEnd", value);
            return this;
        }
    }

    /** {@code form}(fields, submit) with submit {@code {label, action}}. */
    public static final class FormBuilder extends NodeBuilder<FormBuilder> {

        private FormBuilder() {
        }

        @Override
        String type() {
            return "form";
        }

        /** Appends one field node. */
        public FormBuilder field(UiNode node) {
            fields().add(node);
            return this;
        }

        /** Appends one string field (the text shorthand). */
        public FormBuilder field(String text) {
            fields().add(text);
            return this;
        }

        /** Sets the submit button. */
        public FormBuilder submit(String label, Map<String, Object> action) {
            Map<String, Object> submit = new LinkedHashMap<>();
            submit.put("label", label);
            submit.put("action", action);
            props.put("submit", submit);
            return this;
        }

        /** The validation mode: {@code disabled/always/onUserInteraction}; validated. */
        public FormBuilder autovalidateMode(String value) {
            props.put("autovalidateMode", UiEnums.require("autovalidateMode", value, UiEnums.AUTOVALIDATE_MODE));
            return this;
        }

        /** The any-field change action. */
        public FormBuilder onChanged(Map<String, Object> value) {
            props.put("onChanged", value);
            return this;
        }

        private List<Object> fields() {
            @SuppressWarnings("unchecked")
            List<Object> fields = (List<Object>) props.computeIfAbsent("fields", key -> new ArrayList<>());
            return fields;
        }
    }

    /** {@code list}(items, maxHeight?, sections?, …) with the full list parity. */
    public static final class ListBuilder extends ItemBuilder<ListBuilder> {

        private ListBuilder() {
        }

        @Override
        String type() {
            return "list";
        }

        /** The grouped mode sections. */
        public ListBuilder sections(List<Object> sections) {
            props.put("sections", sections);
            return this;
        }

        /** The node inserted between entries. */
        public ListBuilder separator(UiNode node) {
            props.put("separator", node);
            return this;
        }

        /** The reorder affordance action; reports the new order. */
        public ListBuilder onReorder(Map<String, Object> value) {
            props.put("onReorder", value);
            return this;
        }

        /** Whether entries are selectable. */
        public ListBuilder selection(boolean value) {
            props.put("selection", value);
            return this;
        }

        /** The fixed entry extent. */
        public ListBuilder itemExtent(Number value) {
            props.put("itemExtent", value);
            return this;
        }

        /** The prototype node for extent inference. */
        public ListBuilder prototypeItem(UiNode node) {
            props.put("prototypeItem", node);
            return this;
        }

        /** The node rendered when there are no items. */
        public ListBuilder empty(UiNode node) {
            props.put("empty", node);
            return this;
        }
    }

    /** {@code stream_view}(id, topic, mode?, itemLimit?, autoScroll?, empty?). */
    public static final class StreamViewBuilder extends NodeBuilder<StreamViewBuilder> {

        private StreamViewBuilder(String id, String topic) {
            props.put("id", id);
            props.put("topic", topic);
        }

        @Override
        String type() {
            return "stream_view";
        }

        /** The stream mode: {@code append} or {@code replace}; validated. */
        public StreamViewBuilder mode(String value) {
            props.put("mode", UiEnums.require("mode", value, UiEnums.STREAM_MODE));
            return this;
        }

        /** How many items to keep on screen. */
        public StreamViewBuilder itemLimit(int value) {
            props.put("itemLimit", value);
            return this;
        }

        /** Whether the view follows the newest item. */
        public StreamViewBuilder autoScroll(boolean value) {
            props.put("autoScroll", value);
            return this;
        }

        /** The placeholder text shown while the stream is empty. */
        public StreamViewBuilder empty(String value) {
            props.put("empty", value);
            return this;
        }

        /** The placeholder node shown while the stream is empty. */
        public StreamViewBuilder empty(UiNode node) {
            props.put("empty", node);
            return this;
        }
    }

    /** {@code table}(columns, rows) with columns {@code {label, width?}} and the full table parity. */
    public static final class TableBuilder extends NodeBuilder<TableBuilder> {

        private TableBuilder() {
        }

        @Override
        String type() {
            return "table";
        }

        /** Appends one column. */
        public TableBuilder column(String label) {
            return column(label, null);
        }

        /** Appends one column with a width (a number or a string). */
        public TableBuilder column(String label, Object width) {
            Map<String, Object> column = new LinkedHashMap<>();
            column.put("label", label);
            if (width != null) {
                column.put("width", width);
            }
            columns().add(column);
            return this;
        }

        /** Appends one row of cells (nodes or strings). */
        public TableBuilder row(Object... cells) {
            rows().add(List.of(cells));
            return this;
        }

        /** Whether rows are striped. */
        public TableBuilder zebra(boolean value) {
            props.put("zebra", value);
            return this;
        }

        /** Whether rows highlight on hover. */
        public TableBuilder hoverable(boolean value) {
            props.put("hoverable", value);
            return this;
        }

        /** The row tap action. */
        public TableBuilder onRowTap(Map<String, Object> value) {
            props.put("onRowTap", value);
            return this;
        }

        /** Whether the header stays visible while scrolling. */
        public TableBuilder stickyHeader(boolean value) {
            props.put("stickyHeader", value);
            return this;
        }

        /** The current sort: {@code {column, ascending}}. */
        public TableBuilder sort(Map<String, Object> value) {
            props.put("sort", value);
            return this;
        }

        /** The node rendered when {@code rows} is missing or empty. */
        public TableBuilder empty(UiNode node) {
            props.put("empty", node);
            return this;
        }

        private List<Object> columns() {
            @SuppressWarnings("unchecked")
            List<Object> columns = (List<Object>) props.computeIfAbsent("columns", key -> new ArrayList<>());
            return columns;
        }

        private List<Object> rows() {
            @SuppressWarnings("unchecked")
            List<Object> rows = (List<Object>) props.computeIfAbsent("rows", key -> new ArrayList<>());
            return rows;
        }
    }

    /** {@code divider}(height?, thickness?, color?, indent?, endIndent?) — height and color come from the universal lattice. */
    public static final class DividerBuilder extends NodeBuilder<DividerBuilder> {

        private DividerBuilder() {
        }

        @Override
        String type() {
            return "divider";
        }

        /** The line thickness. */
        public DividerBuilder thickness(Number value) {
            props.put("thickness", value);
            return this;
        }

        /** The leading inset. */
        public DividerBuilder indent(Number value) {
            props.put("indent", value);
            return this;
        }

        /** The trailing inset. */
        public DividerBuilder endIndent(Number value) {
            props.put("endIndent", value);
            return this;
        }
    }

    /** {@code spacer}(axis?, size?). */
    public static final class SpacerBuilder extends NodeBuilder<SpacerBuilder> {

        private SpacerBuilder() {
        }

        @Override
        String type() {
            return "spacer";
        }

        /** The spacer axis: {@code vertical} or {@code horizontal}; validated. */
        public SpacerBuilder axis(String value) {
            props.put("axis", UiEnums.require("axis", value, UiEnums.SPACER_AXIS));
            return this;
        }

        /** The gap size in logical pixels (or a token). */
        public SpacerBuilder size(Number value) {
            props.put("size", value);
            return this;
        }
    }

    /** {@code progress}(kind?, value?, color?) — color comes from the universal lattice. */
    public static final class ProgressBuilder extends NodeBuilder<ProgressBuilder> {

        private ProgressBuilder() {
        }

        @Override
        String type() {
            return "progress";
        }

        /** The indicator kind: {@code linear} or {@code circular}; validated. */
        public ProgressBuilder kind(String value) {
            props.put("kind", UiEnums.require("kind", value, UiEnums.PROGRESS_KIND));
            return this;
        }

        /** The completion value; omitted means indeterminate. */
        public ProgressBuilder value(double value) {
            props.put("value", value);
            return this;
        }
    }

    /** {@code image}(src|dataUri, width?, height?, fit?) — width/height come from the universal lattice. */
    public static final class ImageBuilder extends NodeBuilder<ImageBuilder> {

        private ImageBuilder() {
        }

        @Override
        String type() {
            return "image";
        }

        /** The image source URL. */
        public ImageBuilder src(String value) {
            props.put("src", value);
            return this;
        }

        /** The image as an inline data URI. */
        public ImageBuilder dataUri(String value) {
            props.put("dataUri", value);
            return this;
        }

        /** How the image fits its box: {@code cover/contain/fill/fitWidth/fitHeight/none/scaleDown}; validated. */
        public ImageBuilder fit(String value) {
            props.put("fit", UiEnums.require("fit", value, UiEnums.BOX_FIT));
            return this;
        }
    }

    /** {@code figure}(shape, color, width, height) — color/width/height come from the universal lattice. */
    public static final class FigureBuilder extends NodeBuilder<FigureBuilder> {

        private FigureBuilder() {
        }

        @Override
        String type() {
            return "figure";
        }

        /** The shape: {@code rectangle}, {@code circle} or {@code triangle}; validated. */
        public FigureBuilder shape(String value) {
            props.put("shape", UiEnums.require("shape", value, UiEnums.FIGURE_SHAPE));
            return this;
        }

        /** The fill color as an int. */
        public FigureBuilder color(int value) {
            props.put("color", value);
            return this;
        }
    }

    /** {@code chart_line}(series). */
    public static final class ChartLineBuilder extends NodeBuilder<ChartLineBuilder> {

        private ChartLineBuilder() {
        }

        @Override
        String type() {
            return "chart_line";
        }

        /** The plotted series. */
        public ChartLineBuilder series(List<?> value) {
            props.put("series", value);
            return this;
        }
    }

    /** {@code chart_bar}(items|series). */
    public static final class ChartBarBuilder extends NodeBuilder<ChartBarBuilder> {

        private ChartBarBuilder() {
        }

        @Override
        String type() {
            return "chart_bar";
        }

        /** The plotted items. */
        public ChartBarBuilder items(List<?> value) {
            props.put("items", value);
            return this;
        }

        /** The plotted series. */
        public ChartBarBuilder series(List<?> value) {
            props.put("series", value);
            return this;
        }
    }

    /** {@code chart_pie}(items). */
    public static final class ChartPieBuilder extends NodeBuilder<ChartPieBuilder> {

        private ChartPieBuilder() {
        }

        @Override
        String type() {
            return "chart_pie";
        }

        /** The plotted items. */
        public ChartPieBuilder items(List<?> value) {
            props.put("items", value);
            return this;
        }
    }

    /** {@code drawer}(title?, children). */
    public static final class DrawerBuilder extends ParentBuilder<DrawerBuilder> {

        private DrawerBuilder() {
        }

        @Override
        String type() {
            return "drawer";
        }

        /** The drawer title. */
        public DrawerBuilder title(String value) {
            props.put("title", value);
            return this;
        }
    }
}
