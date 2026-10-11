/**
 * {@link UniversalProps}: the universal-prop surface of docs/sdui.md
 * section 2.1 applied to one element in the fixed application order of
 * section 2.3. The order is normative — the {@code style} declaration order
 * test pins the whole sequence — and every group has a mapping test, plus
 * the meta protocol ({@code visible}, {@code when}, {@code id}, templates),
 * token-reference resolution and escaping.
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class UniversalPropsTest {

    // --- application order (section 2.3, normative) -----------------------

    @Test
    void styleDeclarationsFollowTheSpecApplicationOrder() {
        Map<String, Object> props = new LinkedHashMap<>();
        // Prop map order is deliberately the reverse of the application
        // order: the emitter must apply the steps, not the map.
        props.put("margin", 4);
        props.put("fit", "tight");
        props.put("flex", 2);
        props.put("enabled", false);
        props.put("semanticsLabel", "label");
        props.put("focusable", true);
        props.put("cursor", "click");
        props.put("tooltip", "tip");
        props.put("align", "topLeft");
        props.put("clip", "hardEdge");
        props.put("transform", Map.of("translate", List.of(1, 2)));
        props.put("opacity", 0.5);
        props.put("aspectRatio", 1.5);
        props.put("width", 50);
        props.put("height", 60);
        props.put("minWidth", 10);
        props.put("maxWidth", 20);
        props.put("minHeight", 30);
        props.put("maxHeight", 40);
        props.put("padding", 8);
        props.put("shadow", Map.of("color", "#000000", "blur", 4, "spread", 0,
                "offset", List.of(0, 2)));
        props.put("borderRadius", 8);
        props.put("borderWidth", 2);
        props.put("border", "#abc");
        props.put("gradient", Map.of("type", "linear", "begin", "topLeft", "end", "bottomRight",
                "colors", List.of("#ff0000", "#00ff00")));
        props.put("color", "#112233");

        HtmlNode element = new HtmlNode("div");
        UniversalProps.apply(new UiNode("box", props, List.of()), element);

        assertThat(styleProperties(element)).containsExactly(
                "background-color",
                "background-image",
                "border",
                "border-radius",
                "box-shadow",
                "padding",
                "min-width",
                "max-width",
                "min-height",
                "max-height",
                "width",
                "height",
                "aspect-ratio",
                "opacity",
                "transform",
                "overflow",
                "justify-self",
                "align-self",
                "cursor",
                "flex-grow",
                "flex",
                "margin");
    }

    // --- group mappings ---------------------------------------------------

    @Test
    void decorationMapsToBoxCss() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("color", "#112233");
        props.put("gradient", Map.of("type", "linear", "begin", "topLeft", "end", "bottomRight",
                "colors", List.of("#ff0000", "#00ff00")));
        props.put("border", "#abc");
        props.put("borderWidth", 2);
        props.put("borderRadius", 8);
        props.put("shadow", Map.of("color", "#000000", "blur", 4, "spread", 0,
                "offset", List.of(0, 2)));

        assertThat(UniversalProps.styleOf(new UiNode("box", props, List.of()))).isEqualTo(
                "background-color: #112233"
                        + "; background-image: linear-gradient(135deg, #ff0000, #00ff00)"
                        + "; border: 2px solid #abc"
                        + "; border-radius: 8px"
                        + "; box-shadow: 0px 2px 4px 0px #000000");
    }

    @Test
    void textBearingColorIsForegroundAndHeightIsLineHeight() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("color", "#112233");
        props.put("height", 1.5);
        props.put("fontFamily", "monospace");
        props.put("fontSize", 14);
        props.put("fontWeight", 700);
        props.put("textDecoration", "lineThrough");

        String style = UniversalProps.styleOf(new UiNode("text", props, List.of()));
        assertThat(style).isEqualTo(
                "color: #112233"
                        + "; font-family: monospace"
                        + "; font-size: 14px"
                        + "; font-weight: 700"
                        + "; line-height: 1.5"
                        + "; text-decoration: line-through");
        assertThat(stylePropertyNames(style))
                .as("text-bearing height is the line-height multiple, never a box constraint")
                .doesNotContain("height");
    }

    @Test
    void paddingShapesMapToTheCssShorthand() {
        assertThat(padding(8)).isEqualTo("padding: 8px");
        assertThat(padding(List.of(8, 16))).isEqualTo("padding: 8px 16px");
        assertThat(padding(List.of(1, 2, 3))).isEqualTo("padding: 1px 2px 3px");
        assertThat(padding(List.of(1, 2, 3, 4))).isEqualTo("padding: 1px 2px 3px 4px");
        assertThat(padding(Map.of("top", 1, "right", 2, "bottom", 3, "left", 4)))
                .isEqualTo("padding: 1px 2px 3px 4px");
        assertThat(padding("$space.control")).isEqualTo("padding: var(--space-control)");
        assertThat(padding(List.of(8, "$space.control"))).isEqualTo("padding: 8px var(--space-control)");
    }

    @Test
    void constraintsEmitMinMaxThenWidthHeight() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("width", 50);
        props.put("height", 60);
        props.put("minWidth", 10);
        props.put("maxWidth", 20);
        props.put("minHeight", 30);
        props.put("maxHeight", 40);

        assertThat(UniversalProps.styleOf(new UiNode("box", props, List.of()))).isEqualTo(
                "min-width: 10px; max-width: 20px; min-height: 30px; max-height: 40px"
                        + "; width: 50px; height: 60px");
    }

    @Test
    void aspectRatioEmitsAUnitlessRatio() {
        assertThat(UniversalProps.styleOf(Map.of("aspectRatio", 2)))
                .isEqualTo("aspect-ratio: 2");
        assertThat(UniversalProps.styleOf(Map.of("aspectRatio", -1)))
                .isEmpty();
    }

    @Test
    void opacityEmitsItsNumber() {
        assertThat(UniversalProps.styleOf(Map.of("opacity", 0.5)))
                .isEqualTo("opacity: 0.5");
    }

    @Test
    void transformMapsMatrixAndObjectForms() {
        List<Object> matrix = new ArrayList<>();
        for (int i = 1; i <= 16; i++) {
            matrix.add(i);
        }
        assertThat(UniversalProps.styleOf(Map.of("transform", matrix)))
                .isEqualTo("transform: matrix3d(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)");

        Map<String, Object> parts = new LinkedHashMap<>();
        parts.put("translate", List.of(1, 2));
        parts.put("rotate", 0.5);
        parts.put("scale", List.of(2, 3));
        assertThat(UniversalProps.styleOf(Map.of("transform", parts)))
                .isEqualTo("transform: translate3d(1px, 2px, 0px) rotate(0.5rad) scale(2, 3)");
    }

    @Test
    void clipMapsToOverflow() {
        assertThat(UniversalProps.styleOf(Map.of("clip", "hardEdge")))
                .isEqualTo("overflow: hidden");
        assertThat(UniversalProps.styleOf(Map.of("clip", "none")))
                .isEqualTo("overflow: visible");
        assertThat(UniversalProps.styleOf(Map.of("clipBehavior", "softEdge")))
                .isEqualTo("overflow: hidden");
    }

    @Test
    void alignMapsToSelfAlignment() {
        assertThat(UniversalProps.styleOf(Map.of("align", "topLeft")))
                .isEqualTo("justify-self: start; align-self: start");
        assertThat(UniversalProps.styleOf(Map.of("alignment", "centerRight")))
                .isEqualTo("justify-self: end; align-self: center");
        assertThat(UniversalProps.styleOf(new UiNode("stack",
                Map.of("alignment", "center"), List.of())))
                .as("stack owns its alignment prop (section 2.6)")
                .isEmpty();
    }

    @Test
    void tooltipBecomesTheTitleAttribute() {
        HtmlNode element = new HtmlNode("div");
        UniversalProps.apply(Map.of("tooltip", "Hello"), element);

        assertThat(element.render()).isEqualTo("<div title=\"Hello\"></div>");
    }

    @Test
    void handlersEmitCursorAndTabindex() {
        assertThat(UniversalProps.styleOf(Map.of("cursor", "click")))
                .isEqualTo("cursor: pointer");

        HtmlNode focused = new HtmlNode("div");
        UniversalProps.apply(Map.of("focusable", true), focused);
        assertThat(focused.render()).isEqualTo("<div tabindex=\"0\"></div>");

        HtmlNode unfocused = new HtmlNode("div");
        UniversalProps.apply(Map.of("focusable", false), unfocused);
        assertThat(unfocused.render()).isEqualTo("<div tabindex=\"-1\"></div>");
    }

    @Test
    void ariaMapsTheSemanticsProps() {
        HtmlNode element = new HtmlNode("div");
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("semanticsLabel", "Save");
        props.put("semanticsHint", "Saves the file");
        props.put("semanticsValue", "42");
        props.put("excludeSemantics", true);
        props.put("enabled", false);
        UniversalProps.apply(props, element);

        assertThat(element.render()).isEqualTo(
                "<div aria-label=\"Save\" aria-description=\"Saves the file\""
                        + " aria-valuetext=\"42\" aria-hidden=\"true\""
                        + " aria-disabled=\"true\"></div>");
    }

    @Test
    void flexAndFitMapToFlexGrowAndFlex() {
        assertThat(UniversalProps.styleOf(Map.of("flex", 2)))
                .isEqualTo("flex-grow: 2");
        assertThat(UniversalProps.styleOf(Map.of("fit", "tight")))
                .isEqualTo("flex: 1 1 0%");
        assertThat(UniversalProps.styleOf(Map.of("fit", "loose")))
                .isEqualTo("flex: 0 1 auto");
    }

    @Test
    void marginMapsLikePadding() {
        assertThat(UniversalProps.styleOf(Map.of("margin", 4))).isEqualTo("margin: 4px");
        assertThat(UniversalProps.styleOf(Map.of("margin", List.of(1, 2, 3, 4))))
                .isEqualTo("margin: 1px 2px 3px 4px");
    }

    // --- meta protocol ----------------------------------------------------

    @Test
    void visibleFalseIsQueriedByTheRenderer() {
        assertThat(UniversalProps.isVisible(new UiNode("box",
                Map.of("visible", false), List.of()))).isFalse();
        assertThat(UniversalProps.isVisible(Map.of("visible", "false"))).isFalse();
        assertThat(UniversalProps.isVisible(Map.of("visible", true))).isTrue();
        assertThat(UniversalProps.isVisible(Map.of())).isTrue();
    }

    @Test
    void whenBecomesAnAttributeAndTheNodeStaysVisible() {
        HtmlNode element = new HtmlNode("div");
        UiNode node = new UiNode("box", Map.of("when", "turnRunning == false"), List.of());
        UniversalProps.apply(node, element);

        assertThat(UniversalProps.isVisible(node)).isTrue();
        assertThat(element.render()).isEqualTo("<div data-jhin-when=\"turnRunning == false\"></div>");
    }

    @Test
    void idPropSetsBothIdAndDataJhinId() {
        HtmlNode element = new HtmlNode("div");
        UniversalProps.apply(Map.of("id", "msg-7"), element);

        assertThat(element.render()).isEqualTo("<div id=\"msg-7\" data-jhin-id=\"msg-7\"></div>");
    }

    @Test
    void templatePropsCarryTheirRawTemplate() {
        HtmlNode element = new HtmlNode("div");
        UniversalProps.apply(Map.of("text", "Hello ${name}"), element);

        assertThat(element.render())
                .isEqualTo("<div data-jhin-template=\"Hello ${name}\"></div>");
    }

    // --- token references and escaping -----------------------------------

    @Test
    void tokenReferencesResolveToVarIndirection() {
        assertThat(UniversalProps.styleOf(Map.of("borderRadius", "$radius.lg")))
                .isEqualTo("border-radius: var(--radius-lg)");
        assertThat(UniversalProps.styleOf(Map.of("width", "$layout.sidebarWidth")))
                .isEqualTo("width: var(--layout-sidebar-width)");
        assertThat(UniversalProps.styleOf(Map.of("color", "$color.accent")))
                .as("box color is the background")
                .isEqualTo("background-color: var(--color-accent)");
        assertThat(UniversalProps.styleOf(Map.of("borderRadius", "$bogus.key")))
                .as("unknown references render as the literal string (section 2.4)")
                .isEqualTo("border-radius: $bogus.key");
    }

    @Test
    void attributeValuesAreEscaped() {
        HtmlNode element = new HtmlNode("div");
        UniversalProps.apply(Map.of("tooltip", "\"><script>alert(1)</script>"), element);

        assertThat(element.render()).isEqualTo(
                "<div title=\"&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;\"></div>");
    }

    @Test
    void styleValuesAreEscapedAndCannotSmuggleDeclarations() {
        HtmlNode element = new HtmlNode("div");
        UniversalProps.apply(Map.of("border", "red\"><script>"), element);
        assertThat(element.render()).contains("style=\"border: 1px solid red&quot;&gt;&lt;script&gt;\"");

        HtmlNode smuggled = new HtmlNode("div");
        UniversalProps.apply(Map.of("margin", "1px; background: url(x)"), smuggled);
        assertThat(smuggled.render())
                .as("semicolon in a value is neutralized as a CSS hex escape")
                .contains("margin: 1px\\00003b background: url(x)")
                .doesNotContain("background: url(x);");
    }

    // --- helpers ----------------------------------------------------------

    private static String padding(Object value) {
        return UniversalProps.styleOf(Map.of("padding", value));
    }

    private static List<String> styleProperties(HtmlNode element) {
        String html = element.render();
        int start = html.indexOf("style=\"") + "style=\"".length();
        int end = html.indexOf('"', start);
        return stylePropertyNames(html.substring(start, end));
    }

    private static List<String> stylePropertyNames(String style) {
        List<String> properties = new ArrayList<>();
        for (String declaration : style.split("; ")) {
            properties.add(declaration.substring(0, declaration.indexOf(':')));
        }
        return properties;
    }
}
