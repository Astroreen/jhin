/**
 * The {@code welcome} screen (T114): the t3code {@code WelcomeWizard} as a
 * decorative stepped card. Three steps — pick a theme, connect a host, start
 * a thread — advance through inline {@code setState} directives on the
 * {@code welcomeStep} local field; the step panels read that field through
 * their {@code when} expressions. The final step's Finish control navigates
 * to {@code chat:new}. Every interactive node is {@code demo: true} (plan
 * section 14.10): the onboarding backend is out of scope (plan section 14.1),
 * the wizard only changes local state and navigates.
 *
 * <p>Upstream anchors (t3code {@code apps/web/src}, commit {@code 37de6cb}):
 * the wizard shell is {@code components/onboarding/WelcomeWizard.tsx:213-284}
 * (the {@code WizardHeader} with the {@code WizardSteps} stage strip and the
 * {@code WizardPanel} body), the connection step is {@code :330-431} (the
 * "Connect your computers" heading, the computer rows and the Continue
 * button) and the import step is {@code :1135-1343} (the project list and the
 * finish action). The port is behavioural, not TSX (plan section 14.9): the
 * same slots and stage labels authored as SDUI nodes.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;

public final class WelcomeScreen {

    /** The shell id. */
    public static final String SHELL_ID = "welcome-shell";

    /** The body container id. */
    public static final String BODY_ID = "welcome-body";

    /** The wizard card id. */
    public static final String CARD_ID = "welcome-card";

    /** The local state field the step panels read. */
    public static final String STEP_ID = "welcomeStep";

    /** The theme step panel id. */
    public static final String STEP_THEME_ID = "welcome-step-theme";

    /** The host step panel id. */
    public static final String STEP_HOST_ID = "welcome-step-host";

    /** The thread step panel id. */
    public static final String STEP_THREAD_ID = "welcome-step-thread";

    /** The decorative theme picker id. */
    public static final String THEME_PICKER_ID = "welcomeTheme";

    /** The decorative host-url input id. */
    public static final String HOST_INPUT_ID = "welcomeHostUrl";

    /** The Next control id. */
    public static final String NEXT_ID = "welcome-next";

    /** The Back control id. */
    public static final String BACK_ID = "welcome-back";

    /** The Finish control id. */
    public static final String FINISH_ID = "welcome-finish";

    /** The demo wording of the decorative theme picker. */
    static final String THEME_DEMO =
            "Preview only \u2014 the theme is not applied in this build";

    /** The demo wording of the decorative host input. */
    static final String HOST_DEMO =
            "Preview only \u2014 no host is connected in this build";

    /** The fixed shell breakpoint (plan T95 step 7). */
    public static final int BREAKPOINT = 768;

    private WelcomeScreen() {
    }

    /**
     * Builds the {@code welcome} screen.
     *
     * @return the screen node
     */
    public static UiNode render() {
        return Ui.screen()
                .title("Welcome")
                .body(Ui.shell()
                        .id(SHELL_ID)
                        .breakpoint(BREAKPOINT)
                        .topbar(topbar())
                        .topbarCompact(topbarCompact())
                        .pageHeader(pageHeader())
                        .body(body())
                        .build())
                .build();
    }

    /** The wide top bar: the wordmark, the breadcrumb and the app nav tabs. */
    private static UiNode topbar() {
        return Ui.row()
                .id("welcome-topbar")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text("Welcome").style("body").bold(true).build())
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
                .id("welcome-topbar-compact")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text("Welcome").style("body").build())
                .child(Ui.spacer().build())
                .build();
    }

    /** The page header: the {@code Welcome} title and the setup caption. */
    private static UiNode pageHeader() {
        return Ui.row()
                .id("welcome-page-header")
                .align("center")
                .gap(8)
                .child(Ui.text("Welcome").style("h3").build())
                .child(Ui.spacer().build())
                .child(Ui.text("Set up Jhin in three steps").style("caption").build())
                .build();
    }

    /** The body: the wizard card. */
    private static UiNode body() {
        return Ui.container()
                .id(BODY_ID)
                .direction("column")
                .gap(16)
                .padding(16)
                .child(Ui.card()
                        .id(CARD_ID)
                        .title("Set up Jhin")
                        .child(stepStrip())
                        .child(themeStep())
                        .child(hostStep())
                        .child(threadStep())
                        .build())
                .build();
    }

    /**
     * The stage strip: a decorative {@code segmented} control whose value
     * seeds the {@code welcomeStep} local field the panels read. The control
     * is the first child so the field is seeded before the panels evaluate
     * their {@code when} expressions.
     */
    private static UiNode stepStrip() {
        return Ui.segmented()
                .id(STEP_ID)
                .segment("Theme", 0)
                .segment("Host", 1)
                .segment("Thread", 2)
                .value(0)
                .set("demo", true)
                .build();
    }

    /** Step 1: pick a theme. */
    private static UiNode themeStep() {
        return Ui.column()
                .id(STEP_THEME_ID)
                .gap(12)
                .when(STEP_ID + " == 0")
                .child(Ui.text("Pick a theme").style("h3").build())
                .child(Ui.text("Choose how Jhin looks. You can change this later in Settings.")
                        .style("body").build())
                .child(Ui.segmented()
                        .id(THEME_PICKER_ID)
                        .segment("T3 Chat", "t3-chat")
                        .segment("Midnight", "midnight")
                        .segment("Paper", "paper")
                        .value("t3-chat")
                        .set("demo", true)
                        .action(Directives.client(List.of(Directives.toast(THEME_DEMO))))
                        .build())
                .child(navRow(null, 1))
                .build();
    }

    /** Step 2: connect a host. */
    private static UiNode hostStep() {
        return Ui.column()
                .id(STEP_HOST_ID)
                .gap(12)
                .when(STEP_ID + " == 1")
                .child(Ui.text("Connect a host").style("h3").build())
                .child(Ui.text("Point Jhin at a machine to run your agents. You can add more later.")
                        .style("body").build())
                .child(Ui.input(HOST_INPUT_ID)
                        .label("Host URL")
                        .placeholder("https://your-server:5230")
                        .set("demo", true)
                        .build())
                .child(navRow(0, 2))
                .build();
    }

    /** Step 3: start a thread. */
    private static UiNode threadStep() {
        return Ui.column()
                .id(STEP_THREAD_ID)
                .gap(12)
                .when(STEP_ID + " == 2")
                .child(Ui.text("Start a thread").style("h3").build())
                .child(Ui.text("Open a project and start your first conversation.")
                        .style("body").build())
                .child(Ui.row()
                        .align("center")
                        .gap(8)
                        .child(backButton(1))
                        .child(Ui.spacer().build())
                        .child(Ui.button("Finish")
                                .id(FINISH_ID)
                                .style("primary")
                                .icon("arrow_forward")
                                .set("demo", true)
                                .action(Directives.client(List.of(
                                        Directives.navigate("chat:new"))))
                                .build())
                        .build())
                .build();
    }

    /**
     * The Back/Next row of one step: a Back control (absent on the first
     * step) and a Next control that writes the next step index.
     *
     * @param backStep the step the Back control returns to, or {@code null}
     *                 on the first step
     * @param nextStep the step the Next control advances to
     * @return the row node
     */
    private static UiNode navRow(Integer backStep, int nextStep) {
        Ui.RowBuilder row = Ui.row().align("center").gap(8);
        if (backStep != null) {
            row.child(backButton(backStep));
        }
        row.child(Ui.spacer().build());
        row.child(Ui.button("Next")
                .id(NEXT_ID)
                .style("primary")
                .icon("arrow_forward")
                .set("demo", true)
                .action(Directives.client(List.of(
                        Directives.setState(STEP_ID, nextStep))))
                .build());
        return row.build();
    }

    /** One Back control: writes the given step index. */
    private static UiNode backButton(int step) {
        return Ui.button("Back")
                .id(BACK_ID)
                .style("secondary")
                .icon("arrow_back")
                .set("demo", true)
                .action(Directives.client(List.of(
                        Directives.setState(STEP_ID, step))))
                .build();
    }
}