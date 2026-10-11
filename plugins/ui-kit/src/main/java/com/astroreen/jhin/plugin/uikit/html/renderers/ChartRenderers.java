/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html.renderers;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import com.astroreen.jhin.plugin.uikit.html.PropReflection;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Chart primitives &rarr; server-computed inline SVG (T206):
 * {@code chart_line}, {@code chart_bar} and {@code chart_pie}. No JavaScript
 * and no chart library — the path, rect and arc geometry is computed here
 * from the {@code series}/{@code items} props and emitted as static markup.
 *
 * <p>Shape (docs/sdui.md section 2.6):
 *
 * <ul>
 *   <li>{@code chart_line} — {@code series: [{label?, color?, points or
 *       values}]}: {@code values} is a plain number list (the x coordinate is
 *       the index), {@code points} a list of {@code [x, y]} pairs or
 *       {@code {x, y}} maps; each series is one
 *       {@code <path d="M … L …">} polyline;</li>
 *   <li>{@code chart_bar} — {@code items: [{label, value, color?}]} as a
 *       single series of {@code <rect>} bars from a zero baseline, or
 *       {@code series: [{label?, color?, values: [{label, value}]}]} for
 *       grouped bars;</li>
 *   <li>{@code chart_pie} — {@code items: [{label, value, color?}]} as
 *       {@code <path>} arcs around the viewBox center; a single full slice
 *       renders as {@code <circle>}.</li>
 * </ul>
 *
 * <p>Degradation (section 2.4): an empty or unparseable series list renders
 * the documented empty state — the same {@code <svg>} with the
 * {@code jhin-chart-empty} class and <em>no</em> drawing children, never
 * invalid path data and never {@code NaN}. Every number is formatted with
 * {@link Locale#ROOT}; every label goes through {@link
 * com.astroreen.jhin.plugin.uikit.html.HtmlEsc} like any other prop. The
 * chart is {@code role="img"} with an {@code aria-label} only when the node
 * carries a {@code label} prop — otherwise it is decorative
 * ({@code aria-hidden="true"}).
 */
public final class ChartRenderers {

    /** The line/bar viewBox width. */
    private static final double VIEW_WIDTH = 320;

    /** The line/bar viewBox height. */
    private static final double VIEW_HEIGHT = 120;

    /** The pie viewBox is square. */
    private static final double PIE_VIEW = 120;

    /** Padding inside the line/bar viewBox, in viewBox units. */
    private static final double PAD = 4;

    /** The {@code chart_line} props with a semantic mapping. */
    private static final Set<String> LINE_HANDLED = Set.of("series", "label");

    /** The {@code chart_bar} props with a semantic mapping. */
    private static final Set<String> BAR_HANDLED = Set.of("items", "series", "label");

    /** The {@code chart_pie} props with a semantic mapping. */
    private static final Set<String> PIE_HANDLED = Set.of("items", "label");

    private ChartRenderers() {
    }

    public static Map<String, NodeRenderer> renderers() {
        Map<String, NodeRenderer> map = new LinkedHashMap<>();
        map.put("chart_line", line());
        map.put("chart_bar", bar());
        map.put("chart_pie", pie());
        return map;
    }

    private static NodeRenderer line() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "svg";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                boolean empty = true;
                List<Series> seriesList = new ArrayList<>();
                if (node.props().get("series") instanceof List<?> series) {
                    for (Object entry : series) {
                        Series parsed = series(entry);
                        if (parsed != null && !parsed.points().isEmpty()) {
                            seriesList.add(parsed);
                            empty = false;
                        }
                    }
                }
                chartElement(element, node, "jhin-chart jhin-chart-line", empty);
                if (empty) {
                    PropReflection.reflect(node, element, LINE_HANDLED);
                    return;
                }
                double minX = Double.POSITIVE_INFINITY;
                double maxX = Double.NEGATIVE_INFINITY;
                double minY = Double.POSITIVE_INFINITY;
                double maxY = Double.NEGATIVE_INFINITY;
                for (Series series : seriesList) {
                    for (Point point : series.points()) {
                        minX = Math.min(minX, point.x());
                        maxX = Math.max(maxX, point.x());
                        minY = Math.min(minY, point.y());
                        maxY = Math.max(maxY, point.y());
                    }
                }
                if (minX == maxX) {
                    maxX = minX + 1;
                }
                if (minY == maxY) {
                    // A flat series stays a flat line through the middle.
                    minY -= 1;
                    maxY += 1;
                }
                for (Series series : seriesList) {
                    StringBuilder d = new StringBuilder();
                    for (int i = 0; i < series.points().size(); i++) {
                        Point point = series.points().get(i);
                        double x = scale(point.x(), minX, maxX, PAD, VIEW_WIDTH - PAD);
                        double y = scale(point.y(), minY, maxY, VIEW_HEIGHT - PAD, PAD);
                        d.append(i == 0 ? "M " : " L ")
                                .append(num(x)).append(' ').append(num(y));
                    }
                    HtmlNode path = new HtmlNode("path")
                            .attr("class", "jhin-chart-series")
                            .attr("d", d.toString())
                            .attr("fill", "none");
                    if (series.color() != null) {
                        path.attr("stroke", series.color());
                    }
                    if (series.label() != null) {
                        path.child(new HtmlNode("title").textChild(series.label()));
                    }
                    element.child(path);
                }
                PropReflection.reflect(node, element, LINE_HANDLED);
            }
        };
    }

    // --- chart_bar --------------------------------------------------------

    private static NodeRenderer bar() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "svg";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                List<List<Bar>> groups = new ArrayList<>();
                if (node.props().get("items") instanceof List<?> items) {
                    List<Bar> single = bars(items, null, null);
                    if (!single.isEmpty()) {
                        groups.add(single);
                    }
                } else if (node.props().get("series") instanceof List<?> series) {
                    for (Object entry : series) {
                        if (!(entry instanceof Map<?, ?> map)) {
                            continue;
                        }
                        List<Bar> group = bars(
                                map.get("values") instanceof List<?> values ? values : List.of(),
                                stringOrNull(map.get("color")),
                                stringOrNull(map.get("label")));
                        if (!group.isEmpty()) {
                            groups.add(group);
                        }
                    }
                }
                boolean empty = groups.isEmpty();
                chartElement(element, node, "jhin-chart jhin-chart-bar", empty);
                if (empty) {
                    PropReflection.reflect(node, element, BAR_HANDLED);
                    return;
                }
                double max = 0;
                for (List<Bar> group : groups) {
                    for (Bar bar : group) {
                        max = Math.max(max, bar.value());
                    }
                }
                if (max <= 0) {
                    max = 1;
                }
                int totalBars = 0;
                for (List<Bar> group : groups) {
                    totalBars += group.size();
                }
                double slot = (VIEW_WIDTH - 2 * PAD) / Math.max(1, totalBars);
                double barWidth = Math.max(1, slot * 0.7);
                int index = 0;
                for (List<Bar> group : groups) {
                    for (Bar bar : group) {
                        double height = bar.value() / max * (VIEW_HEIGHT - 2 * PAD);
                        double x = PAD + index * slot + (slot - barWidth) / 2;
                        double y = VIEW_HEIGHT - PAD - height;
                        HtmlNode rect = new HtmlNode("rect")
                                .attr("class", "jhin-chart-bar-rect")
                                .attr("x", num(x))
                                .attr("y", num(y))
                                .attr("width", num(barWidth))
                                .attr("height", num(Math.max(0, height)));
                        if (bar.color() != null) {
                            rect.attr("fill", bar.color());
                        }
                        if (bar.label() != null) {
                            rect.child(new HtmlNode("title").textChild(bar.label()));
                        }
                        element.child(rect);
                        index++;
                    }
                }
                PropReflection.reflect(node, element, BAR_HANDLED);
            }
        };
    }

    // --- chart_pie --------------------------------------------------------

    private static NodeRenderer pie() {
        return new NodeRenderer() {
            @Override
            public String tag(UiNode node) {
                return "svg";
            }

            @Override
            public void fill(UiNode node, HtmlNode element) {
                List<Bar> slices = new ArrayList<>();
                if (node.props().get("items") instanceof List<?> items) {
                    slices.addAll(bars(items, null, null));
                }
                double total = 0;
                for (Bar slice : slices) {
                    total += Math.max(0, slice.value());
                }
                boolean empty = slices.isEmpty() || total <= 0;
                chartElement(element, node, "jhin-chart jhin-chart-pie", empty);
                if (empty) {
                    PropReflection.reflect(node, element, PIE_HANDLED);
                    return;
                }
                double cx = PIE_VIEW / 2;
                double cy = PIE_VIEW / 2;
                double radius = PIE_VIEW / 2 - PAD;
                if (slices.size() == 1) {
                    // A single full slice is a circle, never a degenerate arc.
                    HtmlNode circle = new HtmlNode("circle")
                            .attr("class", "jhin-chart-slice")
                            .attr("cx", num(cx))
                            .attr("cy", num(cy))
                            .attr("r", num(radius));
                    if (slices.get(0).color() != null) {
                        circle.attr("fill", slices.get(0).color());
                    }
                    if (slices.get(0).label() != null) {
                        circle.child(new HtmlNode("title").textChild(slices.get(0).label()));
                    }
                    element.child(circle);
                    PropReflection.reflect(node, element, PIE_HANDLED);
                    return;
                }
                double angle = -Math.PI / 2;
                for (Bar slice : slices) {
                    double fraction = Math.max(0, slice.value()) / total;
                    double sweep = fraction * 2 * Math.PI;
                    double end = angle + sweep;
                    double x0 = cx + radius * Math.cos(angle);
                    double y0 = cy + radius * Math.sin(angle);
                    double x1 = cx + radius * Math.cos(end);
                    double y1 = cy + radius * Math.sin(end);
                    int largeArc = sweep > Math.PI ? 1 : 0;
                    String d = "M " + num(cx) + " " + num(cy)
                            + " L " + num(x0) + " " + num(y0)
                            + " A " + num(radius) + " " + num(radius)
                            + " 0 " + largeArc + " 1 " + num(x1) + " " + num(y1)
                            + " Z";
                    HtmlNode path = new HtmlNode("path")
                            .attr("class", "jhin-chart-slice")
                            .attr("d", d);
                    if (slice.color() != null) {
                        path.attr("fill", slice.color());
                    }
                    if (slice.label() != null) {
                        path.child(new HtmlNode("title").textChild(slice.label()));
                    }
                    element.child(path);
                    angle = end;
                }
                PropReflection.reflect(node, element, PIE_HANDLED);
            }
        };
    }

    // --- geometry helpers -------------------------------------------------

    /** The shared {@code <svg>} shell: viewBox, role and the empty state. */
    private static void chartElement(HtmlNode element, UiNode node, String classes, boolean empty) {
        boolean pie = classes.contains("jhin-chart-pie");
        element.attr("class", empty ? classes + " jhin-chart-empty" : classes);
        double view = pie ? PIE_VIEW : VIEW_WIDTH;
        double height = pie ? PIE_VIEW : VIEW_HEIGHT;
        element.attr("viewBox", "0 0 " + num(view) + " " + num(height));
        if (node.props().get("label") != null) {
            element.attr("role", "img");
            element.attr("aria-label", String.valueOf(node.props().get("label")));
        } else {
            element.attr("aria-hidden", "true");
        }
    }

    /** Maps a value from the data range into the target range. */
    private static double scale(double value, double min, double max, double outMin, double outMax) {
        return outMin + (value - min) / (max - min) * (outMax - outMin);
    }

    /** A compact locale-independent number (integral values drop the fraction). */
    private static String num(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            return "0";
        }
        if (value == Math.floor(value) && Math.abs(value) < 1e15) {
            return Long.toString((long) value);
        }
        String formatted = String.format(Locale.ROOT, "%.2f", value);
        // Trim the trailing zeros of the fixed format ("1.50" -> "1.5").
        int end = formatted.length();
        while (end > 1 && formatted.charAt(end - 1) == '0') {
            end--;
        }
        if (formatted.charAt(end - 1) == '.') {
            end--;
        }
        return formatted.substring(0, end);
    }

    /** One parsed line series. */
    private record Series(String label, String color, List<Point> points) {
    }

    /** One point in the line chart's data space. */
    private record Point(double x, double y) {
    }

    /** One bar or pie slice. */
    private record Bar(String label, double value, String color) {
    }

    /**
     * Parses one {@code chart_line} series entry: {@code points} wins over
     * {@code values}; malformed entries degrade to no points (section 2.4).
     */
    private static Series series(Object entry) {
        if (!(entry instanceof Map<?, ?> map)) {
            return null;
        }
        List<Point> points = new ArrayList<>();
        if (map.get("points") instanceof List<?> raw) {
            for (Object value : raw) {
                Point parsed = parsePoint(value);
                if (parsed != null) {
                    points.add(parsed);
                }
            }
        } else if (map.get("values") instanceof List<?> values) {
            for (int i = 0; i < values.size(); i++) {
                Double y = asNumber(values.get(i));
                if (y != null) {
                    points.add(new Point(i, y));
                }
            }
        }
        return new Series(stringOrNull(map.get("label")), stringOrNull(map.get("color")), points);
    }

    /** One {@code [x, y]} pair or {@code {x, y}} map. */
    private static Point parsePoint(Object value) {
        if (value instanceof List<?> pair && pair.size() >= 2) {
            Double x = asNumber(pair.get(0));
            Double y = asNumber(pair.get(1));
            return x == null || y == null ? null : new Point(x, y);
        }
        if (value instanceof Map<?, ?> map) {
            Double x = asNumber(map.get("x"));
            Double y = asNumber(map.get("y"));
            return x == null || y == null ? null : new Point(x, y);
        }
        return null;
    }

    /** Parses the bar/slice entries ({@code {label, value, color?}}). */
    private static List<Bar> bars(List<?> items, String groupColor, String groupLabel) {
        List<Bar> bars = new ArrayList<>();
        for (Object item : items) {
            if (!(item instanceof Map<?, ?> map)) {
                continue;
            }
            Double value = asNumber(map.get("value"));
            if (value == null) {
                continue;
            }
            String label = stringOrNull(map.get("label"));
            String color = stringOrNull(map.get("color"));
            bars.add(new Bar(
                    label != null ? label : groupLabel,
                    value,
                    color != null ? color : groupColor));
        }
        return bars;
    }

    /** A number from the wire: {@code Number} or a numeric string. */
    private static Double asNumber(Object value) {
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        if (value instanceof String text) {
            try {
                return Double.parseDouble(text);
            } catch (NumberFormatException notANumber) {
                return null;
            }
        }
        return null;
    }

    private static String stringOrNull(Object value) {
        return value == null ? null : String.valueOf(value);
    }
}
