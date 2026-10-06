/**
 * The {@code usage} screen (T113): the t3code {@code UsagePage} as a
 * decorative full-page surface. The page header carries the metric and
 * period segmented controls and the refresh control; the body carries the
 * token summary, one meter card per provider (a {@code chart_line} over the
 * fixture's 30-day series), the limit-source meters and the per-provider
 * usage rows. Every interactive node is {@code demo: true} (plan section
 * 14.10): the usage metering backend is out of scope (plan section 14.1),
 * the fixtures are read at build time and never fetched.
 *
 * <p>Upstream anchors (t3code {@code apps/web/src}, commit {@code 37de6cb}):
 * the page header is {@code components/usage/UsagePage.tsx:326-461} (the
 * {@code WorkspaceBreadcrumb} with the {@code Usage} title, the metric and
 * period {@code ToggleGroup}s and the refresh button), the summary is
 * {@code :503-538} (the large token total over the session count), the
 * per-provider chart is {@code components/usage/UsageProviderChart.tsx}
 * (one polyline per provider over the window) and the limit meters are
 * {@code components/usage/UsageLimits.tsx:154-195} (the label, the percent
 * left, the bar and the reset countdown). The port is behavioural, not TSX
 * (plan section 14.9): the same slots and metrics authored as SDUI nodes.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class UsageScreen {

    /** The classpath fixture the screen renders from (plan section 4.8). */
    static final String FIXTURE = "fixtures/usage-fixtures.json";

    /** The shell id. */
    public static final String SHELL_ID = "usage-shell";

    /** The body container id. */
    public static final String BODY_ID = "usage-body";

    /** The empty-state card id (the empty-fixture case). */
    public static final String EMPTY_ID = "usage-empty";

    /** The decorative Add-usage-limit-source button id. */
    public static final String ADD_SOURCE_ID = "addUsageLimitSource";

    /** The Add-usage-limit-source dialog id. */
    public static final String ADD_SOURCE_DIALOG_ID = "add-usage-limit-source-dialog";

    /** The demo wording of the decorative Add-usage-limit-source button. */
    static final String ADD_SOURCE_DEMO =
            "Preview only \u2014 usage limit sources are not added in this build";

    /** The fixed shell breakpoint (plan T95 step 7). */
    public static final int BREAKPOINT = 768;

    private UsageScreen() {
    }

    /**
     * Builds the {@code usage} screen from the classpath fixture.
     *
     * @return the screen node
     */
    public static UiNode render() {
        Map<String, Object> fixture = fixture();
        return render(listOfMaps(fixture.get("providers")),
                listOfMaps(fixture.get("limitSources")));
    }

    /**
     * Builds the {@code usage} screen from explicit fixture data (the T113
     * seam): the public {@link #render()} loads the default fixture pack, the
     * tests pass empty lists to exercise the empty-state card.
     *
     * @param providers    the parsed {@code usage-fixtures.json} provider list
     * @param limitSources the parsed {@code usage-fixtures.json} limit sources
     * @return the screen node
     */
    public static UiNode render(List<Map<String, Object>> providers,
                                List<Map<String, Object>> limitSources) {
        return Ui.screen()
                .title("Usage")
                .body(Ui.shell()
                        .id(SHELL_ID)
                        .breakpoint(BREAKPOINT)
                        .topbar(topbar())
                        .topbarCompact(topbarCompact())
                        .pageHeader(pageHeader())
                        .body(body(providers, limitSources))
                        .build())
                .build();
    }

    /** The wide top bar: the wordmark, the breadcrumb and the app nav tabs. */
    private static UiNode topbar() {
        return Ui.row()
                .id("usage-topbar")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text("Usage").style("body").bold(true).build())
                .child(Ui.spacer().build())
                .child(Ui.nav()
                        .kind("tabs")
                        .item("Sessions", "sessions")
                        .item("Settings", "settings")
                        .item("Plugins", "plugins")
                        .build())
                .build();
    }

    /** The compact top bar below the breakpoint: the wordmark and the title. */
    private static UiNode topbarCompact() {
        return Ui.row()
                .id("usage-topbar-compact")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text("Usage").style("body").build())
                .child(Ui.spacer().build())
                .build();
    }

    /**
     * The page header: the {@code Usage} title, the metric and period
     * segmented controls and the refresh control. All three controls are
     * decorative (the usage backend is out of scope).
     */
    private static UiNode pageHeader() {
        return Ui.row()
                .id("usage-page-header")
                .align("center")
                .gap(8)
                .child(Ui.text("Usage").style("h3").build())
                .child(Ui.spacer().build())
                .child(Ui.segmented()
                        .id("usageMetric")
                        .segment("Tokens", "tokens")
                        .segment("Cost", "cost")
                        .segment("Limits", "limits")
                        .value("tokens")
                        .set("demo", true)
                        .build())
                .child(Ui.segmented()
                        .id("usagePeriod")
                        .segment("24h", "1")
                        .segment("7d", "7")
                        .segment("30d", "30")
                        .value("30")
                        .set("demo", true)
                        .build())
                .child(Ui.iconButton()
                        .id("usageRefresh")
                        .icon("refresh")
                        .tooltip("Refresh usage")
                        .set("demo", true)
                        .action(Directives.client(List.of(Directives.toast(
                                "Preview only \u2014 usage is not refreshed in this build"))))
                        .build())
                .build();
    }

    /** The body: the empty state or the summary, meters, limits and rows. */
    private static UiNode body(List<Map<String, Object>> providers,
                               List<Map<String, Object>> limitSources) {
        Ui.ContainerBuilder body = Ui.container()
                .id(BODY_ID)
                .direction("column")
                .gap(16)
                .padding(16);
        if (providers.isEmpty() && limitSources.isEmpty()) {
            return body.child(emptyState()).build();
        }
        body.child(summaryCard(providers));
        for (Map<String, Object> provider : providers) {
            body.child(meterCard(provider));
        }
        body.child(limitsCard(limitSources));
        body.child(providersCard(providers));
        body.child(addSourceButton());
        return body.build();
    }

    /**
     * The empty state (the empty-fixture case): a hero with the chart glyph,
     * the title and the description, never a blank screen. Upstream anchor:
     * {@code components/pullRequest/PullRequestListEmptyState.tsx:101-118}
     * (the {@code NoProjectsHero} shape).
     */
    private static UiNode emptyState() {
        return Ui.column()
                .id(EMPTY_ID)
                .align("center")
                .gap(8)
                .padding(32)
                .child(Ui.icon().icon("bar_chart").size(40)
                        .color("$color.muted-foreground").build())
                .child(Ui.text("No usage yet").style("h3").build())
                .child(Ui.text("Connect a provider to see token usage and limits.")
                        .style("caption").build())
                .build();
    }

    /** The summary card: the large token total over the session count. */
    private static UiNode summaryCard(List<Map<String, Object>> providers) {
        long totalTokens = 0;
        int sessions = 0;
        for (Map<String, Object> provider : providers) {
            totalTokens += longOf(provider.get("totalTokens"));
            sessions += intOf(provider.get("sessions"));
        }
        return Ui.card()
                .title("Usage")
                .child(Ui.row()
                        .align("center")
                        .gap(16)
                        .child(Ui.column()
                                .gap(2)
                                .child(Ui.text(formatTokens(totalTokens)).style("h1").build())
                                .child(Ui.text(sessions + " sessions").style("caption").build())
                                .build())
                        .child(Ui.spacer().build())
                        .child(Ui.text("Last 30 days").style("caption").build())
                        .build())
                .build();
    }

    /**
     * One provider meter card: the token total and cost over the provider's
     * 30-day {@code chart_line} series.
     */
    private static UiNode meterCard(Map<String, Object> provider) {
        String id = str(provider.get("id"));
        return Ui.card()
                .title(str(provider.get("label")))
                .child(Ui.row()
                        .align("center")
                        .gap(8)
                        .child(Ui.text(formatTokens(longOf(provider.get("totalTokens"))))
                                .style("h2").build())
                        .child(Ui.spacer().build())
                        .child(Ui.text(formatUsd(doubleOf(provider.get("costUsd"))))
                                .style("caption").build())
                        .build())
                .child(Ui.chartLine()
                        .id("usage-chart-" + id)
                        .series(List.of(seriesEntry(str(provider.get("label")),
                                listOf(provider.get("daily")))))
                        .build())
                .build();
    }

    /** The limits card: one meter row per limit source. */
    private static UiNode limitsCard(List<Map<String, Object>> limitSources) {
        Ui.ContainerBuilder rows = Ui.container().direction("column").gap(8);
        for (Map<String, Object> source : limitSources) {
            rows.child(limitRow(source));
        }
        return Ui.card()
                .title("Limits")
                .child(rows.build())
                .build();
    }

    /** One limit-source row: the label, the percent left, the bar and the reset. */
    private static UiNode limitRow(Map<String, Object> source) {
        int remaining = intOf(source.get("remainingPercent"));
        return Ui.row()
                .id("limit-" + str(source.get("id")))
                .align("center")
                .gap(8)
                .child(Ui.text(str(source.get("provider")) + " \u00b7 "
                                + str(source.get("label")))
                        .style("small").build())
                .child(Ui.spacer().build())
                .child(Ui.text(remaining + "% left").style("caption").build())
                .child(Ui.progress()
                        .kind("linear")
                        .value(remaining / 100.0)
                        .width(120)
                        .build())
                .child(Ui.text(str(source.get("resetsIn"))).style("caption").build())
                .build();
    }

    /** The per-provider usage rows. */
    private static UiNode providersCard(List<Map<String, Object>> providers) {
        Ui.ListBuilder list = Ui.list().id("usage-providers");
        for (Map<String, Object> provider : providers) {
            list.item(providerRow(provider));
        }
        return Ui.card()
                .title("Providers")
                .child(list.build())
                .build();
    }

    /** One provider row: the glyph, the label, the token/session line and the cost. */
    private static UiNode providerRow(Map<String, Object> provider) {
        String id = str(provider.get("id"));
        return Ui.listRow()
                .id("usage-provider-" + id)
                .leading(Ui.icon().icon(providerIcon(id)).size(20).build())
                .title(str(provider.get("label")))
                .subtitle(formatTokens(longOf(provider.get("totalTokens"))) + " tokens \u00b7 "
                        + intOf(provider.get("sessions")) + " sessions")
                .trailing(Ui.text(formatUsd(doubleOf(provider.get("costUsd"))))
                        .style("caption").build())
                .set("demo", true)
                .build();
    }

    /**
     * The decorative {@code Add usage limit source} button: it opens the
     * dialog shell and carries {@code demo: true} (plan section 14.10).
     */
    private static UiNode addSourceButton() {
        return Ui.button("Add usage limit source")
                .id(ADD_SOURCE_ID)
                .style("secondary")
                .icon("add")
                .set("demo", true)
                .action(Directives.dialog(addSourceDialog().toJson()))
                .build();
    }

    /** The Add-usage-limit-source dialog shell: a decorative form and actions. */
    private static UiNode addSourceDialog() {
        return Ui.dialog()
                .id(ADD_SOURCE_DIALOG_ID)
                .title("Add usage limit source")
                .content(Ui.column()
                        .gap(12)
                        .child(Ui.dropdown("limitSourceProvider")
                                .hint("Provider")
                                .item("Codex", "codex")
                                .item("Claude Code", "claude")
                                .value("codex")
                                .set("demo", true)
                                .build())
                        .child(Ui.input("limitSourceLabel")
                                .label("Limit label")
                                .value("Weekly")
                                .placeholder("Weekly")
                                .set("demo", true)
                                .build())
                        .build())
                .action(Ui.button("Cancel")
                        .style("text")
                        .set("demo", true)
                        .action(Directives.dismissDialog())
                        .build())
                .action(Ui.button("Add source")
                        .style("primary")
                        .set("demo", true)
                        .action(Directives.client(List.of(
                                Directives.toast(ADD_SOURCE_DEMO),
                                Directives.dismissDialog())))
                        .build())
                .build();
    }

    // --- fixture loading and small helpers ---

    /**
     * The parsed {@code fixtures/usage-fixtures.json} root. Loaded from the
     * classpath at build time; a missing resource is an authoring bug and
     * fails the build.
     *
     * @return the fixture root
     */
    static Map<String, Object> fixture() {
        try (InputStream in = UsageScreen.class.getClassLoader()
                .getResourceAsStream(FIXTURE)) {
            if (in == null) {
                throw new IllegalStateException("missing classpath resource: " + FIXTURE);
            }
            return Json.readMap(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + FIXTURE, e);
        }
    }

    /** One {@code chart_line} series entry ({@code {label, values}}). */
    private static Map<String, Object> seriesEntry(String label, List<Object> values) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("label", label);
        entry.put("values", values);
        return entry;
    }

    /** The icon of one provider id. */
    private static String providerIcon(String id) {
        return switch (id) {
            case "codex" -> "smart_toy";
            case "claude" -> "auto_awesome";
            default -> "memory";
        };
    }

    /** A token count as a compact {@code 2.5M} / {@code 12.3K} label. */
    static String formatTokens(long tokens) {
        if (tokens >= 1_000_000) {
            return String.format("%.1fM", tokens / 1_000_000.0);
        }
        if (tokens >= 1_000) {
            return String.format("%.1fK", tokens / 1_000.0);
        }
        return String.valueOf(tokens);
    }

    /** A USD amount as a {@code $18.75} label. */
    static String formatUsd(double usd) {
        return String.format("$%.2f", usd);
    }

    /** A JSON list value as a list of maps (non-map entries dropped). */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> listOfMaps(Object value) {
        if (!(value instanceof List<?> list)) {
            return List.of();
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                out.add((Map<String, Object>) map);
            }
        }
        return out;
    }

    /** A JSON list value as an immutable list (non-list values become empty). */
    private static List<Object> listOf(Object value) {
        return value instanceof List<?> list ? List.copyOf(list) : List.of();
    }

    /** One string field, the empty string when absent. */
    private static String str(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    /** One int field, {@code 0} when absent. */
    private static int intOf(Object value) {
        return value instanceof Number number ? number.intValue() : 0;
    }

    /** One long field, {@code 0} when absent. */
    private static long longOf(Object value) {
        return value instanceof Number number ? number.longValue() : 0L;
    }

    /** One double field, {@code 0} when absent. */
    private static double doubleOf(Object value) {
        return value instanceof Number number ? number.doubleValue() : 0.0;
    }
}
