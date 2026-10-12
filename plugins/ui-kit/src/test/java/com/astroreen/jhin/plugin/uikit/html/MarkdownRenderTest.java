/**
 * {@link com.astroreen.jhin.plugin.uikit.html.renderers.MarkdownRenderer}:
 * semantic block rendering (headings, lists, tables, code fences, links,
 * blockquotes) and the raw-HTML guarantee — HTML blocks and inline HTML are
 * disabled at parse time and degrade to escaped text at render time, so LLM
 * output and file contents can never inject markup.
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.Ui;
import org.junit.jupiter.api.Test;

class MarkdownRenderTest {

    // --- semantic rendering ----------------------------------------------

    @Test
    void headingsRenderAsSemanticHtml() {
        String html = HtmlRenderer.render(Ui.markdown("# Title\n\n### Sub").build());
        assertThat(html).contains("<h1>Title</h1>");
        assertThat(html).contains("<h3>Sub</h3>");
        assertThat(html).contains("data-jhin-type=\"markdown\"");
        assertThat(html).contains("class=\"jhin-markdown\"");
    }

    @Test
    void listsRenderAsSemanticHtml() {
        String html = HtmlRenderer.render(Ui.markdown("- one\n- two\n\n1. first").build());
        assertThat(html).contains("<ul class=\"jhin-ul\">");
        assertThat(html).contains("<li class=\"jhin-li\">one</li>");
        assertThat(html).contains("<ol class=\"jhin-ol\">");
    }

    @Test
    void tablesRenderAsSemanticHtml() {
        String html = HtmlRenderer.render(Ui.markdown(
                "| Name | Value |\n| --- | --- |\n| a | 1 |").build());
        assertThat(html).contains("<table class=\"jhin-table\">");
        assertThat(html).contains("<thead>");
        assertThat(html).contains("<th>Name</th>");
        assertThat(html).contains("<td>a</td>");
    }

    @Test
    void codeFencesRenderAsCodeBlockMarkup() {
        String html = HtmlRenderer.render(Ui.markdown("```java\nint x = 1;\n```").build());
        // T302: a fence renders as the code_block primitive — the wire type
        // marker, the language class and the copyable header (language label
        // + copy affordance).
        assertThat(html).contains("data-jhin-type=\"code_block\"");
        assertThat(html).contains("class=\"jhin-code-block\"");
        assertThat(html).contains("<code class=\"language-java\">");
        assertThat(html).contains("jhin-code-block-header");
        assertThat(html).contains("jhin-code-block-lang");
        assertThat(html).contains("jhin-code-block-copy");
        assertThat(html).contains("aria-label=\"Copy code\"");
        assertThat(html).contains("int x = 1;");
    }

    @Test
    void indentedCodeAlsoRendersAsCodeBlock() {
        String html = HtmlRenderer.render(Ui.markdown("    int y = 2;").build());
        assertThat(html).contains("data-jhin-type=\"code_block\"");
        assertThat(html).contains("int y = 2;");
    }

    @Test
    void linksAndBlockquotesRenderAsSemanticHtml() {
        String html = HtmlRenderer.render(Ui.markdown(
                "> quoted\n\n[docs](https://example.invalid/docs)").build());
        assertThat(html).contains("<blockquote class=\"jhin-blockquote\">");
        assertThat(html).contains("<a href=\"https://example.invalid/docs\" class=\"jhin-link\"");
    }

    @Test
    void emphasisRendersAsEmAndStrong() {
        String html = HtmlRenderer.render(Ui.markdown("*em* and **strong**").build());
        assertThat(html).contains("<em>em</em>");
        assertThat(html).contains("<strong>strong</strong>");
    }

    // --- GFM parity (T302) ----------------------------------------------

    @Test
    void gfmStrikethroughRendersDel() {
        String html = HtmlRenderer.render(Ui.markdown("~~gone~~ stays").build());
        assertThat(html).contains("<del>gone</del>");
        assertThat(html).contains("stays");
    }

    @Test
    void gfmTaskListsRenderDisabledCheckboxes() {
        String html = HtmlRenderer.render(
                Ui.markdown("- [x] done\n- [ ] open").build());
        assertThat(html).contains("<input type=\"checkbox\" disabled>");
        assertThat(html).contains("<input type=\"checkbox\" disabled checked>");
        assertThat(html).contains("done");
        assertThat(html).contains("open");
    }

    @Test
    void gfmAutolinksRenderAsLinks() {
        String html = HtmlRenderer.render(
                Ui.markdown("see https://example.invalid/docs now").build());
        assertThat(html).contains("<a href=\"https://example.invalid/docs\" class=\"jhin-link\"");
    }

    @Test
    void alertBlockquoteRendersTheCallout() {
        String html = HtmlRenderer.render(
                Ui.markdown("> [!WARNING]\n> Careful.").build());
        assertThat(html).contains("jhin-blockquote jhin-callout jhin-callout-warning");
        assertThat(html).contains("jhin-callout-title");
        assertThat(html).contains("Warning");
        assertThat(html).contains("Careful.");
        assertThat(html).doesNotContain("[!WARNING]");
    }

    @Test
    void plainBlockquoteStaysPlain() {
        String html = HtmlRenderer.render(Ui.markdown("> quoted").build());
        assertThat(html).contains("<blockquote class=\"jhin-blockquote\">");
        assertThat(html).doesNotContain("jhin-callout");
    }

    @Test
    void unclosedFenceDegradesWholeNodeToPlainText() {
        String html = HtmlRenderer.render(
                Ui.markdown("before\n\n```java\nint x = 1;").build());
        assertThat(html).doesNotContain("<pre");
        assertThat(html).doesNotContain("data-jhin-type=\"code_block\"");
        assertThat(html).contains("```java");
        assertThat(html).contains("int x = 1;");
    }

    // --- raw HTML is dead markup (section 9.3) ----------------------------

    @Test
    void scriptProbeNeverBecomesAnElement() {
        String html = HtmlRenderer.render(Ui.markdown("<script>alert(1)</script>").build());
        assertThat(html).doesNotContain("<script");
        assertThat(html).contains("&lt;script&gt;alert(1)&lt;/script&gt;");
    }

    @Test
    void inlineHtmlDoesNotPassThrough() {
        String html = HtmlRenderer.render(Ui.markdown("hello <b>world</b>").build());
        assertThat(html).doesNotContain("<b>");
        assertThat(html).doesNotContain("</b>");
        assertThat(html).contains("&lt;b&gt;world&lt;/b&gt;");
    }

    @Test
    void blockHtmlDoesNotPassThrough() {
        String html = HtmlRenderer.render(Ui.markdown(
                "<div onclick=\"alert(1)\">\nblock\n</div>").build());
        // The wrapper div is ours; the source div degrades to escaped text
        // (the onclick= fragment survives only as visible characters).
        assertThat(html).doesNotContain("<div onclick");
        assertThat(html).contains("&lt;div onclick=");
    }

    @Test
    void javascriptLinksDegradeToPlainText() {
        String html = HtmlRenderer.render(Ui.markdown("[x](javascript:alert(1))").build());
        assertThat(html).doesNotContain("javascript:");
        assertThat(html).doesNotContain("<a ");
        assertThat(html).contains("x");
    }

    @Test
    void httpsLinksSurvive() {
        String html = HtmlRenderer.render(Ui.markdown("[x](https://example.invalid)").build());
        assertThat(html).contains("href=\"https://example.invalid\"");
    }

    @Test
    void codeFenceContentIsEscapedText() {
        String html = HtmlRenderer.render(Ui.markdown("```\n<script>alert(1)</script>\n```").build());
        assertThat(html).contains("<pre");
        assertThat(html).doesNotContain("<script");
        assertThat(html).contains("&lt;script&gt;");
    }

    @Test
    void inlineCodeEscapes() {
        String html = HtmlRenderer.render(Ui.markdown("run `<script>` now").build());
        assertThat(html).contains("class=\"jhin-code-inline\"");
        assertThat(html).doesNotContain("<script");
    }
}