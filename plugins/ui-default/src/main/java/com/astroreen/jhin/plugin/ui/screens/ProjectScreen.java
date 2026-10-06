/**
 * The {@code project:<key>} screen (T114): the t3code
 * {@code projects.$projectKey} page as a {@code WorkspacePageContainer}-style
 * surface. The header carries the project monogram, name and badges; the
 * branch toolbar carries the decorative BranchPicker and Worktree pickers;
 * the threads card lists the real sessions whose workdir is the project path
 * (each row navigates to its {@code chat:<id>} screen); the scripts card
 * carries the decorative run controls. When the project has no threads the
 * threads card renders the {@code NoActiveThreadState} hero with a
 * "Start a conversation" action. Every decorative control is {@code demo:
 * true} (plan section 14.10); the fixture is read at build time and never
 * fetched (plan section 14.1).
 *
 * <p>Upstream anchors (t3code {@code apps/web/src}, commit {@code 37de6cb}):
 * the page frame is {@code components/WorkspacePageContainer.tsx:14-28} (the
 * centred {@code max-w-4xl} column with the workspace gutters), the empty
 * hero is {@code components/NoActiveThreadState.tsx:6-35} (the
 * "Pick a thread to continue" title over the description) and the project
 * header is the {@code WorkspacePageHeader} monogram row. The port is
 * behavioural, not TSX (plan section 14.9): the same slots authored as SDUI
 * nodes.
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
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class ProjectScreen {

    /** The classpath fixture the screen renders from (plan section 4.8). */
    static final String FIXTURE = "fixtures/projects-fixtures.json";

    /** The shell id. */
    public static final String SHELL_ID = "project-shell";

    /** The body container id. */
    public static final String BODY_ID = "project-body";

    /** The header card id. */
    public static final String HEADER_ID = "project-header";

    /** The branch toolbar id. */
    public static final String BRANCH_TOOLBAR_ID = "project-branch-toolbar";

    /** The threads card id. */
    public static final String THREADS_ID = "project-threads";

    /** The scripts card id. */
    public static final String SCRIPTS_ID = "project-scripts";

    /** The empty-threads hero id. */
    public static final String EMPTY_ID = "project-empty";

    /** The "Start a conversation" control id. */
    public static final String START_ID = "project-start";

    /** The demo wording of the decorative branch picker. */
    static final String BRANCH_DEMO =
            "Preview only \u2014 branches are not switched in this build";

    /** The demo wording of the decorative worktree picker. */
    static final String WORKTREE_DEMO =
            "Preview only \u2014 worktrees are not created in this build";

    /** The demo wording of the decorative script run control. */
    static final String SCRIPT_DEMO =
            "Preview only \u2014 scripts are not run in this build";

    /** The fixed shell breakpoint (plan T95 step 7). */
    public static final int BREAKPOINT = 768;

    private ProjectScreen() {
    }

    /**
     * Builds the {@code project:<key>} screen from the classpath fixture.
     *
     * @param key      the project key from the screen id
     * @param sessions the caller's sessions (the real subset is filtered here)
     * @return the screen node, or empty when the key matches no fixture project
     */
    public static Optional<UiNode> render(String key, List<Session> sessions) {
        return find(key).map(project -> render(project, sessions));
    }

    /**
     * Builds the project screen from explicit fixture data (the T114 seam):
     * the public {@link #render(String, List)} resolves the key, the tests
     * pass a project map directly.
     *
     * @param project  the parsed {@code projects-fixtures.json} project
     * @param sessions the caller's sessions
     * @return the screen node
     */
    public static UiNode render(Map<String, Object> project, List<Session> sessions) {
        String path = str(project.get("path"));
        List<Session> threads = new ArrayList<>();
        for (Session session : sessions) {
            if (path.equals(session.workdir())) {
                threads.add(session);
            }
        }
        return Ui.screen()
                .title(str(project.get("name")))
                .body(Ui.shell()
                        .id(SHELL_ID)
                        .breakpoint(BREAKPOINT)
                        .topbar(topbar(project))
                        .topbarCompact(topbarCompact(project))
                        .pageHeader(pageHeader(project))
                        .body(body(project, threads))
                        .build())
                .build();
    }

    /** The wide top bar: the wordmark, the project breadcrumb and the nav tabs. */
    private static UiNode topbar(Map<String, Object> project) {
        return Ui.row()
                .id("project-topbar")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text("Projects").style("small").build())
                .child(Ui.text("/").style("small").build())
                .child(Ui.text(str(project.get("name"))).style("body").bold(true).build())
                .child(Ui.spacer().build())
                .child(Ui.nav()
                        .kind("tabs")
                        .item("Sessions", "sessions")
                        .item("Settings", "settings")
                        .item("Plugins", "plugins")
                        .build())
                .build();
    }

    /** The compact top bar below the breakpoint: the wordmark and the name. */
    private static UiNode topbarCompact(Map<String, Object> project) {
        return Ui.row()
                .id("project-topbar-compact")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text(str(project.get("name"))).style("body").build())
                .child(Ui.spacer().build())
                .build();
    }

    /** The page header: the monogram, the name, the badges and the branch toolbar. */
    private static UiNode pageHeader(Map<String, Object> project) {
        Ui.RowBuilder row = Ui.row()
                .id("project-page-header")
                .align("center")
                .gap(8)
                .child(Ui.avatar()
                        .initials(str(project.get("monogram")))
                        .size(28)
                        .shape("square")
                        .build())
                .child(Ui.text(str(project.get("name"))).style("h3").build());
        for (Object badge : listOf(project.get("badges"))) {
            row.child(Ui.badge().label(badgeLabel(str(badge))).build());
        }
        row.child(Ui.spacer().build());
        row.child(branchToolbar(project));
        return row.build();
    }

    /** The body: the header card, the threads card and the scripts card. */
    private static UiNode body(Map<String, Object> project, List<Session> threads) {
        return Ui.container()
                .id(BODY_ID)
                .direction("column")
                .gap(16)
                .padding(16)
                .child(headerCard(project))
                .child(threadsCard(threads))
                .child(scriptsCard(project))
                .build();
    }

    /** The header card: the monogram, the name, the path and the badges. */
    private static UiNode headerCard(Map<String, Object> project) {
        Ui.RowBuilder badges = Ui.row().align("center").gap(6);
        for (Object badge : listOf(project.get("badges"))) {
            badges.child(Ui.badge().label(badgeLabel(str(badge))).build());
        }
        return Ui.card()
                .id(HEADER_ID)
                .title("Project")
                .child(Ui.row()
                        .align("center")
                        .gap(12)
                        .child(Ui.avatar()
                                .initials(str(project.get("monogram")))
                                .size(40)
                                .shape("square")
                                .build())
                        .child(Ui.column()
                                .gap(2)
                                .child(Ui.text(str(project.get("name"))).style("h2").build())
                                .child(Ui.text(str(project.get("path"))).style("mono").build())
                                .build())
                        .child(Ui.spacer().build())
                        .child(badges.build())
                        .build())
                .build();
    }

    /**
     * The branch toolbar: the decorative BranchPicker and Worktree pickers
     * (plan section 14.10). Both carry {@code demo: true}.
     */
    private static UiNode branchToolbar(Map<String, Object> project) {
        return Ui.row()
                .id(BRANCH_TOOLBAR_ID)
                .align("center")
                .gap(8)
                .child(Ui.dropdown("projectBranch")
                        .hint("Branch")
                        .item(str(project.get("branch")), str(project.get("branch")))
                        .item("main", "main")
                        .value(str(project.get("branch")))
                        .set("demo", true)
                        .action(Directives.client(List.of(Directives.toast(BRANCH_DEMO))))
                        .build())
                .child(Ui.dropdown("projectWorktree")
                        .hint("Worktree")
                        .item(str(project.get("worktree")), str(project.get("worktree")))
                        .item("default", "default")
                        .value(str(project.get("worktree")))
                        .set("demo", true)
                        .action(Directives.client(List.of(Directives.toast(WORKTREE_DEMO))))
                        .build())
                .build();
    }

    /** The threads card: the real session subset or the empty hero. */
    private static UiNode threadsCard(List<Session> threads) {
        Ui.CardBuilder card = Ui.card().id(THREADS_ID).title("Threads");
        if (threads.isEmpty()) {
            return card.child(emptyHero()).build();
        }
        Ui.ListBuilder list = Ui.list().id("project-thread-list");
        for (Session session : threads) {
            list.item(threadRow(session));
        }
        return card.child(list.build()).build();
    }

    /**
     * The {@code NoActiveThreadState} hero: the "Pick a thread to continue"
     * title over the description and the "Start a conversation" action.
     * Upstream anchor: {@code components/NoActiveThreadState.tsx:22-31}.
     */
    private static UiNode emptyHero() {
        return Ui.column()
                .id(EMPTY_ID)
                .align("center")
                .gap(8)
                .padding(32)
                .child(Ui.icon().icon("forum").size(40)
                        .color("$color.muted-foreground").build())
                .child(Ui.text("Pick a thread to continue").style("h3").build())
                .child(Ui.text("Select an existing thread or create a new one to get started.")
                        .style("caption").build())
                .child(Ui.button("Start a conversation")
                        .id(START_ID)
                        .style("primary")
                        .icon("add_comment")
                        .action(Directives.navigate("chat:new"))
                        .build())
                .build();
    }

    /**
     * One thread row: the status glyph, the title, the workdir and the
     * status chip. The row is real — it navigates to the session's chat.
     */
    private static UiNode threadRow(Session session) {
        return Ui.listRow()
                .id("project-thread-" + session.id())
                .leading(Ui.icon().icon("chat_bubble").size(20).build())
                .title(session.title())
                .subtitle(session.workdir())
                .trailing(Ui.chip().label(session.status()).build())
                .action(Directives.navigate("chat:" + session.id()))
                .build();
    }

    /** The scripts card: one decorative run row per fixture script. */
    private static UiNode scriptsCard(Map<String, Object> project) {
        Ui.ListBuilder list = Ui.list().id("project-script-list");
        for (Map<String, Object> script : listOfMaps(project.get("scripts"))) {
            list.item(Ui.listRow()
                    .id("project-script-" + str(script.get("id")))
                    .leading(Ui.icon().icon("terminal").size(20).build())
                    .title(str(script.get("label")))
                    .subtitle(str(script.get("command")))
                    .trailing(Ui.button("Run")
                            .style("secondary")
                            .icon("play_arrow")
                            .set("demo", true)
                            .action(Directives.client(List.of(Directives.toast(SCRIPT_DEMO))))
                            .build())
                    .set("demo", true)
                    .build());
        }
        return Ui.card()
                .id(SCRIPTS_ID)
                .title("Scripts")
                .child(list.build())
                .build();
    }

    // --- fixture loading and small helpers ---

    /**
     * The parsed {@code fixtures/projects-fixtures.json} root. Loaded from the
     * classpath at build time; a missing resource is an authoring bug and
     * fails the build.
     *
     * @return the fixture root
     */
    static Map<String, Object> fixture() {
        try (InputStream in = ProjectScreen.class.getClassLoader()
                .getResourceAsStream(FIXTURE)) {
            if (in == null) {
                throw new IllegalStateException("missing classpath resource: " + FIXTURE);
            }
            return Json.readMap(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + FIXTURE, e);
        }
    }

    /** The fixture projects, in order. */
    public static List<Map<String, Object>> projects() {
        return listOfMaps(fixture().get("projects"));
    }

    /** The fixture project with the given key, or empty when none matches. */
    public static Optional<Map<String, Object>> find(String key) {
        for (Map<String, Object> project : projects()) {
            if (key.equals(str(project.get("key")))) {
                return Optional.of(project);
            }
        }
        return Optional.empty();
    }

    /** The badge label of one fixture badge kind. */
    private static String badgeLabel(String kind) {
        return switch (kind) {
            case "active" -> "Active";
            case "archived" -> "Archived";
            case "git" -> "Git";
            default -> kind;
        };
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
}