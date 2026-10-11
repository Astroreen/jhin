/**
 * The T206 catalog prop work: {@code rich_text} span rendering, the
 * {@code tabs} tablist/tabpanel split, the {@code list_row} status and drag
 * surface, the {@code input}/{@code textarea} validation attributes the
 * client dispatcher reads (T204) and the {@code text} clamp/wrap props. The
 * unsupported placeholder stays reserved for out-of-catalog types.
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CatalogPropsTest {

    // --- rich_text --------------------------------------------------------

    @Test
    void richTextSpansRenderAsStyledInlineSpans() {
        UiNode node = new UiNode("rich_text", props("spans", List.of(
                entry("text", "plain "),
                entry("text", "bold", "style", "h3"),
                entry("text", "linked", "action", action(), "tooltip", "docs"),
                entry("icon", "open_in_new"),
                entry("chip", entry("kind", "citation", "label", "[1]")),
                entry("image", entry("src", "x.png", "semanticsLabel", "pic")))), List.of());

        String html = HtmlRenderer.render(node);

        assertThat(html).contains("class=\"jhin-rich-text\"");
        assertThat(html).contains("class=\"jhin-rich-span\">plain");
        assertThat(html).contains("jhin-text-h3");
        assertThat(html).contains("role=\"button\"");
        assertThat(html).contains("data-jhin-action='");
        assertThat(html).contains("title=\"docs\"");
        assertThat(html).contains("data-jhin-icon=\"open_in_new\"");
        assertThat(html).contains("jhin-chip-citation");
        assertThat(html).contains("[1]");
        assertThat(html).contains("src=\"x.png\"");
        assertThat(html).contains("alt=\"pic\"");
        assertThat(html).doesNotContain("jhin-unsupported");
    }

    @Test
    void richTextSpanStyleMapBecomesInlineDeclarations() {
        UiNode node = new UiNode("rich_text", props("spans", List.of(
                entry("text", "x", "style", entry("fontWeight", 700, "color", "$color.accent")))),
                List.of());
        String html = HtmlRenderer.render(node);
        assertThat(html).contains("font-weight: 700");
        assertThat(html).contains("color: var(--color-accent)");
    }

    @Test
    void richTextLabelsEscapeTheScriptProbe() {
        UiNode node = new UiNode("rich_text", props("spans", List.of(
                entry("text", "<script>alert(1)</script>"))), List.of());
        String html = HtmlRenderer.render(node);
        assertThat(html).doesNotContain("<script");
    }

    // --- tabs -------------------------------------------------------------

    @Test
    void tabsSplitIntoTablistAndTabpanels() {
        UiNode node = new UiNode("tabs", props(
                "id", "t",
                "items", List.of(
                        entry("label", "One", "panel", text("first")),
                        entry("label", "Two", "panel", text("second")))), List.of());

        String html = HtmlRenderer.render(node);

        assertThat(html).contains("class=\"jhin-tabs-list\" role=\"tablist\"");
        assertThat(html).contains("role=\"tab\" aria-selected=\"true\"");
        assertThat(html).contains("id=\"t-tab-0\" aria-controls=\"t-panel-0\"");
        assertThat(html).contains("class=\"jhin-tabpanel\" role=\"tabpanel\" id=\"t-panel-0\" "
                + "aria-labelledby=\"t-tab-0\"");
        assertThat(html).contains("hidden=\"hidden\"");
        // The panels are siblings of the tablist, never inside it.
        int listEnd = html.indexOf("</div>", html.indexOf("jhin-tabs-list"));
        assertThat(html.indexOf("jhin-tabpanel")).isGreaterThan(listEnd);
    }

    @Test
    void tabsVariantAndCloseSurfaceReflect() {
        UiNode node = new UiNode("tabs", props(
                "variant", "pill",
                "hasClose", true,
                "items", List.of(
                        entry("label", "A"),
                        entry("label", "B", "closable", false, "closeAction", action()))), List.of());

        String html = HtmlRenderer.render(node);

        assertThat(html).contains("jhin-tabs-pill");
        assertThat(html).contains("class=\"jhin-tab-close\"");
        assertThat(html).contains("jhin-tab-pinned");
        assertThat(html).contains("data-jhin-closable=\"false\"");
    }

    // --- list_row ---------------------------------------------------------

    @Test
    void listRowStatusIndicatorsAndDragSurfaceReflect() {
        UiNode node = new UiNode("list_row", props(
                "statusIndicators", List.of("working", "failed"),
                "dragHandle", true,
                "draggable", true,
                "dragging", true,
                "hoverReveal", true,
                "commandSubtitle", "thread.rename",
                "searchMatch", entry("key", "query"),
                "dropTargets", List.of(entry("id", "s1", "label", "Done"))), List.of());

        String html = HtmlRenderer.render(node);

        assertThat(count(html, "class=\"jhin-status-indicator\"")).isEqualTo(2);
        assertThat(html).contains("data-jhin-status=\"working\"");
        assertThat(html).contains("data-jhin-status=\"failed\"");
        assertThat(html).contains("class=\"jhin-drag-handle\"");
        assertThat(html).contains("data-jhin-draggable=\"true\"");
        assertThat(html).contains("jhin-dragging");
        assertThat(html).contains("jhin-hover-reveal");
        assertThat(html).contains("class=\"jhin-command-subtitle\">thread.rename");
        assertThat(html).contains("data-jhin-search-match=");
        assertThat(html).contains("data-jhin-drop-targets=");
    }

    // --- input validation (T204 reads these) ------------------------------

    @Test
    void textInputsEmitTheValidationSurfaceTheClientReads() {
        for (String type : List.of("input", "textarea")) {
            UiNode node = new UiNode(type, props(
                    "id", "f", "required", true, "min", 1, "max", 9,
                    "pattern", "[0-9]+", "errorText", "bad"), List.of());
            String html = HtmlRenderer.render(node);
            assertThat(html).as("%s validation surface", type)
                    .contains("required=\"required\"")
                    .contains("min=\"1\"")
                    .contains("max=\"9\"")
                    .contains("pattern=\"[0-9]+\"")
                    .contains("data-jhin-error-text=\"bad\"");
        }
    }

    // --- text clamp / wrap ------------------------------------------------

    @Test
    void textMaxLinesClampsAndSoftWrapSetsWhiteSpace() {
        String clamped = HtmlRenderer.render(Ui.text("x").maxLines(2).build());
        assertThat(clamped).contains("-webkit-line-clamp: 2").contains("overflow: hidden");

        String wrapped = HtmlRenderer.render(Ui.text("x").softWrap(false).build());
        assertThat(wrapped).contains("white-space: nowrap");
        assertThat(HtmlRenderer.render(Ui.text("x").softWrap(true).build()))
                .contains("white-space: normal");
    }

    // --- helpers ----------------------------------------------------------

    private static UiNode text(String value) {
        return new UiNode("text", props("text", value), List.of());
    }

    private static Map<String, Object> action() {
        return entry("path", "/ui/action/a", "name", "a");
    }

    /** An insertion-ordered map literal (Map.of randomizes iteration order). */
    private static Map<String, Object> entry(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            map.put((String) keyValues[i], keyValues[i + 1]);
        }
        return map;
    }

    private static Map<String, Object> props(Object... keyValues) {
        return entry(keyValues);
    }

    private static int count(String html, String needle) {
        int found = 0;
        int at = 0;
        while ((at = html.indexOf(needle, at)) >= 0) {
            found++;
            at += needle.length();
        }
        return found;
    }
}
