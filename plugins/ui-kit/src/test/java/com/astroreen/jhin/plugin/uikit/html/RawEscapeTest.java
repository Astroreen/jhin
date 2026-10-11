/**
 * The {@code Ui.raw(String)} escape hatch: the single unescaped path in the
 * renderer. The hatch emits its payload verbatim (proven here and recorded
 * as QA evidence), while {@code RawEscapeSweepTest} proves no product screen
 * uses it (docs/web-client.md section 3).
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RawEscapeTest {

    /** The verbatim payload: an HTML event-handler vector, trusted chrome only. */
    private static final String HATCH = "<img onerror=alert(1)>";

    @Test
    void rawNodeEmitsItsPayloadVerbatim() {
        String html = HtmlRenderer.render(Ui.raw(HATCH).build());
        assertThat(html).contains(HATCH);
        assertThat(html).doesNotContain("&lt;img");
    }

    @Test
    void rawNodeStillCarriesTheProtocolAndVerbatimPayload() {
        String html = HtmlRenderer.render(Ui.raw(HATCH).id("chrome").build());
        assertThat(html).contains("data-jhin-type=\"raw\"");
        assertThat(html).contains("data-jhin-id=\"chrome\"");
        assertThat(html).contains(HATCH);
    }

    @Test
    void everyOtherPropStaysEscaped() {
        // The hatch is the payload, not a general bypass: the node's own
        // universal props still escape through HtmlNode.
        String html = HtmlRenderer.render(Ui.raw(HATCH).tooltip("\"><script>").build());
        assertThat(html).contains(HATCH);
        assertThat(html).contains("title=\"&quot;&gt;&lt;script&gt;\"");
    }

    @Test
    void rawNodeInsideAParentRendersVerbatim() {
        UiNode row = Ui.row().child(Ui.raw(HATCH).build()).build();
        String html = HtmlRenderer.render(row);
        assertThat(html).contains(HATCH);
        assertThat(html).doesNotContain("&lt;img");
    }

    @Test
    void rawHatchEvidence() {
        String html = HtmlRenderer.render(Ui.raw(HATCH).build());
        String report = """
                # T201 raw escape-hatch proof (scripts/qa/t201.sh)
                # Ui.raw("<img onerror=…>") must render VERBATIM — the hatch works.
                builder=Ui.raw("%s")
                rendered=%s
                contains-verbatim=%s
                contains-escaped=%s
                """.formatted(HATCH, html, html.contains(HATCH), html.contains("&lt;img"));
        HtmlRendererTest.writeEvidence("raw-hatch.txt", report);
        assertThat(html).contains(HATCH);
    }

    @Test
    void rawNodeWithoutPayloadRendersEmptyWrapper() {
        String html = HtmlRenderer.render(new UiNode("raw", Map.of(), List.of()));
        assertThat(html).startsWith("<div data-jhin-type=\"raw\"");
        assertThat(html).endsWith("</div>");
    }
}