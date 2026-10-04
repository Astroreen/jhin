/**
 * Enum validation in the setters: every literal docs/sdui.md documents is
 * accepted, and an unknown literal throws {@link IllegalArgumentException} at
 * build time — the one place the builder is allowed to throw (plan section
 * 5). Token-reference-typed string setters ({@code borderRadius}, {@code
 * shadow}) reject non-token strings the same way.
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class UiEnumValidationTest {

    // --- Box group ---

    @Test
    void clipAcceptsEveryDocumentedLiteralAndRejectsUnknown() {
        for (String literal : List.of("none", "hardEdge", "softEdge", "antiAlias", "antiAliasWithSaveLayer")) {
            assertThatCode(() -> Ui.container().clip(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.container().clipBehavior(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().clip("nope")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.container().clipBehavior("nope")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void borderStyleAcceptsSolidAndNoneOnly() {
        assertThatCode(() -> Ui.container().borderStyle("solid")).doesNotThrowAnyException();
        assertThatCode(() -> Ui.container().borderStyle("none")).doesNotThrowAnyException();
        assertThatThrownBy(() -> Ui.container().borderStyle("dashed")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void alignAcceptsEveryAlignmentLiteralAndRejectsUnknown() {
        for (String literal : List.of(
                "topLeft", "topCenter", "topRight",
                "centerLeft", "center", "centerRight",
                "bottomLeft", "bottomCenter", "bottomRight")) {
            assertThatCode(() -> Ui.container().align(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().align("middle")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void borderRadiusAcceptsNumbersAndTokenReferencesOnly() {
        assertThatCode(() -> Ui.container().borderRadius(14)).doesNotThrowAnyException();
        assertThatCode(() -> Ui.container().borderRadius("$radius.lg")).doesNotThrowAnyException();
        assertThatThrownBy(() -> Ui.container().borderRadius("nope")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void shadowAcceptsSpecMapsAndTokenReferencesOnly() {
        assertThatCode(() -> Ui.container().shadow(UiTokens.shadow("$color.shadow", 12, 0, 0, 4)))
                .doesNotThrowAnyException();
        assertThatCode(() -> Ui.container().shadow("$color.shadow")).doesNotThrowAnyException();
        assertThatThrownBy(() -> Ui.container().shadow("nope")).isInstanceOf(IllegalArgumentException.class);
    }

    // --- Text group ---

    @Test
    void fontStyleTextAlignDecorationAndOverflowValidateTheirLiterals() {
        for (String literal : List.of("normal", "italic")) {
            assertThatCode(() -> Ui.text("x").fontStyle(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.text("x").fontStyle("bold")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("left", "right", "center", "justify", "start", "end")) {
            assertThatCode(() -> Ui.text("x").textAlign(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.text("x").textAlign("nope")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("none", "underline", "overline", "lineThrough")) {
            assertThatCode(() -> Ui.text("x").textDecoration(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.text("x").textDecoration("strike"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("clip", "fade", "ellipsis", "visible")) {
            assertThatCode(() -> Ui.text("x").textOverflow(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.text("x").textOverflow("nope")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void textStyleTokenAcceptsTheDocumentedTypographyTokens() {
        for (String literal : List.of("h1", "h2", "h3", "body", "small", "caption", "mono")) {
            assertThatCode(() -> Ui.text("x").style(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.text("x").style("headline")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void textWidthBasisValidatesItsLiterals() {
        for (String literal : List.of("parent", "longestLine", "character")) {
            assertThatCode(() -> Ui.text("x").textWidthBasis(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.text("x").textWidthBasis("nope")).isInstanceOf(IllegalArgumentException.class);
    }

    // --- T60 text set ---

    @Test
    void richTextSpanStyleValidatesTheTypographyTokens() {
        for (String literal : List.of("h1", "h2", "h3", "body", "small", "caption", "mono")) {
            assertThatCode(() -> Ui.span("x").style(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.span("x").style("headline")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void spanTextStyleMapsStayPassthrough() {
        Map<String, Object> style = Map.of("fontWeight", 700);
        assertThatCode(() -> Ui.richText().span(Ui.span("x").style(style).build()))
                .doesNotThrowAnyException();
    }

    // --- Flex group ---

    @Test
    void flexEnumsValidateTheirLiterals() {
        for (String literal : List.of("loose", "tight")) {
            assertThatCode(() -> Ui.container().fit(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().fit("expand")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("min", "max")) {
            assertThatCode(() -> Ui.container().mainAxisSize(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().mainAxisSize("nope")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("start", "end", "center", "spaceBetween", "spaceAround", "spaceEvenly")) {
            assertThatCode(() -> Ui.container().mainAxisAlignment(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().mainAxisAlignment("nope"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("start", "end", "center", "stretch", "baseline")) {
            assertThatCode(() -> Ui.container().crossAxisAlignment(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().crossAxisAlignment("nope"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("row", "column")) {
            assertThatCode(() -> Ui.container().direction(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().direction("grid")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("ltr", "rtl")) {
            assertThatCode(() -> Ui.container().textDirection(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().textDirection("nope")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("up", "down")) {
            assertThatCode(() -> Ui.container().verticalDirection(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().verticalDirection("nope"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("alphabetic", "ideographic")) {
            assertThatCode(() -> Ui.container().textBaseline(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().textBaseline("nope")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("visible", "clip", "fade", "ellipsis")) {
            assertThatCode(() -> Ui.container().overflow(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().overflow("nope")).isInstanceOf(IllegalArgumentException.class);
    }

    // --- Interaction group ---

    @Test
    void cursorAcceptsEveryDocumentedLiteralAndRejectsUnknown() {
        for (String literal : List.of(
                "system", "none", "click", "text", "forbidden", "grab", "grabbing", "wait", "precise",
                "allScroll", "resizeUpDown", "resizeLeftRight", "alias", "cell", "contextMenu", "copy",
                "help", "move", "noDrop", "progress", "zoomIn", "zoomOut")) {
            assertThatCode(() -> Ui.container().cursor(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.container().cursor("pointer")).isInstanceOf(IllegalArgumentException.class);
    }

    // --- Per-primitive enums ---

    @Test
    void perPrimitiveEnumsValidateTheirLiterals() {
        for (String literal : List.of("primary", "secondary", "danger", "text")) {
            assertThatCode(() -> Ui.button("b").style(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.button("b").style("nope")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("linear", "circular")) {
            assertThatCode(() -> Ui.progress().kind(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.progress().kind("nope")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("append", "replace")) {
            assertThatCode(() -> Ui.streamView("v", "/t").mode(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.streamView("v", "/t").mode("nope"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("cover", "contain", "fill", "fitWidth", "fitHeight", "none", "scaleDown")) {
            assertThatCode(() -> Ui.image().fit(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.image().fit("nope")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("rectangle", "circle", "triangle")) {
            assertThatCode(() -> Ui.figure().shape(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.figure().shape("square")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("tabs", "bottom", "drawer", "rail", "sidebar")) {
            assertThatCode(() -> Ui.nav().kind(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.nav().kind("menu")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("vertical", "horizontal")) {
            assertThatCode(() -> Ui.spacer().axis(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.spacer().axis("diagonal")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("disabled", "always", "onUserInteraction")) {
            assertThatCode(() -> Ui.form().autovalidateMode(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.form().autovalidateMode("nope")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void inputEnumsValidateTheirLiterals() {
        for (String literal : List.of("text", "number", "phone", "email", "url", "visiblePassword", "multiline")) {
            assertThatCode(() -> Ui.input("i").keyboardType(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.input("i").keyboard(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.input("i").keyboardType("nope")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.input("i").keyboard("nope")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("done", "go", "next", "previous", "search", "send", "newline")) {
            assertThatCode(() -> Ui.input("i").textInputAction(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.input("i").textInputAction("nope")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("none", "words", "sentences", "characters")) {
            assertThatCode(() -> Ui.input("i").textCapitalization(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.input("i").textCapitalization("nope"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("none", "enforced", "truncateAfterCompositionEnds")) {
            assertThatCode(() -> Ui.input("i").maxLengthEnforcement(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.input("i").maxLengthEnforcement("nope"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("underline", "outline", "none")) {
            assertThatCode(() -> Ui.input("i").border(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.input("i").enabledBorder(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.input("i").focusedBorder(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.input("i").errorBorder(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.input("i").focusedErrorBorder(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.input("i").disabledBorder(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.textarea("t").border(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.input("i").border("dashed")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.textarea("t").disabledBorder("dashed")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("never", "always", "auto")) {
            assertThatCode(() -> Ui.input("i").floatingLabelBehavior(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.input("i").floatingLabelBehavior("sometimes"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("left", "right", "center", "justify", "start", "end")) {
            assertThatCode(() -> Ui.input("i").textAlign(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.table().column("C", 1, true, literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.input("i").textAlign("sideways")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.table().column("C", 1, true, "sideways"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("ltr", "rtl")) {
            assertThatCode(() -> Ui.input("i").textDirection(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.input("i").textDirection("upsideDown"))
                .isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of(
                "system", "none", "click", "text", "forbidden", "grab", "grabbing", "wait", "precise",
                "allScroll", "resizeUpDown", "resizeLeftRight", "alias", "cell", "contextMenu", "copy",
                "help", "move", "noDrop", "progress", "zoomIn", "zoomOut")) {
            assertThatCode(() -> Ui.input("i").mouseCursor(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.input("i").mouseCursor("pointer")).isInstanceOf(IllegalArgumentException.class);
    }

    // --- T59 layout enums ---

    @Test
    void stackFitValidatesItsLiterals() {
        for (String literal : List.of("loose", "passthrough", "expand")) {
            assertThatCode(() -> Ui.stack().fit(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.stack().fit("nope")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.stack().fit("tight")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void wrapEnumsValidateTheirLiterals() {
        for (String literal : List.of("horizontal", "vertical")) {
            assertThatCode(() -> Ui.wrap().direction(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.wrap().direction("row")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly")) {
            assertThatCode(() -> Ui.wrap().alignment(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.wrap().runAlignment(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.wrap().crossAxisAlignment(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.wrap().alignment("nope")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.wrap().runAlignment("middle")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.wrap().crossAxisAlignment("baseline")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void physicsValidatesItsLiteralsOnGridAndScroll() {
        for (String literal : List.of("neverScrollable", "alwaysScrollable", "bouncing", "clamping")) {
            assertThatCode(() -> Ui.grid().physics(literal)).doesNotThrowAnyException();
            assertThatCode(() -> Ui.scroll().physics(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.grid().physics("nope")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.scroll().physics("nope")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void scrollDirectionValidatesItsLiterals() {
        for (String literal : List.of("vertical", "horizontal")) {
            assertThatCode(() -> Ui.scroll().scrollDirection(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.scroll().scrollDirection("diagonal")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void iconBlendModeValidatesItsLiterals() {
        for (String literal : List.of("clear", "srcOver", "multiply", "luminosity")) {
            assertThatCode(() -> Ui.icon().blendMode(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.icon().blendMode("nope")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.icon().blendMode("srcOver ")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void iconButtonVisualDensityAndAlignmentValidateTheirLiterals() {
        for (String literal : List.of("compact", "comfortable", "spacious")) {
            assertThatCode(() -> Ui.iconButton().visualDensity(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.iconButton().visualDensity("nope")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.iconButton().visualDensity("standard")).isInstanceOf(IllegalArgumentException.class);

        for (String literal : List.of("topLeft", "center", "bottomRight")) {
            assertThatCode(() -> Ui.iconButton().alignment(literal)).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> Ui.iconButton().alignment("middle")).isInstanceOf(IllegalArgumentException.class);
    }

    // --- Token helpers ---

    @Test
    void gradientHelperValidatesTheGradientType() {
        for (String type : List.of("linear", "radial", "sweep")) {
            assertThatCode(() -> UiTokens.gradient(type, List.of("$color.accent"), null, "topLeft", "bottomRight"))
                    .doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> UiTokens.gradient(
                "nope", List.of("$color.accent"), null, "topLeft", "bottomRight"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void nullEnumLiteralsThrowToo() {
        assertThatThrownBy(() -> Ui.container().clip(null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.container().direction(null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Ui.nav().kind(null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void unknownLiteralMessageNamesThePropAndTheAcceptedLiterals() {
        assertThatThrownBy(() -> Ui.container().direction("grid"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("direction")
                .hasMessageContaining("row")
                .hasMessageContaining("column");
    }

    @Test
    void mapValuedActionPropsStayPassthrough() {
        // action/onTap are action objects, not enums: any map passes through.
        Map<String, Object> action = Map.of("name", "x");
        assertThatCode(() -> Ui.container().action(action).onTap(action).onLongPress(action))
                .doesNotThrowAnyException();
    }
}
