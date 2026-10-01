/**
 * Fluent builder over the 25 primitives of the SDUI catalog.
 *
 * <p>One factory per primitive, each returning a small builder whose typed
 * setters mirror the prop list of that primitive (see the catalog of the SDUI
 * contract). The universal optional fields ({@code id}, {@code visible},
 * {@code padding}, {@code flex}, {@code when}) are available on every builder.
 * Builders are lenient: values are passed through to the wire shape and the
 * client degrades malformed props per node, never per screen.
 *
 * <p>Usage:
 * <pre>{@code
 * UiNode screen = Ui.screen()
 *     .title("Jhin")
 *     .body(Ui.container()
 *         .direction("column")
 *         .gap(8)
 *         .child(Ui.text("Hello").style("h2"))
 *         .child("plain string child"))
 *     .build();
 * }</pre>
 */
package com.astroreen.jhin.plugin.uikit;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class Ui {

    private Ui() {
    }

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

    /** Base of every builder: the universal optional fields and {@link #build()}. */
    public abstract static class NodeBuilder<B extends NodeBuilder<B>> {

        /** The props collected so far, in insertion order. */
        protected final Map<String, Object> props = new LinkedHashMap<>();

        @SuppressWarnings("unchecked")
        protected B self() {
            return (B) this;
        }

        /** The primitive type name this builder produces. */
        abstract String type();

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

        /** Sets the universal {@code padding} prop (a number or a padding map). */
        public B padding(Object value) {
            props.put("padding", value);
            return self();
        }

        /** Sets the universal {@code flex} prop. */
        public B flex(int value) {
            props.put("flex", value);
            return self();
        }

        /** Sets the universal {@code when} prop (a local boolean expression). */
        public B when(String expression) {
            props.put("when", expression);
            return self();
        }

        /** Builds the node. */
        public UiNode build() {
            return new UiNode(type(), props, List.of());
        }
    }

    /** Base of the builders whose primitive takes {@code children}. */
    public abstract static class ParentBuilder<B extends ParentBuilder<B>> extends NodeBuilder<B> {

        /** The collected children, in insertion order. */
        protected final List<Object> children = new ArrayList<>();

        /** Appends one child node. */
        public B child(UiNode node) {
            children.add(node);
            return self();
        }

        /** Appends one string child (the text shorthand). */
        public B child(String text) {
            children.add(text);
            return self();
        }

        /** Appends every entry of the list, nodes and strings alike. */
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
    public static final class NavBuilder extends NodeBuilder<NavBuilder> {

        private NavBuilder() {
        }

        @Override
        String type() {
            return "nav";
        }

        /** The navigation kind: {@code tabs}, {@code drawer} or {@code bottom}. */
        public NavBuilder kind(String value) {
            props.put("kind", value);
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

        private List<Object> items() {
            @SuppressWarnings("unchecked")
            List<Object> items = (List<Object>) props.computeIfAbsent("items", key -> new ArrayList<>());
            return items;
        }
    }

    /** {@code container}(children, direction?, padding?, gap?, align?, scroll?). */
    public static final class ContainerBuilder extends ParentBuilder<ContainerBuilder> {

        private ContainerBuilder() {
        }

        @Override
        String type() {
            return "container";
        }

        /** The layout direction: {@code row} or {@code column}. */
        public ContainerBuilder direction(String value) {
            props.put("direction", value);
            return this;
        }

        /** The gap between children, in logical pixels. */
        public ContainerBuilder gap(Number value) {
            props.put("gap", value);
            return this;
        }

        /** The cross-axis alignment. */
        public ContainerBuilder align(String value) {
            props.put("align", value);
            return this;
        }

        /** Whether the container scrolls. */
        public ContainerBuilder scroll(boolean value) {
            props.put("scroll", value);
            return this;
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

    /** {@code text}(text, style?, bold?, color?). */
    public static final class TextBuilder extends NodeBuilder<TextBuilder> {

        private TextBuilder(String text) {
            props.put("text", text);
        }

        @Override
        String type() {
            return "text";
        }

        /** The text style: {@code h1}, {@code h2}, {@code h3}, {@code body}, {@code caption} or {@code mono}. */
        public TextBuilder style(String value) {
            props.put("style", value);
            return this;
        }

        /** Whether the text is bold. */
        public TextBuilder bold(boolean value) {
            props.put("bold", value);
            return this;
        }

        /** The text color as a string ({@code #RRGGBB}, {@code #AARRGGBB}, {@code 0xFFRRGGBB}). */
        public TextBuilder color(String value) {
            props.put("color", value);
            return this;
        }

        /** The text color as an int. */
        public TextBuilder color(int value) {
            props.put("color", value);
            return this;
        }
    }

    /** {@code markdown}(text). */
    public static final class MarkdownBuilder extends NodeBuilder<MarkdownBuilder> {

        private MarkdownBuilder(String text) {
            props.put("text", text);
        }

        @Override
        String type() {
            return "markdown";
        }
    }

    /** {@code button}(label, style?, action?, icon?, confirm?). */
    public static final class ButtonBuilder extends NodeBuilder<ButtonBuilder> {

        private ButtonBuilder(String label) {
            props.put("label", label);
        }

        @Override
        String type() {
            return "button";
        }

        /** The button style: {@code primary}, {@code secondary}, {@code danger} or {@code text}. */
        public ButtonBuilder style(String value) {
            props.put("style", value);
            return this;
        }

        /** The action: an action descriptor or one inline client directive. */
        public ButtonBuilder action(Map<String, Object> value) {
            props.put("action", value);
            return this;
        }

        /** The icon name. */
        public ButtonBuilder icon(String value) {
            props.put("icon", value);
            return this;
        }

        /** The confirmation message asked before the action fires. */
        public ButtonBuilder confirm(String value) {
            props.put("confirm", value);
            return this;
        }
    }

    /** {@code input}(id, label?, value?, placeholder?, multiline?, obscure?, keyboard?, required?, min?, max?, pattern?, errorText?). */
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

        /** The keyboard kind. */
        public InputBuilder keyboard(String value) {
            props.put("keyboard", value);
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
    }

    /** {@code dropdown}(id, items, value?, action?). */
    public static final class DropdownBuilder extends NodeBuilder<DropdownBuilder> {

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

        /** The action fired when the selection changes. */
        public DropdownBuilder action(Map<String, Object> value) {
            props.put("action", value);
            return this;
        }

        private List<Object> items() {
            @SuppressWarnings("unchecked")
            List<Object> items = (List<Object>) props.computeIfAbsent("items", key -> new ArrayList<>());
            return items;
        }
    }

    /** {@code checkbox}(id, label, value?). */
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
    }

    /** {@code switch}(id, label, value?). */
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
    }

    /** {@code slider}(id, label?, min, max, step?, value?). */
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

        private List<Object> fields() {
            @SuppressWarnings("unchecked")
            List<Object> fields = (List<Object>) props.computeIfAbsent("fields", key -> new ArrayList<>());
            return fields;
        }
    }

    /** {@code list}(items, maxHeight?). */
    public static final class ListBuilder extends NodeBuilder<ListBuilder> {

        private ListBuilder() {
        }

        @Override
        String type() {
            return "list";
        }

        /** Appends one item node. */
        public ListBuilder item(UiNode node) {
            items().add(node);
            return this;
        }

        /** Appends one string item (the text shorthand). */
        public ListBuilder item(String text) {
            items().add(text);
            return this;
        }

        /** Sets the maximum height of the scrolling list. */
        public ListBuilder maxHeight(Number value) {
            props.put("maxHeight", value);
            return this;
        }

        private List<Object> items() {
            @SuppressWarnings("unchecked")
            List<Object> items = (List<Object>) props.computeIfAbsent("items", key -> new ArrayList<>());
            return items;
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

        /** The stream mode: {@code append} or {@code replace}. */
        public StreamViewBuilder mode(String value) {
            props.put("mode", value);
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
    }

    /** {@code table}(columns, rows) with columns {@code {label, width?}}. */
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

    /** {@code divider}. */
    public static final class DividerBuilder extends NodeBuilder<DividerBuilder> {

        private DividerBuilder() {
        }

        @Override
        String type() {
            return "divider";
        }
    }

    /** {@code spacer}(size?). */
    public static final class SpacerBuilder extends NodeBuilder<SpacerBuilder> {

        private SpacerBuilder() {
        }

        @Override
        String type() {
            return "spacer";
        }

        /** The gap size in logical pixels. */
        public SpacerBuilder size(Number value) {
            props.put("size", value);
            return this;
        }
    }

    /** {@code progress}(kind?, value?). */
    public static final class ProgressBuilder extends NodeBuilder<ProgressBuilder> {

        private ProgressBuilder() {
        }

        @Override
        String type() {
            return "progress";
        }

        /** The indicator kind: {@code linear} or {@code circular}. */
        public ProgressBuilder kind(String value) {
            props.put("kind", value);
            return this;
        }

        /** The completion value; omitted means indeterminate. */
        public ProgressBuilder value(double value) {
            props.put("value", value);
            return this;
        }
    }

    /** {@code image}(src|dataUri, width?, height?, fit?). */
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

        /** The rendered width. */
        public ImageBuilder width(Number value) {
            props.put("width", value);
            return this;
        }

        /** The rendered height. */
        public ImageBuilder height(Number value) {
            props.put("height", value);
            return this;
        }

        /** How the image fits its box. */
        public ImageBuilder fit(String value) {
            props.put("fit", value);
            return this;
        }
    }

    /** {@code figure}(shape, color, width, height). */
    public static final class FigureBuilder extends NodeBuilder<FigureBuilder> {

        private FigureBuilder() {
        }

        @Override
        String type() {
            return "figure";
        }

        /** The shape: {@code rectangle}, {@code circle} or {@code triangle}. */
        public FigureBuilder shape(String value) {
            props.put("shape", value);
            return this;
        }

        /** The fill color as a string ({@code #RRGGBB}, {@code #AARRGGBB}, {@code 0xFFRRGGBB}). */
        public FigureBuilder color(String value) {
            props.put("color", value);
            return this;
        }

        /** The fill color as an int. */
        public FigureBuilder color(int value) {
            props.put("color", value);
            return this;
        }

        /** The figure width. */
        public FigureBuilder width(Number value) {
            props.put("width", value);
            return this;
        }

        /** The figure height. */
        public FigureBuilder height(Number value) {
            props.put("height", value);
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
