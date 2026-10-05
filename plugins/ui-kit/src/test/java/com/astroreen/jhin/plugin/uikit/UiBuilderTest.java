/**
 * The {@link Ui} fluent builder: every primitive of the catalog produces its
 * type with the documented props, and a composed tree serializes to the
 * expected JSON wire shape.
 */
package com.astroreen.jhin.plugin.uikit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.sdk.json.Json;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class UiBuilderTest {

    @Test
    void everyPrimitiveBuildsItsCatalogType() {
        assertThat(Ui.screen().title("t").body(Ui.text("b").build()).build().type()).isEqualTo("screen");
        assertThat(Ui.nav().kind("tabs").item("a", "s1").build().type()).isEqualTo("nav");
        assertThat(Ui.container().direction("row").build().type()).isEqualTo("container");
        assertThat(Ui.card().title("c").build().type()).isEqualTo("card");
        assertThat(Ui.text("x").build().type()).isEqualTo("text");
        assertThat(Ui.markdown("# h").build().type()).isEqualTo("markdown");
        assertThat(Ui.button("Go").build().type()).isEqualTo("button");
        assertThat(Ui.input("i1").build().type()).isEqualTo("input");
        assertThat(Ui.dropdown("d1").item("a", 1).build().type()).isEqualTo("dropdown");
        assertThat(Ui.checkbox("c1", "Label").build().type()).isEqualTo("checkbox");
        assertThat(Ui.toggle("s1", "Label").build().type()).isEqualTo("switch");
        assertThat(Ui.slider("r1", 0, 10).build().type()).isEqualTo("slider");
        assertThat(Ui.form().field(Ui.input("a").build()).submit("Send", Map.of("name", "send")).build().type())
                .isEqualTo("form");
        assertThat(Ui.list().item("row").build().type()).isEqualTo("list");
        assertThat(Ui.streamView("v1", "/ui/stream/session/s1").build().type()).isEqualTo("stream_view");
        assertThat(Ui.table().column("A").row("1").build().type()).isEqualTo("table");
        assertThat(Ui.divider().build().type()).isEqualTo("divider");
        assertThat(Ui.spacer().size(8).build().type()).isEqualTo("spacer");
        assertThat(Ui.progress().kind("linear").build().type()).isEqualTo("progress");
        assertThat(Ui.image().src("https://example.invalid/i.png").build().type()).isEqualTo("image");
        assertThat(Ui.figure().shape("circle").build().type()).isEqualTo("figure");
        assertThat(Ui.chartLine().series(List.of()).build().type()).isEqualTo("chart_line");
        assertThat(Ui.chartBar().items(List.of()).build().type()).isEqualTo("chart_bar");
        assertThat(Ui.chartPie().items(List.of()).build().type()).isEqualTo("chart_pie");
        assertThat(Ui.drawer().title("d").build().type()).isEqualTo("drawer");
    }

    @Test
    void typedSettersLandInTheProps() {
        Map<String, Object> text = Ui.text("Hello").style("h1").bold(true).color("#112233").build().toJson();
        assertThat(text).containsEntry("text", "Hello").containsEntry("style", "h1")
                .containsEntry("bold", true).containsEntry("color", "#112233");

        Map<String, Object> input = Ui.input("code").label("Code").value("v").placeholder("p")
                .multiline(true).obscure(false).keyboard("number").required(true)
                .min(1).max(9).pattern("[0-9]+").errorText("bad").build().toJson();
        assertThat(input).containsEntry("id", "code").containsEntry("label", "Code")
                .containsEntry("value", "v").containsEntry("placeholder", "p")
                .containsEntry("multiline", true).containsEntry("obscure", false)
                .containsEntry("keyboard", "number").containsEntry("required", true)
                .containsEntry("min", 1).containsEntry("max", 9)
                .containsEntry("pattern", "[0-9]+").containsEntry("errorText", "bad");

        Map<String, Object> stream = Ui.streamView("feed", "/ui/stream/session/s1")
                .mode("append").itemLimit(20).autoScroll(true).empty("quiet").build().toJson();
        assertThat(stream).containsEntry("id", "feed")
                .containsEntry("topic", "/ui/stream/session/s1")
                .containsEntry("mode", "append").containsEntry("itemLimit", 20)
                .containsEntry("autoScroll", true).containsEntry("empty", "quiet");

        Map<String, Object> slider = Ui.slider("r", 0, 100).label("L").step(5).value(30).build().toJson();
        assertThat(slider).containsEntry("min", 0.0).containsEntry("max", 100.0)
                .containsEntry("step", 5.0).containsEntry("value", 30.0);

        Map<String, Object> figure = Ui.figure().shape("rectangle").color("#112233")
                .width(10).height(20).build().toJson();
        assertThat(figure).containsEntry("shape", "rectangle").containsEntry("color", "#112233")
                .containsEntry("width", 10).containsEntry("height", 20);
    }

    @Test
    void navFormListAndTableWireShapes() {
        Map<String, Object> nav = Ui.nav().kind("drawer").item("Home", "home", "sessions")
                .build().toJson();
        List<Object> items = castList(nav.get("items"));
        assertThat(castMap(items.get(0)))
                .containsEntry("label", "Home").containsEntry("icon", "home")
                .containsEntry("screen", "sessions");

        Map<String, Object> form = Ui.form()
                .field(Ui.input("code").build())
                .submit("Enroll", Map.of("name", "enroll"))
                .build().toJson();
        assertThat(castMap(form.get("submit")))
                .containsEntry("label", "Enroll");
        assertThat(castList(form.get("fields"))).hasSize(1);

        Map<String, Object> table = Ui.table().column("Name", 2).column("Path")
                .row("a", Ui.text("b").build()).build().toJson();
        List<Object> columns = castList(table.get("columns"));
        assertThat(castMap(columns.get(0))).containsEntry("label", "Name").containsEntry("width", 2);
        assertThat(castMap(columns.get(1))).containsOnlyKeys("label");
        List<Object> rows = castList(table.get("rows"));
        assertThat(castList(rows.get(0))).hasSize(2);
    }

    @Test
    void composedTreeSerializesToTheExpectedJson() {
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("name", "enroll");
        action.put("method", "POST");
        UiNode tree = Ui.screen()
                .title("Connect")
                .body(Ui.container()
                        .direction("column")
                        .gap(8)
                        .child(Ui.text("Sign in").style("h2").build())
                        .child("string child")
                        .child(Ui.button("Enroll").style("primary")
                                .action(action)
                                .build())
                        .build())
                .build();

        String expected = "{\"type\":\"screen\",\"title\":\"Connect\",\"body\":"
                + "{\"type\":\"container\",\"direction\":\"column\",\"gap\":8,\"children\":"
                + "[{\"type\":\"text\",\"text\":\"Sign in\",\"style\":\"h2\"},"
                + "\"string child\","
                + "{\"type\":\"button\",\"label\":\"Enroll\",\"style\":\"primary\","
                + "\"action\":{\"name\":\"enroll\",\"method\":\"POST\"}}]}}";

        assertThat(Json.write(tree.toJson())).isEqualTo(expected);
    }

    @Test
    void stringChildIsAllowedEverywhereChildrenAre() {
        UiNode card = Ui.card().title("t").child("only text").build();
        assertThat(card.children()).containsExactly("only text");
        assertThat(castList(card.toJson().get("children"))).containsExactly("only text");
    }

    /** T90: the level-3 {@code split} builder lands its documented prop keys. */
    @Test
    void splitWireShapeCarriesTheResizablePaneProps() {
        Map<String, Object> split = Ui.split()
                .first(Ui.text("First").build())
                .second(Ui.text("Second").build())
                .axis("horizontal")
                .initial(256)
                .min(208)
                .max(640)
                .minSecond(640)
                .persistKey("chat_thread_sidebar_width")
                .handleStyle("rail")
                .build().toJson();
        assertThat(split).containsEntry("type", "split")
                .containsEntry("axis", "horizontal")
                .containsEntry("initial", 256)
                .containsEntry("min", 208)
                .containsEntry("max", 640)
                .containsEntry("minSecond", 640)
                .containsEntry("persistKey", "chat_thread_sidebar_width")
                .containsEntry("handleStyle", "rail");
        assertThat(split).containsKey("first").containsKey("second");
    }

    /** T90: unknown split enum literals throw at build time (a builder bug). */
    @Test
    void splitRejectsUnknownEnumLiterals() {
        assertThatThrownBy(() -> Ui.split().axis("diagonal"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown axis literal");
        assertThatThrownBy(() -> Ui.split().handleStyle("wire"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown handleStyle literal");
    }

    /** T91: the level-3 {@code hover_card} builder lands its documented prop keys. */
    @Test
    void hoverCardWireShapeCarriesTheCardProps() {
        Map<String, Object> card = Ui.hoverCard()
                .id("probe-hover-card")
                .trigger(Ui.text("Hover trigger").build())
                .content(Ui.text("Hover content").build())
                .delay(500)
                .placement("top")
                .build().toJson();
        assertThat(card).containsEntry("type", "hover_card")
                .containsEntry("id", "probe-hover-card")
                .containsEntry("delay", 500)
                .containsEntry("placement", "top");
        assertThat(card).containsKey("trigger").containsKey("content");
        // The string shorthands promote to the same wire keys.
        Map<String, Object> shorthand = Ui.hoverCard()
                .trigger("Hover trigger").content("Hover content").build().toJson();
        assertThat(shorthand).containsEntry("trigger", "Hover trigger")
                .containsEntry("content", "Hover content");
    }

    /** T91: unknown hover_card enum literals throw at build time (a builder bug). */
    @Test
    void hoverCardRejectsUnknownEnumLiterals() {
        assertThatThrownBy(() -> Ui.hoverCard().placement("diagonal"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown placement literal");
    }

    /** T91: the level-3 {@code kbd} builder lands its chord. */
    @Test
    void kbdWireShapeCarriesTheChord() {
        Map<String, Object> kbd = Ui.kbd().id("probe-kbd").chord("mod+shift+m").build().toJson();
        assertThat(kbd).containsEntry("type", "kbd")
                .containsEntry("id", "probe-kbd")
                .containsEntry("chord", "mod+shift+m");
    }

    /** T91: the level-3 {@code toast_stack} builder lands its items and direction. */
    @Test
    void toastStackWireShapeCarriesTheItems() {
        Map<String, Object> stack = Ui.toastStack()
                .id("probe-toast-stack")
                .direction("bottom")
                .item(Ui.toastItem("Saved").style("success").duration(5000).build())
                .item("Deleted")
                .item(Ui.toastItem("Undone").action(Map.of("op", "setState", "id", "x", "value", true)))
                .build().toJson();
        assertThat(stack).containsEntry("type", "toast_stack")
                .containsEntry("id", "probe-toast-stack")
                .containsEntry("direction", "bottom");
        assertThat(castList(stack.get("items"))).hasSize(3);
        assertThat(castMap(castList(stack.get("items")).get(0)))
                .containsEntry("text", "Saved").containsEntry("style", "success")
                .containsEntry("duration", 5000);
        assertThat(castMap(castList(stack.get("items")).get(1))).containsEntry("text", "Deleted");
        assertThat(castMap(castList(stack.get("items")).get(2))).containsKey("action");
    }

    /** T91: unknown toast_stack enum literals throw at build time (a builder bug). */
    @Test
    void toastStackRejectsUnknownEnumLiterals() {
        assertThatThrownBy(() -> Ui.toastStack().direction("left"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown direction literal");
        assertThatThrownBy(() -> Ui.toastItem("x").style("info"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unknown style literal");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}
