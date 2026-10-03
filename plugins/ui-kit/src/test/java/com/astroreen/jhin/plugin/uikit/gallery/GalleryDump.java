/**
 * Fixture generator for the golden gallery harness (T57): builds &gt;=80
 * {@link UiNode} fixtures through the real {@link Ui} builders, covering all
 * 40 current primitives ({@code BuilderProbe.BUILDERS}) with a basic and a
 * prop-heavy variant each, and emits them as a generated Dart list consumed
 * by {@code frontend/test/gallery/golden_test.dart}.
 *
 * <p>Regenerate with:
 * {@code ./gradlew :jhin-plugin-ui-kit:test --tests '*GalleryDump*'}
 * (a plain JUnit test rather than a separate Gradle task, since the probe
 * only needs the test classpath and this keeps the invocation uniform with
 * the rest of the module's tests).
 *
 * <p>Idempotent: the fixture list and the JSON each builder call emits are
 * both deterministic (insertion-ordered maps, no clock/random input), so
 * re-running produces a byte-identical {@code gallery_nodes.dart}.
 */
package com.astroreen.jhin.plugin.uikit.gallery;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;

class GalleryDump {

    /** The actual invocation to regenerate this fixture file — recorded in the header comment. */
    private static final String INVOCATION = "./gradlew :jhin-plugin-ui-kit:test --tests '*GalleryDump*'";

    /** frontend/test/gallery/gallery_nodes.dart, relative to this module's rootDir (plugins/ui-kit). */
    private static final Path DART_OUTPUT =
            Path.of("..", "..", "frontend", "test", "gallery", "gallery_nodes.dart").toAbsolutePath().normalize();

    /** Per-primitive coverage table, read by scripts/qa/t57.sh (build dir — not committed). */
    private static final Path COVERAGE_OUTPUT =
            Path.of("build", "gallery", "coverage.txt").toAbsolutePath().normalize();

    /** The 40 current primitives (the 25 of T57, the T58 layout set and the T59 stack/wrap/grid/scroll set). */
    private static final List<String> EXPECTED_PRIMITIVES = List.of(
            "screen", "nav", "container", "card", "text", "markdown", "button", "input",
            "dropdown", "checkbox", "switch", "slider", "form", "list", "stream_view",
            "table", "divider", "spacer", "progress", "image", "figure", "chart_line",
            "chart_bar", "chart_pie", "drawer",
            "box", "row", "column", "flex", "expanded", "flexible", "sized_box",
            "align", "center", "aspect_ratio",
            "stack", "positioned", "wrap", "grid", "scroll");

    private static Map<String, Object> action(String name) {
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("name", name);
        action.put("method", "POST");
        action.put("path", "/ui/action/" + name);
        return action;
    }

    /**
     * An insertion-ordered map literal for chart series/item entries.
     * {@code Map.of(...)} is deliberately avoided here: its small-map
     * implementation randomizes iteration order per JVM run (hash-flooding
     * mitigation), which would make the generated fixture file byte-different
     * on every re-run and break the idempotency check.
     */
    private static Map<String, Object> entry(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            map.put((String) keyValues[i], keyValues[i + 1]);
        }
        return map;
    }

    /**
     * Applies a representative slice of the universal surface (box/margin/
     * padding/opacity, interaction) to any builder — every builder extends
     * {@link Ui.NodeBuilder}, so this is real, compiled usage of the same
     * setters each primitive already exposes, not a shortcut around them.
     * Uses {@code $spacing}/{@code $color} tokens so the gallery also covers
     * token-string props.
     */
    private static <B extends Ui.NodeBuilder<B>> B heavy(B builder, String idSuffix) {
        return builder
                .id("fixture-" + idSuffix)
                .padding("$spacing.lg")
                .margin("$spacing.md")
                .opacity(0.92)
                .tooltip(idSuffix.replace('-', ' ') + " tooltip")
                .action(action(idSuffix))
                .semanticsLabel(idSuffix.replace('-', ' ') + " label")
                .enabled(true)
                .focusable(true);
    }

    private record Fixture(String id, UiNode node) {
    }

    private static List<Fixture> fixtures() {
        List<Fixture> all = new ArrayList<>();

        // screen
        all.add(new Fixture("fixture-screen-basic", Ui.screen()
                .id("fixture-screen-basic")
                .title("Basic Screen")
                .body(Ui.text("Body").build())
                .build()));
        all.add(new Fixture("fixture-screen-propheavy", heavy(Ui.screen(), "screen-propheavy")
                .visible(true).flex(1).when("true")
                .title("Prop Heavy Screen")
                .appBar(Ui.text("AppBar").build())
                .body(Ui.container()
                        .direction("column").gap(8).align("center").scroll(true)
                        .child(Ui.text("Sign in").style("h2").bold(true).color("$color.accent").build())
                        .child("string child")
                        .build())
                .floatingAction(Ui.button("Go").build())
                .build()));

        // nav
        all.add(new Fixture("fixture-nav-basic", Ui.nav()
                .id("fixture-nav-basic")
                .kind("drawer")
                .item("Home", "home", "sessions")
                .item("Settings", "settings")
                .build()));
        all.add(new Fixture("fixture-nav-propheavy", heavy(Ui.nav(), "nav-propheavy")
                .kind("bottom")
                .item("Home", "home", "sessions")
                .item("Chat", "chat")
                .build()));

        // container
        all.add(new Fixture("fixture-container-basic", Ui.container()
                .id("fixture-container-basic")
                .direction("row")
                .child(Ui.text("A").build())
                .child(Ui.text("B").build())
                .build()));
        all.add(new Fixture("fixture-container-propheavy", heavy(Ui.container(), "container-propheavy")
                .direction("column").gap(8).spacing(4)
                .mainAxisAlignment("spaceBetween").crossAxisAlignment("center")
                .mainAxisSize("max").textDirection("ltr").verticalDirection("down")
                .overflow("clip").clipBehavior("antiAlias")
                .color("$color.surface").border("$color.outline").borderWidth(2)
                .borderStyle("solid").borderRadius("$radius.md")
                .align("center")
                .child(Ui.text("Inside").build())
                .child("raw string child")
                .build()));

        // card
        all.add(new Fixture("fixture-card-basic", Ui.card()
                .id("fixture-card-basic")
                .title("Card").child(Ui.text("inside").build()).child("raw").build()));
        all.add(new Fixture("fixture-card-propheavy", heavy(Ui.card(), "card-propheavy")
                .title("Prop Heavy Card")
                .color("$color.surface").borderRadius("$radius.lg")
                .child(Ui.text("Card body").build())
                .build()));

        // text
        all.add(new Fixture("fixture-text-basic", Ui.text("Hello")
                .id("fixture-text-basic")
                .style("h1").bold(true).color("#AABBCC").color(0x112233)
                .build()));
        all.add(new Fixture("fixture-text-propheavy", heavy(Ui.text("Prop heavy text"), "text-propheavy")
                .style("body").bold(true).italic(true)
                .fontSize(18).fontWeight(600).letterSpacing(0.5).wordSpacing(1.0)
                .textAlign("center").textDecoration("underline").textOverflow("ellipsis")
                .maxLines(2).softWrap(true)
                .build()));

        // markdown
        all.add(new Fixture("fixture-markdown-basic", Ui.markdown("# Heading\n\nbody")
                .id("fixture-markdown-basic")
                .build()));
        all.add(new Fixture("fixture-markdown-propheavy", heavy(
                Ui.markdown("# Prop Heavy\n\n- one\n- two\n\nSome **bold** text."), "markdown-propheavy")
                .build()));

        // button
        all.add(new Fixture("fixture-button-basic", Ui.button("Enroll")
                .id("fixture-button-basic")
                .style("primary")
                .action(action("enroll"))
                .icon("check")
                .confirm("Sure?")
                .build()));
        all.add(new Fixture("fixture-button-propheavy", heavy(Ui.button("Prop Heavy Button"), "button-propheavy")
                .style("danger")
                .icon("delete")
                .confirm("Really sure?")
                .fontSize(16)
                .build()));

        // input
        all.add(new Fixture("fixture-input-basic", Ui.input("code")
                .id("fixture-input-basic")
                .label("Code").value("v").placeholder("p")
                .multiline(true).obscure(false).keyboard("number").required(true)
                .min(1).max(9).pattern("[0-9]+").errorText("bad")
                .build()));
        all.add(new Fixture("fixture-input-propheavy", heavy(Ui.input("propheavy"), "input-propheavy")
                .label("Prop Heavy Input").value("v2").placeholder("placeholder")
                .keyboard("email").required(false)
                .build()));

        // dropdown
        all.add(new Fixture("fixture-dropdown-basic", Ui.dropdown("d1")
                .id("fixture-dropdown-basic")
                .item("a", 1)
                .item("b", "two")
                .value(1)
                .action(action("pick"))
                .build()));
        all.add(new Fixture("fixture-dropdown-propheavy", heavy(Ui.dropdown("d2"), "dropdown-propheavy")
                .item("x", 1)
                .item("y", 2)
                .item("z", 3)
                .value(2)
                .build()));

        // checkbox
        all.add(new Fixture("fixture-checkbox-basic", Ui.checkbox("c1", "Label")
                .id("fixture-checkbox-basic")
                .value(true).build()));
        all.add(new Fixture("fixture-checkbox-propheavy", heavy(
                Ui.checkbox("c2", "Prop Heavy Checkbox"), "checkbox-propheavy")
                .value(false).build()));

        // switch (toggle)
        all.add(new Fixture("fixture-switch-basic", Ui.toggle("s1", "Label")
                .id("fixture-switch-basic")
                .value(false).build()));
        all.add(new Fixture("fixture-switch-propheavy", heavy(
                Ui.toggle("s2", "Prop Heavy Switch"), "switch-propheavy")
                .value(true).build()));

        // slider
        all.add(new Fixture("fixture-slider-basic", Ui.slider("r1", 0, 10)
                .id("fixture-slider-basic")
                .label("L").step(2).value(6).build()));
        all.add(new Fixture("fixture-slider-propheavy", heavy(Ui.slider("r2", 0, 100), "slider-propheavy")
                .label("Prop Heavy Slider").step(5).value(50).build()));

        // form
        all.add(new Fixture("fixture-form-basic", Ui.form()
                .id("fixture-form-basic")
                .field(Ui.input("a").label("A").build())
                .field("shorthand field")
                .submit("Send", action("send"))
                .build()));
        all.add(new Fixture("fixture-form-propheavy", heavy(Ui.form(), "form-propheavy")
                .field(Ui.input("b").label("B").build())
                .field(Ui.checkbox("c", "Agree").build())
                .submit("Submit", action("submit-heavy"))
                .build()));

        // list
        all.add(new Fixture("fixture-list-basic", Ui.list()
                .id("fixture-list-basic")
                .item(Ui.text("one").build())
                .item("two")
                .maxHeight(240)
                .build()));
        all.add(new Fixture("fixture-list-propheavy", heavy(Ui.list(), "list-propheavy")
                .item(Ui.text("alpha").build())
                .item(Ui.text("beta").build())
                .item("gamma")
                .maxHeight(320)
                .build()));

        // stream_view
        all.add(new Fixture("fixture-stream_view-basic", Ui.streamView("feed", "/ui/stream/session/s1")
                .id("fixture-stream_view-basic")
                .mode("append").itemLimit(20).autoScroll(true).empty("quiet")
                .build()));
        all.add(new Fixture("fixture-stream_view-propheavy", heavy(
                Ui.streamView("feed2", "/ui/stream/session/s2"), "stream_view-propheavy")
                .mode("replace").itemLimit(50).autoScroll(false).empty("nothing yet")
                .build()));

        // table
        all.add(new Fixture("fixture-table-basic", Ui.table()
                .id("fixture-table-basic")
                .column("Name", 2).column("Path")
                .row("a", Ui.text("b").build())
                .row("c")
                .build()));
        all.add(new Fixture("fixture-table-propheavy", heavy(Ui.table(), "table-propheavy")
                .column("Col A", 1).column("Col B", 2).column("Col C")
                .row("1", "2", "3")
                .row(Ui.text("x").build(), "y", "z")
                .build()));

        // divider
        all.add(new Fixture("fixture-divider-basic", Ui.divider()
                .id("fixture-divider-basic")
                .build()));
        all.add(new Fixture("fixture-divider-propheavy", heavy(Ui.divider(), "divider-propheavy")
                .color("$color.outline").height(2)
                .build()));

        // spacer
        all.add(new Fixture("fixture-spacer-basic", Ui.spacer()
                .id("fixture-spacer-basic")
                .size(12).build()));
        all.add(new Fixture("fixture-spacer-propheavy", heavy(Ui.spacer(), "spacer-propheavy")
                .size(24).axis("horizontal").build()));

        // progress
        all.add(new Fixture("fixture-progress-basic", Ui.progress()
                .id("fixture-progress-basic")
                .kind("circular").value(0.5).build()));
        all.add(new Fixture("fixture-progress-propheavy", heavy(Ui.progress(), "progress-propheavy")
                .kind("linear").value(0.75).color("$color.accent").build()));

        // image
        all.add(new Fixture("fixture-image-basic", Ui.image()
                .id("fixture-image-basic")
                .src("https://example.invalid/i.png").width(32).height(32).fit("cover")
                .build()));
        all.add(new Fixture("fixture-image-propheavy", heavy(Ui.image(), "image-propheavy")
                .src("https://example.invalid/j.png").width(64).height(64).fit("contain")
                .borderRadius(8)
                .build()));

        // figure
        all.add(new Fixture("fixture-figure-basic", Ui.figure()
                .id("fixture-figure-basic")
                .shape("rectangle").color("#112233").width(10).height(20)
                .build()));
        all.add(new Fixture("fixture-figure-propheavy", heavy(Ui.figure(), "figure-propheavy")
                .shape("circle").color("$color.accent").width(40).height(40)
                .build()));

        // chart_line
        all.add(new Fixture("fixture-chart_line-basic", Ui.chartLine()
                .id("fixture-chart_line-basic")
                .series(List.of(entry("label", "l"), entry("values", List.of(1, 2))))
                .build()));
        all.add(new Fixture("fixture-chart_line-propheavy", heavy(Ui.chartLine(), "chart_line-propheavy")
                .series(List.of(
                        entry("label", "series a", "values", List.of(1, 3, 2)),
                        entry("label", "series b", "values", List.of(2, 1, 4))))
                .build()));

        // chart_bar
        all.add(new Fixture("fixture-chart_bar-basic", Ui.chartBar()
                .id("fixture-chart_bar-basic")
                .items(List.of(entry("label", "a", "value", 1)))
                .build()));
        all.add(new Fixture("fixture-chart_bar-propheavy", heavy(Ui.chartBar(), "chart_bar-propheavy")
                .items(List.of(
                        entry("label", "a", "value", 3),
                        entry("label", "b", "value", 5),
                        entry("label", "c", "value", 2)))
                .build()));

        // chart_pie
        all.add(new Fixture("fixture-chart_pie-basic", Ui.chartPie()
                .id("fixture-chart_pie-basic")
                .items(List.of(entry("label", "a", "value", 2)))
                .build()));
        all.add(new Fixture("fixture-chart_pie-propheavy", heavy(Ui.chartPie(), "chart_pie-propheavy")
                .items(List.of(
                        entry("label", "a", "value", 3),
                        entry("label", "b", "value", 4),
                        entry("label", "c", "value", 1)))
                .build()));

        // drawer
        all.add(new Fixture("fixture-drawer-basic", Ui.drawer()
                .id("fixture-drawer-basic")
                .title("Drawer").child(Ui.text("d").build()).build()));
        all.add(new Fixture("fixture-drawer-propheavy", heavy(Ui.drawer(), "drawer-propheavy")
                .title("Prop Heavy Drawer")
                .color("$color.surface")
                .child(Ui.text("drawer body").build())
                .build()));

        // box
        all.add(new Fixture("fixture-box-basic", Ui.box()
                .id("fixture-box-basic")
                .shape("rectangle")
                .child(Ui.text("boxed").build())
                .build()));
        all.add(new Fixture("fixture-box-propheavy", heavy(Ui.box(), "box-propheavy")
                .shape("rectangle")
                .gradient(Ui.gradient("linear", List.of("$color.accent", "$color.accentMuted"),
                        List.of("0", "1"), "topLeft", "bottomRight"))
                .border("$color.outline").borderWidth(2).borderStyle("solid")
                .borderRadius("$radius.md")
                .shadow(Ui.shadow("$color.shadow", 12, 0, 0, 4))
                .clip("antiAlias").align("center")
                .direction("row").gap(8)
                .child(Ui.text("L").build())
                .child(Ui.text("R").build())
                .build()));

        // row
        all.add(new Fixture("fixture-row-basic", Ui.row()
                .id("fixture-row-basic")
                .child(Ui.text("A").build())
                .child(Ui.text("B").build())
                .build()));
        all.add(new Fixture("fixture-row-propheavy", heavy(Ui.row(), "row-propheavy")
                .mainAxisAlignment("spaceBetween").crossAxisAlignment("baseline")
                .mainAxisSize("min").textDirection("ltr").verticalDirection("down")
                .textBaseline("alphabetic").spacing(8)
                .overflow("clip").clipBehavior("antiAlias")
                .child(Ui.text("small").style("caption").build())
                .child(Ui.text("LARGE").style("h2").build())
                .build()));

        // column
        all.add(new Fixture("fixture-column-basic", Ui.column()
                .id("fixture-column-basic")
                .child(Ui.text("top").build())
                .child(Ui.text("bottom").build())
                .build()));
        all.add(new Fixture("fixture-column-propheavy", heavy(Ui.column(), "column-propheavy")
                .mainAxisAlignment("center").crossAxisAlignment("stretch")
                .mainAxisSize("max").textDirection("rtl").verticalDirection("up")
                .gap(4)
                .child(Ui.text("one").build())
                .child("string child")
                .build()));

        // flex
        all.add(new Fixture("fixture-flex-basic", Ui.flex("column")
                .id("fixture-flex-basic")
                .child(Ui.text("x").build())
                .child(Ui.text("y").build())
                .build()));
        all.add(new Fixture("fixture-flex-propheavy", heavy(Ui.flex("row"), "flex-propheavy")
                .mainAxisAlignment("spaceEvenly").crossAxisAlignment("end")
                .mainAxisSize("min").textDirection("ltr").verticalDirection("up")
                .spacing(12).overflow("visible")
                .child(Ui.text("a").build())
                .child(Ui.text("b").build())
                .build()));

        // expanded (standalone: the flex wrap degrades to the plain child)
        all.add(new Fixture("fixture-expanded-basic", Ui.expanded()
                .id("fixture-expanded-basic")
                .child(Ui.text("expanded child").build())
                .build()));
        all.add(new Fixture("fixture-expanded-propheavy", heavy(Ui.expanded(), "expanded-propheavy")
                .flex(2)
                .child(Ui.text("expanded propheavy child").build())
                .build()));

        // flexible (standalone: the flex wrap degrades to the plain child)
        all.add(new Fixture("fixture-flexible-basic", Ui.flexible()
                .id("fixture-flexible-basic")
                .child(Ui.text("flexible child").build())
                .build()));
        all.add(new Fixture("fixture-flexible-propheavy", heavy(Ui.flexible(), "flexible-propheavy")
                .flex(1).fit("loose")
                .child(Ui.text("flexible propheavy child").build())
                .build()));

        // sized_box
        all.add(new Fixture("fixture-sized_box-basic", Ui.sizedBox()
                .id("fixture-sized_box-basic")
                .width(80).height(40)
                .child(Ui.text("fixed").build())
                .build()));
        all.add(new Fixture("fixture-sized_box-propheavy", heavy(Ui.sizedBox(), "sized_box-propheavy")
                .width(120).height(48)
                .color("$color.surface")
                .child(Ui.text("fixed heavy").build())
                .build()));

        // align
        all.add(new Fixture("fixture-align-basic", Ui.align()
                .id("fixture-align-basic")
                .align("bottomRight")
                .child(Ui.text("aligned").build())
                .build()));
        all.add(new Fixture("fixture-align-propheavy", heavy(Ui.align(), "align-propheavy")
                .align("topLeft")
                .width(200).height(80).color("$color.surface")
                .child(Ui.text("aligned heavy").build())
                .build()));

        // center
        all.add(new Fixture("fixture-center-basic", Ui.center()
                .id("fixture-center-basic")
                .child(Ui.text("centered").build())
                .build()));
        all.add(new Fixture("fixture-center-propheavy", heavy(Ui.center(), "center-propheavy")
                .width(200).height(80)
                .child(Ui.text("centered heavy").build())
                .build()));

        // aspect_ratio
        all.add(new Fixture("fixture-aspect_ratio-basic", Ui.aspectRatio(1.5)
                .id("fixture-aspect_ratio-basic")
                .child(Ui.text("ratio").build())
                .build()));
        all.add(new Fixture("fixture-aspect_ratio-propheavy", heavy(Ui.aspectRatio(2.5), "aspect_ratio-propheavy")
                .color("$color.surface").borderRadius("$radius.sm")
                .child(Ui.text("ratio heavy").build())
                .build()));

        // stack — badge over avatar: the T59 composition golden
        all.add(new Fixture("fixture-stack-basic", Ui.stack()
                .id("fixture-stack-basic")
                .child(Ui.figure().shape("circle").color("#3D5A80").width(64).height(64).build())
                .child(Ui.positioned()
                        .top(0).right(0)
                        .child(Ui.box()
                                .color("#C1272D").borderRadius(10).padding(4)
                                .child(Ui.text("3").color("#FFFFFF").bold(true).build())
                                .build())
                        .build())
                .build()));
        all.add(new Fixture("fixture-stack-propheavy", heavy(Ui.stack(), "stack-propheavy")
                .alignment("bottomRight").fit("expand").clipBehavior("antiAlias").textDirection("ltr")
                .child(Ui.figure().shape("rectangle").color("#3D5A80").width(120).height(80).build())
                .child(Ui.positioned()
                        .top(12).left(12).width(60).height(24)
                        .child(Ui.text("badge").build())
                        .build())
                .child(Ui.text("loose child").build())
                .build()));

        // positioned (standalone: the golden pins the align degrade)
        all.add(new Fixture("fixture-positioned-basic", Ui.positioned()
                .id("fixture-positioned-basic")
                .top(8).left(8)
                .child(Ui.text("positioned child").build())
                .build()));
        all.add(new Fixture("fixture-positioned-propheavy", heavy(Ui.positioned(), "positioned-propheavy")
                .top(0).right(0).bottom(0).left(0).width(40).height(20)
                .child(Ui.text("boxed").build())
                .build()));

        // wrap
        all.add(new Fixture("fixture-wrap-basic", Ui.wrap()
                .id("fixture-wrap-basic")
                .spacing(8).runSpacing(8)
                .child(Ui.text("one").build())
                .child(Ui.text("two").build())
                .child(Ui.text("three").build())
                .child(Ui.text("four").build())
                .build()));
        all.add(new Fixture("fixture-wrap-propheavy", heavy(Ui.wrap(), "wrap-propheavy")
                .direction("vertical").alignment("spaceBetween").crossAxisAlignment("center")
                .spacing(4).runSpacing(12).runAlignment("end")
                .textDirection("ltr").verticalDirection("down")
                .child(Ui.box().width(60).height(20).color("$color.surface").child(Ui.text("a").build()).build())
                .child(Ui.box().width(60).height(20).color("$color.surface").child(Ui.text("b").build()).build())
                .child(Ui.box().width(60).height(40).color("$color.surface").child(Ui.text("c").build()).build())
                .build()));

        // grid
        all.add(new Fixture("fixture-grid-basic", Ui.grid()
                .id("fixture-grid-basic")
                .columns(3)
                .childAspectRatio(1.4)
                .child(Ui.text("1").build())
                .child(Ui.text("2").build())
                .child(Ui.text("3").build())
                .child(Ui.text("4").build())
                .child(Ui.text("5").build())
                .child(Ui.text("6").build())
                .child(Ui.text("7").build())
                .child(Ui.text("8").build())
                .child(Ui.text("9").build())
                .build()));
        all.add(new Fixture("fixture-grid-propheavy", heavy(Ui.grid(), "grid-propheavy")
                .columns(2).childAspectRatio(1.8)
                .crossAxisSpacing(8).mainAxisSpacing(8)
                .shrinkWrap(true).physics("neverScrollable")
                .child(Ui.box().color("$color.surface").child(Ui.text("a").build()).build())
                .child(Ui.box().color("$color.surface").child(Ui.text("b").build()).build())
                .child(Ui.box().color("$color.surface").child(Ui.text("c").build()).build())
                .child(Ui.box().color("$color.surface").child(Ui.text("d").build()).build())
                .build()));

        // scroll
        all.add(new Fixture("fixture-scroll-basic", Ui.scroll()
                .id("fixture-scroll-basic")
                .child(Ui.text("eager one").build())
                .child(Ui.text("eager two").build())
                .build()));
        all.add(new Fixture("fixture-scroll-propheavy", heavy(Ui.scroll(), "scroll-propheavy")
                .scrollDirection("horizontal").reverse(false)
                .physics("alwaysScrollable").shrinkWrap(false)
                .itemCount(3)
                .item(Ui.text("lazy a").build())
                .item(Ui.text("lazy b").build())
                .item(Ui.text("lazy c").build())
                .build()));

        return all;
    }

    @Test
    void dumpGallery() throws IOException {
        List<Fixture> all = fixtures();

        assertThat(all).hasSizeGreaterThanOrEqualTo(80);

        Map<String, Integer> perType = new TreeMap<>();
        for (Fixture f : all) {
            perType.merge(f.node().type(), 1, Integer::sum);
        }
        assertThat(perType.keySet()).containsExactlyInAnyOrderElementsOf(EXPECTED_PRIMITIVES);

        StringBuilder dart = new StringBuilder();
        dart.append("// GENERATED by GalleryDump — do not edit. Regenerate: ").append(INVOCATION).append('\n');
        dart.append("import 'dart:convert';\n\n");
        dart.append("final List<Map<String, dynamic>> galleryFixtures = [\n");
        for (Fixture f : all) {
            String json = Json.write(f.node().toJson());
            dart.append("  json.decode(r'''").append(json).append("''') as Map<String, dynamic>,\n");
        }
        dart.append("];\n");

        Files.createDirectories(DART_OUTPUT.getParent());
        Files.writeString(DART_OUTPUT, dart.toString(), StandardCharsets.UTF_8);

        StringBuilder coverage = new StringBuilder();
        coverage.append("total=").append(all.size()).append('\n');
        coverage.append("primitives=").append(perType.size()).append('\n');
        for (Map.Entry<String, Integer> entry : perType.entrySet()) {
            coverage.append(entry.getKey()).append('=').append(entry.getValue()).append('\n');
        }

        Files.createDirectories(COVERAGE_OUTPUT.getParent());
        Files.writeString(COVERAGE_OUTPUT, coverage.toString(), StandardCharsets.UTF_8);

        System.out.println("GalleryDump: wrote " + DART_OUTPUT + " (" + all.size() + " fixtures, "
                + perType.size() + " primitives)");
        System.out.println(coverage);
    }
}
