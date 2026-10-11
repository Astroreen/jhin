/**
 * The T206 chart renderers: {@code chart_line}/{@code chart_bar}/
 * {@code chart_pie} compute inline SVG geometry on the server (no JS, no
 * chart library). The tests pin the shape contract: the {@code viewBox}
 * matches the emitted geometry, the {@code d} attributes parse as path
 * commands with finite coordinates, numbers are {@link java.util.Locale#ROOT}
 * formatted, labels are escaped, and an empty series renders the documented
 * empty state (the {@code jhin-chart-empty} svg with no drawing children) —
 * never {@code NaN} and never invalid path data.
 */
package com.astroreen.jhin.plugin.uikit.html;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class ChartRenderTest {

    /** A {@code M/L}-path: commands are {@code M} or {@code L} plus two finite numbers. */
    private static final Pattern PATH_COMMAND = Pattern.compile("[ML]\\s+(-?[0-9.]+)\\s+(-?[0-9.]+)");

    /** A pie arc path: {@code M cx cy L … A r r 0 l s x y Z}. */
    private static final Pattern ARC_PATH = Pattern.compile(
            "^M (-?[0-9.]+) (-?[0-9.]+) L (-?[0-9.]+) (-?[0-9.]+) "
                    + "A (-?[0-9.]+) (-?[0-9.]+) 0 ([01]) ([01]) (-?[0-9.]+) (-?[0-9.]+) Z$");

    // --- chart_line -------------------------------------------------------

    @Test
    void chartLineRendersOnePathPerSeriesInsideTheViewBox() {
        String html = HtmlRenderer.render(new UiNode("chart_line", props(
                "series", List.of(
                        entry("label", "tokens", "values", List.of(1, 3, 2)),
                        entry("color", "#112233", "points", List.of(
                                List.of(0, 10), List.of(5, 20))))), List.of()));

        assertThat(html).contains("class=\"jhin-chart jhin-chart-line\"");
        assertThat(html).contains("viewBox=\"0 0 320 120\"");
        assertThat(html).contains("aria-hidden=\"true\"");
        assertThat(count(html, "class=\"jhin-chart-series\"")).isEqualTo(2);
        for (double[] point : pathPoints(html)) {
            assertThat(point[0]).as("x inside the viewBox").isBetween(0.0, 320.0);
            assertThat(point[1]).as("y inside the viewBox").isBetween(0.0, 120.0);
        }
        // The series color rides on the stroke attribute.
        assertThat(html).contains("stroke=\"#112233\"");
    }

    @Test
    void chartLineLabelsEscapeTheScriptProbe() {
        String html = HtmlRenderer.render(new UiNode("chart_line", props(
                "series", List.of(entry("label", "<script>alert(1)</script>",
                        "values", List.of(1, 2)))), List.of()));

        assertThat(html).doesNotContain("<script");
        assertThat(html).contains("&lt;script&gt;");
    }

    @Test
    void chartLineEmptySeriesRendersTheDocumentedEmptyState() {
        for (Object series : List.of(List.of(), List.of(entry("values", List.of())),
                "garbage", List.of(entry("points", List.of("x"))))) {
            String html = HtmlRenderer.render(new UiNode("chart_line",
                    props("series", series), List.of()));
            assertThat(html)
                    .as("empty series %s", series)
                    .contains("jhin-chart-empty")
                    .contains("viewBox=\"0 0 320 120\"")
                    .doesNotContain("<path")
                    .doesNotContain("NaN");
        }
    }

    @Test
    void chartLineFlatSeriesStaysAFlatFiniteLine() {
        String html = HtmlRenderer.render(new UiNode("chart_line", props(
                "series", List.of(entry("values", List.of(7, 7, 7)))), List.of()));

        assertThat(html).doesNotContain("NaN");
        assertThat(pathPoints(html)).hasSize(3);
    }

    // --- chart_bar --------------------------------------------------------

    @Test
    void chartBarRendersRectsFromAZeroBaseline() {
        String html = HtmlRenderer.render(new UiNode("chart_bar", props(
                "items", List.of(
                        entry("label", "a", "value", 4),
                        entry("label", "b", "value", 8, "color", "#ff0000"))), List.of()));

        assertThat(html).contains("class=\"jhin-chart jhin-chart-bar\"");
        assertThat(html).contains("viewBox=\"0 0 320 120\"");
        assertThat(count(html, "class=\"jhin-chart-bar-rect\"")).isEqualTo(2);
        assertThat(html).contains("fill=\"#ff0000\"");
        Matcher heights = Pattern.compile("height=\"([0-9.]+)\"").matcher(html);
        List<Double> rendered = new ArrayList<>();
        while (heights.find()) {
            rendered.add(Double.parseDouble(heights.group(1)));
        }
        assertThat(rendered).as("the 8-value bar is twice the 4-value bar")
                .containsExactly(56.0, 112.0);
    }

    @Test
    void chartBarGroupedSeriesRenderPerSeriesColors() {
        String html = HtmlRenderer.render(new UiNode("chart_bar", props(
                "series", List.of(
                        entry("label", "s1", "color", "#00ff00",
                                "values", List.of(entry("label", "x", "value", 1))),
                        entry("values", List.of(entry("label", "x", "value", 2))))), List.of()));

        assertThat(count(html, "class=\"jhin-chart-bar-rect\"")).isEqualTo(2);
        assertThat(html).contains("fill=\"#00ff00\"");
    }

    @Test
    void chartBarEmptyItemsRenderTheEmptyStateWithoutRects() {
        String html = HtmlRenderer.render(new UiNode("chart_bar",
                props("items", List.of()), List.of()));
        assertThat(html).contains("jhin-chart-empty").doesNotContain("<rect");
    }

    // --- chart_pie --------------------------------------------------------

    @Test
    void chartPieRendersOneArcSlicePerItem() {
        String html = HtmlRenderer.render(new UiNode("chart_pie", props(
                "items", List.of(
                        entry("label", "a", "value", 1),
                        entry("label", "b", "value", 1),
                        entry("label", "c", "value", 2))), List.of()));

        assertThat(html).contains("class=\"jhin-chart jhin-chart-pie\"");
        assertThat(html).contains("viewBox=\"0 0 120 120\"");
        assertThat(count(html, "class=\"jhin-chart-slice\"")).isEqualTo(3);
        for (String d : pathData(html)) {
            Matcher arc = ARC_PATH.matcher(d);
            assertThat(arc.matches()).as("arc path %s", d).isTrue();
        }
    }

    @Test
    void chartPieSingleSliceIsACircleNeverADegenerateArc() {
        String html = HtmlRenderer.render(new UiNode("chart_pie", props(
                "items", List.of(entry("label", "all", "value", 3))), List.of()));

        assertThat(html).contains("<circle");
        assertThat(html).doesNotContain("<path");
    }

    @Test
    void chartPieZeroTotalRendersTheEmptyState() {
        String html = HtmlRenderer.render(new UiNode("chart_pie", props(
                "items", List.of(entry("value", 0), entry("value", -1))), List.of()));

        assertThat(html).contains("jhin-chart-empty").doesNotContain("<path").doesNotContain("<circle");
    }

    // --- label semantics --------------------------------------------------

    @Test
    void chartsAreDecorativeUnlessTheLabelPropExists() {
        String anonymous = HtmlRenderer.render(new UiNode("chart_line", props(
                "series", List.of(entry("values", List.of(1, 2)))), List.of()));
        assertThat(anonymous).contains("aria-hidden=\"true\"").doesNotContain("role=\"img\"");

        String labeled = HtmlRenderer.render(new UiNode("chart_line", props(
                "label", "Usage", "series", List.of(entry("values", List.of(1, 2)))), List.of()));
        assertThat(labeled).contains("role=\"img\"").contains("aria-label=\"Usage\"");
    }

    // --- helpers ----------------------------------------------------------

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

    /** Every {@code d="…"} attribute of the fragment. */
    private static List<String> pathData(String html) {
        List<String> out = new ArrayList<>();
        Matcher matcher = Pattern.compile(" d=\"([^\"]*)\"").matcher(html);
        while (matcher.find()) {
            out.add(matcher.group(1));
        }
        return out;
    }

    /** Every {@code M/L} polyline coordinate pair, parsed and finite. */
    private static List<double[]> pathPoints(String html) {
        List<double[]> out = new ArrayList<>();
        for (String d : pathData(html)) {
            Matcher matcher = PATH_COMMAND.matcher(d);
            int consumed = 0;
            while (matcher.find()) {
                assertThat(d.substring(consumed, matcher.start()))
                        .as("only whitespace between path commands in %s", d)
                        .isBlank();
                out.add(new double[] {
                        Double.parseDouble(matcher.group(1)),
                        Double.parseDouble(matcher.group(2))});
                consumed = matcher.end();
            }
            assertThat(consumed).as("path %s is fully consumed by M/L commands", d)
                    .isEqualTo(d.length());
        }
        return out;
    }
}
