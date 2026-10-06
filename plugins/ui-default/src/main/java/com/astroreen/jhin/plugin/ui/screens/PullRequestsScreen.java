/**
 * The {@code pull-requests} screen (T113): the t3code pull-request list and
 * detail as a decorative full-page surface. The page header carries the
 * state filter and the refresh control; the body carries the pull-request
 * list (number, title, branch chip, status badge) and the detail card (the
 * {@code PullRequestDetailPanel} shell: the summary, the Summary / Timeline
 * / Code tabs over a decorative {@code diff_view}, the {@code Link to
 * thread} menu and the {@code Unlink} action). Every interactive node is
 * {@code demo: true} (plan section 14.10): the pull-request API is out of
 * scope (plan section 14.1), the fixtures are read at build time and never
 * fetched.
 *
 * <p>Upstream anchors (t3code {@code apps/web/src}, commit {@code 37de6cb}):
 * the list row is {@code components/pullRequest/PullRequestRow.tsx:96-160}
 * (the {@code #n} number, the title, the branch pair and the state glyph),
 * the row lines are {@code components/pullRequest/PullRequestListRow.tsx:
 * 76-165} (the number/title line over the branch line) and the detail tabs
 * are {@code components/pullRequest/PullRequestDetailPanel.tsx:244-248}
 * ({@code Summary}, {@code Timeline}, {@code Code}). The link control is
 * {@code components/pullRequest/PullRequestThreadLinks.tsx:136-157}
 * ({@code Link to thread} / {@code Unlink from this thread}). The port is
 * behavioural, not TSX (plan section 14.9): the same slots and metrics
 * authored as SDUI nodes.
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
import java.util.List;
import java.util.Map;

public final class PullRequestsScreen {

    /** The classpath fixture the screen renders from (plan section 4.8). */
    static final String FIXTURE = "fixtures/pull-requests-fixtures.json";

    /** The shell id. */
    public static final String SHELL_ID = "pull-requests-shell";

    /** The body container id. */
    public static final String BODY_ID = "pull-requests-body";

    /** The empty-state card id (the empty-fixture case). */
    public static final String EMPTY_ID = "pull-requests-empty";

    /** The detail card id. */
    public static final String DETAIL_ID = "pull-request-detail";

    /** The detail tab strip id. */
    public static final String DETAIL_TABS_ID = "pull-request-detail-tabs";

    /** The Link-to-thread menu id. */
    public static final String LINK_MENU_ID = "pull-request-link-menu";

    /** The demo wording of the decorative Link-to-thread menu. */
    static final String LINK_DEMO =
            "Preview only \u2014 pull requests are not linked to threads in this build";

    /** The demo wording of the decorative Unlink action. */
    static final String UNLINK_DEMO =
            "Preview only \u2014 pull requests are not unlinked in this build";

    /** The fixed shell breakpoint (plan T95 step 7). */
    public static final int BREAKPOINT = 768;

    private PullRequestsScreen() {
    }

    /**
     * Builds the {@code pull-requests} screen from the classpath fixture.
     *
     * @return the screen node
     */
    public static UiNode render() {
        return render(listOfMaps(fixture().get("pullRequests")));
    }

    /**
     * Builds the {@code pull-requests} screen from explicit fixture data (the
     * T113 seam): the public {@link #render()} loads the default fixture pack,
     * the tests pass an empty list to exercise the empty-state card.
     *
     * @param pullRequests the parsed {@code pull-requests-fixtures.json} list
     * @return the screen node
     */
    public static UiNode render(List<Map<String, Object>> pullRequests) {
        return Ui.screen()
                .title("Pull Requests")
                .body(Ui.shell()
                        .id(SHELL_ID)
                        .breakpoint(BREAKPOINT)
                        .topbar(topbar())
                        .topbarCompact(topbarCompact())
                        .pageHeader(pageHeader())
                        .body(body(pullRequests))
                        .build())
                .build();
    }

    /** The wide top bar: the wordmark, the breadcrumb and the app nav tabs. */
    private static UiNode topbar() {
        return Ui.row()
                .id("pull-requests-topbar")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text("Pull Requests").style("body").bold(true).build())
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
                .id("pull-requests-topbar-compact")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text("Pull Requests").style("body").build())
                .child(Ui.spacer().build())
                .build();
    }

    /**
     * The page header: the {@code Pull Requests} title, the state filter and
     * the refresh control. Both controls are decorative (the pull-request API
     * is out of scope).
     */
    private static UiNode pageHeader() {
        return Ui.row()
                .id("pull-requests-page-header")
                .align("center")
                .gap(8)
                .child(Ui.text("Pull Requests").style("h3").build())
                .child(Ui.spacer().build())
                .child(Ui.segmented()
                        .id("pullRequestState")
                        .segment("Open", "open")
                        .segment("Closed", "closed")
                        .segment("All", "all")
                        .value("open")
                        .set("demo", true)
                        .build())
                .child(Ui.iconButton()
                        .id("pullRequestsRefresh")
                        .icon("refresh")
                        .tooltip("Refresh pull requests")
                        .set("demo", true)
                        .action(Directives.client(List.of(Directives.toast(
                                "Preview only \u2014 pull requests are not refreshed in this build"))))
                        .build())
                .build();
    }

    /** The body: the empty state or the list and the detail card. */
    private static UiNode body(List<Map<String, Object>> pullRequests) {
        Ui.ContainerBuilder body = Ui.container()
                .id(BODY_ID)
                .direction("column")
                .gap(16)
                .padding(16);
        if (pullRequests.isEmpty()) {
            return body.child(emptyState()).build();
        }
        body.child(listCard(pullRequests));
        body.child(detailCard(pullRequests.get(0)));
        return body.build();
    }

    /**
     * The empty state (the empty-fixture case): a hero with the branch glyph,
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
                .child(Ui.icon().icon("call_merge").size(40)
                        .color("$color.muted-foreground").build())
                .child(Ui.text("No pull requests").style("h3").build())
                .child(Ui.text("Pull requests from every project in this workspace appear here.")
                        .style("caption").build())
                .build();
    }

    /** The pull-request list card: one row per fixture pull request. */
    private static UiNode listCard(List<Map<String, Object>> pullRequests) {
        Ui.ListBuilder list = Ui.list().id("pull-requests-list");
        for (Map<String, Object> pullRequest : pullRequests) {
            list.item(pullRequestRow(pullRequest));
        }
        return Ui.card()
                .title("Pull Requests")
                .child(list.build())
                .build();
    }

    /**
     * One pull-request row: the state glyph, the {@code #n title} line, the
     * branch chip and the status badge. The row is decorative (plan section
     * 14.10).
     */
    private static UiNode pullRequestRow(Map<String, Object> pullRequest) {
        int number = intOf(pullRequest.get("number"));
        String state = stateOf(pullRequest);
        return Ui.listRow()
                .id("pull-request-" + number)
                .leading(Ui.icon().icon(stateIcon(state)).size(20)
                        .color(stateColor(state)).build())
                .title("#" + number + " " + str(pullRequest.get("title")))
                .subtitle(Ui.row()
                        .align("center")
                        .gap(6)
                        .child(Ui.chip()
                                .label(str(pullRequest.get("headBranch")))
                                .icon("account_tree")
                                .build())
                        .child(Ui.text("\u2192 " + str(pullRequest.get("baseBranch")))
                                .style("mono").build())
                        .child(Ui.text(str(pullRequest.get("author")))
                                .style("caption").build())
                        .build())
                .trailing(Ui.row()
                        .align("center")
                        .gap(6)
                        .child(Ui.badge().label(stateLabel(state)).build())
                        .child(Ui.chip().label(reviewLabel(str(pullRequest.get("reviewDecision"))))
                                .build())
                        .build())
                .set("demo", true)
                .action(Directives.client(List.of(Directives.toast(
                        "Preview only \u2014 pull request #" + number + " is not opened in this build"))))
                .build();
    }

    /**
     * The detail card (the {@code PullRequestDetailPanel} shell): the summary
     * header, the Summary / Timeline / Code tabs over a decorative
     * {@code diff_view}, and the Link-to-thread menu plus the Unlink action.
     */
    private static UiNode detailCard(Map<String, Object> pullRequest) {
        return Ui.card()
                .id(DETAIL_ID)
                .title("Pull request detail")
                .child(summaryHeader(pullRequest))
                .child(Ui.tabs()
                        .id(DETAIL_TABS_ID)
                        .activeIndex(0)
                        .set("demo", true)
                        .item(Ui.tabItem("Summary").icon("description")
                                .panel(summaryPanel(pullRequest)))
                        .item(Ui.tabItem("Timeline").icon("history")
                                .panel(timelinePanel(pullRequest)))
                        .item(Ui.tabItem("Code").icon("difference")
                                .panel(codePanel(pullRequest)))
                        .build())
                .child(Ui.row()
                        .align("center")
                        .gap(8)
                        .child(linkMenu())
                        .child(Ui.button("Unlink")
                                .style("danger")
                                .icon("link_off")
                                .set("demo", true)
                                .action(Directives.client(List.of(Directives.toast(UNLINK_DEMO))))
                                .build())
                        .build())
                .build();
    }

    /** The detail summary header: the title, the state badge and the branch pair. */
    private static UiNode summaryHeader(Map<String, Object> pullRequest) {
        int number = intOf(pullRequest.get("number"));
        String state = stateOf(pullRequest);
        return Ui.column()
                .id("pull-request-summary-header")
                .gap(6)
                .child(Ui.row()
                        .align("center")
                        .gap(8)
                        .child(Ui.text("#" + number + " " + str(pullRequest.get("title")))
                                .style("h3").build())
                        .child(Ui.badge().label(stateLabel(state)).build())
                        .child(Ui.spacer().build())
                        .child(Ui.text("+" + intOf(pullRequest.get("additions"))
                                        + " \u2212" + intOf(pullRequest.get("deletions")))
                                .style("mono").build())
                        .build())
                .child(Ui.row()
                        .align("center")
                        .gap(6)
                        .child(Ui.chip()
                                .label(str(pullRequest.get("headBranch")))
                                .icon("account_tree")
                                .build())
                        .child(Ui.text("\u2192 " + str(pullRequest.get("baseBranch")))
                                .style("mono").build())
                        .child(Ui.text(str(pullRequest.get("author")) + " \u00b7 "
                                        + str(pullRequest.get("updatedAt")))
                                .style("caption").build())
                        .build())
                .build();
    }

    /** The Summary tab: the description and the changed-file count. */
    private static UiNode summaryPanel(Map<String, Object> pullRequest) {
        return Ui.column()
                .id("pull-request-summary-panel")
                .gap(8)
                .padding(8)
                .child(Ui.text(str(pullRequest.get("summary"))).style("body").build())
                .child(Ui.text(intOf(pullRequest.get("changedFiles")) + " changed files")
                        .style("caption").build())
                .build();
    }

    /** The Timeline tab: one row per fixture review. */
    private static UiNode timelinePanel(Map<String, Object> pullRequest) {
        Ui.ContainerBuilder rows = Ui.container().direction("column").gap(6).padding(8);
        for (Map<String, Object> review : listOfMaps(pullRequest.get("reviews"))) {
            rows.child(Ui.row()
                    .id("pull-request-review-" + str(review.get("author")))
                    .align("center")
                    .gap(8)
                    .child(Ui.avatar()
                            .initials(initialsOf(str(review.get("author"))))
                            .size(20)
                            .shape("circle")
                            .build())
                    .child(Ui.text(str(review.get("author"))).style("small").build())
                    .child(Ui.spacer().build())
                    .child(Ui.chip()
                            .label(reviewLabel(str(review.get("decision"))))
                            .build())
                    .child(Ui.text(str(review.get("at"))).style("caption").build())
                    .build());
        }
        return rows.build();
    }

    /**
     * The Code tab: the decorative {@code diff_view} (the {@code demo} marker
     * is mandatory on the primitive). The hunks are deterministic and derived
     * from the fixture's stats.
     */
    private static UiNode codePanel(Map<String, Object> pullRequest) {
        return Ui.diffView()
                .id("pull-request-diff")
                .file(str(pullRequest.get("headBranch")) + ".patch")
                .language("diff")
                .view("unified")
                .colorScheme("default")
                .stats(intOf(pullRequest.get("additions")), intOf(pullRequest.get("deletions")))
                .hunk(Ui.diffHunk("@@ -1,4 +1,6 @@")
                        .line(Ui.diffLine("ctx").oldNo(1).newNo(1)
                                .text("import { createFileRoute } from \"@tanstack/react-router\";"))
                        .line(Ui.diffLine("del").oldNo(2).text("import { UsagePage } from \"../components/usage/UsagePage\";"))
                        .line(Ui.diffLine("add").newNo(2).text("import { UsagePage } from \"../components/usage/UsagePage\";"))
                        .line(Ui.diffLine("add").newNo(3).text("import { UsageLimits } from \"../components/usage/UsageLimits\";"))
                        .line(Ui.diffLine("ctx").oldNo(3).newNo(4).text("export const Route = createFileRoute(\"/usage\")({"))
                        .build())
                .hunk(Ui.diffHunk("@@ -10,3 +12,4 @@")
                        .line(Ui.diffLine("ctx").oldNo(10).newNo(12).text("  component: UsagePage,"))
                        .line(Ui.diffLine("add").newNo(13).text("  loader: () => loadUsage(),"))
                        .line(Ui.diffLine("ctx").oldNo(11).newNo(14).text("});"))
                        .build())
                .demo(true)
                .build();
    }

    /**
     * The decorative {@code Link to thread} menu: the trigger button and the
     * link/unlink entries, all {@code demo: true} (plan section 14.10).
     */
    private static UiNode linkMenu() {
        return Ui.menu()
                .id(LINK_MENU_ID)
                .set("demo", true)
                .trigger(Ui.button("Link to thread")
                        .style("secondary")
                        .icon("link")
                        .set("demo", true)
                        .build())
                .item(Ui.menuItem("Link to this thread")
                        .icon("link")
                        .action(Directives.client(List.of(Directives.toast(LINK_DEMO))))
                        .build())
                .item(Ui.menuItem("Unlink from this thread")
                        .icon("link_off")
                        .danger(true)
                        .action(Directives.client(List.of(Directives.toast(UNLINK_DEMO))))
                        .build())
                .build();
    }

    // --- fixture loading and small helpers ---

    /**
     * The parsed {@code fixtures/pull-requests-fixtures.json} root. Loaded
     * from the classpath at build time; a missing resource is an authoring bug
     * and fails the build.
     *
     * @return the fixture root
     */
    static Map<String, Object> fixture() {
        try (InputStream in = PullRequestsScreen.class.getClassLoader()
                .getResourceAsStream(FIXTURE)) {
            if (in == null) {
                throw new IllegalStateException("missing classpath resource: " + FIXTURE);
            }
            return Json.readMap(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + FIXTURE, e);
        }
    }

    /** The resolved state of one pull request: {@code draft} wins over {@code open}. */
    private static String stateOf(Map<String, Object> pullRequest) {
        String state = str(pullRequest.get("state"));
        if ("open".equals(state) && bool(pullRequest.get("isDraft"))) {
            return "draft";
        }
        return state;
    }

    /** The state badge label (the upstream {@code PULL_REQUEST_STATE_PRESENTATION}). */
    private static String stateLabel(String state) {
        return switch (state) {
            case "open" -> "Open";
            case "draft" -> "Draft";
            case "merged" -> "Merged";
            case "closed" -> "Closed";
            default -> state;
        };
    }

    /** The state glyph icon name. */
    private static String stateIcon(String state) {
        return switch (state) {
            case "open" -> "call_merge";
            case "draft" -> "edit_note";
            case "merged" -> "merge";
            case "closed" -> "cancel";
            default -> "call_merge";
        };
    }

    /** The state glyph colour token. */
    private static String stateColor(String state) {
        return switch (state) {
            case "open" -> "$color.success";
            case "draft" -> "$color.muted-foreground";
            case "merged" -> "$color.primary";
            case "closed" -> "$color.destructive";
            default -> "$color.muted-foreground";
        };
    }

    /** The review-decision chip label (the upstream {@code reviewDecisionPresentation}). */
    private static String reviewLabel(String decision) {
        return switch (decision) {
            case "approved" -> "Approved";
            case "changes-requested" -> "Changes requested";
            case "review-required" -> "Awaiting review";
            default -> decision;
        };
    }

    /** The initials of one author login (the avatar fallback). */
    private static String initialsOf(String login) {
        if (login == null || login.isBlank()) {
            return "?";
        }
        String[] parts = login.split("[-_. ]+");
        StringBuilder initials = new StringBuilder();
        for (String part : parts) {
            if (!part.isEmpty() && initials.length() < 2) {
                initials.append(Character.toUpperCase(part.charAt(0)));
            }
        }
        return initials.length() == 0 ? "?" : initials.toString();
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

    /** One string field, the empty string when absent. */
    private static String str(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    /** One boolean field, {@code false} when absent. */
    private static boolean bool(Object value) {
        return value instanceof Boolean flag && flag;
    }

    /** One int field, {@code 0} when absent. */
    private static int intOf(Object value) {
        return value instanceof Number number ? number.intValue() : 0;
    }
}
