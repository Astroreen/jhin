/**
 * The {@link HtmlRenderer} pipeline: the escaping matrix (every injectable
 * prop position carries {@code <script>alert(1)</script>} and must render
 * escaped), the attribute protocol, the meta pass ({@code visible},
 * {@code when}), the text-shorthand children, nested-prop recursion
 * ({@code items}, {@code fields}, {@code rows}) and the unsupported-type
 * placeholder. The XSS matrix is also dumped as a QA evidence artifact when
 * {@code JHIN_EVIDENCE_DIR} is set (scripts/qa/t201.sh).
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class HtmlRendererTest {

    /** The matrix payload: the canonical XSS probe, in every position. */
    private static final String PROBE = "<script>alert(1)</script>";

    // --- escaping matrix (risk №1, T201) ---------------------------------

    @Test
    void textPropEscapesTheScriptProbe() {
        String html = HtmlRenderer.render(Ui.text(PROBE).build());
        assertEscaped(html);
        assertThat(html).contains("&lt;script&gt;alert(1)&lt;/script&gt;");
    }

    @Test
    void labelPropEscapesTheScriptProbe() {
        String html = HtmlRenderer.render(Ui.button(PROBE).build());
        assertEscaped(html);
    }

    @Test
    void titlePropEscapesTheScriptProbe() {
        String html = HtmlRenderer.render(Ui.card().title(PROBE).build());
        assertEscaped(html);
    }

    @Test
    void markdownPropEscapesTheScriptProbe() {
        String html = HtmlRenderer.render(Ui.markdown(PROBE).build());
        assertEscaped(html);
        // Raw HTML in markdown never becomes an element (section 9.3).
        assertThat(html).doesNotContain("<script");
    }

    @Test
    void attributePositionsEscapeTheScriptProbe() {
        String html = HtmlRenderer.render(Ui.text("x")
                .tooltip(PROBE)
                .semanticsLabel(PROBE).build());
        assertEscaped(html);
        assertThat(html).contains("title=\"&lt;script&gt;alert(1)&lt;/script&gt;\"");
    }

    @Test
    void xssMatrixEvidence() {
        List<String> lines = new ArrayList<>();
        lines.add("# T201 XSS matrix — every injectable prop position, input "
                + PROBE);
        lines.add("# rendered outputs must contain zero raw <script (inputs may show it)");
        record(lines, "text", HtmlRenderer.render(Ui.text(PROBE).build()));
        record(lines, "label", HtmlRenderer.render(Ui.button(PROBE).build()));
        record(lines, "title", HtmlRenderer.render(Ui.card().title(PROBE).build()));
        record(lines, "markdown", HtmlRenderer.render(Ui.markdown(PROBE).build()));
        record(lines, "tooltip", HtmlRenderer.render(Ui.text("x").tooltip(PROBE).build()));
        record(lines, "semanticsLabel",
                HtmlRenderer.render(Ui.text("x").semanticsLabel(PROBE).build()));
        record(lines, "placeholder",
                HtmlRenderer.render(Ui.input("f").placeholder(PROBE).build()));
        record(lines, "code", HtmlRenderer.render(Ui.codeBlock(PROBE).build()));
        String file = String.join("\n", lines) + "\n";
        writeEvidence("xss-matrix.txt", file);
        // The artifact itself is the proof: every output line is escaped.
        for (String line : lines) {
            if (line.startsWith("output=")) {
                assertThat(line).doesNotContain("<script");
            }
        }
    }

    private static void record(List<String> lines, String position, String html) {
        lines.add("");
        lines.add("position=" + position);
        lines.add("input=" + PROBE);
        lines.add("output=" + html);
        assertThat(html).doesNotContain("<script");
    }

    private static void assertEscaped(String html) {
        assertThat(html).doesNotContain("<script");
        assertThat(html).doesNotContain("alert(1)</script>");
    }

    // --- attribute protocol (docs/sdui.md section 9.2) --------------------

    @Test
    void everyNodeCarriesDataJhinType() {
        assertThat(HtmlRenderer.render(Ui.text("t").build()))
                .contains("data-jhin-type=\"text\"");
        assertThat(HtmlRenderer.render(Ui.divider().build()))
                .contains("data-jhin-type=\"divider\"");
        assertThat(HtmlRenderer.render(new UiNode("mystery", Map.of(), List.of())))
                .contains("data-jhin-type=\"mystery\"");
    }

    @Test
    void idPropSetsBothHtmlIdAndDataJhinId() {
        String html = HtmlRenderer.render(Ui.text("t").id("msg-7").build());
        assertThat(html).contains("id=\"msg-7\"");
        assertThat(html).contains("data-jhin-id=\"msg-7\"");
    }

    @Test
    void actionRidesAsASingleQuotedJsonAttribute() {
        Map<String, Object> action = Map.of("path", "/ui/action/send", "name", "send");
        String html = HtmlRenderer.render(Ui.button("Send").action(action).confirm("Sure?").build());
        assertThat(html).contains("data-jhin-action='");
        assertThat(html).contains("data-jhin-confirm=\"Sure?\"");
        // Tolerant round-trip: the button tag carries the type and the action.
        assertThat(html).matches(
                "(?s)<button[^>]*data-jhin-type=\"button\"[^>]*data-jhin-action='[^']*'[^>]*>.*</button>");
        // The JSON survives the single-quoted shape (quotes entity-escaped).
        assertThat(html).contains("&quot;path&quot;:&quot;/ui/action/send&quot;");
    }

    @Test
    void onTapAndOnLongPressFallBackForTheActionAttribute() {
        assertThat(HtmlRenderer.render(Ui.text("t").onTap(Map.of("client", List.of())).build()))
                .contains("data-jhin-action='");
        assertThat(HtmlRenderer.render(Ui.text("t").onLongPress(Map.of("client", List.of())).build()))
                .contains("data-jhin-action='");
        assertThat(HtmlRenderer.render(Ui.text("t").build())).doesNotContain("data-jhin-action");
    }

    // --- meta pass --------------------------------------------------------

    @Test
    void invisibleNodesAreOmittedEntirely() {
        assertThat(HtmlRenderer.render(Ui.text("gone").visible(false).build())).isEmpty();
        UiNode row = Ui.row().child(Ui.text("kept").build()).child(Ui.text("gone").visible(false).build()).build();
        String html = HtmlRenderer.render(row);
        assertThat(html).contains("kept");
        assertThat(html).doesNotContain("gone");
    }

    @Test
    void whenStaysVisibleAndBecomesDataJhinWhen() {
        String html = HtmlRenderer.render(Ui.text("live").when("composerFocus").build());
        assertThat(html).contains("data-jhin-when=\"composerFocus\"");
        assertThat(html).contains("live");
    }

    @Test
    void templateStringsBecomeDataJhinTemplate() {
        String html = HtmlRenderer.render(Ui.text("Hello ${name}").build());
        assertThat(html).contains("data-jhin-template=\"Hello ${name}\"");
    }

    // --- text-shorthand children and nested-prop recursion ----------------

    @Test
    void stringChildrenRenderAsTextNodes() {
        UiNode column = Ui.column().child("plain").child(Ui.text("node").build()).build();
        String html = HtmlRenderer.render(column);
        assertThat(html).contains("<span data-jhin-type=\"text\" class=\"jhin-text\">plain</span>");
        assertThat(html).contains("data-jhin-type=\"text\"");
    }

    @Test
    void nestedItemsRenderThroughThePipeline() {
        UiNode list = Ui.list().item("one").item(Ui.text("two").build()).build();
        String html = HtmlRenderer.render(list);
        assertThat(html).contains("data-jhin-type=\"list\"");
        assertThat(html).contains(">one</span>");
        assertThat(html).contains(">two</span>");
    }

    @Test
    void nestedFieldsRenderThroughThePipeline() {
        UiNode form = Ui.form()
                .field(Ui.input("a").label("A").build())
                .submit("Send", Map.of("path", "/ui/action/x"))
                .build();
        String html = HtmlRenderer.render(form);
        assertThat(html).contains("data-jhin-type=\"form\"");
        assertThat(html).contains("data-jhin-type=\"input\"");
        assertThat(html).contains("<button type=\"button\"");
    }

    @Test
    void nestedRowsRenderThroughThePipeline() {
        UiNode table = Ui.table()
                .column("Name")
                .row(Ui.text("cell").build(), "plain")
                .build();
        String html = HtmlRenderer.render(table);
        assertThat(html).contains("<table");
        assertThat(html).contains("<thead>");
        assertThat(html).contains("<th>Name</th>");
        assertThat(html).contains("<td>");
        assertThat(html).contains("data-jhin-type=\"text\"");
        assertThat(html).contains("plain");
    }

    @Test
    void deeplyNestedNodeValuedPropsRenderRecursively() {
        UiNode screen = Ui.screen()
                .body(Ui.list().item(Ui.listRow().title(Ui.text("deep").build()).build()).build())
                .build();
        String html = HtmlRenderer.render(screen);
        assertThat(html).contains("data-jhin-type=\"screen\"");
        assertThat(html).contains("data-jhin-type=\"list\"");
        assertThat(html).contains("data-jhin-type=\"list_row\"");
        assertThat(html).contains("data-jhin-type=\"text\"");
    }

    // --- unsupported fallback (section 2.4) -------------------------------

    @Test
    void unknownTypeRendersTheUnsupportedPlaceholder() {
        UiNode unknown = new UiNode("mystery", Map.of(), List.of());
        String html = HtmlRenderer.render(unknown);
        assertThat(html).contains("class=\"jhin-unsupported\"");
        assertThat(html).contains("data-jhin-type=\"mystery\"");
    }

    @Test
    void t206CatalogTypesHaveRealRenderers() {
        for (String type : List.of("rich_text", "chart_line", "chart_bar", "chart_pie")) {
            String html = HtmlRenderer.render(new UiNode(type, Map.of(), List.of()));
            assertThat(html)
                    .as("type %s is a catalog type and must never hit the placeholder", type)
                    .doesNotContain("jhin-unsupported")
                    .contains("data-jhin-type=\"" + type + "\"");
        }
    }

    @Test
    void everyCatalogTypeHasARealRenderer() {
        List<String> types = List.of(
                "screen", "shell", "container", "box", "row", "column", "flex",
                "expanded", "flexible", "stack", "positioned", "align", "center",
                "sized_box", "aspect_ratio", "wrap", "grid", "scroll", "divider",
                "spacer", "list", "list_row", "table", "tree", "split",
                "text", "rich_text", "markdown", "code_block",
                "button", "icon_button", "icon", "input", "textarea", "dropdown",
                "checkbox", "switch", "slider", "form", "segmented", "menu",
                "tabs", "kbd", "scroll_fade",
                "card", "drawer", "sheet", "dialog", "banner", "chip", "badge",
                "avatar", "skeleton", "progress", "image", "figure", "hover_card",
                "toast_stack",
                "stream_view", "chart_line", "chart_bar", "chart_pie", "diff_view",
                "nav");
        assertThat(types).as("the docs/sdui.md section 2.5 node types (68 names "
                        + "minus the four universal prop names)").hasSize(64);
        for (String type : types) {
            String html = HtmlRenderer.render(new UiNode(type, Map.of(), List.of()));
            assertThat(html)
                    .as("type %s must have a real renderer", type)
                    .doesNotContain("jhin-unsupported")
                    .contains("data-jhin-type=\"" + type + "\"");
        }
    }

    // --- purity -----------------------------------------------------------

    @Test
    void renderingIsPureAndDeterministic() {
        UiNode node = Ui.button("Go").action(Map.of("path", "/ui/action/go")).build();
        assertThat(HtmlRenderer.render(node)).isEqualTo(HtmlRenderer.render(node));
        assertThat(HtmlRenderer.renderFragment(node)).isEqualTo(HtmlRenderer.render(node));
        assertThat(HtmlRenderer.render(null)).isEmpty();
    }

    // --- evidence helper --------------------------------------------------

    /**
     * Writes one QA evidence artifact when the {@code JHIN_EVIDENCE_DIR}
     * environment variable is set (scripts/qa/t201.sh exports it); a plain
     * {@code gradle test} run without the variable writes nothing.
     */
    static void writeEvidence(String name, String content) {
        String dir = System.getenv("JHIN_EVIDENCE_DIR");
        if (dir == null || dir.isBlank()) {
            return;
        }
        try {
            Files.createDirectories(Path.of(dir));
            Files.writeString(Path.of(dir, name), content, StandardCharsets.UTF_8);
        } catch (IOException failure) {
            throw new IllegalStateException("cannot write evidence " + name, failure);
        }
    }
}