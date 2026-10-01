/**
 * The {@code connect} screen: the enrollment form shown to a caller without a
 * principal while the security plugin is loaded (the bootstrap {@code entry}
 * decision). The form carries the two required fields of the enrollment
 * contract — the enrollment code and the device name — and submits them to the
 * {@code enroll} action, which answers with {@code setToken} and a navigation
 * to the session list. Client-side validation rides on the field contracts
 * ({@code required}, {@code errorText}), so a blank field never leaves the
 * device.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;

public final class EnrollScreen {

    private EnrollScreen() {
    }

    /**
     * Builds the connect screen.
     *
     * @return the screen node
     */
    public static UiNode render() {
        return Ui.screen()
                .title("Connect")
                .body(Ui.container()
                        .direction("column")
                        .gap(12)
                        .padding(16)
                        .child(Ui.text("Sign in to continue").style("h2").build())
                        .child(Ui.form()
                                .field(Ui.input("code")
                                        .label("Enrollment code")
                                        .required(true)
                                        .errorText("Enrollment code is required")
                                        .build())
                                .field(Ui.input("deviceName")
                                        .label("Device name")
                                        .required(true)
                                        .errorText("Device name is required")
                                        .build())
                                .submit("Enroll", ActionDescriptors.of(
                                        "enroll", null, List.of("code", "deviceName")))
                                .build())
                        .child(Ui.text("Ask your administrator for an enrollment code.")
                                .style("caption").build())
                        .build())
                .build();
    }
}
