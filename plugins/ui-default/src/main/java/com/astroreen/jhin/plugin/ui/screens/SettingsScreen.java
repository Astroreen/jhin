/**
 * The {@code settings} screen: account info, the General card (T96), the
 * Appearance and Thread-behavior cards (T78), the Keyboard section (T70),
 * the client-owned server surface, sign-out, the help link and — while the
 * reload plugin is loaded — the reload button.
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

    private SettingsScreen() {
    }

    /**
     * Builds the settings screen of one caller.
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
                .padding(16)
                .child(Ui.text("Settings").style("h2").build());
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
        return Ui.screen().title("Settings").body(body.build()).build();
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