/**
 * Fluent builder over the primitive catalog of the SDUI contract.
 *
 * <p>One factory per primitive, each returning a small builder whose typed
 * setters mirror the prop list of that primitive (docs/sdui.md section 2.6)
 * plus the full universal surface of section 2.1. The universal surface is
 * implemented once in {@link NodeBuilder} through the {@code Has*} lattice of
 * the {@code has} package (Box, Text, Flex, Interaction); parent builders add
 * {@code children} ({@link ParentBuilder}) and item-taking builders add
 * {@code items} ({@link ItemBuilder}). The level-3 glass group
 * ({@link com.astroreen.jhin.plugin.uikit.has.HasGlass}) is accepted on
 * exactly the five glass-capable surfaces — card, sheet, dialog, menu and
 * banner; every other builder rejects it through the escape hatch. Every
 * Flutter parameter of the widget
 * a primitive renders has exactly one typed setter; unset params are simply
 * absent from the emitted JSON so the client uses its token defaults.
 *
 * <p>Builders validate enum-typed literals immediately ({@code
 * IllegalArgumentException} on an unknown value — a builder bug is a
 * build-time failure, never a silent render-time degradation) and pass
 * everything else through to the wire shape; the client degrades malformed
 * props per node, never per screen. Token references ({@code $space.commandContent},
 * {@code $color.accent}, …) are emitted as literal strings — see
 * {@link UiTokens}; resolution is client-side only.
 *
 * <p>Usage:
 * <pre>{@code
 * UiNode screen = Ui.screen()
 *     .title("Jhin")
 *     .body(Ui.container()
 *         .direction("column")
 *         .gap(UiTokens.space("sidebarControlGap"))
 *         .padding(UiTokens.space("commandContent"))
 *         .child(Ui.text("Hello").style("h2"))
 *         .child("plain string child"))
 *     .build();
 * }</pre>
 */
package com.astroreen.jhin.plugin.uikit;

import com.astroreen.jhin.plugin.uikit.has.HasBox;
import com.astroreen.jhin.plugin.uikit.has.HasChildren;
import com.astroreen.jhin.plugin.uikit.has.HasDiffView;
import com.astroreen.jhin.plugin.uikit.has.HasFlex;
import com.astroreen.jhin.plugin.uikit.has.HasGlass;
import com.astroreen.jhin.plugin.uikit.has.HasHoverCard;
import com.astroreen.jhin.plugin.uikit.has.HasInteraction;
import com.astroreen.jhin.plugin.uikit.has.HasItems;
import com.astroreen.jhin.plugin.uikit.has.HasKbd;
import com.astroreen.jhin.plugin.uikit.has.HasScrollFade;
import com.astroreen.jhin.plugin.uikit.has.HasSplit;
import com.astroreen.jhin.plugin.uikit.has.HasText;
import com.astroreen.jhin.plugin.uikit.has.HasToastStack;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
     * A {@code borderRadius} token reference: a {@code $radius.*} string as
     * produced by {@link UiTokens#radius}. Build the reference through
     * {@code UiTokens.radius(key)} so an unknown key fails at build time.
     *
     * @param token the {@code $radius} token
     * @return the token unchanged
     */
    public static String radius(String token) {
        return token;
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

    /** A mixed-style inline run: {@code rich_text}(spans). */
    public static RichTextBuilder richText() {
        return new RichTextBuilder();
    }

    /** One {@code rich_text} span spec: {@code {text, style?, action?, tooltip?}}. */
    public static SpanBuilder span(String text) {
        return new SpanBuilder(text);
    }

    /** A code block: {@code code_block}(code, language?, wrap?, copyable?, maxLines?, lineNumbers?). */
    public static CodeBlockBuilder codeBlock(String code) {
        return new CodeBlockBuilder(code);
    }

    /** A button: {@code button}(label, style?, action?, icon?, confirm?). */
    public static ButtonBuilder button(String label) {
        return new ButtonBuilder(label);
    }

    /** A text field: {@code input}(id, label?, value?, placeholder?, …). */
    public static InputBuilder input(String id) {
        return new InputBuilder(id);
    }

    /** {@code textarea}(id) — the full {@code input} prop set with {@code multiline} defaulting to true (client-side). */
    public static TextareaBuilder textarea(String id) {
        return new TextareaBuilder(id);
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

    /** {@code tree}(items, onSelect?) with nested item specs. */
    public static TreeBuilder tree() {
        return new TreeBuilder();
    }

    /** One {@code tree} item spec: {@code label}, {@code icon?}, {@code expanded?}, {@code action?}, {@code items?}. */
    public static TreeItemBuilder treeItem(String label) {
        return new TreeItemBuilder(label);
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

    /** A decorated layout box: {@code box}(child?, children?, direction?, shape?, alignment?) — the layout superset of {@code container}. */
    public static BoxBuilder box() {
        return new BoxBuilder();
    }

    /** A horizontal flex: {@code row}(children) — all layout props come from the universal Flex group. */
    public static RowBuilder row() {
        return new RowBuilder();
    }

    /** A vertical flex: {@code column}(children) — all layout props come from the universal Flex group. */
    public static ColumnBuilder column() {
        return new ColumnBuilder();
    }

    /** The explicit, axis-parametrized flex primitive: {@code flex}(direction, children). */
    public static FlexBuilder flex(String direction) {
        return new FlexBuilder(direction);
    }

    /** {@code expanded}(flex?, child) — {@code flex} is inherited from the universal Flex group (default {@code 1} client-side). */
    public static ExpandedBuilder expanded() {
        return new ExpandedBuilder();
    }

    /** {@code flexible}(flex?, fit?, child) — {@code flex}/{@code fit} are inherited from the universal Flex group. */
    public static FlexibleBuilder flexible() {
        return new FlexibleBuilder();
    }

    /** {@code sized_box}(width?, height?, child?) — {@code width}/{@code height} are inherited from the universal Box group. */
    public static SizedBoxBuilder sizedBox() {
        return new SizedBoxBuilder();
    }

    /** {@code align}(align?, child) — {@code align} is inherited from the universal Box group (default {@code center} client-side). */
    public static AlignBuilder align() {
        return new AlignBuilder();
    }

    /** {@code center}(child) — shorthand for {@code align: center}. */
    public static CenterBuilder center() {
        return new CenterBuilder();
    }

    /** {@code aspect_ratio}(aspectRatio, child?) — the explicit standalone form of the universal {@code aspectRatio}, wrapping a {@code child} slot. */
    public static AspectRatioBuilder aspectRatio(double aspectRatio) {
        return new AspectRatioBuilder(aspectRatio);
    }

    /** A layered overlay: {@code stack}(alignment?, fit?, clipBehavior?, textDirection?, children). */
    public static StackBuilder stack() {
        return new StackBuilder();
    }

    /** A stack-layered child: {@code positioned}(top?, right?, bottom?, left?, width?, height?, child?). */
    public static PositionedBuilder positioned() {
        return new PositionedBuilder();
    }

    /** A flow layout: {@code wrap}(direction?, alignment?, spacing?, runSpacing?, runAlignment?, crossAxisAlignment?, textDirection?, verticalDirection?, children). */
    public static WrapBuilder wrap() {
        return new WrapBuilder();
    }

    /** A cell grid: {@code grid}(columns?, childAspectRatio?, crossAxisSpacing?, mainAxisSpacing?, shrinkWrap?, physics?, children). */
    public static GridBuilder grid() {
        return new GridBuilder();
    }

    /** A scroll region: {@code scroll}(children?, items?, itemCount?, scrollDirection?, reverse?, physics?, shrinkWrap?). */
    public static ScrollBuilder scroll() {
        return new ScrollBuilder();
    }

    /** A registry icon: {@code icon}(icon, size?, color?, semanticLabel?, fill?, weight?, grade?, opticalSize?, shadows?, textDirection?, blendMode?). */
    public static IconBuilder icon() {
        return new IconBuilder();
    }

    /** An icon button: {@code icon_button}(icon, action?, iconSize?, color?, …) — the full IconButton parameter set of docs/sdui.md section 2.6. */
    public static IconButtonBuilder iconButton() {
        return new IconButtonBuilder();
    }

    /** A list row: {@code list_row}(leading?, title?, subtitle?, trailing?, badge?, selected?, dragHandle?). */
    public static ListRowBuilder listRow() {
        return new ListRowBuilder();
    }

    /** A badge: {@code badge}(label?, count?, dot?, color?, max?). */
    public static BadgeBuilder badge() {
        return new BadgeBuilder();
    }

    /** A chip: {@code chip}(label, icon?, avatar?, selected?, onDeleted?, variant?). */
    public static ChipBuilder chip() {
        return new ChipBuilder();
    }

    /** An avatar: {@code avatar}(image?, initials?, icon?, color?, size?, shape?). */
    public static AvatarBuilder avatar() {
        return new AvatarBuilder();
    }

    /** A skeleton placeholder: {@code skeleton}(variant?, lines?, width?, height?, shimmer?). */
    public static SkeletonBuilder skeleton() {
        return new SkeletonBuilder();
    }

    /** A popup menu: {@code menu}(trigger, items, breakpoint?). */
    public static MenuBuilder menu() {
        return new MenuBuilder();
    }

    /** One {@code menu} item spec ({@code {label, icon?, action?, confirm?, disabled?, divider?, danger?}}). */
    public static MenuItemBuilder menuItem(String label) {
        return new MenuItemBuilder(label);
    }

    /** A modal bottom sheet: {@code sheet}(title?, body?, footer?, height?, dismissible?). */
    public static SheetBuilder sheet() {
        return new SheetBuilder();
    }

    /** An AlertDialog-shaped node: {@code dialog}(title?, content?, actions?). */
    public static DialogBuilder dialog() {
        return new DialogBuilder();
    }

    /** A persistent notice: {@code banner}(content?, actions?, onDismiss?). */
    public static BannerBuilder banner() {
        return new BannerBuilder();
    }

    /** A tab strip with panels: {@code tabs}(items, activeIndex?, variant?). */
    public static TabsBuilder tabs() {
        return new TabsBuilder();
    }

    /** One {@code tabs} item spec ({@code {label, icon?, badge?, panel?}}). */
    public static TabItemBuilder tabItem(String label) {
        return new TabItemBuilder(label);
    }

    /** A single-select control: {@code segmented}(segments, value?, action?). */
    public static SegmentedBuilder segmented() {
        return new SegmentedBuilder();
    }

    /** An app shell: {@code shell}(sidebar?, header?, body?, detail?, rail?, breakpoint?, sidebarWidth?, sidebarCollapsedWidth?, collapsible?, collapsed?). */
    public static ShellBuilder shell() {
        return new ShellBuilder();
    }

    /**
     * A resizable two-pane layout: {@code split}(first, second, axis?,
     * initial?, min?, max?, minSecond?, persistKey?, handleStyle?). The
     * client defaults come from the layout token family — {@code initial}
     * from {@code layout.sidebarWidth} (256), {@code min} from
     * {@code layout.sidebarMinWidth} (208) and {@code minSecond} from
     * {@code layout.mainMinWidth} (640).
     */
    public static SplitBuilder split() {
        return new SplitBuilder();
    }

    /**
     * A hover-opened preview card: {@code hover_card}(trigger, content,
     * delay?, placement?). The client opens the card after {@code delay} ms
     * (default 500) of hover — tap-and-hold on touch — and degrades a
     * missing content to the bare trigger.
     */
    public static HoverCardBuilder hoverCard() {
        return new HoverCardBuilder();
    }

    /**
     * A keyboard-hint pill row: {@code kbd}(chord). The chord splits on
     * {@code +} and {@code mod} resolves per platform client-side (Cmd on
     * macOS, Ctrl elsewhere).
     */
    public static KbdBuilder kbd() {
        return new KbdBuilder();
    }

    /**
     * A positioned stack of transient notices: {@code toast_stack}(items,
     * direction?). Each item is {@code {text, style?, action?, duration?}} —
     * the 5 s undo pattern is an item with an inline {@code action} and the
     * default 5000 ms window.
     */
    public static ToastStackBuilder toastStack() {
        return new ToastStackBuilder();
    }

    /**
     * An alpha fade over a scrollable's edge: {@code scroll_fade}(child,
     * edge?, height?, mode?). The {@code topbar} mode paints the static
     * seven-stop band (the messages-timeline recipe), the {@code
     * virtualized} mode the scroll-aware two-stop band (the lazy-list
     * recipe — an edge fades only while content hides beyond it).
     */
    public static ScrollFadeBuilder scrollFade() {
        return new ScrollFadeBuilder();
    }

    /**
     * The decorative diff renderer: {@code diff_view}(file?, language?,
     * hunks, view?, colorScheme?, stats?, demo). The {@code demo} marker is
     * mandatory — {@link DiffViewBuilder#build()} fails with
     * {@code demo marker required} without it.
     */
    public static DiffViewBuilder diffView() {
        return new DiffViewBuilder();
    }

    /** One {@code diff_view} hunk spec ({@code {header, lines}}). */
    public static DiffHunkBuilder diffHunk(String header) {
        return new DiffHunkBuilder(header);
    }

    /** One {@code diff_view} line spec ({@code {kind, oldNo?, newNo?, text}}). */
    public static DiffLineBuilder diffLine(String kind) {
        return new DiffLineBuilder(kind);
    }

    /** One {@code toast_stack} item spec ({@code {text, style?, action?, duration?}}). */
    public static ToastItemBuilder toastItem(String text) {
        return new ToastItemBuilder(text);
    }

    /** One {@code nav} item spec ({@code {label, icon?, screen?, action?, badge?, count?, section?, enabled?}}). */
    public static NavItemBuilder navItem(String label) {
        return new NavItemBuilder(label);
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
            if (!glassCapable() && (key.equals("glass") || key.equals("glassTint"))) {
                throw new IllegalArgumentException("unsupported prop " + key + " on " + type()
                        + " — only card, sheet, dialog, menu and banner accept it");
            }
            props.put(key, value);
            return self();
        }

        @Override
        public Map<String, Object> props() {
            return props;
        }

        /**
         * Whether this builder is one of the five glass-capable surfaces
         * (docs/sdui.md section 2.1); the escape hatch rejects the glass
         * keys everywhere else with the standard unsupported-prop error.
         */
        boolean glassCapable() {
            return false;
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

        /** Appends one item that opens a named sidebar section. */
        public NavBuilder item(String label, String icon, String screen, String section) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("label", label);
            if (icon != null) {
                item.put("icon", icon);
            }
            item.put("screen", screen);
            if (section != null) {
                item.put("section", section);
            }
            items().add(item);
            return this;
        }

        /** Appends one finished item spec ({@link Ui#navItem(String)}). */
        public NavBuilder item(NavItemBuilder item) {
            items().add(item.build());
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
    public static final class CardBuilder extends ParentBuilder<CardBuilder> implements HasGlass<CardBuilder> {

        private CardBuilder() {
        }

        @Override
        String type() {
            return "card";
        }

        @Override
        boolean glassCapable() {
            return true;
        }

        /** The level-3 {@code glass} prop: the glass surface treatment. */
        @Override
        public CardBuilder glass(boolean value) {
            props.put("glass", value);
            return this;
        }

        /** The level-3 {@code glassTint} prop: the tint colour of the glass fill. */
        @Override
        public CardBuilder glassTint(String value) {
            props.put("glassTint", value);
            return this;
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

    /**
     * The spec builder of one {@code rich_text} span ({@code {text, style?,
     * action?, tooltip?}}): see {@link Ui#span(String)}. Finished with
     * {@link #build()}, the spec is appended through
     * {@link RichTextBuilder#span(Map)}.
     */
    public static final class SpanBuilder {

        private final Map<String, Object> spec = new LinkedHashMap<>();

        private SpanBuilder(String text) {
            spec.put("text", text);
        }

        /** The span style typography token: {@code h1}, {@code h2}, {@code h3}, {@code body}, {@code small}, {@code caption} or {@code mono}; validated. */
        public SpanBuilder style(String token) {
            spec.put("style", UiEnums.require("style", token, UiEnums.TEXT_STYLE));
            return this;
        }

        /** The span style as a TextStyle map. */
        public SpanBuilder style(Map<String, Object> value) {
            spec.put("style", value);
            return this;
        }

        /** The tappable span action (an unknown action drops the action and keeps the text). */
        public SpanBuilder action(Map<String, Object> value) {
            spec.put("action", value);
            return this;
        }

        /** The span tooltip. */
        public SpanBuilder tooltip(String value) {
            spec.put("tooltip", value);
            return this;
        }

        /** The finished span spec, in insertion order. */
        public Map<String, Object> build() {
            return new LinkedHashMap<>(spec);
        }
    }

    /** {@code rich_text}(spans) — inline spans of {@code {text, style?, action?, tooltip?}}. */
    public static final class RichTextBuilder extends NodeBuilder<RichTextBuilder> {

        private RichTextBuilder() {
        }

        @Override
        String type() {
            return "rich_text";
        }

        /** Appends one plain-text span. */
        public RichTextBuilder span(String text) {
            Map<String, Object> spec = new LinkedHashMap<>();
            spec.put("text", text);
            spans().add(spec);
            return this;
        }

        /** Appends one span spec ({@link Ui#span(String)} builds one). */
        public RichTextBuilder span(Map<String, Object> spec) {
            spans().add(new LinkedHashMap<>(spec));
            return this;
        }

        private List<Object> spans() {
            @SuppressWarnings("unchecked")
            List<Object> spans = (List<Object>) props.computeIfAbsent("spans", key -> new ArrayList<>());
            return spans;
        }
    }

    /**
     * {@code code_block}(code, language?, wrap?, copyable?, maxLines?,
     * lineNumbers?) — a monospace code block with an optional language label,
     * copy affordance (clipboard + toast), wrap toggle, line limit and line
     * numbers (docs/sdui.md section 2.6).
     */
    public static final class CodeBlockBuilder extends NodeBuilder<CodeBlockBuilder> {

        private CodeBlockBuilder(String code) {
            props.put("code", code);
        }

        @Override
        String type() {
            return "code_block";
        }

        /** The language label (any string; an unknown language is just a label). */
        public CodeBlockBuilder language(String value) {
            props.put("language", value);
            return this;
        }

        /** Whether long lines wrap. */
        public CodeBlockBuilder wrap(boolean value) {
            props.put("wrap", value);
            return this;
        }

        /** Whether the copy affordance is shown (copies via clipboard + toast). */
        public CodeBlockBuilder copyable(boolean value) {
            props.put("copyable", value);
            return this;
        }

        /** The line limit. */
        public CodeBlockBuilder maxLines(int value) {
            props.put("maxLines", value);
            return this;
        }

        /** Whether line numbers are shown. */
        public CodeBlockBuilder lineNumbers(boolean value) {
            props.put("lineNumbers", value);
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
    public static class InputBuilder extends NodeBuilder<InputBuilder> {

        protected InputBuilder(String id) {
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

        /** The maximum line count. */
        public InputBuilder maxLines(int value) {
            props.put("maxLines", value);
            return this;
        }

        /** The decoration prefix text. */
        public InputBuilder prefix(String value) {
            props.put("prefix", value);
            return this;
        }

        /** The decoration suffix text. */
        public InputBuilder suffix(String value) {
            props.put("suffix", value);
            return this;
        }

        /** The border when focused with an error; validated like {@link #border(String)}. */
        public InputBuilder focusedErrorBorder(String value) {
            props.put("focusedErrorBorder",
                    UiEnums.require("focusedErrorBorder", value, UiEnums.INPUT_BORDER));
            return this;
        }

        /** The border when disabled; validated like {@link #border(String)}. */
        public InputBuilder disabledBorder(String value) {
            props.put("disabledBorder", UiEnums.require("disabledBorder", value, UiEnums.INPUT_BORDER));
            return this;
        }

        /** The label floating behavior: {@code never/always/auto}; validated. */
        public InputBuilder floatingLabelBehavior(String value) {
            props.put("floatingLabelBehavior",
                    UiEnums.require("floatingLabelBehavior", value, UiEnums.FLOATING_LABEL_BEHAVIOR));
            return this;
        }

        /** The semantics counter text. */
        public InputBuilder semanticCounterText(String value) {
            props.put("semanticCounterText", value);
            return this;
        }

        /** The text alignment; validated. */
        public InputBuilder textAlign(String value) {
            props.put("textAlign", UiEnums.require("textAlign", value, UiEnums.TEXT_ALIGN));
            return this;
        }

        /** The input text direction: {@code ltr/rtl}; validated. */
        public InputBuilder textDirection(String value) {
            props.put("textDirection", UiEnums.require("textDirection", value, UiEnums.TEXT_DIRECTION));
            return this;
        }

        /** The scroll padding (a number, an array or a padding map). */
        public InputBuilder scrollPadding(Object value) {
            props.put("scrollPadding", value);
            return this;
        }

        /** The restoration id. */
        public InputBuilder restorationId(String value) {
            props.put("restorationId", value);
            return this;
        }
    }

    /** {@code textarea}(id) — the full {@code input} prop set; the client defaults {@code multiline} to true. */
    public static final class TextareaBuilder extends InputBuilder {

        private TextareaBuilder(String id) {
            super(id);
        }

        @Override
        String type() {
            return "textarea";
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

        /** The menu corner radius. */
        public DropdownBuilder borderRadius(Number value) {
            props.put("borderRadius", value);
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

        /** The track outline color. */
        public ToggleBuilder trackOutline(String value) {
            props.put("trackOutline", value);
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

        /** The accessibility value template; {@code {value}} is replaced with the current value. */
        public SliderBuilder semanticFormatterCallback(String value) {
            props.put("semanticFormatterCallback", value);
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

    /** The node rendered above the scrollable (the T97 sidebar header block). */
    public ListBuilder header(UiNode node) {
        props.put("header", node);
        return this;
    }

    /** The node rendered below the scrollable (the T97 sidebar footer block). */
    public ListBuilder footer(UiNode node) {
        props.put("footer", node);
        return this;
    }

    /**
     * The T97 client-side search spec ({@code {key, fields?, empty?}}): the
     * UiState string under {@code key} filters the section items against
     * their {@code fields} (default {@code title}/{@code subtitle}) and a
     * match-count line renders above the sections while it is non-empty.
     */
    public ListBuilder search(Map<String, Object> value) {
        props.put("search", value);
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

        /** Appends one column with a width and a sort flag. */
        public TableBuilder column(String label, Object width, boolean sortable) {
            Map<String, Object> column = new LinkedHashMap<>();
            column.put("label", label);
            if (width != null) {
                column.put("width", width);
            }
            if (sortable) {
                column.put("sortable", true);
            }
            columns().add(column);
            return this;
        }

        /**
         * Appends one column with a width, a sort flag and a cell alignment
         * ({@code left/right/center/justify/start/end}); validated.
         */
        public TableBuilder column(String label, Object width, boolean sortable, String align) {
            Map<String, Object> column = new LinkedHashMap<>();
            column.put("label", label);
            if (width != null) {
                column.put("width", width);
            }
            if (sortable) {
                column.put("sortable", true);
            }
            column.put("align", UiEnums.require("align", align, UiEnums.TEXT_ALIGN));
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

        /** The sortable header tap action; fires with {@code {column, ascending}} merged into its payload. */
        public TableBuilder onSort(Map<String, Object> value) {
            props.put("onSort", value);
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

    /** {@code tree}(items, onSelect?) with nested item specs and per-item expand/collapse. */
    public static final class TreeBuilder extends NodeBuilder<TreeBuilder> {

        private TreeBuilder() {
        }

        @Override
        String type() {
            return "tree";
        }

        /** Appends one item with a label. */
        public TreeBuilder item(String label) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("label", label);
            items().add(item);
            return this;
        }

        /** Appends one finished item spec ({@link Ui#treeItem(String)}). */
        public TreeBuilder item(TreeItemBuilder item) {
            items().add(item.build());
            return this;
        }

        /** The select action; fires with the selected item merged into its payload. */
        public TreeBuilder onSelect(Map<String, Object> value) {
            props.put("onSelect", value);
            return this;
        }

        private List<Object> items() {
            @SuppressWarnings("unchecked")
            List<Object> items = (List<Object>) props.computeIfAbsent("items", key -> new ArrayList<>());
            return items;
        }
    }

    /** {@code tree} item spec: {@code label}, {@code icon?}, {@code expanded?}, {@code action?}, {@code items?}. */
    public static final class TreeItemBuilder {

        private final Map<String, Object> spec = new LinkedHashMap<>();

        private TreeItemBuilder(String label) {
            spec.put("label", label);
        }

        /** The leading icon name. */
        public TreeItemBuilder icon(String value) {
            spec.put("icon", value);
            return this;
        }

        /** Whether the item starts expanded. */
        public TreeItemBuilder expanded(boolean value) {
            spec.put("expanded", value);
            return this;
        }

        /** The select action of this item. */
        public TreeItemBuilder action(Map<String, Object> value) {
            spec.put("action", value);
            return this;
        }

        /** Appends one nested child item with a label. */
        public TreeItemBuilder item(String label) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("label", label);
            items().add(item);
            return this;
        }

        /** Appends one finished nested child spec. */
        public TreeItemBuilder item(TreeItemBuilder child) {
            items().add(child.build());
            return this;
        }

        /** The finished item spec, in insertion order. */
        public Map<String, Object> build() {
            return new LinkedHashMap<>(spec);
        }

        private List<Object> items() {
            @SuppressWarnings("unchecked")
            List<Object> items = (List<Object>) spec.computeIfAbsent("items", key -> new ArrayList<>());
            return items;
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

        /**
         * The level-3 duty-cycle mode (docs/sdui.md section 2.1): {@code
         * pulse}, {@code ping}, {@code skeleton} or {@code none}; validated.
         * A complete indicator ({@code value >= 1.0}) never animates
         * client-side.
         */
        public ProgressBuilder statusPulse(String value) {
            props.put("statusPulse", UiEnums.require("statusPulse", value, UiEnums.STATUS_PULSE));
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

    /** {@code box}(child?, children?, direction?, shape?, alignment?) — the layout superset of {@code container}; decoration comes from the universal Box group. */
    public static final class BoxBuilder extends NodeBuilder<BoxBuilder> {

        private BoxBuilder() {
        }

        @Override
        String type() {
            return "box";
        }

        /** The single child node. */
        public BoxBuilder child(UiNode node) {
            props.put("child", node);
            return this;
        }

        /** The single child as a string (the text shorthand). */
        public BoxBuilder child(String text) {
            props.put("child", text);
            return this;
        }

        /** Multiple children, laid out per {@link com.astroreen.jhin.plugin.uikit.has.HasFlex#direction} when more than one. */
        public BoxBuilder children(List<Object> nodes) {
            props.put("children", nodes);
            return this;
        }

        /** The decoration shape: {@code rectangle} or {@code circle}; validated. */
        public BoxBuilder shape(String value) {
            props.put("shape", UiEnums.require("shape", value, UiEnums.BOX_SHAPE));
            return this;
        }

        /** The alignment prop, documented as an alias of the universal {@code align}; validated. */
        public BoxBuilder alignment(String value) {
            props.put("alignment", UiEnums.require("alignment", value, UiEnums.ALIGNMENT));
            return this;
        }
    }

    /** {@code row}(children) — all layout props come from the universal Flex group. */
    public static final class RowBuilder extends ParentBuilder<RowBuilder> {

        private RowBuilder() {
        }

        @Override
        String type() {
            return "row";
        }
    }

    /** {@code column}(children) — all layout props come from the universal Flex group. */
    public static final class ColumnBuilder extends ParentBuilder<ColumnBuilder> {

        private ColumnBuilder() {
        }

        @Override
        String type() {
            return "column";
        }
    }

    /** {@code flex}(direction, children) — the explicit, axis-parametrized form of {@code row}/{@code column}. */
    public static final class FlexBuilder extends ParentBuilder<FlexBuilder> {

        private FlexBuilder(String direction) {
            direction(direction);
        }

        @Override
        String type() {
            return "flex";
        }
    }

    /** {@code expanded}(flex?, child). */
    public static final class ExpandedBuilder extends NodeBuilder<ExpandedBuilder> {

        private ExpandedBuilder() {
        }

        @Override
        String type() {
            return "expanded";
        }

        /** The child node. */
        public ExpandedBuilder child(UiNode node) {
            props.put("child", node);
            return this;
        }

        /** The child as a string (the text shorthand). */
        public ExpandedBuilder child(String text) {
            props.put("child", text);
            return this;
        }
    }

    /** {@code flexible}(flex?, fit?, child). */
    public static final class FlexibleBuilder extends NodeBuilder<FlexibleBuilder> {

        private FlexibleBuilder() {
        }

        @Override
        String type() {
            return "flexible";
        }

        /** The child node. */
        public FlexibleBuilder child(UiNode node) {
            props.put("child", node);
            return this;
        }

        /** The child as a string (the text shorthand). */
        public FlexibleBuilder child(String text) {
            props.put("child", text);
            return this;
        }
    }

    /** {@code sized_box}(width?, height?, child?). */
    public static final class SizedBoxBuilder extends NodeBuilder<SizedBoxBuilder> {

        private SizedBoxBuilder() {
        }

        @Override
        String type() {
            return "sized_box";
        }

        /** The child node. */
        public SizedBoxBuilder child(UiNode node) {
            props.put("child", node);
            return this;
        }

        /** The child as a string (the text shorthand). */
        public SizedBoxBuilder child(String text) {
            props.put("child", text);
            return this;
        }
    }

    /** {@code align}(align?, child). */
    public static final class AlignBuilder extends NodeBuilder<AlignBuilder> {

        private AlignBuilder() {
        }

        @Override
        String type() {
            return "align";
        }

        /** The child node. */
        public AlignBuilder child(UiNode node) {
            props.put("child", node);
            return this;
        }

        /** The child as a string (the text shorthand). */
        public AlignBuilder child(String text) {
            props.put("child", text);
            return this;
        }
    }

    /** {@code center}(child). */
    public static final class CenterBuilder extends NodeBuilder<CenterBuilder> {

        private CenterBuilder() {
        }

        @Override
        String type() {
            return "center";
        }

        /** The child node. */
        public CenterBuilder child(UiNode node) {
            props.put("child", node);
            return this;
        }

        /** The child as a string (the text shorthand). */
        public CenterBuilder child(String text) {
            props.put("child", text);
            return this;
        }
    }

    /**
     * {@code aspect_ratio}(aspectRatio, child?) — the explicit standalone form
     * of the universal {@code aspectRatio} (docs/sdui.md section 2.1 Box
     * group), wrapping a {@code child} slot instead of this node's own
     * rendering.
     */
    public static final class AspectRatioBuilder extends NodeBuilder<AspectRatioBuilder> {

        private AspectRatioBuilder(double aspectRatio) {
            aspectRatio(aspectRatio);
        }

        @Override
        String type() {
            return "aspect_ratio";
        }

        /** The child node. */
        public AspectRatioBuilder child(UiNode node) {
            props.put("child", node);
            return this;
        }

        /** The child as a string (the text shorthand). */
        public AspectRatioBuilder child(String text) {
            props.put("child", text);
            return this;
        }
    }

    /** {@code stack}(alignment?, fit?, clipBehavior?, textDirection?, children). */
    public static final class StackBuilder extends ParentBuilder<StackBuilder> {

        private StackBuilder() {
        }

        @Override
        String type() {
            return "stack";
        }

        /**
         * The alignment of the non-positioned children (docs/sdui.md section
         * 2.6) — stack's own prop, NOT the universal {@code align} alias.
         */
        public StackBuilder alignment(String value) {
            props.put("alignment", UiEnums.require("alignment", value, UiEnums.ALIGNMENT));
            return this;
        }

        /**
         * The stack fit: {@code loose/passthrough/expand} (docs/sdui.md
         * section 2.6) — overrides the universal Flex {@code fit} literals.
         */
        @Override
        public StackBuilder fit(String value) {
            props.put("fit", UiEnums.require("fit", value, UiEnums.STACK_FIT));
            return this;
        }
    }

    /**
     * {@code positioned}(top?, right?, bottom?, left?, width?, height?,
     * child?) — {@code width}/{@code height} come from the universal Box
     * group (same wire keys the client's {@code Positioned} wrap reads).
     */
    public static final class PositionedBuilder extends NodeBuilder<PositionedBuilder> {

        private PositionedBuilder() {
        }

        @Override
        String type() {
            return "positioned";
        }

        /** The offset from the top of the stack. */
        public PositionedBuilder top(Number value) {
            props.put("top", value);
            return this;
        }

        /** The offset from the right of the stack. */
        public PositionedBuilder right(Number value) {
            props.put("right", value);
            return this;
        }

        /** The offset from the bottom of the stack. */
        public PositionedBuilder bottom(Number value) {
            props.put("bottom", value);
            return this;
        }

        /** The offset from the left of the stack. */
        public PositionedBuilder left(Number value) {
            props.put("left", value);
            return this;
        }

        /** The layered child node. */
        public PositionedBuilder child(UiNode node) {
            props.put("child", node);
            return this;
        }

        /** The layered child as a string (the text shorthand). */
        public PositionedBuilder child(String text) {
            props.put("child", text);
            return this;
        }
    }

    /**
     * {@code wrap}(direction?, alignment?, spacing?, runSpacing?,
     * runAlignment?, crossAxisAlignment?, textDirection?, verticalDirection?,
     * children) — {@code direction}/{@code alignment}/{@code runAlignment}/
     * {@code crossAxisAlignment} carry wrap's own literal sets (docs/sdui.md
     * section 2.6), not the Flex ones.
     */
    public static final class WrapBuilder extends ParentBuilder<WrapBuilder> {

        private WrapBuilder() {
        }

        @Override
        String type() {
            return "wrap";
        }

        /**
         * The run direction: {@code horizontal/vertical} (docs/sdui.md
         * section 2.6) — not the Flex {@code row/column} direction.
         */
        @Override
        public WrapBuilder direction(String value) {
            props.put("direction", UiEnums.require("direction", value, UiEnums.WRAP_DIRECTION));
            return this;
        }

        /** The main-axis run alignment (wrap alignment literals). */
        public WrapBuilder alignment(String value) {
            props.put("alignment", UiEnums.require("alignment", value, UiEnums.WRAP_ALIGNMENT));
            return this;
        }

        /** The gap between runs. */
        public WrapBuilder runSpacing(Number value) {
            props.put("runSpacing", value);
            return this;
        }

        /** The alignment of the runs themselves (wrap alignment literals). */
        public WrapBuilder runAlignment(String value) {
            props.put("runAlignment", UiEnums.require("runAlignment", value, UiEnums.WRAP_ALIGNMENT));
            return this;
        }

        /**
         * The cross-axis alignment inside a run (wrap alignment literals,
         * docs/sdui.md section 2.6) — not the Flex cross-axis set.
         */
        @Override
        public WrapBuilder crossAxisAlignment(String value) {
            props.put("crossAxisAlignment", UiEnums.require("crossAxisAlignment", value, UiEnums.WRAP_ALIGNMENT));
            return this;
        }
    }

    /**
     * {@code grid}(columns?, childAspectRatio?, crossAxisSpacing?,
     * mainAxisSpacing?, shrinkWrap?, physics?, children) — {@code padding}
     * is the universal Box prop.
     */
    public static final class GridBuilder extends ParentBuilder<GridBuilder> {

        private GridBuilder() {
        }

        @Override
        String type() {
            return "grid";
        }

        /** The column count. */
        public GridBuilder columns(int value) {
            props.put("columns", value);
            return this;
        }

        /** The cell width/height ratio. */
        public GridBuilder childAspectRatio(Number value) {
            props.put("childAspectRatio", value);
            return this;
        }

        /** The gap between columns. */
        public GridBuilder crossAxisSpacing(Number value) {
            props.put("crossAxisSpacing", value);
            return this;
        }

        /** The gap between rows. */
        public GridBuilder mainAxisSpacing(Number value) {
            props.put("mainAxisSpacing", value);
            return this;
        }

        /** Whether the grid sizes to its content. */
        public GridBuilder shrinkWrap(boolean value) {
            props.put("shrinkWrap", value);
            return this;
        }

        /** The scroll physics: {@code neverScrollable/alwaysScrollable/bouncing/clamping}; validated. */
        public GridBuilder physics(String value) {
            props.put("physics", UiEnums.require("physics", value, UiEnums.PHYSICS));
            return this;
        }
    }

    /**
     * {@code scroll}(children?, items?, itemCount?, scrollDirection?,
     * reverse?, physics?, shrinkWrap?) — {@code children} is the eager slot,
     * {@code items} the lazy one enabled by {@code itemCount}.
     */
    public static final class ScrollBuilder extends ParentBuilder<ScrollBuilder> implements HasItems<ScrollBuilder> {

        private ScrollBuilder() {
        }

        @Override
        String type() {
            return "scroll";
        }

        @Override
        public ScrollBuilder item(UiNode node) {
            items().add(node);
            return this;
        }

        @Override
        public ScrollBuilder item(String text) {
            items().add(text);
            return this;
        }

        @Override
        public ScrollBuilder item(Map<String, Object> entry) {
            items().add(entry);
            return this;
        }

        /** The live {@code items} list inside the props map. */
        @SuppressWarnings("unchecked")
        private List<Object> items() {
            return (List<Object>) props.computeIfAbsent("items", key -> new ArrayList<>());
        }

        /** The lazy item count; its presence enables lazy building of {@code items}. */
        public ScrollBuilder itemCount(int value) {
            props.put("itemCount", value);
            return this;
        }

        /** The scroll axis: {@code vertical/horizontal}; validated. */
        public ScrollBuilder scrollDirection(String value) {
            props.put("scrollDirection", UiEnums.require("scrollDirection", value, UiEnums.SCROLL_DIRECTION));
            return this;
        }

        /** Whether the scroll order is reversed. */
        public ScrollBuilder reverse(boolean value) {
            props.put("reverse", value);
            return this;
        }

        /** The scroll physics: {@code neverScrollable/alwaysScrollable/bouncing/clamping}; validated. */
        public ScrollBuilder physics(String value) {
            props.put("physics", UiEnums.require("physics", value, UiEnums.PHYSICS));
            return this;
        }

        /** Whether the scroll region sizes to its content. */
        public ScrollBuilder shrinkWrap(boolean value) {
            props.put("shrinkWrap", value);
            return this;
        }
    }

    /**
     * {@code icon}(icon, size?, color?, semanticLabel?, fill?, weight?,
     * grade?, opticalSize?, shadows?, textDirection?, blendMode?) — the
     * Flutter {@code Icon} parameter set of docs/sdui.md section 2.6.
     * {@code color} (inherited) is the icon color and {@code textDirection}
     * (inherited) the rendering direction; the name resolves through the
     * generated client registry, and an unknown name degrades to an empty
     * icon client-side (section 2.4).
     */
    public static final class IconBuilder extends NodeBuilder<IconBuilder> {

        private IconBuilder() {
        }

        @Override
        String type() {
            return "icon";
        }

        /** The icon name (required; resolved through the client icon registry). */
        public IconBuilder icon(String value) {
            props.put("icon", value);
            return this;
        }

        /** The icon size in logical pixels. */
        public IconBuilder size(Number value) {
            props.put("size", value);
            return this;
        }

        /** The semantics label of the icon. */
        public IconBuilder semanticLabel(String value) {
            props.put("semanticLabel", value);
            return this;
        }

        /** The variable-font fill ({@code 0.0}–{@code 1.0}). */
        public IconBuilder fill(Number value) {
            props.put("fill", value);
            return this;
        }

        /** The variable-font weight. */
        public IconBuilder weight(Number value) {
            props.put("weight", value);
            return this;
        }

        /** The variable-font grade. */
        public IconBuilder grade(Number value) {
            props.put("grade", value);
            return this;
        }

        /** The variable-font optical size. */
        public IconBuilder opticalSize(Number value) {
            props.put("opticalSize", value);
            return this;
        }

        /** The icon shadows (the shadow-array form of the section 2.1 shadow spec). */
        public IconBuilder shadows(List<Map<String, Object>> value) {
            props.put("shadows", value);
            return this;
        }

        /** The color blend mode: the Flutter {@code BlendMode} names; validated. */
        public IconBuilder blendMode(String value) {
            props.put("blendMode", UiEnums.require("blendMode", value, UiEnums.BLEND_MODE));
            return this;
        }
    }

    /**
     * {@code icon_button}(icon, action?, iconSize?, color?, disabledColor?,
     * highlightColor?, splashColor?, focusColor?, hoverColor?, padding?,
     * alignment?, constraints?, autofocus?, isSelected?, selectedIcon?,
     * mouseCursor?, visualDensity?, enableFeedback?, splashRadius?, style?) —
     * the full Flutter {@code IconButton} parameter set of docs/sdui.md
     * section 2.6.
     * {@code color}/{@code padding} (inherited) are the button's own icon
     * color and icon padding; {@code action}/{@code tooltip}/{@code confirm}
     * come from the interaction lattice. Without an {@code action} the
     * button is disabled client-side.
     */
    public static final class IconButtonBuilder extends NodeBuilder<IconButtonBuilder> {

        private IconButtonBuilder() {
        }

        @Override
        String type() {
            return "icon_button";
        }

        /** The icon name (required; resolved through the client icon registry). */
        public IconButtonBuilder icon(String value) {
            props.put("icon", value);
            return this;
        }

        /** The icon as an inline node (the {@code icon} primitive or any node). */
        public IconButtonBuilder icon(UiNode value) {
            props.put("icon", value);
            return this;
        }

        /** The icon size in logical pixels. */
        public IconButtonBuilder iconSize(Number value) {
            props.put("iconSize", value);
            return this;
        }

        /** The icon color when disabled. */
        public IconButtonBuilder disabledColor(String value) {
            props.put("disabledColor", value);
            return this;
        }

        /** The highlight color. */
        public IconButtonBuilder highlightColor(String value) {
            props.put("highlightColor", value);
            return this;
        }

        /** The splash color. */
        public IconButtonBuilder splashColor(String value) {
            props.put("splashColor", value);
            return this;
        }

        /** The focus color. */
        public IconButtonBuilder focusColor(String value) {
            props.put("focusColor", value);
            return this;
        }

        /** The hover color. */
        public IconButtonBuilder hoverColor(String value) {
            props.put("hoverColor", value);
            return this;
        }

        /** The icon alignment inside the button; validated. */
        public IconButtonBuilder alignment(String value) {
            props.put("alignment", UiEnums.require("alignment", value, UiEnums.ALIGNMENT));
            return this;
        }

        /** The size constraints ({@code minWidth}/{@code maxWidth}/{@code minHeight}/{@code maxHeight}). */
        public IconButtonBuilder constraints(Map<String, Object> value) {
            props.put("constraints", value);
            return this;
        }

        /** Whether the button takes focus automatically. */
        public IconButtonBuilder autofocus(boolean value) {
            props.put("autofocus", value);
            return this;
        }

        /** The toggled state (shows {@code selectedIcon} when true). */
        public IconButtonBuilder isSelected(boolean value) {
            props.put("isSelected", value);
            return this;
        }

        /** The icon shown when selected (an icon name). */
        public IconButtonBuilder selectedIcon(String value) {
            props.put("selectedIcon", value);
            return this;
        }

        /** The icon shown when selected (an inline node). */
        public IconButtonBuilder selectedIcon(UiNode value) {
            props.put("selectedIcon", value);
            return this;
        }

        /** The mouse cursor: the section 2.1 cursor literals; validated. */
        public IconButtonBuilder mouseCursor(String value) {
            props.put("mouseCursor", UiEnums.require("mouseCursor", value, UiEnums.CURSOR));
            return this;
        }

        /** The visual density: {@code compact/comfortable/spacious}; validated. */
        public IconButtonBuilder visualDensity(String value) {
            props.put("visualDensity", UiEnums.require("visualDensity", value, UiEnums.VISUAL_DENSITY));
            return this;
        }

        /** Whether acoustic/haptic feedback is enabled. */
        public IconButtonBuilder enableFeedback(boolean value) {
            props.put("enableFeedback", value);
            return this;
        }

        /** The splash radius. */
        public IconButtonBuilder splashRadius(Number value) {
            props.put("splashRadius", value);
            return this;
        }

        /** The ButtonStyle map (see docs/sdui.md section 2.6). */
        public IconButtonBuilder style(Map<String, Object> value) {
            props.put("style", value);
            return this;
        }
    }

    /** The {@code list_row} primitive: row slots plus the visual drag handle. */
    public static final class ListRowBuilder extends NodeBuilder<ListRowBuilder> {

        private ListRowBuilder() {
        }

        @Override
        String type() {
            return "list_row";
        }

        /** The leading widget node. */
        public ListRowBuilder leading(UiNode node) {
            props.put("leading", node);
            return this;
        }

        /** The title string shorthand. */
        public ListRowBuilder title(String text) {
            props.put("title", text);
            return this;
        }

        /** The title node. */
        public ListRowBuilder title(UiNode node) {
            props.put("title", node);
            return this;
        }

        /** The subtitle string shorthand. */
        public ListRowBuilder subtitle(String text) {
            props.put("subtitle", text);
            return this;
        }

        /** The subtitle node. */
        public ListRowBuilder subtitle(UiNode node) {
            props.put("subtitle", node);
            return this;
        }

        /** The trailing widget node. */
        public ListRowBuilder trailing(UiNode node) {
            props.put("trailing", node);
            return this;
        }

        /** The badge widget node. */
        public ListRowBuilder badge(UiNode node) {
            props.put("badge", node);
            return this;
        }

        /** Whether the row shows the selected tint. */
        public ListRowBuilder selected(boolean value) {
            props.put("selected", value);
            return this;
        }

        /** Whether the visual drag affordance renders (reorder goes through actions). */
        public ListRowBuilder dragHandle(boolean value) {
            props.put("dragHandle", value);
            return this;
        }

        /**
         * The T97 status indicator kinds (the leading cluster): the client
         * renders them through the {@code ThreadStatusIndicators} widget —
         * {@code working}, {@code idle}, {@code monitoring},
         * {@code needs-approval}, {@code needs-answer}, {@code failed},
         * {@code limited}, {@code snoozed}, {@code settled}, {@code unread},
         * {@code pinned}; an unknown kind falls back to {@code idle}.
         */
        public ListRowBuilder statusIndicators(List<String> kinds) {
            props.put("statusIndicators", List.copyOf(kinds));
            return this;
        }

        /**
         * The T97 hover reveal: the trailing cluster fades in on hover or
         * focus (the upstream group-hover reveal of the row actions).
         */
        public ListRowBuilder hoverReveal(boolean value) {
            props.put("hoverReveal", value);
            return this;
        }

        /**
         * The T97 search-match spec ({@code {key, minChars?}}): the client
         * renders the match pill in the trailing cluster when the UiState
         * query under {@code key} is at least {@code minChars} (default 2)
         * characters and matches the row's title or subtitle.
         */
        public ListRowBuilder searchMatch(Map<String, Object> value) {
            props.put("searchMatch", Map.copyOf(value));
            return this;
        }

        /** The T97 dragging state: the row renders as the lifted card. */
        public ListRowBuilder dragging(boolean value) {
            props.put("dragging", value);
            return this;
        }

        /**
         * The T98 command-subtitle marker (the {@code ThreadCommandSubtitle}
         * port): the command id text shown as the trailing muted marker when
         * the row came from a palette search. Absent on rows the palette did
         * not produce.
         */
        public ListRowBuilder commandSubtitle(String value) {
            props.put("commandSubtitle", value);
            return this;
        }

        /**
         * The T99 drag affordance: the row can be picked up (long-press) and
         * dragged. The choreography itself — the reveal label, the accent
         * drop targets, the Escape cancel and the drop dispatch — is driven
         * by the sectioned {@code list} (docs/sdui.md section 2.6).
         */
        public ListRowBuilder draggable(boolean value) {
            props.put("draggable", value);
            return this;
        }

        /**
         * The T99 reveal-label chip template: the node rendered on the
         * dragged row while a drop target is hovered. The client swaps the
         * template's icon and text with the hovered target's badge word
         * (the {@code dropVerbBadge} port).
         */
        public ListRowBuilder dragLabel(UiNode node) {
            props.put("dragLabel", node);
            return this;
        }

        /**
         * The T99 drop targets: {@code [{id, label, accentWhenHovered,
         * action?}]} — the section ids this row may be dropped on, the badge
         * word each shows while hovered, whether the hovered header takes
         * the accent colour, and the lifecycle action the drop dispatches
         * (exactly once; absent for a purely decorative drag).
         */
        public ListRowBuilder dropTargets(List<Map<String, Object>> value) {
            props.put("dropTargets", List.copyOf(value));
            return this;
        }
    }

    /** The {@code badge} primitive: label/count/dot with the {@code max} cap. */
    public static final class BadgeBuilder extends NodeBuilder<BadgeBuilder> {

        private BadgeBuilder() {
        }

        @Override
        String type() {
            return "badge";
        }

        /** The badge label. */
        public BadgeBuilder label(String value) {
            props.put("label", value);
            return this;
        }

        /** The badge count. */
        public BadgeBuilder count(Number value) {
            props.put("count", value);
            return this;
        }

        /** The count cap; counts above render as {@code <max>+}. */
        public BadgeBuilder max(Number value) {
            props.put("max", value);
            return this;
        }

        /** Whether the badge renders as a bare dot. */
        public BadgeBuilder dot(boolean value) {
            props.put("dot", value);
            return this;
        }
    }

    /** The {@code chip} primitive: label plus the variant literal set. */
    public static final class ChipBuilder extends NodeBuilder<ChipBuilder> {

        private ChipBuilder() {
        }

        @Override
        String type() {
            return "chip";
        }

        /** The chip label (required by the contract). */
        public ChipBuilder label(String value) {
            props.put("label", value);
            return this;
        }

        /** The leading icon name. */
        public ChipBuilder icon(String value) {
            props.put("icon", value);
            return this;
        }

        /** The leading avatar node. */
        public ChipBuilder avatar(UiNode node) {
            props.put("avatar", node);
            return this;
        }

        /** The selected state. */
        public ChipBuilder selected(boolean value) {
            props.put("selected", value);
            return this;
        }

        /** The delete action; without it the delete affordance is hidden. */
        public ChipBuilder onDeleted(Map<String, Object> value) {
            props.put("onDeleted", value);
            return this;
        }

        /** The variant: {@code assist/filter/input/action}; validated. */
        public ChipBuilder variant(String value) {
            props.put("variant", UiEnums.require("variant", value, UiEnums.CHIP_VARIANT));
            return this;
        }
    }

    /** The {@code avatar} primitive: image/initials/icon fallback chain. */
    public static final class AvatarBuilder extends NodeBuilder<AvatarBuilder> {

        private AvatarBuilder() {
        }

        @Override
        String type() {
            return "avatar";
        }

        /** The image src or dataUri. */
        public AvatarBuilder image(String value) {
            props.put("image", value);
            return this;
        }

        /** The initials fallback. */
        public AvatarBuilder initials(String value) {
            props.put("initials", value);
            return this;
        }

        /** The icon fallback. */
        public AvatarBuilder icon(String value) {
            props.put("icon", value);
            return this;
        }

        /** The diameter. */
        public AvatarBuilder size(Number value) {
            props.put("size", value);
            return this;
        }

        /** The shape: {@code circle/square}; validated. */
        public AvatarBuilder shape(String value) {
            props.put("shape", UiEnums.require("shape", value, UiEnums.AVATAR_SHAPE));
            return this;
        }
    }

    /** The {@code skeleton} primitive: placeholder shapes with the shimmer. */
    public static final class SkeletonBuilder extends NodeBuilder<SkeletonBuilder> {

        private SkeletonBuilder() {
        }

        @Override
        String type() {
            return "skeleton";
        }

        /** The variant: {@code text/circle/rect/list}; validated. */
        public SkeletonBuilder variant(String value) {
            props.put("variant", UiEnums.require("variant", value, UiEnums.SKELETON_VARIANT));
            return this;
        }

        /** The line count for {@code text}/{@code list}. */
        public SkeletonBuilder lines(int value) {
            props.put("lines", value);
            return this;
        }

        /** Whether the shimmer animation runs (collapses under reduced motion). */
        public SkeletonBuilder shimmer(boolean value) {
            props.put("shimmer", value);
            return this;
        }
    }

    /** {@code menu}(trigger, items, breakpoint?) — a popup menu over a trigger node. */
    public static final class MenuBuilder extends ItemBuilder<MenuBuilder> implements HasGlass<MenuBuilder> {

        private MenuBuilder() {
        }

        @Override
        String type() {
            return "menu";
        }

        @Override
        boolean glassCapable() {
            return true;
        }

        /** The level-3 {@code glass} prop: the glass surface treatment. */
        @Override
        public MenuBuilder glass(boolean value) {
            props.put("glass", value);
            return this;
        }

        /** The level-3 {@code glassTint} prop: the tint colour of the glass fill. */
        @Override
        public MenuBuilder glassTint(String value) {
            props.put("glassTint", value);
            return this;
        }

        /** The trigger node that opens the menu. */
        public MenuBuilder trigger(UiNode node) {
            props.put("trigger", node);
            return this;
        }

        /** The trigger as a string (the text shorthand). */
        public MenuBuilder trigger(String text) {
            props.put("trigger", text);
            return this;
        }

        /** The width below which the menu opens as a bottom sheet. */
        public MenuBuilder breakpoint(Number value) {
            props.put("breakpoint", value);
            return this;
        }

        /** Appends one label-only item ({@code {label}}). */
        public MenuBuilder item(String label) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("label", label);
            items().add(item);
            return this;
        }
    }

    /**
     * The spec builder of one {@code menu} item ({@code {label, icon?,
     * action?, confirm?, disabled?, divider?, danger?}}): see
     * {@link Ui#menuItem(String)}. Finished with {@link #build()}, the spec
     * is appended through {@link ItemBuilder#item(Map)}.
     */
    public static final class MenuItemBuilder {

        private final Map<String, Object> spec = new LinkedHashMap<>();

        private MenuItemBuilder(String label) {
            spec.put("label", label);
        }

        /** The leading icon name. */
        public MenuItemBuilder icon(String value) {
            spec.put("icon", value);
            return this;
        }

        /** The dispatch action. */
        public MenuItemBuilder action(Map<String, Object> value) {
            spec.put("action", value);
            return this;
        }

        /** The confirmation prompt gating the dispatch. */
        public MenuItemBuilder confirm(String value) {
            spec.put("confirm", value);
            return this;
        }

        /** The disabled entry (dispatches nothing). */
        public MenuItemBuilder disabled(boolean value) {
            spec.put("disabled", value);
            return this;
        }

        /** Whether the entry renders as a divider. */
        public MenuItemBuilder divider(boolean value) {
            spec.put("divider", value);
            return this;
        }

        /** The destructive styling flag. */
        public MenuItemBuilder danger(boolean value) {
            spec.put("danger", value);
            return this;
        }

        /**
         * The T98 submenu: the nested item specs (same shape, one level
         * deep). A child carries {@code checked} for the radio-style
         * entries; {@code separatorBefore} on the first child keeps the
         * upstream group boundary.
         */
        public MenuItemBuilder children(List<Map<String, Object>> specs) {
            spec.put("children", List.copyOf(specs));
            return this;
        }

        /** The T98 checked mark (the radio-style submenu entries). */
        public MenuItemBuilder checked(boolean value) {
            spec.put("checked", value);
            return this;
        }

        /** The T98 separator rendered above the entry. */
        public MenuItemBuilder separatorBefore(boolean value) {
            spec.put("separatorBefore", value);
            return this;
        }

        /** The finished item spec, in insertion order. */
        public Map<String, Object> build() {
            return new LinkedHashMap<>(spec);
        }
    }

    /** {@code sheet}(title?, body?, footer?, height?, dismissible?) — a modal bottom sheet surface. */
    public static final class SheetBuilder extends NodeBuilder<SheetBuilder> implements HasGlass<SheetBuilder> {

        private SheetBuilder() {
        }

        @Override
        String type() {
            return "sheet";
        }

        @Override
        boolean glassCapable() {
            return true;
        }

        /** The level-3 {@code glass} prop: the glass surface treatment. */
        @Override
        public SheetBuilder glass(boolean value) {
            props.put("glass", value);
            return this;
        }

        /** The level-3 {@code glassTint} prop: the tint colour of the glass fill. */
        @Override
        public SheetBuilder glassTint(String value) {
            props.put("glassTint", value);
            return this;
        }

        /** The sheet title (a string or a node). */
        public SheetBuilder title(String value) {
            props.put("title", value);
            return this;
        }

        /** The sheet title node. */
        public SheetBuilder title(UiNode node) {
            props.put("title", node);
            return this;
        }

        /** The sheet body node. */
        public SheetBuilder body(UiNode node) {
            props.put("body", node);
            return this;
        }

        /** The sheet body as a string (the text shorthand). */
        public SheetBuilder body(String text) {
            props.put("body", text);
            return this;
        }

        /** The footer row node. */
        public SheetBuilder footer(UiNode node) {
            props.put("footer", node);
            return this;
        }

        /** The footer as a string (the text shorthand). */
        public SheetBuilder footer(String text) {
            props.put("footer", text);
            return this;
        }

        /** Whether the sheet can be dismissed (default {@code true}). */
        public SheetBuilder dismissible(boolean value) {
            props.put("dismissible", value);
            return this;
        }
    }

    /** {@code dialog}(title?, content?, actions?) — an AlertDialog-shaped node. */
    public static final class DialogBuilder extends NodeBuilder<DialogBuilder> implements HasGlass<DialogBuilder> {

        private DialogBuilder() {
        }

        @Override
        String type() {
            return "dialog";
        }

        @Override
        boolean glassCapable() {
            return true;
        }

        /** The level-3 {@code glass} prop: the glass surface treatment. */
        @Override
        public DialogBuilder glass(boolean value) {
            props.put("glass", value);
            return this;
        }

        /** The level-3 {@code glassTint} prop: the tint colour of the glass fill. */
        @Override
        public DialogBuilder glassTint(String value) {
            props.put("glassTint", value);
            return this;
        }

        /** The dialog title (a string or a node). */
        public DialogBuilder title(String value) {
            props.put("title", value);
            return this;
        }

        /** The dialog title node. */
        public DialogBuilder title(UiNode node) {
            props.put("title", node);
            return this;
        }

        /** The dialog content node. */
        public DialogBuilder content(UiNode node) {
            props.put("content", node);
            return this;
        }

        /** The dialog content as a string (the text shorthand). */
        public DialogBuilder content(String text) {
            props.put("content", text);
            return this;
        }

        /** Appends one action button node (the {@code actions} array). */
        public DialogBuilder action(UiNode node) {
            actions().add(node);
            return this;
        }

        /** Sets the action button nodes wholesale. */
        public DialogBuilder actions(List<Object> nodes) {
            props.put("actions", nodes);
            return this;
        }

        private List<Object> actions() {
            @SuppressWarnings("unchecked")
            List<Object> actions = (List<Object>) props.computeIfAbsent("actions", key -> new ArrayList<>());
            return actions;
        }
    }

    /** {@code banner}(content?, actions?, onDismiss?) — a persistent notice. */
    public static final class BannerBuilder extends NodeBuilder<BannerBuilder> implements HasGlass<BannerBuilder> {

        private BannerBuilder() {
        }

        @Override
        String type() {
            return "banner";
        }

        @Override
        boolean glassCapable() {
            return true;
        }

        /** The level-3 {@code glass} prop: the glass surface treatment. */
        @Override
        public BannerBuilder glass(boolean value) {
            props.put("glass", value);
            return this;
        }

        /** The level-3 {@code glassTint} prop: the tint colour of the glass fill. */
        @Override
        public BannerBuilder glassTint(String value) {
            props.put("glassTint", value);
            return this;
        }

        /** The notice content node. */
        public BannerBuilder content(UiNode node) {
            props.put("content", node);
            return this;
        }

        /** The notice content as a string (the text shorthand). */
        public BannerBuilder content(String text) {
            props.put("content", text);
            return this;
        }

        /** Appends one action button node (the {@code actions} array). */
        public BannerBuilder action(UiNode node) {
            actions().add(node);
            return this;
        }

        /** Sets the action button nodes wholesale. */
        public BannerBuilder actions(List<Object> nodes) {
            props.put("actions", nodes);
            return this;
        }

        /** The dismiss action; without it the dismiss affordance is hidden. */
        public BannerBuilder onDismiss(Map<String, Object> value) {
            props.put("onDismiss", value);
            return this;
        }

        private List<Object> actions() {
            @SuppressWarnings("unchecked")
            List<Object> actions = (List<Object>) props.computeIfAbsent("actions", key -> new ArrayList<>());
            return actions;
        }
    }

    /** {@code tabs}(items, activeIndex?, variant?) — a tab strip whose selected item shows its {@code panel}. */
    public static final class TabsBuilder extends ItemBuilder<TabsBuilder> {

        private TabsBuilder() {
        }

        @Override
        String type() {
            return "tabs";
        }

        /** Appends one label-only item ({@code {label}}). */
        @Override
        public TabsBuilder item(String label) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("label", label);
            items().add(item);
            return this;
        }

        /** Appends one finished item spec ({@link Ui#tabItem(String)}). */
        public TabsBuilder item(TabItemBuilder item) {
            items().add(item.build());
            return this;
        }

        /** The selected tab by index; patchable via the node {@code id}. */
        public TabsBuilder activeIndex(int value) {
            props.put("activeIndex", value);
            return this;
        }

        /** The visual variant: {@code underline}, {@code pill} or {@code segmented}; validated. */
        public TabsBuilder variant(String value) {
            props.put("variant", UiEnums.require("variant", value, UiEnums.TAB_VARIANT));
            return this;
        }
    }

    /**
     * The spec builder of one {@code tabs} item ({@code {label, icon?,
     * badge?, panel?}}): see {@link Ui#tabItem(String)}. Finished with
     * {@link #build()}, the spec is appended through {@link ItemBuilder#item(Map)}.
     */
    public static final class TabItemBuilder {

        private final Map<String, Object> spec = new LinkedHashMap<>();

        private TabItemBuilder(String label) {
            spec.put("label", label);
        }

        /** The leading icon name. */
        public TabItemBuilder icon(String value) {
            spec.put("icon", value);
            return this;
        }

        /** The trailing badge node. */
        public TabItemBuilder badge(UiNode value) {
            spec.put("badge", value);
            return this;
        }

        /** The panel node shown while the tab is selected. */
        public TabItemBuilder panel(UiNode value) {
            spec.put("panel", value);
            return this;
        }

        /** The finished item spec, in insertion order. */
        public Map<String, Object> build() {
            return new LinkedHashMap<>(spec);
        }
    }

    /** {@code segmented}(segments, value?, action?) — a single-select segmented control. */
    public static final class SegmentedBuilder extends NodeBuilder<SegmentedBuilder> {

        private SegmentedBuilder() {
        }

        @Override
        String type() {
            return "segmented";
        }

        /** Appends one segment ({@code {label, value, icon?}}). */
        public SegmentedBuilder segment(String label, Object value) {
            return segment(label, value, null);
        }

        /** Appends one segment with an icon name. */
        public SegmentedBuilder segment(String label, Object value, String icon) {
            Map<String, Object> segment = new LinkedHashMap<>();
            segment.put("label", label);
            segment.put("value", value);
            if (icon != null) {
                segment.put("icon", icon);
            }
            segments().add(segment);
            return this;
        }

        /** Sets the segment entries wholesale. */
        public SegmentedBuilder segments(List<Object> entries) {
            props.put("segments", new ArrayList<>(entries));
            return this;
        }

        /** The selected value. */
        public SegmentedBuilder value(Object value) {
            props.put("value", value);
            return this;
        }

        /** The selection action dispatched on change. */
        public SegmentedBuilder action(Map<String, Object> value) {
            props.put("action", value);
            return this;
        }

        private List<Object> segments() {
            @SuppressWarnings("unchecked")
            List<Object> segments = (List<Object>) props.computeIfAbsent("segments", key -> new ArrayList<>());
            return segments;
        }
    }

    /**
     * {@code shell}(sidebar?, header?, body?, detail?, rail?, breakpoint?,
     * sidebarWidth?, sidebarCollapsedWidth?, collapsible?, collapsed?,
     * topbar?, topbarCompact?, pageHeader?, terminal?, stageBackdrop?) — the
     * app shell; a shell without {@code body} degrades to a card with
     * "Missing body" on the client. The T95 chrome slots: {@code topbar} is
     * the fixed-height workspace top bar (the client renders it at the
     * {@code layout.topbarHeight} token, 52), {@code topbarCompact} the
     * condensed variant below the breakpoint, {@code pageHeader} the title +
     * actions row above the body, {@code terminal} the optional terminal
     * drawer below the body row and {@code stageBackdrop} the stage-art
     * gradient painted behind the sidebar.
     */
    public static final class ShellBuilder extends NodeBuilder<ShellBuilder> {

        /**
         * The prop keys a {@code shell} accepts: the chrome slots and
         * metrics plus the universal surface keys. The escape hatch rejects
         * anything else with the standard unsupported-prop error — an
         * unknown slot name must fail at build time, never silently render
         * as nothing (T95).
         */
        private static final Set<String> ALLOWED = Set.of(
                "sidebar", "header", "body", "detail", "rail",
                "topbar", "topbarCompact", "pageHeader", "terminal", "stageBackdrop",
                "breakpoint", "sidebarWidth", "sidebarCollapsedWidth", "collapsible", "collapsed",
                "id", "visible", "when", "padding", "margin", "opacity", "tooltip", "action",
                "semanticsLabel", "enabled", "focusable", "flex",
                "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
                "demo", "safeArea");

        private ShellBuilder() {
        }

        @Override
        String type() {
            return "shell";
        }

        @Override
        public ShellBuilder set(String key, Object value) {
            if (!ALLOWED.contains(key)) {
                throw new IllegalArgumentException("unsupported prop " + key + " on " + type()
                        + " — unknown slot or prop name");
            }
            return super.set(key, value);
        }

        /** The sidebar region (a {@code nav} with {@code kind: sidebar}). */
        public ShellBuilder sidebar(UiNode node) {
            props.put("sidebar", node);
            return this;
        }

        /** The top header region. */
        public ShellBuilder header(UiNode node) {
            props.put("header", node);
            return this;
        }

        /** The main region. */
        public ShellBuilder body(UiNode node) {
            props.put("body", node);
            return this;
        }

        /** The main region as a string (the text shorthand). */
        public ShellBuilder body(String text) {
            props.put("body", text);
            return this;
        }

        /** The optional right detail region. */
        public ShellBuilder detail(UiNode node) {
            props.put("detail", node);
            return this;
        }

        /** The optional navigation rail for narrow widths. */
        public ShellBuilder rail(UiNode node) {
            props.put("rail", node);
            return this;
        }

        /** The width below which the sidebar becomes a drawer. */
        public ShellBuilder breakpoint(Number value) {
            props.put("breakpoint", value);
            return this;
        }

        /** The expanded sidebar width (a number or a {@code $size.sidebar} token). */
        public ShellBuilder sidebarWidth(Object value) {
            props.put("sidebarWidth", value);
            return this;
        }

        /** The collapsed sidebar width. */
        public ShellBuilder sidebarCollapsedWidth(Number value) {
            props.put("sidebarCollapsedWidth", value);
            return this;
        }

        /** Whether the sidebar can collapse. */
        public ShellBuilder collapsible(boolean value) {
            props.put("collapsible", value);
            return this;
        }

        /** The current collapsed state; patchable via the node {@code id}. */
        public ShellBuilder collapsed(boolean value) {
            props.put("collapsed", value);
            return this;
        }

        /**
         * The workspace top bar (T95): the fixed-height row the client
         * renders at the {@code layout.topbarHeight} token (52) — wordmark,
         * breadcrumb and the top-right control cluster.
         */
        public ShellBuilder topbar(UiNode node) {
            props.put("topbar", node);
            return this;
        }

        /**
         * The condensed top bar below the breakpoint (T95): the breadcrumb
         * reduced to the current title only. Absent, the client reuses
         * {@code topbar}.
         */
        public ShellBuilder topbarCompact(UiNode node) {
            props.put("topbarCompact", node);
            return this;
        }

        /** The page header row above the body: title plus the actions (T95). */
        public ShellBuilder pageHeader(UiNode node) {
            props.put("pageHeader", node);
            return this;
        }

        /** The optional terminal drawer below the body row (T95; the T106 owner). */
        public ShellBuilder terminal(UiNode node) {
            props.put("terminal", node);
            return this;
        }

        /**
         * Whether the client paints the stage-art gradient behind the
         * sidebar (T95): the {@code theme.stageArt} colors under the
         * sidebar-stage fade mask.
         */
        public ShellBuilder stageBackdrop(boolean value) {
            props.put("stageBackdrop", value);
            return this;
        }
    }

    /**
     * The spec builder of one {@code nav} item ({@code {label, icon?,
     * screen?, action?, badge?, count?, section?, enabled?}}): see
     * {@link Ui#navItem(String)}. Finished with {@link #build()}, the spec is
     * appended through {@link ItemBuilder#item(Map)}.
     */
    /**
     * {@code split}(first, second, axis?, initial?, min?, max?, minSecond?,
     * persistKey?, handleStyle?) — the level-3 resizable two-pane layout
     * (docs/sdui.md section 2.6). A level-2 client receives the node
     * degraded to a {@code column} by the server's downgrade map.
     */
    public static final class SplitBuilder extends NodeBuilder<SplitBuilder>
            implements HasSplit<SplitBuilder> {

        private SplitBuilder() {
        }

        @Override
        String type() {
            return "split";
        }

        /** The leading pane (required). */
        @Override
        public SplitBuilder first(UiNode node) {
            props.put("first", node);
            return this;
        }

        /** The trailing pane (required). */
        @Override
        public SplitBuilder second(UiNode node) {
            props.put("second", node);
            return this;
        }

        /** The pane direction: {@code horizontal} (default) or {@code vertical}. */
        @Override
        public SplitBuilder axis(String value) {
            props.put("axis", UiEnums.require("axis", value, UiEnums.SPLIT_AXIS));
            return this;
        }

        /** The initial divider position in px from the leading edge. */
        @Override
        public SplitBuilder initial(Number value) {
            props.put("initial", value);
            return this;
        }

        /** The minimum first-pane extent in px. */
        @Override
        public SplitBuilder min(Number value) {
            props.put("min", value);
            return this;
        }

        /** The maximum first-pane extent in px. */
        @Override
        public SplitBuilder max(Number value) {
            props.put("max", value);
            return this;
        }

        /** The minimum second-pane extent in px (the 640 main-content minimum upstream). */
        @Override
        public SplitBuilder minSecond(Number value) {
            props.put("minSecond", value);
            return this;
        }

        /** The client store key the divider position persists under (written at drag end). */
        @Override
        public SplitBuilder persistKey(String value) {
            props.put("persistKey", value);
            return this;
        }

        /** The drag-handle look: {@code rail} (default), {@code grip} or {@code invisible}. */
        @Override
        public SplitBuilder handleStyle(String value) {
            props.put("handleStyle", UiEnums.require("handleStyle", value, UiEnums.HANDLE_STYLE));
            return this;
        }
    }

    /**
     * {@code hover_card}(trigger, content, delay?, placement?) — the
     * level-3 hover-opened preview card (docs/sdui.md section 2.6). A
     * level-2 client receives the node replaced by its trigger (the
     * universal props, including {@code tooltip}, merged onto it) by the
     * server's downgrade map.
     */
    public static final class HoverCardBuilder extends NodeBuilder<HoverCardBuilder>
            implements HasHoverCard<HoverCardBuilder> {

        private HoverCardBuilder() {
        }

        @Override
        String type() {
            return "hover_card";
        }

        /** The node that opens the card on hover (required). */
        @Override
        public HoverCardBuilder trigger(UiNode node) {
            props.put("trigger", node);
            return this;
        }

        /** The trigger as a string (the text shorthand). */
        @Override
        public HoverCardBuilder trigger(String text) {
            props.put("trigger", text);
            return this;
        }

        /** The card content (required). */
        @Override
        public HoverCardBuilder content(UiNode node) {
            props.put("content", node);
            return this;
        }

        /** The content as a string (the text shorthand). */
        @Override
        public HoverCardBuilder content(String text) {
            props.put("content", text);
            return this;
        }

        /** The hover delay in ms before the card opens (default 500). */
        @Override
        public HoverCardBuilder delay(Number value) {
            props.put("delay", value);
            return this;
        }

        /** The card placement: {@code top} (default), {@code bottom}, {@code left} or {@code right}. */
        @Override
        public HoverCardBuilder placement(String value) {
            props.put("placement", UiEnums.require("placement", value, UiEnums.HOVER_PLACEMENT));
            return this;
        }
    }

    /**
     * {@code kbd}(chord) — the level-3 keyboard-hint pill row (docs/sdui.md
     * section 2.6). A level-2 client receives the node degraded to a mono
     * {@code text} carrying the chord by the server's downgrade map.
     */
    public static final class KbdBuilder extends NodeBuilder<KbdBuilder>
            implements HasKbd<KbdBuilder> {

        private KbdBuilder() {
        }

        @Override
        String type() {
            return "kbd";
        }

        /** The chord to render, modifiers joined with {@code +} (required). */
        @Override
        public KbdBuilder chord(String value) {
            props.put("chord", value);
            return this;
        }
    }

    /**
     * {@code toast_stack}(items, direction?) — the level-3 positioned stack
     * of transient notices (docs/sdui.md section 2.6). A level-2 client
     * receives the node degraded to a {@code column} of plain texts by the
     * server's downgrade map.
     */
    public static final class ToastStackBuilder extends NodeBuilder<ToastStackBuilder>
            implements HasToastStack<ToastStackBuilder> {

        private ToastStackBuilder() {
        }

        @Override
        String type() {
            return "toast_stack";
        }

        /** The collected item specs, in insertion order (the {@code items} prop). */
        @SuppressWarnings("unchecked")
        private List<Object> items() {
            return (List<Object>) props.computeIfAbsent("items", key -> new ArrayList<>());
        }

        /** Appends one item spec ({@code {text, style?, action?, duration?}}). */
        @Override
        public ToastStackBuilder item(Map<String, Object> entry) {
            items().add(entry);
            return this;
        }

        /** Appends one text-only item. */
        @Override
        public ToastStackBuilder item(String text) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("text", text);
            items().add(item);
            return this;
        }

        /** Appends one item built through {@link Ui#toastItem(String)}. */
        @Override
        public ToastStackBuilder item(Ui.ToastItemBuilder entry) {
            items().add(entry.build());
            return this;
        }

        /** The screen edge the stack grows from: {@code bottom} (default) or {@code top}. */
        @Override
        public ToastStackBuilder direction(String value) {
            props.put("direction", UiEnums.require("direction", value, UiEnums.TOAST_DIRECTION));
            return this;
        }
    }

    /**
     * The spec builder of one {@code toast_stack} item ({@code {text,
     * style?, action?, duration?}}): see {@link Ui#toastItem(String)}.
     * Finished with {@link #build()}, the spec is appended through
     * {@link ToastStackBuilder#item(Map)}.
     */
    public static final class ToastItemBuilder {

        private final Map<String, Object> spec = new LinkedHashMap<>();

        private ToastItemBuilder(String text) {
            spec.put("text", text);
        }

        /** The toast style: {@code error} or {@code success} (like the {@code toast} directive). */
        public ToastItemBuilder style(String value) {
            spec.put("style", UiEnums.require("style", value, UiEnums.TOAST_STYLE));
            return this;
        }

        /** The inline action (the 5 s undo pattern). */
        public ToastItemBuilder action(Map<String, Object> value) {
            spec.put("action", value);
            return this;
        }

        /** The visible window in ms (default 5000). */
        public ToastItemBuilder duration(Number value) {
            spec.put("duration", value);
            return this;
        }

        /** The finished item spec, in insertion order. */
        public Map<String, Object> build() {
            return new LinkedHashMap<>(spec);
        }
    }

    /**
     * {@code scroll_fade}(child, edge?, height?, mode?) — the level-3 alpha
     * fade over a scrollable's edge (docs/sdui.md section 2.6). A level-2
     * client receives the node degraded to a {@code scroll} wrapping the
     * same child by the server's downgrade map.
     */
    public static final class ScrollFadeBuilder extends NodeBuilder<ScrollFadeBuilder>
            implements HasScrollFade<ScrollFadeBuilder> {

        private ScrollFadeBuilder() {
        }

        @Override
        String type() {
            return "scroll_fade";
        }

        /** The scrollable the fade wraps (required; the client degrades a missing child visibly). */
        @Override
        public ScrollFadeBuilder child(UiNode node) {
            props.put("child", node);
            return this;
        }

        /** The scrolled edge: {@code top} (default), {@code bottom}, {@code start} or {@code end}; validated. */
        @Override
        public ScrollFadeBuilder edge(String value) {
            props.put("edge", UiEnums.require("edge", value, UiEnums.SCROLL_FADE_EDGE));
            return this;
        }

        /** The fade extent in px (default 24 — the 1.5rem titlebar fade height). */
        @Override
        public ScrollFadeBuilder height(Number value) {
            props.put("height", value);
            return this;
        }

        /** The recipe: {@code topbar} (static band, default) or {@code virtualized} (scroll-aware); validated. */
        @Override
        public ScrollFadeBuilder mode(String value) {
            props.put("mode", UiEnums.require("mode", value, UiEnums.SCROLL_FADE_MODE));
            return this;
        }
    }

    /**
     * {@code diff_view}(file?, language?, hunks, view?, colorScheme?,
     * stats?, demo) — the level-3 decorative diff renderer (docs/sdui.md
     * section 2.6). A level-2 client receives the node degraded to a
     * {@code code_block} carrying the file name and the hunk headers by the
     * server's downgrade map.
     *
     * <p>The primitive renders exactly the hunks the server authors — no
     * diff engine exists client-side or server-side — so it is decorative
     * and the universal {@code demo} marker is mandatory:
     * {@link #build()} throws {@code demo marker required} when
     * {@link #demo(boolean)} was never called with {@code true}.
     */
    public static final class DiffViewBuilder extends NodeBuilder<DiffViewBuilder>
            implements HasDiffView<DiffViewBuilder> {

        private DiffViewBuilder() {
        }

        @Override
        String type() {
            return "diff_view";
        }

        /** The file path shown in the stat header. */
        @Override
        public DiffViewBuilder file(String value) {
            props.put("file", value);
            return this;
        }

        /** The language label (a plain label, like the {@code code_block} language). */
        @Override
        public DiffViewBuilder language(String value) {
            props.put("language", value);
            return this;
        }

        /** The layout: {@code unified} (default) or {@code split}; validated. */
        @Override
        public DiffViewBuilder view(String value) {
            props.put("view", UiEnums.require("view", value, UiEnums.DIFF_VIEW_LAYOUT));
            return this;
        }

        /** The colour scheme: {@code default} or {@code blue-orange}; validated. */
        @Override
        public DiffViewBuilder colorScheme(String value) {
            props.put("colorScheme", UiEnums.require("colorScheme", value, UiEnums.DIFF_COLOR_SCHEME));
            return this;
        }

        /** The stat header counts, rendered green {@code +n} / red {@code -n}. */
        @Override
        public DiffViewBuilder stats(Number additions, Number deletions) {
            Map<String, Object> stats = new LinkedHashMap<>();
            stats.put("additions", additions);
            stats.put("deletions", deletions);
            props.put("stats", stats);
            return this;
        }

        /** The collected hunk specs, in insertion order (the {@code hunks} prop). */
        @SuppressWarnings("unchecked")
        private List<Object> hunks() {
            return (List<Object>) props.computeIfAbsent("hunks", key -> new ArrayList<>());
        }

        /** Appends one hunk spec ({@code {header, lines}}). */
        @Override
        public DiffViewBuilder hunk(Map<String, Object> hunk) {
            hunks().add(hunk);
            return this;
        }

        /** Appends one hunk built through {@link Ui#diffHunk(String)}. */
        @Override
        public DiffViewBuilder hunk(Ui.DiffHunkBuilder hunk) {
            hunks().add(hunk.build());
            return this;
        }

        /** The universal {@code demo} marker — mandatory and {@code true} on this primitive. */
        @Override
        public DiffViewBuilder demo(boolean value) {
            props.put("demo", value);
            return this;
        }

        /** Wholesale hunk list; the appenders extend the instance in place. */
        @Override
        public DiffViewBuilder hunks(List<Object> hunks) {
            hunks().addAll(hunks);
            return this;
        }

        @Override
        public UiNode build() {
            if (!Boolean.TRUE.equals(props.get("demo"))) {
                throw new IllegalArgumentException(
                        "demo marker required: diff_view is decorative (docs/sdui.md section 2.6)"
                                + " — call demo(true)");
            }
            return super.build();
        }
    }

    /**
     * The spec builder of one {@code diff_view} hunk ({@code {header,
     * lines}}): see {@link Ui#diffHunk(String)}. Finished with
     * {@link #build()}, the spec is appended through
     * {@link DiffViewBuilder#hunk(Map)}.
     */
    public static final class DiffHunkBuilder {

        private final Map<String, Object> spec = new LinkedHashMap<>();

        private DiffHunkBuilder(String header) {
            spec.put("header", header);
        }

        /** The collected line specs, in insertion order (the {@code lines} prop). */
        @SuppressWarnings("unchecked")
        private List<Object> lines() {
            return (List<Object>) spec.computeIfAbsent("lines", key -> new ArrayList<>());
        }

        /** Appends one line spec ({@code {kind, oldNo?, newNo?, text}}). */
        public DiffHunkBuilder line(Map<String, Object> line) {
            lines().add(line);
            return this;
        }

        /** Appends one line built through {@link Ui#diffLine(String, String)}. */
        public DiffHunkBuilder line(Ui.DiffLineBuilder line) {
            lines().add(line.build());
            return this;
        }

        /** The finished hunk spec, in insertion order. */
        public Map<String, Object> build() {
            return new LinkedHashMap<>(spec);
        }
    }

    /**
     * The spec builder of one {@code diff_view} line ({@code {kind, oldNo?,
     * newNo?, text}}): see {@link Ui#diffLine(String, String)}. Finished
     * with {@link #build()}, the spec is appended through
     * {@link DiffHunkBuilder#line(Map)}.
     */
    public static final class DiffLineBuilder {

        private final Map<String, Object> spec = new LinkedHashMap<>();

        private DiffLineBuilder(String kind) {
            spec.put("kind", UiEnums.require("kind", kind, UiEnums.DIFF_LINE_KIND));
        }

        /** The old-side line number (the unified left gutter, the split old pane). */
        public DiffLineBuilder oldNo(Number value) {
            spec.put("oldNo", value);
            return this;
        }

        /** The new-side line number (the unified right gutter, the split new pane). */
        public DiffLineBuilder newNo(Number value) {
            spec.put("newNo", value);
            return this;
        }

        /** The line text (content only — the kind colors the row). */
        public DiffLineBuilder text(String value) {
            spec.put("text", value);
            return this;
        }

        /** The finished line spec, in insertion order. */
        public Map<String, Object> build() {
            return new LinkedHashMap<>(spec);
        }
    }

    public static final class NavItemBuilder {

        private final Map<String, Object> spec = new LinkedHashMap<>();

        private NavItemBuilder(String label) {
            spec.put("label", label);
        }

        /** The leading icon name. */
        public NavItemBuilder icon(String value) {
            spec.put("icon", value);
            return this;
        }

        /** The screen id to navigate to. */
        public NavItemBuilder screen(String value) {
            spec.put("screen", value);
            return this;
        }

        /** The custom dispatch action. */
        public NavItemBuilder action(Map<String, Object> value) {
            spec.put("action", value);
            return this;
        }

        /** The trailing badge node. */
        public NavItemBuilder badge(UiNode value) {
            spec.put("badge", value);
            return this;
        }

        /** The trailing count badge. */
        public NavItemBuilder count(Number value) {
            spec.put("count", value);
            return this;
        }

        /** The sidebar section label this item opens. */
        public NavItemBuilder section(String value) {
            spec.put("section", value);
            return this;
        }

        /** Whether the item accepts taps (defaults to {@code true}). */
        public NavItemBuilder enabled(boolean value) {
            spec.put("enabled", value);
            return this;
        }

        /** The finished item spec, in insertion order. */
        public Map<String, Object> build() {
            return new LinkedHashMap<>(spec);
        }
    }
}
