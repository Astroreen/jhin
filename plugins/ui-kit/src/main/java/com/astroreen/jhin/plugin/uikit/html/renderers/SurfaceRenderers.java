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
 * Surface primitives (docs/sdui.md section 9.1): {@code card, drawer, sheet,
 * dialog, banner, chip, badge, avatar, skeleton, progress, image, figure,
 * hover_card, toast_stack}.
 *
 * <p>The surfaces map to their semantic containers — {@code <section>} for
 * {@code card}/{@code banner}, {@code <dialog>} for {@code sheet}/{@code
 * dialog} (both are modal surfaces), {@code <aside>} for {@code drawer} —
 * and the data surfaces to their real elements: {@code <progress>} (or
 * {@code <div role="progressbar">} when circular), {@code <img>}.
 * {@code badge} and {@code chip} are {@code <span class="jhin-badge">} with
 * {@code role="status"} when colored.
 */
public final class SurfaceRenderers {

    /** The titled-surface props the shared renderer reflects itself (T206). */
    private static final Set<String> SURFACE_HANDLED = Set.of(
            "title", "body", "content", "children", "actions", "footer");

    /** One {@code toast_stack} item's props with a semantic mapping. */
    private static final Set<String> TOAST_ITEM_HANDLED = Set.of(
            "text", "style", "action", "duration");

    private SurfaceRenderers() {
    }

    public static Map<String, NodeRenderer> renderers() {
        Map<String, NodeRenderer> map = new LinkedHashMap<>();
        map.put("card", surface("card", "section"));
        map.put("drawer", surface("drawer", "aside"));
        map.put("sheet", surface("sheet", "dialog"));
        map.put("dialog", surface("dialog", "dialog"));
        map.put("banner", banner());
        map.put("chip", chip());
        map.put("badge", badge());
        map.put("avatar", avatar());
        map.put("skeleton", skeleton());
        map.put("progress", progress());
        map.put("image", image());
        map.put("figure", figure());
        map.put("hover_card", hoverCard());
        map.put("toast_stack", toastStack());
        return map;
    }

    // --- containers -------------------------------------------------------

    /**
     * A titled surface: {@code title} becomes a heading child, the
     * content-bearing props ({@code children}/{@code body}/{@code content}/
     * {@code actions}/{@code footer}) and the children list render in
     * section 2.6 order.
     */
    private static NodeRenderer surface(String type, String tag) {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return tag;
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", HtmlRenderer.typeClass(type));
                appendTitle(element, node);
                HtmlRenderer.appendProp(element, node, "body");
                HtmlRenderer.appendProp(element, node, "content");
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendProp(element, node, "actions");
                HtmlRenderer.appendProp(element, node, "footer");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, SURFACE_HANDLED);
            }
        };
    }

    private static void appendTitle(HtmlNode element, UiNode node) {
        Object title = node.props().get("title");
        if (title == null) {
            return;
        }
        if (title instanceof UiNode) {
            HtmlRenderer.appendContent(element, title);
        } else {
            element.child(new HtmlNode("h2")
                    .attr("class", "jhin-surface-title")
                    .textChild(String.valueOf(title)));
        }
    }

    private static NodeRenderer banner() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "section";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-banner");
                element.attr("role", "status");
                if (node.props().get("onDismiss") != null) {
                    HtmlNode dismiss = new HtmlNode("button")
                            .attr("type", "button")
                            .attr("class", "jhin-banner-dismiss")
                            .attr("aria-label", "Dismiss");
                    HtmlRenderer.applyActionAttrs(dismiss, node.props().get("onDismiss"), null);
                    element.child(dismiss);
                }
                HtmlRenderer.appendProp(element, node, "content");
                HtmlRenderer.appendProp(element, node, "actions");
                HtmlRenderer.appendProp(element, node, "children");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element,
                        Set.of("content", "actions", "children", "onDismiss"));
            }
        };
    }

    // --- badges / chips / avatars ----------------------------------------

    private static NodeRenderer chip() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "span";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                StringBuilder classes = new StringBuilder("jhin-badge jhin-chip");
                if (node.props().get("kind") != null) {
                    classes.append(" jhin-chip-").append(node.props().get("kind"));
                }
                if (node.props().get("variant") != null) {
                    classes.append(" jhin-chip-variant-").append(node.props().get("variant"));
                }
                if (Boolean.TRUE.equals(node.props().get("selected"))) {
                    classes.append(" jhin-selected");
                }
                element.attr("class", classes.toString());
                if (node.props().get("color") != null) {
                    element.attr("role", "status");
                }
                HtmlRenderer.appendProp(element, node, "avatar");
                Object icon = node.props().get("icon");
                if (icon instanceof String name) {
                    element.child(ControlRenderers.iconElement(name, null));
                }
                if (node.props().get("label") != null) {
                    element.textChild(String.valueOf(node.props().get("label")));
                }
                if (node.props().get("onDeleted") != null) {
                    HtmlNode delete = new HtmlNode("button")
                            .attr("type", "button")
                            .attr("class", "jhin-chip-delete")
                            .attr("aria-label", "Remove");
                    HtmlRenderer.applyActionAttrs(delete, node.props().get("onDeleted"), null);
                    element.child(delete);
                }
                PropReflection.reflect(node, element, Set.of(
                        "kind", "variant", "selected", "avatar", "icon", "label", "onDeleted"));
            }
        };
    }

    private static NodeRenderer badge() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "span";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                StringBuilder classes = new StringBuilder("jhin-badge");
                if (Boolean.TRUE.equals(node.props().get("dot"))) {
                    classes.append(" jhin-badge-dot");
                }
                element.attr("class", classes.toString());
                if (node.props().get("color") != null) {
                    element.attr("role", "status");
                }
                Object label = node.props().get("label");
                Object count = node.props().get("count");
                if (Boolean.TRUE.equals(node.props().get("dot"))) {
                    // dot mode renders no text
                } else if (count instanceof Number number) {
                    int max = node.props().get("max") instanceof Number maxNumber
                            ? maxNumber.intValue() : 99;
                    int value = number.intValue();
                    element.textChild(value > max ? max + "+" : String.valueOf(value));
                } else if (label != null) {
                    element.textChild(String.valueOf(label));
                }
                PropReflection.reflect(node, element, Set.of("label", "count", "dot"));
            }
        };
    }

    private static NodeRenderer avatar() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return node.props().get("image") != null ? "img" : "span";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-avatar"
                        + ("square".equals(String.valueOf(node.props().get("shape")))
                                ? " jhin-avatar-square" : " jhin-avatar-circle"));
                Object size = node.props().get("size");
                if (size != null) {
                    String px = LayoutRenderers.px(size);
                    element.attr("style", "width: " + px + "; height: " + px);
                }
                if (node.props().get("image") != null) {
                    element.attr("src", String.valueOf(node.props().get("image")));
                    if (node.props().get("initials") != null) {
                        element.attr("alt", String.valueOf(node.props().get("initials")));
                    }
                    PropReflection.reflect(node, element,
                            Set.of("image", "initials", "icon", "shape", "size"));
                    return;
                }
                if (node.props().get("initials") != null) {
                    element.textChild(String.valueOf(node.props().get("initials")));
                } else if (node.props().get("icon") instanceof String name) {
                    element.child(ControlRenderers.iconElement(name, null));
                }
                PropReflection.reflect(node, element,
                        Set.of("image", "initials", "icon", "shape", "size"));
            }
        };
    }

    // --- placeholders / progress / images --------------------------------

    private static NodeRenderer skeleton() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                String variant = node.props().get("variant") == null
                        ? "text" : String.valueOf(node.props().get("variant"));
                element.attr("class", "jhin-skeleton jhin-skeleton-" + variant);
                if (node.props().get("lines") instanceof Number number) {
                    element.attr("data-jhin-lines", String.valueOf(number.intValue()));
                }
                if (!Boolean.TRUE.equals(node.props().get("shimmer"))) {
                    element.attr("data-jhin-shimmer", "false");
                }
                PropReflection.reflect(node, element, Set.of("variant", "lines", "shimmer"));
            }
        };
    }

    private static NodeRenderer progress() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "circular".equals(String.valueOf(node.props().get("kind")))
                        ? "div" : "progress";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-progress");
                Object value = node.props().get("value");
                if ("div".equals(tag(node))) {
                    element.attr("role", "progressbar");
                    if (value instanceof Number number) {
                        element.attr("aria-valuenow", String.valueOf(number));
                    }
                } else if (value instanceof Number number) {
                    element.attr("value", String.valueOf(number));
                    element.attr("max", "1");
                }
                PropReflection.reflect(node, element, Set.of("kind", "value"));
            }
        };
    }

    private static NodeRenderer image() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "img";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-image");
                Object src = node.props().get("src");
                if (src == null) {
                    src = node.props().get("dataUri");
                }
                element.attr("src", src == null ? "" : String.valueOf(src));
                Object alt = node.props().get("semanticsLabel");
                if (alt == null) {
                    alt = node.props().get("label");
                }
                element.attr("alt", alt == null ? "" : String.valueOf(alt));
                if (node.props().get("fit") != null) {
                    // BoxFit.scaleDown folds to its CSS spelling; the other
                    // six literals are their own object-fit values.
                    String fit = String.valueOf(node.props().get("fit"));
                    LayoutRenderers.composeStyle(node, element,
                            "object-fit: " + ("scaleDown".equals(fit) ? "scale-down" : fit));
                }
                PropReflection.reflect(node, element, Set.of("src", "dataUri", "fit", "label"));
            }
        };
    }

    private static NodeRenderer figure() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                Object shape = node.props().get("shape");
                element.attr("class", "jhin-figure"
                        + (shape != null ? " jhin-figure-" + shape : ""));
                StringBuilder extras = new StringBuilder();
                if (node.props().get("width") != null) {
                    LayoutRenderers.appendDecl(extras, "width",
                            LayoutRenderers.px(node.props().get("width")));
                }
                if (node.props().get("height") != null) {
                    LayoutRenderers.appendDecl(extras, "height",
                            LayoutRenderers.px(node.props().get("height")));
                }
                if (node.props().get("color") != null) {
                    LayoutRenderers.appendDecl(extras, "background-color",
                            String.valueOf(node.props().get("color")));
                }
                if ("circle".equals(String.valueOf(shape))) {
                    LayoutRenderers.appendDecl(extras, "border-radius", "50%");
                }
                if (extras.length() > 0) {
                    LayoutRenderers.composeStyle(node, element, extras.toString());
                }
                PropReflection.reflect(node, element, Set.of("shape"));
            }
        };
    }

    private static NodeRenderer hoverCard() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-hover-card");
                if (node.props().get("delay") != null) {
                    element.attr("data-jhin-delay", String.valueOf(node.props().get("delay")));
                }
                if (node.props().get("placement") != null) {
                    element.attr("data-jhin-placement",
                            String.valueOf(node.props().get("placement")));
                }
                HtmlRenderer.appendProp(element, node, "trigger");
                HtmlRenderer.appendProp(element, node, "content");
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element,
                        Set.of("trigger", "content", "delay", "placement"));
            }
        };
    }

    private static NodeRenderer toastStack() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "div";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                element.attr("class", "jhin-toast-stack");
                element.attr("role", "status");
                if (node.props().get("direction") != null) {
                    element.attr("data-jhin-direction",
                            String.valueOf(node.props().get("direction")));
                }
                if (node.props().get("items") instanceof List<?> items) {
                    for (Object item : items) {
                        appendToast(element, item);
                    }
                }
                HtmlRenderer.appendChildren(element, node);
                PropReflection.reflect(node, element, Set.of("items", "direction"));
            }
        };
    }

    /** One {@code toast_stack} item ({@code text, style?, action?, duration?}). */
    private static void appendToast(HtmlNode parent, Object item) {
        if (!(item instanceof Map<?, ?> map)) {
            HtmlRenderer.appendContent(parent, item);
            return;
        }
        HtmlNode toast = new HtmlNode("div")
                .attr("class", "jhin-toast"
                        + (map.get("style") != null ? " jhin-toast-" + map.get("style") : ""))
                .attr("role", "status");
        if (map.get("duration") != null) {
            toast.attr("data-jhin-duration", String.valueOf(map.get("duration")));
        }
        if (map.get("text") != null) {
            toast.textChild(String.valueOf(map.get("text")));
        }
        if (map.get("action") != null) {
            HtmlNode button = new HtmlNode("button")
                    .attr("type", "button")
                    .attr("class", "jhin-toast-action");
            HtmlRenderer.applyActionAttrs(button, map.get("action"), map.get("confirm"));
            toast.child(button);
        }
        PropReflection.reflect(map, toast, TOAST_ITEM_HANDLED);
        parent.child(toast);
    }
}