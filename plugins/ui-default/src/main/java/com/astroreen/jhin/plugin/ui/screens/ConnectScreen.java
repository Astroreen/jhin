/**
 * The {@code connect} screen (T114): the t3code {@code ConnectCliAuthorizeSurface}
 * as a decorative device-connection explainer. The card carries the
 * "Connect your terminal" heading, the connect command, a decorative
 * connection-code input and the docs link; the Connect control only toasts
 * the preview notice. Every interactive node is {@code demo: true} (plan
 * section 14.10): the CLI authorization backend is out of scope (plan section
 * 14.1), the screen reads no fixture and writes nothing.
 *
 * <p>Upstream anchors (t3code {@code apps/web/src}, commit {@code 37de6cb}):
 * the surface is {@code components/cloud/ConnectCliAuthSurface.tsx:47-113}
 * (the {@code AuthSurfaceShell} with the eyebrow, the title and the
 * description) and the invalid-link message is {@code :34-39} ("This connect
 * link is incomplete"). The port is behavioural, not TSX (plan section 14.9):
 * the same slots authored as SDUI nodes.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;

public final class ConnectScreen {

    /** The shell id. */
    public static final String SHELL_ID = "connect-shell";

    /** The body container id. */
    public static final String BODY_ID = "connect-body";

    /** The explainer card id. */
    public static final String CARD_ID = "connect-card";

    /** The decorative connection-code input id. */
    public static final String CODE_INPUT_ID = "connectionCode";

    /** The docs-link control id. */
    public static final String DOCS_ID = "connect-docs";

    /** The decorative Connect control id. */
    public static final String CONNECT_ID = "connect-submit";

    /** The docs URL the decorative link opens. */
    public static final String DOCS_URL = "https://example.invalid/docs/connect";

    /** The demo wording of the decorative Connect control. */
    static final String CONNECT_DEMO =
            "Preview only \u2014 no device is connected in this build";

    /** The fixed shell breakpoint (plan T95 step 7). */
    public static final int BREAKPOINT = 768;

    private ConnectScreen() {
    }

    /**
     * Builds the {@code connect} screen.
     *
     * @return the screen node
     */
    public static UiNode render() {
        return Ui.screen()
                .title("Connect")
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
                .id("connect-topbar")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text("Connect").style("body").bold(true).build())
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
                .id("connect-topbar-compact")
                .align("center")
                .child(Ui.text("Jhin").style("h3").bold(true).build())
                .child(Ui.text("Connect").style("body").build())
                .child(Ui.spacer().build())
                .build();
    }

    /** The page header: the {@code Connect} title and the browser-auth eyebrow. */
    private static UiNode pageHeader() {
        return Ui.row()
                .id("connect-page-header")
                .align("center")
                .gap(8)
                .child(Ui.text("Connect").style("h3").build())
                .child(Ui.spacer().build())
                .child(Ui.text("Browser authorization").style("caption").build())
                .build();
    }

    /** The body: the device-connection explainer card. */
    private static UiNode body() {
        return Ui.container()
                .id(BODY_ID)
                .direction("column")
                .gap(16)
                .padding(16)
                .child(Ui.card()
                        .id(CARD_ID)
                        .title("Connect a device")
                        .child(Ui.text("Connect your terminal").style("h3").build())
                        .child(Ui.text("Run the connect command on the machine you want to link,"
                                        + " then paste the connection code below.")
                                .style("body").build())
                        .child(Ui.codeBlock("npx jhin connect")
                                .language("shell")
                                .copyable(true)
                                .build())
                        .child(Ui.input(CODE_INPUT_ID)
                                .label("Connection code")
                                .placeholder("XXXX-XXXX")
                                .set("demo", true)
                                .build())
                        .child(Ui.row()
                                .align("center")
                                .gap(8)
                                .child(Ui.button("Open docs")
                                        .id(DOCS_ID)
                                        .style("text")
                                        .icon("open_in_new")
                                        .set("demo", true)
                                        .action(Directives.openUrl(DOCS_URL))
                                        .build())
                                .child(Ui.spacer().build())
                                .child(Ui.button("Connect")
                                        .id(CONNECT_ID)
                                        .style("primary")
                                        .icon("link")
                                        .set("demo", true)
                                        .action(Directives.client(List.of(
                                                Directives.toast(CONNECT_DEMO))))
                                        .build())
                                .build())
                        .build())
                .build();
    }
}