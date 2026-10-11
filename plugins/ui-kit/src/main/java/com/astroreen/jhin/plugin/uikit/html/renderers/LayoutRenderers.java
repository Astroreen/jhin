/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html.renderers;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import com.astroreen.jhin.plugin.uikit.html.UniversalProps;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Layout primitives &rarr; semantic boxes (docs/sdui.md section 9.1):
 * {@code screen, shell, container, box, row, column, flex, expanded,
 * flexible, stack, positioned, align, center, sized_box, aspect_ratio, wrap,
 * grid, scroll, divider, spacer, list, list_row, table, tree, split}.
 *
 * <p>Boxes are {@code <div>}s carrying {@code jhin-} display classes
 * ({@code .jhin-row} is {@code display: flex} in the stylesheet, not inline
 * style); only geometry CSS cannot express through a class — the
 * {@code positioned} offsets and the {@code grid} column template — is
 * composed into the {@code style} attribute alongside the universal
 * declarations. {@code divider} is the one void element
 * ({@code <hr>}); {@code list_row} becomes a {@code <button>} when it
 * carries an action; {@code table} and {@code tree} render their real
 * semantics ({@code <table>}/{@code <thead>}/{@code <tbody>},
 * {@code <ul role="tree">}/{@code <li role="treeitem">}).
 */
public final class LayoutRenderers {

    private LayoutRenderers() {
    }

    public static Map<String, NodeRenderer> renderers() {
        Map<String, NodeRenderer> map = new LinkedHashMap<>();
        map.put("screen", new NodeRenderer() {
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
            }
        });
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
        map.put("wrap", box("wrap"));
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

    /** A generic box: {@code child}/{@code children} props plus the children list. */
    private static NodeRenderer box(String type) {
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
            }
        };
    }

    /** A single-child box ({@code expanded}, {@code align}, {@code center}, …). */
    private static NodeRenderer single(String type) {
        return box(type);
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
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
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
                Object columns = node.props().get("columns");
                if (columns instanceof Number number) {
                    composeStyle(node, element, "grid-template-columns: repeat("
                            + number.intValue() + ", minmax(0, 1fr))");
                }
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
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
                element.attr("class", "jhin-spacer");
                Object size = node.props().get("size");
                if (size != null) {
                    boolean horizontal = "horizontal".equals(
                            String.valueOf(node.props().get("axis")));
                    composeStyle(node, element, (horizontal ? "width: " : "height: ") + px(size));
                }
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
                HtmlRenderer.appendProp(element, node, "header");
                Object sections = node.props().get("sections");
                if (sections instanceof List<?> list && !list.isEmpty()) {
                    for (Object section : list) {
                        appendSection(element, section);
                    }
                } else {
                    HtmlRenderer.appendProp(element, node, "items");
                    HtmlRenderer.appendChildren(element, node);
                }
                boolean empty = node.props().get("items") == null
                        && node.props().get("sections") == null
                        && node.children().isEmpty();
                if (empty && node.props().get("empty") != null) {
                    HtmlRenderer.appendProp(element, node, "empty");
                }
                HtmlRenderer.appendProp(element, node, "footer");
            }
        };
    }

    /**
     * One {@code list} section entry ({@code label, id?, items, when?, …},
     * docs/sdui.md section 2.6): a labeled group; the section {@code when}
     * gate travels as {@code data-jhin-when}.
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
            group.child(new HtmlNode("h3").attr("class", "jhin-list-section-label")
                    .textChild(String.valueOf(label)));
        }
        HtmlRenderer.appendContent(group, map.get("items"));
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
                element.attr("class", "jhin-list-row");
                element.attr("role", "listitem");
                if (hasAction(node)) {
                    element.attr("type", "button");
                }
                if (Boolean.TRUE.equals(node.props().get("selected"))) {
                    element.attr("class", "jhin-list-row jhin-selected");
                    element.attr("aria-current", "true");
                }
                HtmlRenderer.appendProp(element, node, "leading");
                HtmlNode title = new HtmlNode("div").attr("class", "jhin-list-row-title");
                appendTextOrNode(title, node.props().get("title"));
                appendTextOrNode(title, node.props().get("subtitle"));
                element.child(title);
                HtmlRenderer.appendProp(element, node, "trailing");
                HtmlRenderer.appendProp(element, node, "badge");
                HtmlRenderer.appendProp(element, node, "dragLabel");
                HtmlRenderer.appendChildren(element, node);
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
                element.attr("class", classes.toString());
                Object columns = node.props().get("columns");
                if (columns instanceof List<?> list && !list.isEmpty()) {
                    HtmlNode head = new HtmlNode("thead");
                    HtmlNode row = new HtmlNode("tr");
                    for (Object column : list) {
                        row.child(headerCell(column));
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
            }
        };
    }

    private static HtmlNode headerCell(Object column) {
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
                if (node.props().get("persistKey") != null) {
                    element.attr("data-jhin-persist-key",
                            String.valueOf(node.props().get("persistKey")));
                }
                HtmlRenderer.appendProp(element, node, "first");
                element.child(new HtmlNode("div").attr("class", "jhin-split-handle"));
                HtmlRenderer.appendProp(element, node, "second");
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
}
