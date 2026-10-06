/**
 * The {@code settings} shell and its sub-routes (T109): the t3code settings
 * layout — a left settings {@code nav} (kind {@code sidebar}) over the
 * fourteen sub-routes of the plan section 4.2, each its own Jhin screen id
 * ({@code settings:general}, {@code settings:appearance}, …) reachable by
 * {@code navigate} and listed in the bootstrap {@code screens[]}.
 *
 * <p>Upstream anchors (t3code {@code apps/web/src}, commit {@code 37de6cb}):
 * the settings route layout is {@code routes/settings.tsx} (the
 * {@code SidebarInset} with the {@code WorkspacePageHeader} carrying the
 * {@code SettingsBreadcrumb}, {@code settings.tsx:110-140}), the nav is
 * {@code components/settings/SettingsSidebarNav.tsx} (the
 * {@code SidebarMenu} of section buttons, {@code :245-266}) and the
 * breadcrumb labels are {@code components/settings/SettingsBreadcrumb.tsx}
 * ({@code Settings / Section}, {@code :20-40}) over the section labels of
 * {@code components/settings/settingsSearch.ts} ({@code
 * SETTINGS_SECTION_LABELS}, {@code :83-96}). The port is behavioural, not
 * TSX (plan section 14.9): the same slots and metrics authored as SDUI
 * nodes.
 *
 * <p><b>The shell.</b> Every settings screen is a {@code shell} (T95) whose
 * {@code sidebar} slot carries the settings {@code nav} (kind {@code
 * sidebar}, the fourteen entries in plan section 4.2 order), whose
 * {@code pageHeader} slot carries the {@code Settings / <name>} breadcrumb
 * and whose {@code body} carries the panel. The nav highlights the active
 * route through {@code activeId} (the client paints the active row with the
 * {@code sidebar-row-active} token, the T97 row state). The top bar carries
 * the wordmark and the {@code Back to threads} button (a real
 * {@code navigate sessions}).
 *
 * <p><b>The root.</b> The {@code settings} screen itself is the overview:
 * the shell with the account card, the General card (T96), the Appearance
 * and Thread-behavior cards (T78) and the Keyboard section (T70) — the
 * pre-T109 content, kept so the T78 contract assertions on {@code
 * /ui/screen/settings} stay green. The three sections also live on their
 * new homes: Appearance on {@code settings:appearance}, Thread behavior on
 * {@code settings:general}, Keyboard on {@code settings:keybindings}.
 *
 * <p>Appearance (T78) edits the persisted {@code jhin.ui} settings of
 * {@link UiSettings}: the six-theme catalogue grid (T85), theme mode,
 * canvas/accent seed colors, control density and the panel-animation
 * duration. Picking a theme card writes the {@code themeId} state key; the
 * Save button posts {@code save-appearance} with the six field ids included
 * and the server re-derives the seeds from the catalogue; a valid save
 * answers {@code reloadBootstrap}, so the next bootstrap carries the new
 * {@code theme}/{@code density}/{@code tokens.motion.panel}. The hex fields
 * carry {@code pattern}+{@code errorText} so an invalid color never leaves
 * the client, and the server repeats the check for raw dispatches.
 *
 * <p>Thread behavior (T78) edits the auto-settle master switch and the
 * inactivity window — both jhin.ui-owned proxy keys, see {@link UiSettings} —
 * and shows the disabled "settle on PR merged" switch with its tooltip. The
 * Save button posts {@code save-thread-behavior} and answers {@code refresh}.
 *
 * <p>The Keyboard section lists the rebindable commands (T70): the effective
 * chord of every default keymap entry — the client's
 * {@code X-Jhin-Keybindings} overrides win per command — plus per-row
 * {@code Edit}/{@code Reset} and the {@code Restore defaults} action.
 *
 * <p>"Change server" opens the client's own profile surface
 * ({@code openProfiles}); "Sign out" drops the stored bearer token
 * ({@code clearToken}). The reload button posts to the {@code reload} action,
 * which answers with {@code reloadBootstrap}; the plugin restart itself is the
 * reload plugin's {@code POST /admin/reload} behind the client's re-bootstrap.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.ui.UiSettings;
import com.astroreen.jhin.plugin.uikit.ThemeCatalog;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.UiTokens;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class SettingsScreen {

    /** The product-neutral help link of the surface. */
    private static final String HELP_URL = "https://example.invalid/docs";

    /** The hex-color validation message of the canvas/accent fields. */
    private static final String HEX_ERROR = "Use #RRGGBB or #AARRGGBB";

    /** The hex-color validation pattern of the canvas/accent fields. */
    private static final String HEX_PATTERN = "^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$";

    /** The wordmark text of the settings top bar. */
    static final String WORDMARK = "Jhin";

    /** The breadcrumb root crumb. */
    static final String BREADCRUMB_ROOT = "Settings";

    /** The breadcrumb separator (the upstream "/" crumb). */
    static final String BREADCRUMB_SEPARATOR = "/";

    /** The settings shell id. */
    public static final String SHELL_ID = "settings-shell";

    /** The settings nav id. */
    public static final String NAV_ID = "settings-nav";

    /** The settings breadcrumb id. */
    public static final String BREADCRUMB_ID = "settings-breadcrumb";

    /** The fixed shell breakpoint (plan T95 step 7): the sidebar overlays below it. */
    public static final int BREAKPOINT = 768;

    /** Field id of the theme-mode segmented control. */
    static final String ID_APPEARANCE = "appearance";

    /** Prefix of the theme-card node ids: {@code theme-<id>} (T85). */
    static final String ID_THEME_PREFIX = "theme-";

    /** The UiState key the theme cards write the picked theme id into (T85). */
    static final String ID_THEME_ID = "themeId";

    /** Field id of the canvas color input. */
    static final String ID_CANVAS = "canvas";

    /** Field id of the accent color input. */
    static final String ID_ACCENT = "accent";

    /** Field id of the density segmented control. */
    static final String ID_DENSITY = "density";

    /** Field id of the panel-animation slider. */
    static final String ID_PANEL_MOTION_MS = "panelMotionMs";

    /** Field id of the auto-settle master switch. */
    static final String ID_AUTO_SETTLE = "autoSettleDefault";

    /**
     * Field id of the decorative Working-section switch (T96): the state key
     * the sessions sidebar's Working section gate reads.
     */
    static final String ID_WORKING_SECTION = "workingSection";

    /** Field id of the inactivity-days slider. */
    static final String ID_INACTIVITY_DAYS = "inactivityDays";

    /** Field id of the disabled "settle on PR merged" switch. */
    static final String ID_SETTLE_ON_PR = "settleOnPrMerged";

    /** Tooltip of the disabled "settle on PR merged" switch. */
    static final String PR_TOOLTIP = "PR linking is not enabled";

    // --- T110 general panel field ids (upstream settings.general.tsx) ---

    /** Field id of the Send-shortcut dropdown (demo). */
    static final String ID_SEND_SHORTCUT = "sendShortcut";

    /** Field id of the Follow-up-behavior dropdown (demo). */
    static final String ID_FOLLOW_UP = "followUpBehavior";

    /** Field id of the Auto-resume-limited-threads switch (demo). */
    static final String ID_AUTO_RESUME = "autoResumeLimitedThreads";

    /** Field id of the Snooze-limited-threads switch (demo). */
    static final String ID_SNOOZE = "snoozeLimitedThreads";

    /** Field id of the Quit-shortcut-mode dropdown (demo). */
    static final String ID_QUIT_MODE = "confirmQuit";

    /** Field id of the Auto-settle-rules environment selector (demo). */
    static final String ID_AUTO_SETTLE_RULES = "autoSettleRules";

    // --- T110 appearance panel field ids (upstream settings.appearance.tsx) ---

    /** Field id of the contrast-boost slider (demo, 0–100). */
    static final String ID_CONTRAST = "contrastBoost";

    /** Field id of the chat-width segmented control (demo). */
    static final String ID_CHAT_WIDTH = "chatWidth";

    /** Field id of the diff-colour-scheme switch (demo). */
    static final String ID_DIFF_SCHEME = "diffColorScheme";

    /** Field id of the interface font-size slider (demo, 12–20). */
    static final String ID_FONT_INTERFACE = "fontSizeInterface";

    /** Field id of the prompt font-size slider (demo, 12–20). */
    static final String ID_FONT_PROMPT = "fontSizePrompt";

    /** Field id of the code font-size slider (demo, 10–18). */
    static final String ID_FONT_CODE = "fontSizeCode";

    /** Field id of the interface font-family picker (demo). */
    static final String ID_FONT_FAMILY_INTERFACE = "fontFamilySans";

    /** Field id of the code font-family picker (demo). */
    static final String ID_FONT_FAMILY_CODE = "fontFamilyCode";

    /** Field id of the prompt font-family picker (demo). */
    static final String ID_FONT_FAMILY_PROMPT = "fontFamilyComposer";

    /** Node id of the reduced-motion note (T110). */
    static final String ID_REDUCED_MOTION_NOTE = "reducedMotionNote";

    /** The demo toast wording of a decorative control (never claims a save). */
    static final String DEMO_TOAST = "Preview only \u2014 not saved in this build";

    /** The upstream interface font-size clamp (settings.ts:122-125). */
    static final int MIN_INTERFACE_FONT_SIZE = 12;

    /** The upstream interface font-size clamp (settings.ts:122-125). */
    static final int MAX_INTERFACE_FONT_SIZE = 20;

    /** The upstream prompt font-size clamp (settings.ts:130-133). */
    static final int MIN_PROMPT_FONT_SIZE = 12;

    /** The upstream prompt font-size clamp (settings.ts:130-133). */
    static final int MAX_PROMPT_FONT_SIZE = 20;

    /** The upstream code font-size clamp (settings.ts:138-141). */
    static final int MIN_CODE_FONT_SIZE = 10;

    /** The upstream code font-size clamp (settings.ts:138-141). */
    static final int MAX_CODE_FONT_SIZE = 18;

    /** The plan's contrast-boost slider bounds (T110; upstream pref is 50–200). */
    static final int MIN_CONTRAST_BOOST = 0;

    /** The plan's contrast-boost slider bounds (T110; upstream pref is 50–200). */
    static final int MAX_CONTRAST_BOOST = 100;

    /**
     * One settings sub-route: the Jhin screen id, the nav/breadcrumb label
     * and the nav icon name.
     */
    public record Route(String id, String label, String icon) {
    }

    /**
     * The fourteen settings sub-routes of the plan section 4.2, in nav
     * order. The upstream route files are {@code
     * apps/web/src/routes/settings.*.tsx} (commit {@code 37de6cb}); the
     * labels are the {@code SETTINGS_SECTION_LABELS} values of {@code
     * components/settings/settingsSearch.ts:83-96} plus the two detail-page
     * labels of {@code SettingsBreadcrumb.tsx:7-10} ({@code Diagnostics},
     * {@code Open source licenses}).
     */
    public static final List<Route> ROUTES = List.of(
            new Route("settings:general", "General", "settings"),
            new Route("settings:appearance", "Appearance", "palette"),
            new Route("settings:keybindings", "Keybindings", "keyboard"),
            new Route("settings:providers", "Providers", "smart_toy"),
            new Route("settings:connections", "Connections", "link"),
            new Route("settings:integrations", "Integrations", "extension"),
            new Route("settings:diagnostics", "Diagnostics", "monitor_heart"),
            new Route("settings:storage", "Storage", "storage"),
            new Route("settings:archived", "Archive", "archive"),
            new Route("settings:projects", "Project", "folder"),
            new Route("settings:scheduled-tasks", "Scheduled Tasks", "schedule"),
            new Route("settings:source-control", "Source Control", "account_tree"),
            new Route("settings:snap-shot", "SnapShots", "photo_camera"),
            new Route("settings:licenses", "Open source licenses", "description"));

    private SettingsScreen() {
    }

    /**
     * The settings sub-route with the given screen id, when it exists.
     *
     * @param id the screen id ({@code settings:general}, …)
     * @return the route, empty for an unknown id
     */
    public static Optional<Route> route(String id) {
        return ROUTES.stream().filter(route -> route.id().equals(id)).findFirst();
    }

    /**
     * Builds the {@code settings} overview screen of one caller: the shell
     * with the settings nav and the pre-T109 content (account, General,
     * Appearance, Thread behavior, Keyboard, the client-owned controls and
     * the reload button). The three section cards stay here so the T78
     * contract assertions on {@code /ui/screen/settings} remain green; they
     * also live on their new sub-routes.
     *
     * @param account           the caller's account id, empty when unauthenticated
     * @param securityPresent   whether the security plugin is loaded (account info)
     * @param reloadPresent     whether the reload plugin is loaded (reload button)
     * @param keymap            the default keymap entries ({@code key},
     *                          {@code command}) — the rebindable rows
     * @param clientKeybindings the caller's overrides (command to chord);
     *                          they win over the default chord per command
     * @param settings          the effective jhin.ui settings (T78 cards)
     * @return the screen node
     */
    public static UiNode render(Optional<String> account, boolean securityPresent,
                                boolean reloadPresent,
                                List<Map<String, Object>> keymap,
                                Map<String, String> clientKeybindings,
                                UiSettings.Snapshot settings) {
        Ui.ContainerBuilder body = Ui.container()
                .direction("column")
                .gap(12)
                .padding(16);
        if (securityPresent) {
            String info = account
                    .map(id -> "Signed in as " + id)
                    .orElse("Not signed in");
            body.child(Ui.card()
                    .title("Account")
                    .child(Ui.text(info).style("body").build())
                    .build());
        }
        body.child(generalCard());
        body.child(appearanceCard(settings));
        body.child(threadBehaviorCard(settings));
        body.child(Ui.card()
                .title("Keyboard")
                .child(keyboardRows(keymap, clientKeybindings))
                .build());
        body.child(Ui.button("Change server")
                .style("secondary")
                .action(Directives.openProfiles())
                .build());
        body.child(Ui.button("Sign out")
                .style("danger")
                .action(Directives.clearToken())
                .build());
        body.child(Ui.button("Help")
                .style("text")
                .action(Directives.openUrl(HELP_URL))
                .build());
        if (reloadPresent) {
            body.child(Ui.button("Reload")
                    .style("secondary")
                    .action(ActionDescriptors.of("reload"))
                    .build());
        }
        return Ui.screen()
                .title("Settings")
                .body(shell("settings:general", BREADCRUMB_ROOT, body.build()))
                .build();
    }

    /**
     * Builds one settings sub-route screen of one caller: the shell with the
     * settings nav (the route highlighted), the {@code Settings / <name>}
     * breadcrumb and the route's panel. The three pre-T109 sections render
     * on their new homes; the remaining routes render a decorative
     * placeholder panel until their owning todos (T110–T112) fill them.
     *
     * @param routeId           the sub-route screen id
     * @param account           the caller's account id, empty when unauthenticated
     * @param securityPresent   whether the security plugin is loaded
     * @param reloadPresent     whether the reload plugin is loaded
     * @param keymap            the default keymap entries
     * @param clientKeybindings the caller's overrides (command to chord)
     * @param settings          the effective jhin.ui settings
     * @return the screen node
     * @throws IllegalArgumentException when the id is not a settings sub-route
     */
    public static UiNode renderRoute(String routeId, Optional<String> account,
                                     boolean securityPresent, boolean reloadPresent,
                                     List<Map<String, Object>> keymap,
                                     Map<String, String> clientKeybindings,
                                     UiSettings.Snapshot settings) {
        Route route = route(routeId).orElseThrow(
                () -> new IllegalArgumentException("unknown settings route: " + routeId));
        UiNode content = panel(route, keymap, clientKeybindings, settings);
        return Ui.screen()
                .title("Settings")
                .body(shell(routeId, route.label(), content))
                .build();
    }

    /**
     * The settings shell: the sidebar nav, the top bar, the breadcrumb page
     * header and the content body (plan T109 step 1 and 5).
     *
     * @param activeId        the highlighted nav item (the active route id)
     * @param breadcrumbLabel the breadcrumb section label
     * @param content         the panel node
     * @return the shell node
     */
    private static UiNode shell(String activeId, String breadcrumbLabel, UiNode content) {
        return Ui.shell()
                .id(SHELL_ID)
                .breakpoint(BREAKPOINT)
                .topbar(topbar())
                .topbarCompact(topbarCompact())
                .pageHeader(breadcrumb(breadcrumbLabel))
                .sidebar(settingsNav(activeId))
                .stageBackdrop(true)
                .body(content)
                .build();
    }

    /**
     * The settings nav: the fourteen sub-route entries (kind {@code
     * sidebar}), the active route highlighted through {@code activeId}.
     */
    private static UiNode settingsNav(String activeId) {
        Ui.NavBuilder nav = Ui.nav().id(NAV_ID).kind("sidebar");
        for (Route route : ROUTES) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", route.id());
            item.put("label", route.label());
            item.put("icon", route.icon());
            item.put("screen", route.id());
            nav.item(item);
        }
        if (activeId != null) {
            nav.activeId(activeId);
        }
        return nav.build();
    }

    /** The wide top bar: the wordmark and the real back-to-threads button. */
    private static UiNode topbar() {
        return Ui.row()
                .id("settings-topbar")
                .align("center")
                .child(Ui.text(WORDMARK).style("h3").bold(true).build())
                .child(Ui.spacer().build())
                .child(Ui.button("Back to threads")
                        .style("secondary")
                        .action(Directives.navigate("sessions"))
                        .build())
                .build();
    }

    /** The compact top bar below the breakpoint: the wordmark only. */
    private static UiNode topbarCompact() {
        return Ui.row()
                .id("settings-topbar-compact")
                .align("center")
                .child(Ui.text(WORDMARK).style("h3").bold(true).build())
                .child(Ui.spacer().build())
                .build();
    }

    /**
     * The page-header breadcrumb: {@code Settings / <name>} for a sub-route,
     * the bare {@code Settings} crumb for the overview (the upstream
     * {@code SettingsBreadcrumb} shape).
     */
    private static UiNode breadcrumb(String label) {
        Ui.RowBuilder row = Ui.row()
                .id(BREADCRUMB_ID)
                .align("center")
                .gap(8)
                .child(Ui.text(BREADCRUMB_ROOT).style("small").build());
        if (!BREADCRUMB_ROOT.equals(label)) {
            row.child(Ui.text(BREADCRUMB_SEPARATOR).style("small").build());
            row.child(Ui.text(label).style("body").bold(true).build());
        }
        return row.build();
    }

    /**
     * The panel of one sub-route. The three pre-T109 sections render on
     * their new homes; every other route renders a decorative placeholder
     * card until its owning todo fills it.
     */
    private static UiNode panel(Route route, List<Map<String, Object>> keymap,
                                Map<String, String> clientKeybindings,
                                UiSettings.Snapshot settings) {
        return switch (route.id()) {
            case "settings:general" -> generalPanel(settings);
            case "settings:appearance" -> appearancePanel(settings);
            case "settings:keybindings" -> Ui.container()
                    .direction("column")
                    .gap(12)
                    .padding(16)
                    .child(Ui.card()
                            .title("Keyboard")
                            .child(keyboardRows(keymap, clientKeybindings))
                            .build())
                    .build();
            default -> placeholder(route);
        };
    }

    /**
     * The decorative placeholder panel of a not-yet-built sub-route: a card
     * titled with the section label and the unavailable copy. No interactive
     * node, so no {@code demo} marker is needed.
     */
    private static UiNode placeholder(Route route) {
        return Ui.container()
                .direction("column")
                .gap(12)
                .padding(16)
                .child(Ui.card()
                        .title(route.label())
                        .child(Ui.text("This panel is not available in this build.")
                                .style("caption")
                                .build())
                        .build())
                .build();
    }

    /**
     * One {@code FoldedSettingsSection}-style collapsible card (T110): a
     * {@code card} titled with the section name whose body folds through a
     * local {@code fold_<id>} state key. The header carries a chevron and the
     * one-line summary; tapping it dispatches {@code setState} to open (the
     * closed header) or close (the open header), and the body container
     * carries the matching {@code when} gate. The server always emits the
     * body, so the QA tree sees every field; the client hides it until the
     * fold opens. Upstream anchor: {@code
     * components/settings/FoldedSettingsSection.tsx:14-98} (starts closed,
     * chevron rotates, summary beside the title).
     *
     * @param id      the section id (also the fold state key suffix)
     * @param title   the card title (the section name)
     * @param summary the one-line summary beside the chevron
     * @param body    the section content
     * @return the collapsible card node
     */
    private static UiNode foldedSection(String id, String title, String summary, UiNode body) {
        // The `when` grammar only accepts identifier characters, so the fold
        // key uses underscores (a hyphen would make the expression degrade to
        // "visible" and the section would never fold).
        String key = "fold_" + id.replace('-', '_');
        String prefix = "section-" + id;
        // The hidden seed switch writes the fold key into the client UiState
        // on first render (a `switch` is one of the seedable types), so the
        // `when` gates below resolve to a real boolean instead of degrading
        // to "visible" on an unknown field. The section therefore starts
        // closed, exactly like the upstream FoldedSettingsSection.
        UiNode seed = Ui.toggle(key, title)
                .value(false)
                .visible(false)
                .build();
        UiNode closed = Ui.row()
                .id(prefix + "-toggle")
                .align("center")
                .gap(8)
                .when(key + " != true")
                .onTap(Directives.setState(key, true))
                .child(Ui.icon().icon("chevron_right").size(16)
                        .color("$color.muted-foreground").build())
                .child(Ui.text(summary).style("caption").build())
                .build();
        UiNode open = Ui.row()
                .id(prefix + "-toggle-open")
                .align("center")
                .gap(8)
                .when(key + " == true")
                .onTap(Directives.setState(key, false))
                .child(Ui.icon().icon("expand_more").size(16)
                        .color("$color.muted-foreground").build())
                .child(Ui.text(summary).style("caption").build())
                .build();
        UiNode content = Ui.container()
                .id(prefix + "-body")
                .direction("column")
                .gap(8)
                .when(key + " == true")
                .child(body)
                .build();
        return Ui.card()
                .id(prefix)
                .title(title)
                .child(seed)
                .child(closed)
                .child(open)
                .child(content)
                .build();
    }

    /**
     * The {@code settings:general} panel (T110): the upstream General panel
     * field for field, in three folded sections. The real fields — the
     * auto-settle master switch and the default settle days — persist through
     * {@code save-thread-behavior}; every other control is decorative
     * ({@code demo: true}) because Jhin has no backing key for it.
     *
     * <p>Upstream anchors (t3code {@code apps/web/src}, commit {@code
     * 37de6cb}): {@code components/settings/SettingsPanels.tsx:2166-3220}
     * (the General panel), the send-shortcut options {@code :2168-2172}, the
     * follow-up behavior {@code :2832-2872}, the limited-thread switches
     * {@code :2333-2364}, the working section {@code :2366-2391}, the
     * auto-settle rows {@code :2393-2472} and the confirmations section
     * {@code :3099-3219}.
     *
     * @param settings the effective jhin.ui settings
     * @return the panel node
     */
    private static UiNode generalPanel(UiSettings.Snapshot settings) {
        UiNode general = Ui.container()
                .direction("column")
                .gap(8)
                .child(demoDropdown(ID_SEND_SHORTCUT, "Send shortcut",
                        "Choose when Enter sends a prompt or inserts a new line",
                        List.of(new String[] {"Enter", "enter"},
                                new String[] {"Ctrl + Enter for multiline prompts",
                                        "mod-enter-multiline"},
                                new String[] {"Ctrl + Enter always", "mod-enter"}),
                        "enter"))
                .child(demoDropdown(ID_FOLLOW_UP, "Follow-up behavior",
                        "Queue follow-ups while the agent runs or steer the current run",
                        List.of(new String[] {"Queue", "queue"}, new String[] {"Steer", "steer"}),
                        "queue"))
                .child(demoToggle(ID_AUTO_RESUME, "Auto-resume limited threads", true))
                .child(demoToggle(ID_SNOOZE, "Snooze limited threads", false))
                .child(Ui.toggle(ID_WORKING_SECTION, "Working section (beta)")
                        .value(true)
                        .set("demo", true)
                        .build())
                .build();

        UiNode behavior = Ui.container()
                .direction("column")
                .gap(8)
                .child(demoDropdown(ID_AUTO_SETTLE_RULES, "Auto-settle rules",
                        "All environments \u2014 mixed across selected environments",
                        List.of(new String[] {"All environments", "all"},
                                new String[] {"Local", "local"},
                                new String[] {"Remote", "remote"}),
                        "all"))
                .child(Ui.toggle(ID_AUTO_SETTLE, "Auto-settle inactive threads")
                        .value(settings.autoSettleDefault())
                        .build())
                .child(Ui.slider(ID_INACTIVITY_DAYS,
                                UiSettings.MIN_INACTIVITY_DAYS, UiSettings.MAX_INACTIVITY_DAYS)
                        .label("Default settle days")
                        .step(1)
                        .value(settings.inactivityDays())
                        .build())
                .child(Ui.toggle(ID_SETTLE_ON_PR, "Settle on PR merged")
                        .value(false)
                        .enabled(false)
                        .tooltip(PR_TOOLTIP)
                        .build())
                .build();

        UiNode confirmations = Ui.container()
                .direction("column")
                .gap(8)
                .child(demoDropdown(ID_QUIT_MODE, "Quit shortcut",
                        "Hold mode also quits on two quick presses",
                        List.of(new String[] {"Direct", "direct"},
                                new String[] {"Hold", "hold"},
                                new String[] {"Double press", "double-click"}),
                        "direct"))
                .build();

        return Ui.container()
                .direction("column")
                .gap(12)
                .padding(16)
                .child(foldedSection("general", "General",
                        "Send shortcut, follow-ups and limited threads", general))
                .child(foldedSection("thread-behavior", "Thread behavior",
                        "Auto-settle rules and inactivity", behavior))
                .child(foldedSection("confirmations", "Confirmations",
                        "Quit shortcut behavior", confirmations))
                .child(Ui.button("Save")
                        .action(ActionDescriptors.of("save-thread-behavior", null, List.of(
                                ID_AUTO_SETTLE, ID_INACTIVITY_DAYS)))
                        .build())
                .build();
    }

    /**
     * The {@code settings:appearance} panel (T110): the upstream Appearance
     * panel field for field, in four folded sections. The real fields — the
     * theme grid, the appearance mode, the canvas/accent seeds, the density
     * and the panel-animation duration — persist through
     * {@code save-appearance}; the contrast, chat-width, diff-colour,
     * font-size and font-family controls are decorative ({@code demo: true})
     * because Jhin keeps those as client-side prefs, not server keys.
     *
     * <p>Upstream anchors (t3code {@code apps/web/src}, commit {@code
     * 37de6cb}): {@code components/settings/SettingsPanels.tsx:1143-1509}
     * (the Appearance panel), the contrast slider {@code :1203-1249}, the
     * diff colors {@code :1343-1388}, the chat width {@code :1418-1449}, the
     * panel animations {@code :1452-1504} and the typography rows {@code
     * :1531-1632}; the clamps are {@code packages/contracts/src/settings.ts}
     * ({@code :100-141}).
     *
     * @param settings the effective jhin.ui settings
     * @return the panel node
     */
    private static UiNode appearancePanel(UiSettings.Snapshot settings) {
        UiNode colors = Ui.container()
                .direction("column")
                .gap(8)
                .child(themeGrid(settings))
                .child(Ui.segmented()
                        .id(ID_APPEARANCE)
                        .segment("System", "system")
                        .segment("Light", "light")
                        .segment("Dark", "dark")
                        .value(settings.appearance())
                        .build())
                .child(Ui.input(ID_CANVAS)
                        .label("Canvas")
                        .value(settings.canvas())
                        .pattern(HEX_PATTERN)
                        .errorText(HEX_ERROR)
                        .build())
                .child(Ui.input(ID_ACCENT)
                        .label("Accent")
                        .value(settings.accent())
                        .pattern(HEX_PATTERN)
                        .errorText(HEX_ERROR)
                        .build())
                .build();

        UiNode interfaceSection = Ui.container()
                .direction("column")
                .gap(8)
                .child(demoSlider(ID_CONTRAST, "Contrast boost",
                        MIN_CONTRAST_BOOST, MAX_CONTRAST_BOOST, 5, 100))
                .child(demoSegmented(ID_CHAT_WIDTH, "Chat width",
                        List.of(new String[] {"Default", "default"},
                                new String[] {"Wide", "wide"},
                                new String[] {"Full", "full"}),
                        "default"))
                .child(demoToggle(ID_DIFF_SCHEME, "Blue & orange diff colors", false))
                .child(Ui.segmented()
                        .id(ID_DENSITY)
                        .segment("Compact", "compact")
                        .segment("Comfortable", "comfortable")
                        .segment("Spacious", "spacious")
                        .value(settings.density())
                        .build())
                .child(Ui.text("Reduced motion follows your operating system and disables "
                                + "panel animations.")
                        .id(ID_REDUCED_MOTION_NOTE)
                        .style("caption")
                        .build())
                .build();

        UiNode typography = Ui.container()
                .direction("column")
                .gap(8)
                .child(demoSlider(ID_FONT_INTERFACE, "Interface font size",
                        MIN_INTERFACE_FONT_SIZE, MAX_INTERFACE_FONT_SIZE, 1, 16))
                .child(demoSlider(ID_FONT_PROMPT, "Prompt font size",
                        MIN_PROMPT_FONT_SIZE, MAX_PROMPT_FONT_SIZE, 1, 14))
                .child(demoSlider(ID_FONT_CODE, "Code font size",
                        MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, 1, 13))
                .child(demoInput(ID_FONT_FAMILY_INTERFACE, "Interface font", "System default"))
                .child(demoInput(ID_FONT_FAMILY_CODE, "Code font", "System monospace"))
                .child(demoInput(ID_FONT_FAMILY_PROMPT, "Prompt font", "System default"))
                .build();

        UiNode motion = Ui.container()
                .direction("column")
                .gap(8)
                .child(Ui.slider(ID_PANEL_MOTION_MS,
                                UiSettings.MIN_PANEL_MOTION_MS, UiSettings.MAX_PANEL_MOTION_MS)
                        .label("Panel animations")
                        .step(20)
                        .value(settings.panelMotionMs())
                        .build())
                .build();

        return Ui.container()
                .direction("column")
                .gap(12)
                .padding(16)
                .child(foldedSection("appearance", "Appearance",
                        "Theme, mode and seed colors", colors))
                .child(foldedSection("interface", "Interface",
                        "Contrast, chat width and diff colors", interfaceSection))
                .child(foldedSection("typography", "Typography",
                        "Interface, prompt and code fonts", typography))
                .child(foldedSection("motion", "Motion",
                        "Panel open and close speed", motion))
                .child(Ui.button("Save")
                        .action(ActionDescriptors.of("save-appearance", null, List.of(
                                ID_APPEARANCE, ID_THEME_ID, ID_CANVAS, ID_ACCENT,
                                ID_DENSITY, ID_PANEL_MOTION_MS)))
                        .build())
                .build();
    }

    /** The demo action of a decorative control: an honest preview toast. */
    private static Map<String, Object> demoAction() {
        return Directives.client(List.of(Directives.toast(DEMO_TOAST)));
    }

    /** One decorative switch ({@code demo: true}) with the given default. */
    private static UiNode demoToggle(String id, String label, boolean value) {
        return Ui.toggle(id, label)
                .value(value)
                .set("demo", true)
                .build();
    }

    /** One decorative slider ({@code demo: true}) with the given bounds. */
    private static UiNode demoSlider(String id, String label, int min, int max, int step, int value) {
        return Ui.slider(id, min, max)
                .label(label)
                .step(step)
                .value(value)
                .set("demo", true)
                .build();
    }

    /** One decorative text input ({@code demo: true}). */
    private static UiNode demoInput(String id, String label, String value) {
        return Ui.input(id)
                .label(label)
                .value(value)
                .set("demo", true)
                .build();
    }

    /** One decorative segmented control ({@code demo: true}). */
    private static UiNode demoSegmented(String id, String label, List<String[]> options,
                                        String value) {
        Ui.SegmentedBuilder builder = Ui.segmented().id(id).value(value);
        for (String[] option : options) {
            builder.segment(option[0], option[1]);
        }
        return builder.action(demoAction()).set("demo", true).build();
    }

    /**
     * One decorative dropdown ({@code demo: true}): the label, the hint and
     * the {@code {label, value}} options. The client writes the picked value
     * into the local state and toasts the preview wording; nothing is saved.
     */
    private static UiNode demoDropdown(String id, String label, String hint,
                                       List<String[]> options, String value) {
        Ui.DropdownBuilder builder = Ui.dropdown(id).hint(hint).value(value);
        for (String[] option : options) {
            builder.item(option[0], option[1]);
        }
        return builder.action(demoAction()).set("demo", true).build();
    }

    /**
     * The General card (T96): the decorative {@code workingSection} switch
     * (upstream Settings &rarr; General &rarr; Working section, {@code
     * docs/user/thread-sidebar.md} "Fold working threads (beta)"). The switch
     * writes the {@code workingSection} state key client-side on toggle —
     * no round-trip, nothing persisted server-side — and the sessions
     * sidebar's Working section carries the matching
     * {@code when: "workingSection != false"} gate ({@link SidebarBuilder}).
     * The marker is {@code demo: true}: the effect is an ephemeral client
     * state change, never a stored setting.
     */
    private static UiNode generalCard() {
        return Ui.card()
                .title("General")
                .child(Ui.toggle(ID_WORKING_SECTION, "Working section")
                        .value(true)
                        .set("demo", true)
                        .build())
                .build();
    }

    /**
     * The Appearance card (T78 + T85): the six-theme grid, the theme mode,
     * canvas/accent seed colors, density and the panel-animation duration,
     * saved through {@code save-appearance}. Picking a theme card writes the
     * {@code themeId} state key; the save re-derives the seeds from the
     * catalogue server-side, so the hex fields always show the selected
     * theme's derived pair after the round-trip.
     */
    private static UiNode appearanceCard(UiSettings.Snapshot settings) {
        return Ui.card()
                .title("Appearance")
                .child(themeGrid(settings))
                .child(Ui.segmented()
                        .id(ID_APPEARANCE)
                        .segment("System", "system")
                        .segment("Light", "light")
                        .segment("Dark", "dark")
                        .value(settings.appearance())
                        .build())
                .child(Ui.input(ID_CANVAS)
                        .label("Canvas")
                        .value(settings.canvas())
                        .pattern(HEX_PATTERN)
                        .errorText(HEX_ERROR)
                        .build())
                .child(Ui.input(ID_ACCENT)
                        .label("Accent")
                        .value(settings.accent())
                        .pattern(HEX_PATTERN)
                        .errorText(HEX_ERROR)
                        .build())
                .child(Ui.segmented()
                        .id(ID_DENSITY)
                        .segment("Compact", "compact")
                        .segment("Comfortable", "comfortable")
                        .segment("Spacious", "spacious")
                        .value(settings.density())
                        .build())
                .child(Ui.slider(ID_PANEL_MOTION_MS,
                                UiSettings.MIN_PANEL_MOTION_MS, UiSettings.MAX_PANEL_MOTION_MS)
                        .label("Panel animations")
                        .step(20)
                        .value(settings.panelMotionMs())
                        .build())
                .child(Ui.button("Save")
                        .action(ActionDescriptors.of("save-appearance", null, List.of(
                                ID_APPEARANCE, ID_THEME_ID, ID_CANVAS, ID_ACCENT,
                                ID_DENSITY, ID_PANEL_MOTION_MS)))
                        .build())
                .build();
    }

    /**
     * The theme grid (T85): three cards per row, one per catalogue theme.
     * Each card carries the live swatch (the canvas and accent seeds of the
     * effective appearance, converted server-side through the OKLCH port),
     * the theme name and the light/dark preview chips (the accent seed of
     * each pair). Tapping a card writes the {@code themeId} state key the
     * Save action includes; the active theme's card is outlined in the
     * primary color.
     */
    private static UiNode themeGrid(UiSettings.Snapshot settings) {
        List<String> ids = ThemeCatalog.ids();
        Ui.ContainerBuilder grid = Ui.container().direction("column").gap(8);
        for (int start = 0; start < ids.size(); start += 3) {
            Ui.RowBuilder row = Ui.row().gap(8);
            for (int i = start; i < Math.min(start + 3, ids.size()); i++) {
                row.child(Ui.expanded()
                        .child(themeCard(ThemeCatalog.get(ids.get(i)), settings))
                        .build());
            }
            grid.child(row.build());
        }
        return grid.build();
    }

    /** One theme card of the grid: swatch, name, light/dark chips, tap-to-pick. */
    private static UiNode themeCard(ThemeCatalog.Theme theme, UiSettings.Snapshot settings) {
        boolean active = theme.id().equals(settings.themeId());
        ThemeCatalog.Seeds activeSeeds = theme.seeds(settings.appearance());
        return Ui.box()
                .id(ID_THEME_PREFIX + theme.id())
                .padding(UiTokens.spacing.md())
                .borderRadius(UiTokens.radius.md())
                .borderWidth(1)
                .border(active ? UiTokens.color("primary") : UiTokens.color("border"))
                .onTap(Directives.setState(ID_THEME_ID, theme.id()))
                .child(Ui.container()
                        .direction("column")
                        .gap(8)
                        .child(Ui.row()
                                .gap(8)
                                .child(swatch("swatch-" + theme.id() + "-canvas", activeSeeds.canvas()))
                                .child(swatch("swatch-" + theme.id() + "-accent", activeSeeds.accent()))
                                .build())
                        .child(Ui.text(theme.label()).style("body").build())
                        .child(Ui.row()
                                .gap(8)
                                .child(Ui.chip().label("Light")
                                        .avatar(swatch("chip-" + theme.id() + "-light",
                                                theme.light().accent()))
                                        .build())
                                .child(Ui.chip().label("Dark")
                                        .avatar(swatch("chip-" + theme.id() + "-dark",
                                                theme.dark().accent()))
                                        .build())
                                .build())
                        .build())
                .build();
    }

    /** One color swatch: a fixed-size box painted with the given hex. */
    private static UiNode swatch(String id, String hex) {
        return Ui.sizedBox().id(id).width(40).height(24).color(hex).build();
    }

    /** One color swatch: a fixed-size box painted with the given hex. */
    private static UiNode swatch(String hex) {
        return Ui.sizedBox().width(40).height(24).color(hex).build();
    }

    /**
     * The Thread-behavior card (T78): the auto-settle master switch and the
     * inactivity window (both jhin.ui-owned proxy keys, see {@link UiSettings})
     * plus the disabled "settle on PR merged" switch, saved through
     * {@code save-thread-behavior}.
     */
    private static UiNode threadBehaviorCard(UiSettings.Snapshot settings) {
        return Ui.card()
                .title("Thread behavior")
                .child(Ui.toggle(ID_AUTO_SETTLE, "Auto-settle idle threads")
                        .value(settings.autoSettleDefault())
                        .build())
                .child(Ui.slider(ID_INACTIVITY_DAYS,
                                UiSettings.MIN_INACTIVITY_DAYS, UiSettings.MAX_INACTIVITY_DAYS)
                        .label("Settle after inactivity (days)")
                        .step(1)
                        .value(settings.inactivityDays())
                        .build())
                .child(Ui.toggle(ID_SETTLE_ON_PR, "Settle on PR merged")
                        .value(false)
                        .enabled(false)
                        .tooltip(PR_TOOLTIP)
                        .build())
                .child(Ui.button("Save")
                        .action(ActionDescriptors.of("save-thread-behavior", null, List.of(
                                ID_AUTO_SETTLE, ID_INACTIVITY_DAYS)))
                        .build())
                .build();
    }

    /**
     * The Keyboard rows (T70): one row per default keymap entry with the
     * effective chord (the client override wins) plus Edit/Reset, and the
     * Restore-defaults action after the list.
     */
    private static UiNode keyboardRows(List<Map<String, Object>> keymap,
                                       Map<String, String> clientKeybindings) {
        Ui.ContainerBuilder rows = Ui.container().direction("column").gap(8);
        for (Map<String, Object> binding : keymap) {
            String command = String.valueOf(binding.get("command"));
            String chord = clientKeybindings.getOrDefault(
                    command, String.valueOf(binding.get("key")));
            UiNode trailing = Ui.row()
                    .child(Ui.button("Edit")
                            .style("secondary")
                            .action(ActionDescriptors.of(
                                    "keybind-edit", Map.of("command", command), null))
                            .build())
                    .child(Ui.button("Reset")
                            .style("text")
                            .action(ActionDescriptors.of(
                                    "keybind-reset", Map.of("command", command), null))
                            .build())
                    .build();
            rows.child(Ui.listRow()
                    .title(command)
                    .subtitle(chord)
                    .trailing(trailing)
                    .build());
        }
        rows.child(Ui.button("Restore defaults")
                .style("secondary")
                .action(ActionDescriptors.of("keybind-restore"))
                .build());
        return rows.build();
    }
}
