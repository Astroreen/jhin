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
            case "settings:general" -> Ui.container()
                    .direction("column")
                    .gap(12)
                    .padding(16)
                    .child(generalCard())
                    .child(threadBehaviorCard(settings))
                    .build();
            case "settings:appearance" -> Ui.container()
                    .direction("column")
                    .gap(12)
                    .padding(16)
                    .child(appearanceCard(settings))
                    .build();
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
