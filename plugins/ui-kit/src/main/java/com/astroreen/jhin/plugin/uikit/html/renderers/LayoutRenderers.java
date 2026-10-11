/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html.renderers;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import com.astroreen.jhin.plugin.uikit.html.PropReflection;
import com.astroreen.jhin.plugin.uikit.html.UniversalProps;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Layout primitives &rarr; semantic boxes (docs/sdui.md section 9.1):
 * {@code screen, shell, container, box, row, column, flex, expanded,
 * flexible, stack, positioned, align, center, sized_box, aspect_ratio, wrap,
 * grid, scroll, divider, spacer, list, list_row, table, tree, split}.
 *
 * <p>Boxes are {@code <div>}s carrying {@code jhin-} display classes
 * ({@code .jhin-row} is {@code display: flex} in the stylesheet, not inline
 * style); only geometry CSS cannot express through a class — the
 * {@code positioned} offsets, the {@code grid} column template, the
 * {@code container}/{@code wrap} gap and direction declarations — is
 * composed into the {@code style} attribute alongside the universal
 * declarations. {@code divider} is the one void element ({@code <hr>});
 * {@code list_row} becomes a {@code <button>} when it carries an action;
 * {@code table} and {@code tree} render their real semantics
 * ({@code <table>}/{@code <thead>}/{@code <tbody>},
 * {@code <ul role="tree">}/{@code <li role="treeitem">}).
 *
 * <p>T206 prop completeness: the section 2.6 layout props land as classes,
 * inline declarations, child structure (the {@code list} separator, the
 * {@code list_row} status indicators and drag affordances) or — for the
 * client-driven ones — {@link PropReflection} attributes.
 */
public final class LayoutRenderers {

    /** The {@code screen} props the renderer reflects itself. */
    private static final Set<String> SCREEN_HANDLED = Set.of("title", "appBar", "body", "floatingAction");

    /** The {@code shell} props the renderer reflects itself. */
    private static final Set<String> SHELL_HANDLED = Set.of(
            "collapsed", "breakpoint", "body", "sidebar", "header", "topbar",
            "topbarCompact", "pageHeader", "detail", "rail", "terminal");

    /** The shared {@code container}/{@code box} props the renderer reflects itself. */
    private static final Set<String> BOX_HANDLED = Set.of(
            "child", "children", "direction", "gap", "scroll", "laneWidth",
            "panelWidth", "shape", "alignment");

    /** The {@code wrap} props the renderer reflects itself. */
    private static final Set<String> WRAP_HANDLED = Set.of(
            "children", "direction", "alignment", "spacing", "runSpacing",
            "runAlignment", "crossAxisAlignment", "textDirection", "verticalDirection");

    /** The {@code list} props the renderer reflects itself. */
    private static final Set<String> LIST_HANDLED = Set.of(
            "items", "sections", "separator", "empty", "header", "footer", "maxHeight");

    /** One {@code list} section's props with a semantic mapping. */
    private static final Set<String> SECTION_HANDLED = Set.of(
            "label", "id", "when", "items", "uppercase", "count");

    /** The {@code list_row} props with a semantic mapping. */
    private static final Set<String> LIST_ROW_HANDLED = Set.of(
            "leading", "title", "subtitle", "trailing", "badge", "selected",
            "dragHandle", "statusIndicators", "hoverReveal", "dragging",
            "draggable", "commandSubtitle", "dragLabel");

    /** The {@code table} props the renderer reflects itself. */
    private static final Set<String> TABLE_HANDLED = Set.of(
            "columns", "rows", "zebra", "hoverable", "stickyHeader", "sort", "empty");

    /** One {@code table} column's props with a semantic mapping. */
    private static final Set<String> COLUMN_HANDLED = Set.of("label", "width", "align", "sortable");

    /** One {@code tree} item's props with a semantic mapping. */
    private static final Set<String> TREE_ITEM_HANDLED = Set.of(
            "label", "icon", "expanded", "action", "confirm", "badge", "stat", "items");

    /** The {@code split} props the renderer reflects itself. */
    private static final Set<String> SPLIT_HANDLED = Set.of(
            "first", "second", "axis", "persistKey", "handleStyle");

    private LayoutRenderers() {
    }

    public static Map<String, NodeRenderer> renderers() {
        Map<String, NodeRenderer> map = new LinkedHashMap<>();
        map.put("screen", screen());
        map.put("shell", shell());
        map.put("container", box("container"));
        map.put("box", box("box"));
        map.put("row", fixed("row", "row"));
        map.put("column", fixed("column", "column"));
        map.put("flex", flex());
        map.put("expanded", single("expanded"));
        map.put("flexible", single("flexible"));
        map.put("stack", stack());
        map.put("positioned", positioned());
        map.put("align", single("align"));
        map.put("center", single("center"));
        map.put("sized_box", single("sized_box"));
        map.put("aspect_ratio", single("aspect_ratio"));
        map.put("wrap", wrap());
        map.put("grid", grid());
        map.put("scroll", scroll());
        map.put("divider", divider());
        map.put("spacer", spacer());
        map.put("list", list());
        map.put("list_row", listRow());
        map.put("table", table());
        map.put("tree", tree());
        map.put("split", split());
        return map;
    }

    // --- shared box shapes ------------------------------------------------

    /**
     * A generic box ({@code container}, {@code box}, {@code wrap} shell):
     * {@code child}/{@code children} props plus the children list, and the
     * section 2.6 geometry as inline declarations (T206): {@code direction},
     * {@code gap}, {@code scroll}, {@code laneWidth}, {@code panelWidth},
     * {@code shape}.
     */
    private static NodeRenderer box(String type) {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", HtmlRenderer.typeClass(type));
                StringBuilder extras = new StringBuilder();
                if (node.props().get("direction") != null) {
                    appendDecl(extras, "flex-direction",
                            "row".equals(String.valueOf(node.props().get("direction")))
                                    ? "row" : "column");
                }
                if (node.props().get("gap") != null) {
                    appendDecl(extras, "gap", px(node.props().get("gap")));
                }
                if (Boolean.TRUE.equals(node.props().get("scroll"))) {
                    appendDecl(extras, "overflow", "auto");
                }
                if (node.props().get("laneWidth") != null) {
                    // The chat content lane (T100): a capped, centered lane.
                    appendDecl(extras, "max-width", px(node.props().get("laneWidth")));
                    appendDecl(extras, "margin-left", "auto");
                    appendDecl(extras, "margin-right", "auto");
                }
                if (node.props().get("panelWidth") != null) {
                    appendDecl(extras, "width", px(node.props().get("panelWidth")));
                }
                if ("circle".equals(String.valueOf(node.props().get("shape")))) {
                    appendDecl(extras, "border-radius", "50%");
                }
                if (extras.length() > 0) {
                    composeStyle(node, element, extras.toString());
                }
                HtmlRenderer.appendProp(element, node, "child");
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, BOX_HANDLED);
            }
        };
    }

    /** A box with one fixed display class suffix ({@code row}, {@code column}). */
    private static NodeRenderer fixed(String type, String display) {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                String classes = HtmlRenderer.typeClass(type);
                if (!type.equals(display)) {
                    classes = classes + " jhin-" + display;
                }
                element.attr("class", classes);
                HtmlRenderer.appendProp(element, node, "child");
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, Set.of("child", "children"));
            }
        };
    }

    /** A single-child box ({@code expanded}, {@code align}, {@code center}, …). */
    private static NodeRenderer single(String type) {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", HtmlRenderer.typeClass(type));
                HtmlRenderer.appendProp(element, node, "child");
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
                // `align` owns `align`/`alignment` through the universal
                // pass; the other single-child boxes only carry child props.
                Set<String> handled = "align".equals(type)
                        ? Set.of("child", "children", "align", "alignment")
                        : Set.of("child", "children");
                PropReflection.reflect(node, element, handled);
            }
        };
    }

    private static NodeRenderer screen() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-screen");
                Object title = node.props().get("title");
                if (title != null) {
                    HtmlNode bar = new HtmlNode("header").attr("class", "jhin-appbar");
                    bar.textChild(String.valueOf(title));
                    element.child(bar);
                }
                HtmlRenderer.appendProp(element, node, "appBar");
                HtmlRenderer.appendProp(element, node, "body");
                HtmlRenderer.appendProp(element, node, "floatingAction");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, SCREEN_HANDLED);
            }
        };
    }

    private static NodeRenderer shell() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-shell");
                if (Boolean.TRUE.equals(node.props().get("collapsed"))) {
                    element.attr("data-jhin-collapsed", "true");
                }
                if (node.props().get("breakpoint") != null) {
                    element.attr("data-jhin-breakpoint",
                            String.valueOf(node.props().get("breakpoint")));
                }
                for (String region : new String[] {
                        "sidebar", "header", "topbar", "topbarCompact", "pageHeader",
                        "detail", "rail", "terminal"}) {
                    HtmlRenderer.appendProp(element, node, region);
                }
                if (node.props().get("body") != null) {
                    HtmlRenderer.appendProp(element, node, "body");
                } else {
                    // Section 2.6: a shell without a body degrades to a card
                    // that names the problem; the page still paints.
                    element.child(new HtmlNode("div")
                            .attr("class", "jhin-card jhin-shell-missing-body")
                            .attr("data-jhin-type", "card")
                            .textChild("Missing body"));
                }
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, SHELL_HANDLED);
            }
        };
    }

    private static NodeRenderer flex() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                Object direction = node.props().get("direction");
                String display = "column".equals(String.valueOf(direction)) ? "column" : "row";
                element.attr("class", "jhin-flex jhin-" + display);
                HtmlRenderer.appendProp(element, node, "child");
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, Set.of("direction", "child", "children"));
            }
        };
    }

    private static NodeRenderer stack() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-stack");
                StringBuilder extras = new StringBuilder();
                if (node.props().get("alignment") != null) {
                    // The 9-point stack alignment (section 2.6) places the
                    // non-positioned children in the grid.
                    String[] pair = alignPair(String.valueOf(node.props().get("alignment")));
                    appendDecl(extras, "justify-items", pair[0]);
                    appendDecl(extras, "align-items", pair[1]);
                }
                if (node.props().get("textDirection") != null) {
                    appendDecl(extras, "direction", String.valueOf(node.props().get("textDirection")));
                }
                if (node.props().get("fit") != null) {
                    element.attr("data-jhin-fit", String.valueOf(node.props().get("fit")));
                }
                if (extras.length() > 0) {
                    composeStyle(node, element, extras.toString());
                }
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element,
                        Set.of("children", "alignment", "textDirection", "fit"));
            }
        };
    }

    private static NodeRenderer positioned() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-positioned");
                StringBuilder extras = new StringBuilder("position: absolute");
                for (String side : new String[] {"top", "right", "bottom", "left"}) {
                    Object value = node.props().get(side);
                    if (value != null) {
                        extras.append("; ").append(side).append(": ").append(px(value));
                    }
                }
                composeStyle(node, element, extras.toString());
                HtmlRenderer.appendProp(element, node, "child");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, Set.of("child"));
            }
        };
    }

    private static NodeRenderer wrap() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-wrap");
                StringBuilder extras = new StringBuilder();
                boolean vertical = "vertical".equals(String.valueOf(node.props().get("direction")));
                boolean up = "up".equals(String.valueOf(node.props().get("verticalDirection")));
                if (node.props().get("direction") != null
                        || node.props().get("verticalDirection") != null) {
                    appendDecl(extras, "flex-direction",
                            vertical ? (up ? "column-reverse" : "column")
                                    : (up ? "row-reverse" : "row"));
                }
                if (node.props().get("alignment") != null) {
                    appendDecl(extras, "justify-content",
                            wrapMain(String.valueOf(node.props().get("alignment"))));
                }
                if (node.props().get("runAlignment") != null) {
                    appendDecl(extras, "align-content",
                            wrapMain(String.valueOf(node.props().get("runAlignment"))));
                }
                if (node.props().get("crossAxisAlignment") != null) {
                    appendDecl(extras, "align-items",
                            wrapCross(String.valueOf(node.props().get("crossAxisAlignment"))));
                }
                if (node.props().get("spacing") != null) {
                    appendDecl(extras, "column-gap", px(node.props().get("spacing")));
                }
                if (node.props().get("runSpacing") != null) {
                    appendDecl(extras, "row-gap", px(node.props().get("runSpacing")));
                }
                if (node.props().get("textDirection") != null) {
                    appendDecl(extras, "direction", String.valueOf(node.props().get("textDirection")));
                }
                if (extras.length() > 0) {
                    composeStyle(node, element, extras.toString());
                }
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, WRAP_HANDLED);
            }
        };
    }

    private static NodeRenderer grid() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-grid");
                StringBuilder extras = new StringBuilder();
                if (node.props().get("columns") instanceof Number number) {
                    appendDecl(extras, "grid-template-columns",
                            "repeat(" + number.intValue() + ", minmax(0, 1fr))");
                }
                if (node.props().get("crossAxisSpacing") != null) {
                    appendDecl(extras, "column-gap", px(node.props().get("crossAxisSpacing")));
                }
                if (node.props().get("mainAxisSpacing") != null) {
                    appendDecl(extras, "row-gap", px(node.props().get("mainAxisSpacing")));
                }
                if (extras.length() > 0) {
                    composeStyle(node, element, extras.toString());
                }
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element,
                        Set.of("columns", "children", "crossAxisSpacing", "mainAxisSpacing"));
            }
        };
    }

    private static NodeRenderer scroll() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-scroll");
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendProp(element, node, "items");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, Set.of("children", "items"));
            }
        };
    }

    private static NodeRenderer divider() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "hr";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-divider");
                StringBuilder extras = new StringBuilder();
                if (node.props().get("thickness") != null) {
                    extras.append("border-top-width: ").append(px(node.props().get("thickness")));
                }
                if (node.props().get("indent") != null) {
                    appendDecl(extras, "margin-left", px(node.props().get("indent")));
                }
                if (node.props().get("endIndent") != null) {
                    appendDecl(extras, "margin-right", px(node.props().get("endIndent")));
                }
                if (extras.length() > 0) {
                    composeStyle(node, element, extras.toString());
                }
                PropReflection.reflect(node, element, Set.of("thickness", "indent", "endIndent"));
            }
        };
    }

    private static NodeRenderer spacer() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                Object axis = node.props().get("axis");
                element.attr("class", "jhin-spacer"
                        + (axis != null ? " jhin-spacer-" + axis : ""));
                Object size = node.props().get("size");
                if (size != null) {
                    boolean horizontal = "horizontal".equals(String.valueOf(axis));
                    composeStyle(node, element, (horizontal ? "width: " : "height: ") + px(size));
                }
                PropReflection.reflect(node, element, Set.of("axis", "size"));
            }
        };
    }

    // --- list / list_row --------------------------------------------------

    private static NodeRenderer list() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-list");
                element.attr("role", "list");
                if (node.props().get("maxHeight") != null) {
                    composeStyle(node, element,
                            "max-height: " + px(node.props().get("maxHeight")));
                }
                HtmlRenderer.appendProp(element, node, "header");
                Object sections = node.props().get("sections");
                if (sections instanceof List<?> list && !list.isEmpty()) {
                    for (Object section : list) {
                        appendSection(element, section);
                    }
                } else {
                    appendItems(element, node);
                }
                boolean empty = node.props().get("items") == null
                        && node.props().get("sections") == null
                        && node.children().isEmpty();
                if (empty && node.props().get("empty") != null) {
                    HtmlRenderer.appendProp(element, node, "empty");
                }
                HtmlRenderer.appendProp(element, node, "footer");
                PropReflection.reflect(node, element, LIST_HANDLED);
            }
        };
    }

    /** The flat {@code items} with the {@code separator} interleaved (T206). */
    private static void appendItems(HtmlNode element, UiNode node) {
        List<Object> items = new ArrayList<>();
        if (node.props().get("items") instanceof List<?> list) {
            items.addAll(list);
        }
        items.addAll(node.children());
        Object separator = node.props().get("separator");
        for (int i = 0; i < items.size(); i++) {
            if (i > 0 && separator != null) {
                HtmlRenderer.appendContent(element, separator);
            }
            HtmlRenderer.appendContent(element, items.get(i));
        }
    }

    /**
     * One {@code list} section entry ({@code label, id?, items, when?,
     * collapsible?, collapsed?, uppercase?, count?, badgeStyle?, storeKey?,
     * boundaryLabel?}, docs/sdui.md section 2.6): a labeled group; the
     * section {@code when} gate travels as {@code data-jhin-when} and the
     * count badge as a rounded pill in the label row.
     */
    private static void appendSection(HtmlNode element, Object section) {
        if (!(section instanceof Map<?, ?> map)) {
            HtmlRenderer.appendContent(element, section);
            return;
        }
        HtmlNode group = new HtmlNode("section").attr("class", "jhin-list-section");
        if (map.get("id") != null) {
            group.attr("id", String.valueOf(map.get("id")));
            group.attr("data-jhin-id", String.valueOf(map.get("id")));
        }
        if (map.get("when") != null) {
            group.attr("data-jhin-when", String.valueOf(map.get("when")));
        }
        Object label = map.get("label");
        if (label != null) {
            HtmlNode labelElement = new HtmlNode("h3").attr("class", "jhin-list-section-label");
            if (Boolean.TRUE.equals(map.get("uppercase"))) {
                labelElement.attr("style", "text-transform: uppercase");
            }
            labelElement.textChild(String.valueOf(label));
            group.child(labelElement);
        }
        if (map.get("count") instanceof Number count) {
            group.child(new HtmlNode("span").attr("class", "jhin-list-section-count")
                    .textChild(String.valueOf(count)));
        }
        HtmlRenderer.appendContent(group, map.get("items"));
        PropReflection.reflect(map, group, SECTION_HANDLED);
        element.child(group);
    }

    private static NodeRenderer listRow() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return hasAction(node) ? "button" : "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-list-row"
                        + (Boolean.TRUE.equals(node.props().get("selected")) ? " jhin-selected" : "")
                        + (Boolean.TRUE.equals(node.props().get("dragging")) ? " jhin-dragging" : "")
                        + (Boolean.TRUE.equals(node.props().get("hoverReveal")) ? " jhin-hover-reveal" : ""));
                element.attr("role", "listitem");
                if (hasAction(node)) {
                    element.attr("type", "button");
                }
                if (Boolean.TRUE.equals(node.props().get("selected"))) {
                    element.attr("aria-current", "true");
                }
                if (Boolean.TRUE.equals(node.props().get("draggable"))) {
                    element.attr("data-jhin-draggable", "true");
                }
                if (node.props().get("statusIndicators") instanceof List<?> kinds) {
                    for (Object kind : kinds) {
                        element.child(new HtmlNode("span")
                                .attr("class", "jhin-status-indicator")
                                .attr("data-jhin-status", String.valueOf(kind)));
                    }
                }
                if (Boolean.TRUE.equals(node.props().get("dragHandle"))) {
                    element.child(new HtmlNode("span").attr("class", "jhin-drag-handle")
                            .child(ControlRenderers.iconElement("drag_indicator", null)));
                }
                HtmlRenderer.appendProp(element, node, "leading");
                HtmlNode title = new HtmlNode("div").attr("class", "jhin-list-row-title");
                appendTextOrNode(title, node.props().get("title"));
                appendTextOrNode(title, node.props().get("subtitle"));
                if (node.props().get("commandSubtitle") != null) {
                    title.child(new HtmlNode("span").attr("class", "jhin-command-subtitle")
                            .textChild(String.valueOf(node.props().get("commandSubtitle"))));
                }
                element.child(title);
                HtmlRenderer.appendProp(element, node, "trailing");
                HtmlRenderer.appendProp(element, node, "badge");
                HtmlRenderer.appendProp(element, node, "dragLabel");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, LIST_ROW_HANDLED);
            }
        };
    }

    // --- table / tree / split ---------------------------------------------

    private static NodeRenderer table() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "table";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                StringBuilder classes = new StringBuilder("jhin-table");
                if (Boolean.TRUE.equals(node.props().get("zebra"))) {
                    classes.append(" jhin-zebra");
                }
                if (Boolean.TRUE.equals(node.props().get("hoverable"))) {
                    classes.append(" jhin-hoverable");
                }
                if (Boolean.TRUE.equals(node.props().get("stickyHeader"))) {
                    classes.append(" jhin-sticky-header");
                }
                element.attr("class", classes.toString());
                Object sort = node.props().get("sort");
                if (sort instanceof Map<?, ?> sortMap) {
                    element.attr("data-jhin-sort", HtmlRenderer.actionJson(sortMap));
                }
                Object columns = node.props().get("columns");
                if (columns instanceof List<?> list && !list.isEmpty()) {
                    HtmlNode head = new HtmlNode("thead");
                    HtmlNode row = new HtmlNode("tr");
                    for (Object column : list) {
                        row.child(headerCell(column, sort));
                    }
                    head.child(row);
                    element.child(head);
                }
                Object rows = node.props().get("rows");
                if (rows instanceof List<?> list && !list.isEmpty()) {
                    HtmlNode body = new HtmlNode("tbody");
                    for (Object row : list) {
                        body.child(row(row));
                    }
                    element.child(body);
                } else if (node.props().get("empty") != null) {
                    HtmlNode body = new HtmlNode("tbody");
                    HtmlNode cell = new HtmlNode("td").attr("colspan", "1");
                    HtmlRenderer.appendProp(cell, node, "empty");
                    body.child(new HtmlNode("tr").child(cell));
                    element.child(body);
                }
                PropReflection.reflect(node, element, TABLE_HANDLED);
            }
        };
    }

    private static HtmlNode headerCell(Object column, Object sort) {
        HtmlNode cell = new HtmlNode("th");
        if (column instanceof Map<?, ?> map) {
            if (map.get("label") != null) {
                cell.textChild(String.valueOf(map.get("label")));
            }
            StringBuilder style = new StringBuilder();
            if (map.get("width") != null) {
                appendDecl(style, "width", px(map.get("width")));
            }
            if (map.get("align") != null) {
                appendDecl(style, "text-align", String.valueOf(map.get("align")));
            }
            if (style.length() > 0) {
                cell.attr("style", style.toString());
            }
            if (Boolean.TRUE.equals(map.get("sortable"))) {
                cell.attr("data-jhin-sortable", "true");
            }
            if (sort instanceof Map<?, ?> sortMap
                    && map.get("label") != null
                    && String.valueOf(sortMap.get("column")).equals(String.valueOf(map.get("label")))) {
                cell.attr("aria-sort",
                        Boolean.FALSE.equals(sortMap.get("ascending")) ? "descending" : "ascending");
            }
            PropReflection.reflect(map, cell, COLUMN_HANDLED);
        } else {
            cell.textChild(String.valueOf(column));
        }
        return cell;
    }

    private static HtmlNode row(Object row) {
        HtmlNode tr = new HtmlNode("tr");
        List<?> cells = row instanceof List<?> list ? list : List.of(row);
        for (Object cell : cells) {
            HtmlNode td = new HtmlNode("td");
            if (cell instanceof UiNode || cell instanceof List || cell instanceof Map) {
                HtmlRenderer.appendContent(td, cell);
            } else {
                td.textChild(String.valueOf(cell));
            }
            tr.child(td);
        }
        return tr;
    }

    private static NodeRenderer tree() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "ul";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-tree");
                element.attr("role", "tree");
                Object items = node.props().get("items");
                if (items instanceof List<?> list) {
                    for (Object item : list) {
                        appendTreeItem(element, item);
                    }
                }
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, Set.of("items"));
            }
        };
    }

    /**
     * Appends one {@code tree} item ({@code label, icon?, expanded?, action?,
     * badge?, stat?, items?}) as a {@code <li role="treeitem">}; nested items
     * recurse. The item {@code action} rides on the row element through the
     * same {@code data-jhin-action} protocol as node actions.
     */
    static void appendTreeItem(HtmlNode parent, Object item) {
        if (!(item instanceof Map<?, ?> map)) {
            HtmlRenderer.appendContent(parent, item);
            return;
        }
        HtmlNode li = new HtmlNode("li")
                .attr("class", "jhin-tree-item")
                .attr("role", "treeitem");
        if (map.get("expanded") != null) {
            li.attr("aria-expanded", String.valueOf(map.get("expanded")));
        }
        HtmlRenderer.applyActionAttrs(li, map.get("action"), map.get("confirm"));
        if (map.get("icon") instanceof String icon) {
            li.child(ControlRenderers.iconElement(icon, null));
        }
        HtmlNode label = new HtmlNode("span").attr("class", "jhin-tree-label");
        if (map.get("label") != null) {
            label.textChild(String.valueOf(map.get("label")));
        }
        li.child(label);
        if (map.get("stat") != null) {
            li.child(new HtmlNode("span").attr("class", "jhin-tree-stat")
                    .textChild(String.valueOf(map.get("stat"))));
        }
        if (map.get("badge") instanceof UiNode badge) {
            HtmlRenderer.appendNode(li, badge);
        }
        Object children = map.get("items");
        if (children instanceof List<?> nested && !nested.isEmpty()) {
            HtmlNode ul = new HtmlNode("ul")
                    .attr("class", "jhin-tree-children")
                    .attr("role", "group");
            for (Object child : nested) {
                appendTreeItem(ul, child);
            }
            li.child(ul);
        }
        PropReflection.reflect(map, li, TREE_ITEM_HANDLED);
        parent.child(li);
    }

    private static NodeRenderer split() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-split");
                if (node.props().get("axis") != null) {
                    composeStyle(node, element, "flex-direction: "
                            + ("vertical".equals(String.valueOf(node.props().get("axis")))
                                    ? "column" : "row"));
                }
                if (node.props().get("persistKey") != null) {
                    element.attr("data-jhin-persist-key",
                            String.valueOf(node.props().get("persistKey")));
                }
                HtmlRenderer.appendProp(element, node, "first");
                Object handleStyle = node.props().get("handleStyle");
                element.child(new HtmlNode("div").attr("class", "jhin-split-handle"
                        + (handleStyle != null ? " jhin-split-handle-" + handleStyle : "")));
                HtmlRenderer.appendProp(element, node, "second");
                PropReflection.reflect(node, element, SPLIT_HANDLED);
            }
        };
    }

    // --- shared helpers ---------------------------------------------------

    static boolean hasAction(UiNode node) {
        return node.props().get("action") != null
                || node.props().get("onTap") != null
                || node.props().get("onLongPress") != null;
    }

    /** A string prop renders as text content, a node prop through the pipeline. */
    static void appendTextOrNode(HtmlNode target, Object value) {
        if (value == null) {
            return;
        }
        if (value instanceof UiNode) {
            HtmlRenderer.appendContent(target, value);
        } else {
            target.textChild(String.valueOf(value));
        }
    }

    /**
     * Re-sets the {@code style} attribute as the universal declarations plus
     * the family's extras, keeping the section 2.3 application order (the
     * universal declarations first).
     */
    static void composeStyle(UiNode node, HtmlNode element, String extras) {
        String style = UniversalProps.styleOf(node);
        if (style.isEmpty()) {
            style = extras;
        } else if (!extras.isEmpty()) {
            style = style + "; " + extras;
        }
        if (!style.isEmpty()) {
            element.attr("style", style);
        }
    }

    static void appendDecl(StringBuilder style, String property, String value) {
        if (value == null) {
            return;
        }
        if (style.length() > 0) {
            style.append("; ");
        }
        style.append(property).append(": ").append(value);
    }

    /** A number is logical px; a string is a token reference or a raw CSS length. */
    static String px(Object value) {
        if (value instanceof Number number) {
            double d = number.doubleValue();
            if (d == Math.floor(d) && !Double.isInfinite(d)) {
                return ((long) d) + "px";
            }
            return d + "px";
        }
        return String.valueOf(value);
    }

    /** The 9-point alignment literal to a {@code {justify, align}} pair. */
    private static String[] alignPair(String literal) {
        return switch (literal) {
            case "topLeft" -> new String[] {"start", "start"};
            case "topCenter" -> new String[] {"center", "start"};
            case "topRight" -> new String[] {"end", "start"};
            case "centerLeft" -> new String[] {"start", "center"};
            case "centerRight" -> new String[] {"end", "center"};
            case "bottomLeft" -> new String[] {"start", "end"};
            case "bottomCenter" -> new String[] {"center", "end"};
            case "bottomRight" -> new String[] {"end", "end"};
            default -> new String[] {"center", "center"};
        };
    }

    /** The wrap main-axis literal to a {@code justify-*} value. */
    private static String wrapMain(String literal) {
        return switch (literal) {
            case "start" -> "flex-start";
            case "end" -> "flex-end";
            case "spaceBetween" -> "space-between";
            case "spaceAround" -> "space-around";
            case "spaceEvenly" -> "space-evenly";
            default -> "center";
        };
    }

    /** The wrap cross-axis literal to an {@code align-*} value. */
    private static String wrapCross(String literal) {
        return switch (literal) {
            case "start" -> "flex-start";
            case "end" -> "flex-end";
            default -> "center";
        };
    }
}
