/**
 * The right panel of the chat screen (T105): the tab strip with per-tab
 * close buttons over the {@code ThreadDetailsPanel} shell.
 *
 * <p><b>Chrome.</b> The panel is a {@code positioned} overlay docked to the
 * right edge of the chat frame, layered above the content (the upstream
 * {@code --z-sheet} 46, index.css:115). It is gated by the chat header's
 * {@code setState} toggle ({@link ChatScreen#STATE_RIGHT_PANEL}): the slot
 * carries {@code when: chat_right_panel == true}, so the toggle opens it and
 * closing the last tab hides it again. The panel paints the sidebar surface
 * ({@code $color.sidebar}) with the {@code border-l} hairline
 * ({@code $color.sidebar-border}) at the upstream
 * {@code --thread-details-panel-width} 17.5rem (index.css:129, the
 * {@code layout.threadDetailsPanelWidth} token value).
 *
 * <p><b>Tab bar.</b> The six upstream tab kinds — {@code Details},
 * {@code Diff}, {@code Files}, {@code Preview}, {@code Pull Requests},
 * {@code Usage} — are a {@code tabs} node with {@code hasClose: true}: each
 * item carries an icon, a label and a close {@code X} (the upstream
 * {@code PanelTabCloseButton}, {@code size-4} = 16&nbsp;px hit target,
 * {@code components/ui/panel-tab-close-button.tsx:20-27}). The active tab
 * uses {@code sidebar-row-active}, the inactive label
 * {@code sidebar-muted-foreground}, gap 1 and the {@code px-3 py-2} inset
 * (the upstream {@code gap-1 ... pr-2 pl-1.5 text-xs} row,
 * {@code RightPanelTabs.tsx:1109-1114}). Closing a tab is a client-side
 * {@code patch} on the tabs node's {@code id}; the last close runs the node
 * {@code closeAction} (the panel {@code setState} off). A tab marked
 * {@code closable: false} is a no-op (the pinned case).
 *
 * <p><b>Details tab.</b> The {@code ThreadDetailsPanel} shell (T105.2): the
 * thread title with its status indicator, the model / effort / provider
 * label rows, the created / updated / settled timing rows, the decorative
 * {@code ThreadRelationshipsControl} (parent / child rows) and the
 * decorative {@code ThreadDetailsPrRows} with the {@code Link to thread}
 * menu entries. Every interactive node is {@code demo}-marked and dispatches
 * inline directives only (never a database write, plan section 14.10).
 *
 * <p><b>Diff / Files / Preview tabs (T107).</b> The three decorative
 * surfaces are seeded from the deterministic fixture pack (plan section 4.8):
 * {@code fixtures/diff-fixtures.json} (3 files &times; 3 hunks with
 * add/del/ctx lines and stats, both colour schemes) and
 * {@code fixtures/files-fixtures.json} (the changed-files tree with A/M/D
 * badges and line stats). The Diff tab is the file-list header (the changed
 * count, the total stat, the copy-path button and the unified/split toggle)
 * over one {@code diff_view} per changed file; the Files tab is a
 * {@code tree} whose file rows are inline {@code setState} selectors that
 * {@code patch} the Diff tab's {@code diff_view} to that file; the Preview
 * tab is a syntax-highlighted {@code code_block} with a decorative
 * {@code Open in…} button. There is no diff engine, no git operation and no
 * file read (plan section 14.1): the fixtures are loaded at build time and
 * never fetched at runtime. Every interactive node is {@code demo}-marked.
 * An empty fixture renders the empty-state card, never a blank tab.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class RightPanelBuilder {

    /** The positioned overlay slot id (the {@code when} carrier). */
    public static final String SLOT_ID = "right-panel-slot";

    /** The panel surface id (the width / background / border carrier). */
    public static final String PANEL_ID = "right-panel";

    /** The tabs node id (the patch target of a tab close). */
    public static final String TABS_ID = "right-panel-tabs";

    /** The Details tab body id. */
    public static final String DETAILS_ID = "right-panel-details";

    /** The Details tab status badge id. */
    public static final String STATUS_ID = "right-panel-status";

    /** The relationships section id (the decorative control shell). */
    public static final String RELATIONSHIPS_ID = "right-panel-relationships";

    /** The pull-requests section id (the decorative PR rows shell). */
    public static final String PRS_ID = "right-panel-prs";

    /** The Diff tab body id (T107). */
    public static final String DIFF_ID = "right-panel-diff";

    /** The Diff tab file-list header id (T107). */
    public static final String DIFF_HEADER_ID = "right-panel-diff-header";

    /** The Diff tab copy-path button id (T107). */
    public static final String DIFF_COPY_ID = "right-panel-diff-copy";

    /** The Diff tab {@code diff_view} id (the Files-tab patch target, T107). */
    public static final String DIFF_VIEW_ID = "right-panel-diff-view";

    /** The Files tab body id (T107). */
    public static final String FILES_ID = "right-panel-files";

    /** The Files tab {@code tree} id (T107). */
    public static final String FILES_TREE_ID = "right-panel-files-tree";

    /** The Preview tab body id (T107). */
    public static final String PREVIEW_ID = "right-panel-preview";

    /** The Preview tab header row id (T107). */
    public static final String PREVIEW_HEADER_ID = "right-panel-preview-header";

    /** The Preview tab {@code code_block} id (T107). */
    public static final String PREVIEW_CODE_ID = "right-panel-preview-code";

    /** The Preview tab decorative {@code Open in…} button id (T107). */
    public static final String PREVIEW_OPEN_ID = "right-panel-preview-open";

    /** The T108 browser-preview section id (the URL bar + progress + viewport). */
    public static final String PREVIEW_BROWSER_ID = "right-panel-preview-browser";

    /** The T108 URL-bar row id. */
    public static final String PREVIEW_URL_BAR_ID = "right-panel-preview-url-bar";

    /** The T108 URL input id (the UiState field the reload action includes). */
    public static final String PREVIEW_URL_ID = "preview_url";

    /** The T108 decorative Reload button id. */
    public static final String PREVIEW_RELOAD_ID = "right-panel-preview-reload";

    /** The T108 preview-loading progress bar id (the reload patch target). */
    public static final String PREVIEW_PROGRESS_ID = "right-panel-preview-progress";

    /** The T108 viewport placeholder id. */
    public static final String PREVIEW_VIEWPORT_ID = "right-panel-preview-viewport";

    /** The T108 viewport illustration figure id. */
    public static final String PREVIEW_FIGURE_ID = "right-panel-preview-figure";

    /** The T108 file-preview section id (the retained T107 code block). */
    public static final String PREVIEW_FILE_ID = "right-panel-preview-file";

    /** The T108 URL-bar fixture value (the demo address). */
    public static final String PREVIEW_URL_VALUE = "http://localhost:5173";

    /** The T108 URL-bar validation text (the empty-URL failure path). */
    public static final String PREVIEW_URL_ERROR = "Enter a URL to preview";

    /** The T108 preview-loading mode (the upstream keyframe). */
    public static final String PREVIEW_LOADING_MODE = "preview-loading";

    /** The empty-state card ids of the three T107 tabs. */
    public static final String DIFF_EMPTY_ID = "right-panel-diff-empty";
    public static final String FILES_EMPTY_ID = "right-panel-files-empty";
    public static final String PREVIEW_EMPTY_ID = "right-panel-preview-empty";

    /** The UiState id of the selected changed file (the Files-tab selector). */
    public static final String STATE_DIFF_FILE = "chat_diff_file";

    /** The UiState id of the selected diff layout (the unified/split toggle). */
    public static final String STATE_DIFF_VIEW = "chat_diff_view";

    /** The diff fixture resource (plan section 4.8). */
    public static final String DIFF_FIXTURE = "fixtures/diff-fixtures.json";

    /** The changed-files fixture resource (plan section 4.8). */
    public static final String FILES_FIXTURE = "fixtures/files-fixtures.json";

    /** The empty diff fixture resource (the T107 empty-state case). */
    public static final String EMPTY_DIFF_FIXTURE = "fixtures/empty-diff-fixtures.json";

    /** The empty changed-files fixture resource (the T107 empty-state case). */
    public static final String EMPTY_FILES_FIXTURE = "fixtures/empty-files-fixtures.json";

    /**
     * The panel width: the upstream {@code --thread-details-panel-width}
     * default (17.5rem, index.css:129; the {@code layout.threadDetailsPanelWidth}
     * token value). The client parses the length against its interface
     * font-size rem base (the {@code container.panelWidth} prop).
     */
    public static final String PANEL_WIDTH = "17.5rem";

    /** The timestamp label format (the upstream panel's local clock). */
    private static final DateTimeFormatter TIMESTAMP =
            DateTimeFormatter.ofPattern("MMM d, h:mm a", Locale.ROOT);

    private RightPanelBuilder() {
    }

    /**
     * Builds the right-panel overlay of one chat session.
     *
     * @param session the session the chat screen is opened for
     * @param status  the run status label ({@link MessageCardBuilder#STATUS_IDLE},
     *                {@link MessageCardBuilder#STATUS_RUNNING} or
     *                {@link MessageCardBuilder#STATUS_LIMITED})
     * @return the positioned overlay slot carrying the panel
     */
    public static UiNode build(Session session, String status) {
        return build(session, status, diffFiles(), filesTree());
    }

    /**
     * Builds the right-panel overlay from explicit fixture data (the T107
     * seam): the public {@link #build(Session, String)} loads the default
     * fixture pack, the tests pass an empty list to exercise the empty-state
     * card.
     *
     * @param session    the session the chat screen is opened for
     * @param status     the run status label
     * @param diffFiles  the parsed {@code diff-fixtures.json} file list
     * @param filesTree  the parsed {@code files-fixtures.json} tree
     * @return the positioned overlay slot carrying the panel
     */
    public static UiNode build(Session session, String status,
                        List<Map<String, Object>> diffFiles,
                        List<Map<String, Object>> filesTree) {        return Ui.positioned()
                .id(SLOT_ID)
                .top(0)
                .right(0)
                .bottom(0)
                .when(ChatScreen.STATE_RIGHT_PANEL + " == true")
                .child(panel(session, status, diffFiles, filesTree))
                .build();
    }

    /** The panel surface: the sidebar fill, the left hairline and the tab strip. */
    private static UiNode panel(Session session, String status,
                                List<Map<String, Object>> diffFiles,
                                List<Map<String, Object>> filesTree) {
        return Ui.container()
                .id(PANEL_ID)
                .direction("column")
                .gap(0)
                .set("panelWidth", PANEL_WIDTH)
                .color("$color.sidebar")
                .border("$color.sidebar-border")
                .borderWidth(1)
                .child(tabStrip(session, status, diffFiles, filesTree))
                .build();
    }

    /**
     * The tab strip: the six upstream panel tabs with close buttons. The
     * node's {@code closeAction} runs when the last closable tab closes,
     * flipping the panel's {@code when} condition off (the panel close).
     */
    private static UiNode tabStrip(Session session, String status,
                                   List<Map<String, Object>> diffFiles,
                                   List<Map<String, Object>> filesTree) {
        return Ui.tabs()
                .id(TABS_ID)
                .activeIndex(0)
                .hasClose(true)
                .closeAction(Directives.setState(ChatScreen.STATE_RIGHT_PANEL, false))
                .set("demo", true)
                .item(Ui.tabItem("Details").icon("info").panel(details(session, status)))
                .item(Ui.tabItem("Diff").icon("difference").panel(diffTab(diffFiles)))
                .item(Ui.tabItem("Files").icon("folder")
                        .panel(filesTab(filesTree, diffFiles)))
                .item(Ui.tabItem("Preview").icon("public").panel(previewTab(diffFiles)))
                .item(emptyTab("Pull Requests", "call_merge", "No linked pull requests."))
                .item(emptyTab("Usage", "bar_chart", "No usage recorded."))
                .build();
    }

    /** One not-yet-implemented tab: the icon plus the empty-state body. */
    private static Ui.TabItemBuilder emptyTab(String label, String icon, String message) {
        return Ui.tabItem(label).icon(icon).panel(emptyState(message));
    }

    /** The empty-state body of a tab whose phase-E/F owner has not landed. */
    private static UiNode emptyState(String message) {
        return Ui.column()
                .padding(12)
                .child(Ui.text(message)
                        .fontSize(12)
                        .color("$color.sidebar-muted-foreground")
                        .build())
                .build();
    }

    // --- T107: the Diff / Files / Preview tabs ---

    /**
     * The Diff tab: the file-list header (the changed count, the total stat,
     * the copy-path button and the unified/split toggle) over the selected
     * file's {@code diff_view}. An empty fixture renders the empty-state
     * card, never a blank tab.
     */
    private static UiNode diffTab(List<Map<String, Object>> files) {
        if (files.isEmpty()) {
            return emptyCard(DIFF_EMPTY_ID, "No changes yet.",
                    "This build has no diff engine.");
        }
        return Ui.column()
                .id(DIFF_ID)
                .gap(8)
                .padding(12)
                .child(diffHeader(files))
                .child(diffView(files.get(0)))
                .build();
    }

    /** The Diff tab file-list header: the count, the total stat and the controls. */
    private static UiNode diffHeader(List<Map<String, Object>> files) {
        int additions = 0;
        int deletions = 0;
        for (Map<String, Object> file : files) {
            additions += intOf(file.get("stats"), "additions");
            deletions += intOf(file.get("stats"), "deletions");
        }
        return Ui.row()
                .id(DIFF_HEADER_ID)
                .align("center")
                .gap(8)
                .child(Ui.text(files.size()
                                + (files.size() == 1 ? " changed file" : " changed files"))
                        .fontSize(12)
                        .fontWeight(600)
                        .build())
                .child(Ui.text("+" + additions)
                        .fontSize(12)
                        .color("$color.diff-addition-foreground")
                        .build())
                .child(Ui.text("-" + deletions)
                        .fontSize(12)
                        .color("$color.diff-deletion-foreground")
                        .build())
                .child(Ui.spacer().build())
                .child(copyPathButton())
                .child(viewToggle("unified", "table_rows", "Unified view"))
                .child(viewToggle("split", "view_column", "Split view"))
                .build();
    }

    /** The decorative copy-path button (toasts the preview notice). */
    private static UiNode copyPathButton() {
        return Ui.iconButton()
                .id(DIFF_COPY_ID)
                .icon("content_copy")
                .iconSize(16)
                .tooltip("Copy path")
                .action(Directives.client(List.of(
                        Directives.toast("Copied path (preview only)"))))
                .set("demo", true)
                .build();
    }

    /**
     * One unified/split toggle button: the inline {@code setState} plus the
     * {@code patch} on the {@code diff_view} node — no server round-trip
     * (plan section 4.4).
     */
    private static UiNode viewToggle(String view, String icon, String tooltip) {
        return Ui.iconButton()
                .id(DIFF_VIEW_ID + "-toggle-" + view)
                .icon(icon)
                .iconSize(16)
                .tooltip(tooltip)
                .action(Directives.client(List.of(
                        Directives.setState(STATE_DIFF_VIEW, view),
                        Directives.patch(DIFF_VIEW_ID, Map.of("view", view)))))
                .set("demo", true)
                .build();
    }

    /**
     * One fixture {@code diff_view}: the file path, the language, the stat
     * header and the fixture hunks. The {@code colorScheme} prop is left
     * unset so the ambient {@code data-diff-color-scheme} switch (T86)
     * applies the blue-orange mapping.
     */
    private static UiNode diffView(Map<String, Object> file) {
        Ui.DiffViewBuilder builder = Ui.diffView()
                .id(DIFF_VIEW_ID)
                .file(str(file.get("path")))
                .language(str(file.get("language")))
                .stats(intOf(file.get("stats"), "additions"),
                        intOf(file.get("stats"), "deletions"))
                .demo(true);
        for (Map<String, Object> hunk : listOfMaps(file.get("hunks"))) {
            builder.hunk(hunk);
        }
        return builder.build();
    }

    /**
     * The Files tab: the changed-files {@code tree}. Each file row carries
     * the A/M/D status badge and the {@code +n −m} line stats, and its tap
     * is an inline {@code setState} selector that {@code patch}es the Diff
     * tab's {@code diff_view} to that file. An empty fixture renders the
     * empty-state card.
     */
    private static UiNode filesTab(List<Map<String, Object>> tree,
                                   List<Map<String, Object>> diffFiles) {
        if (tree.isEmpty()) {
            return emptyCard(FILES_EMPTY_ID, "No changed files.",
                    "This build has no diff engine.");
        }
        return Ui.column()
                .id(FILES_ID)
                .gap(8)
                .padding(12)
                .child(Ui.text("Changed files")
                        .fontSize(12)
                        .fontWeight(600)
                        .build())
                .child(Ui.tree()
                        .id(FILES_TREE_ID)
                        .set("items", treeItems(tree, diffFiles))
                        .build())
                .build();
    }

    /** Maps the fixture tree to {@code tree} item specs, recursively. */
    private static List<Object> treeItems(List<Map<String, Object>> nodes,
                                          List<Map<String, Object>> diffFiles) {
        List<Object> items = new ArrayList<>();
        for (Map<String, Object> node : nodes) {
            items.add(treeItem(node, diffFiles));
        }
        return items;
    }

    /** One {@code tree} item: a directory node or a file leaf. */
    private static Map<String, Object> treeItem(Map<String, Object> node,
                                                List<Map<String, Object>> diffFiles) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("label", str(node.get("label")));
        if (node.get("icon") != null) {
            item.put("icon", str(node.get("icon")));
        }
        if (node.get("expanded") != null) {
            item.put("expanded", node.get("expanded"));
        }
        if (node.get("items") instanceof List<?> children) {
            item.put("items", treeItems(listOfMaps(children), diffFiles));
            return item;
        }
        String path = str(node.get("path"));
        item.put("path", path);
        item.put("icon", "description");
        item.put("badge", statusBadge(str(node.get("status"))));
        item.put("stat", "+" + intOf(node, "additions")
                + " \u2212" + intOf(node, "deletions"));
        item.put("action", Directives.client(List.of(
                Directives.setState(STATE_DIFF_FILE, path),
                Directives.patch(DIFF_VIEW_ID, diffViewPatch(path, diffFiles)))));
        return item;
    }

    /** The A/M/D status badge of one changed file. */
    private static UiNode statusBadge(String status) {
        Ui.BadgeBuilder badge = Ui.badge().label(status);
        switch (status) {
            case "A" -> badge.color("$color.diff-addition-foreground");
            case "D" -> badge.color("$color.diff-deletion-foreground");
            default -> badge.color("$color.sidebar-muted-foreground");
        }
        return badge.build();
    }

    /** The {@code diff_view} patch props of one changed file (matched by path). */
    private static Map<String, Object> diffViewPatch(String path,
                                                     List<Map<String, Object>> diffFiles) {
        for (Map<String, Object> file : diffFiles) {
            if (path.equals(str(file.get("path")))) {
                Map<String, Object> patch = new LinkedHashMap<>();
                patch.put("file", str(file.get("path")));
                patch.put("language", str(file.get("language")));
                patch.put("stats", file.get("stats"));
                patch.put("hunks", file.get("hunks"));
                return patch;
            }
        }
        return Map.of();
    }

    /**
     * The Preview tab (T108): the browser-preview chrome — the URL bar with
     * the decorative Reload button, the {@code preview-loading} progress bar
     * and the illustrated viewport placeholder — over the retained T107 file
     * preview (the syntax-highlighted {@code code_block} with the decorative
     * {@code Open in…} button). An empty fixture renders the file-preview
     * empty-state card, never a blank tab.
     */
    private static UiNode previewTab(List<Map<String, Object>> files) {
        Ui.ColumnBuilder column = Ui.column()
                .id(PREVIEW_ID)
                .gap(8)
                .padding(12)
                .child(browserPreview());
        if (files.isEmpty()) {
            column.child(emptyCard(PREVIEW_EMPTY_ID, "No file to preview.",
                    "This build has no file preview."));
        } else {
            column.child(filePreview(files));
        }
        return column.build();
    }

    /**
     * The T108 browser-preview chrome: the URL bar, the loading progress bar
     * and the viewport placeholder. There is no browser automation (plan
     * section 14.1): the URL is a read-only fixture value, the Reload button
     * is a {@code demo} server action whose empty-URL validation is the
     * client's own, and the viewport is an illustrated placeholder.
     */
    private static UiNode browserPreview() {
        return Ui.column()
                .id(PREVIEW_BROWSER_ID)
                .gap(8)
                .child(urlBar())
                .child(progressBar())
                .child(viewport())
                .build();
    }

    /**
     * The URL bar: the read-only address input (the fixture URL) and the
     * decorative Reload icon button. The input is {@code required} with the
     * T108 error text, so the client's {@code ActionDispatcher} blocks the
     * reload on an empty address and shows the validation text instead of
     * animating (the {@code --fail} path).
     */
    private static UiNode urlBar() {
        return Ui.row()
                .id(PREVIEW_URL_BAR_ID)
                .align("center")
                .gap(8)
                .child(Ui.input(PREVIEW_URL_ID)
                        .value(PREVIEW_URL_VALUE)
                        .placeholder("Search or enter URL")
                        .readOnly(true)
                        .required(true)
                        .errorText(PREVIEW_URL_ERROR)
                        .flex(1)
                        .build())
                .child(Ui.iconButton()
                        .id(PREVIEW_RELOAD_ID)
                        .icon("refresh")
                        .iconSize(16)
                        .tooltip("Reload")
                        .action(ActionDescriptors.of("preview-reload", null,
                                List.of(PREVIEW_URL_ID)))
                        .set("demo", true)
                        .build())
                .build();
    }

    /**
     * The top progress bar: the T108 {@code preview-loading} mode, hidden
     * until the reload action patches {@code loading: true} (the upstream
     * {@code data-loading} attribute).
     */
    private static UiNode progressBar() {
        return Ui.progress()
                .id(PREVIEW_PROGRESS_ID)
                .kind("linear")
                .statusPulse(PREVIEW_LOADING_MODE)
                .loading(false)
                .build();
    }

    /**
     * The viewport placeholder: the illustrated {@code figure} over the
     * "Preview is not available in this build" copy (the upstream
     * {@code PreviewPanel} unavailable state, {@code PreviewPanel.tsx:31-40}).
     */
    private static UiNode viewport() {
        return Ui.column()
                .id(PREVIEW_VIEWPORT_ID)
                .align("center")
                .gap(8)
                .padding(24)
                .child(Ui.figure()
                        .id(PREVIEW_FIGURE_ID)
                        .shape("rectangle")
                        .color("$color.muted")
                        .width(160)
                        .height(96)
                        .build())
                .child(Ui.text("Preview is not available in this build")
                        .fontSize(13)
                        .fontWeight(600)
                        .build())
                .child(Ui.text("Browser previews are only available in the desktop app.")
                        .fontSize(12)
                        .color("$color.sidebar-muted-foreground")
                        .build())
                .build();
    }

    /**
     * The retained T107 file preview: the file path header with the
     * decorative {@code Open in…} button over the syntax-highlighted
     * {@code code_block} of the first fixture file.
     */
    private static UiNode filePreview(List<Map<String, Object>> files) {
        Map<String, Object> first = files.get(0);
        return Ui.column()
                .id(PREVIEW_FILE_ID)
                .gap(8)
                .child(Ui.row()
                        .id(PREVIEW_HEADER_ID)
                        .align("center")
                        .gap(8)
                        .child(Ui.text(str(first.get("path")))
                                .fontSize(12)
                                .fontWeight(600)
                                .maxLines(1)
                                .ellipsis(true)
                                .flex(1)
                                .build())
                        .child(Ui.button("Open in\u2026")
                                .id(PREVIEW_OPEN_ID)
                                .icon("open_in_new")
                                .style("text")
                                .action(Directives.client(List.of(
                                        Directives.toast(
                                                "Open in editor (preview only)"))))
                                .set("demo", true)
                                .build())
                        .build())
                .child(Ui.codeBlock(str(first.get("content")))
                        .id(PREVIEW_CODE_ID)
                        .language(str(first.get("language")))
                        .copyable(true)
                        .lineNumbers(true)
                        .set("syntax", true)
                        .build())
                .build();
    }

    /** The empty-state card of a T107 tab (never a blank tab). */
    private static UiNode emptyCard(String id, String title, String detail) {
        return Ui.card()
                .id(id)
                .child(Ui.column()
                        .gap(4)
                        .child(Ui.text(title)
                                .fontSize(13)
                                .fontWeight(600)
                                .build())
                        .child(Ui.text(detail)
                                .fontSize(12)
                                .color("$color.sidebar-muted-foreground")
                                .build())
                        .build())
                .build();
    }

    // --- T107 fixture loading (build time, never fetched) ---

    /** The parsed {@code diff-fixtures.json} file list. */
    public static List<Map<String, Object>> diffFiles() {
        return listOfMaps(loadFixture(DIFF_FIXTURE).get("files"));
    }

    /** The parsed {@code files-fixtures.json} tree. */
    public static List<Map<String, Object>> filesTree() {
        return listOfMaps(loadFixture(FILES_FIXTURE).get("tree"));
    }

    /** Reads one fixture resource from the classpath. */
    public static Map<String, Object> loadFixture(String resource) {
        try (InputStream in = RightPanelBuilder.class.getClassLoader()
                .getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalStateException("missing classpath resource: " + resource);
            }
            return Json.readMap(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + resource, e);
        }
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

    /** One numeric field of a map, {@code 0} when absent or malformed. */
    private static int intOf(Object map, String key) {
        if (map instanceof Map<?, ?> values && values.get(key) instanceof Number number) {
            return number.intValue();
        }
        return 0;
    }

    /** One string field, the empty string when absent. */
    private static String str(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    /** The Details tab body: the {@code ThreadDetailsPanel} shell. */
    private static UiNode details(Session session, String status) {
        return Ui.column()
                .id(DETAILS_ID)
                .gap(12)
                .padding(12)
                .child(detailsHeader(session, status))
                .child(labelRows(session))
                .child(timingRows(session))
                .child(relationships())
                .child(pullRequests())
                .build();
    }

    /** The title + status indicator row of the Details panel. */
    private static UiNode detailsHeader(Session session, String status) {
        Ui.BadgeBuilder badge = Ui.badge().id(STATUS_ID).label(status);
        String color = statusColor(status);
        if (color != null) {
            badge.color(color);
        }
        return Ui.row()
                .id("right-panel-header")
                .align("center")
                .gap(8)
                .child(Ui.text(session.title())
                        .fontSize(14)
                        .fontWeight(600)
                        .maxLines(1)
                        .ellipsis(true)
                        .flex(1)
                        .build())
                .child(badge.build())
                .build();
    }

    /** The model / effort / provider label rows. */
    private static UiNode labelRows(Session session) {
        return Ui.column()
                .gap(4)
                .child(infoRow("right-panel-model", "Model",
                        valueOrDash(session.model())))
                .child(infoRow("right-panel-effort", "Effort", "Med"))
                .child(infoRow("right-panel-provider", "Provider",
                        valueOrDash(session.providerId())))
                .build();
    }

    /** The created / updated / settled timing rows. */
    private static UiNode timingRows(Session session) {
        return Ui.column()
                .gap(4)
                .child(infoRow("right-panel-created", "Created",
                        timestamp(session.createdAt())))
                .child(infoRow("right-panel-updated", "Updated",
                        timestamp(session.updatedAt())))
                .child(infoRow("right-panel-settled", "Settled",
                        session.settledAt() == null ? "\u2014"
                                : timestamp(session.settledAt())))
                .build();
    }

    /** One label / value row: the muted label leading, the value trailing. */
    private static UiNode infoRow(String id, String label, String value) {
        return Ui.row()
                .id(id)
                .align("center")
                .gap(8)
                .child(Ui.text(label)
                        .fontSize(12)
                        .color("$color.sidebar-muted-foreground")
                        .build())
                .child(Ui.spacer().build())
                .child(Ui.text(value)
                        .fontSize(12)
                        .maxLines(1)
                        .ellipsis(true)
                        .build())
                .build();
    }

    /**
     * The decorative {@code ThreadRelationshipsControl} shell: the parent
     * and child rows. Each row is a {@code demo} button whose tap toasts the
     * preview notice — the real relationship graph does not exist in this
     * build (plan section 14.1).
     */
    private static UiNode relationships() {
        return Ui.column()
                .id(RELATIONSHIPS_ID)
                .gap(4)
                .child(sectionHeading("Relationships"))
                .child(relationshipRow("Parent thread", "corner_left_up",
                        "Fix the login bug"))
                .child(relationshipRow("Fork", "call_split",
                        "Add OAuth callback"))
                .build();
    }

    /** One decorative relationship row (parent / fork). */
    private static UiNode relationshipRow(String label, String icon, String title) {
        return Ui.button(title)
                .id("right-panel-rel-" + icon)
                .icon(icon)
                .style("text")
                .action(Directives.client(List.of(
                        Directives.toast(label + ": " + title + " (preview only)"))))
                .set("demo", true)
                .build();
    }

    /**
     * The decorative {@code ThreadDetailsPrRows} shell: the pull-request rows
     * with the {@code Link to thread} menu entries that only toast.
     */
    private static UiNode pullRequests() {
        return Ui.column()
                .id(PRS_ID)
                .gap(4)
                .child(sectionHeading("Pull requests"))
                .child(prRow("#142", "Add OAuth callback"))
                .child(prRow("#139", "Drop the legacy importer"))
                .build();
    }

    /** One decorative pull-request row with its link menu. */
    private static UiNode prRow(String number, String title) {
        return Ui.row()
                .id("right-panel-pr-" + number.substring(1))
                .align("center")
                .gap(8)
                .child(Ui.icon()
                        .icon("call_merge")
                        .size(16)
                        .color("$color.sidebar-muted-foreground")
                        .build())
                .child(Ui.text(number + ": " + title)
                        .fontSize(12)
                        .maxLines(1)
                        .ellipsis(true)
                        .flex(1)
                        .build())
                .child(linkMenu(number))
                .build();
    }

    /** The {@code Link to thread} menu of one PR row (toast-only entries). */
    private static UiNode linkMenu(String number) {
        return Ui.menu()
                .id("right-panel-pr-menu-" + number.substring(1))
                .trigger(Ui.iconButton()
                        .icon("more_horiz")
                        .tooltip("Pull request actions")
                        .build())
                .item(Ui.menuItem("Link to thread")
                        .icon("link")
                        .action(Directives.client(List.of(
                                Directives.toast("Linked " + number
                                        + " to this thread (preview only)"))))
                        .build())
                .item(Ui.menuItem("Unlink from thread")
                        .icon("link_off")
                        .action(Directives.client(List.of(
                                Directives.toast("Unlinked " + number
                                        + " (preview only)"))))
                        .build())
                .set("demo", true)
                .build();
    }

    /** One section heading (the muted uppercase-free label row). */
    private static UiNode sectionHeading(String title) {
        return Ui.text(title)
                .fontSize(12)
                .fontWeight(600)
                .color("$color.sidebar-muted-foreground")
                .padding(List.of(0, 0, 4, 0))
                .build();
    }

    /** The run-status badge colour, {@code null} for the default. */
    private static String statusColor(String status) {
        return switch (status) {
            case MessageCardBuilder.STATUS_RUNNING -> "$color.accent";
            case MessageCardBuilder.STATUS_LIMITED -> MessageCardBuilder.DANGER;
            default -> null;
        };
    }

    /** A nullable string as-is, an em dash when absent. */
    private static String valueOrDash(String value) {
        return value == null || value.isBlank() ? "\u2014" : value;
    }

    /** One epoch-millisecond timestamp as the panel's local clock label. */
    private static String timestamp(long epochMillis) {
        return TIMESTAMP.format(Instant.ofEpochMilli(epochMillis)
                .atZone(ZoneId.systemDefault()));
    }

    /** The list of tab labels, in render order (the QA assertion source). */
    public static List<String> tabLabels() {
        return new ArrayList<>(List.of(
                "Details", "Diff", "Files", "Preview", "Pull Requests", "Usage"));
    }
}
