/**
 * The {@code pair} screen (T114): the enrollment form shown to a caller
 * without a principal while the security plugin is loaded (the bootstrap
 * {@code entry} decision). The form sits on a {@code card} and carries the
 * two required fields of the enrollment contract — the enrollment code and
 * the device name — and submits them to the {@code enroll} action, which
 * answers with {@code setToken} and a navigation to the session list.
 * Client-side validation rides on the field contracts ({@code required},
 * {@code errorText}), so a blank field never leaves the device.
 *
 * <p>The screen also carries the {@code enroll-error} banner, hidden by
 * default ({@code visible: false}); a refused enrollment patches it visible
 * with the security message, so the failure is shown on the screen and not
 * only as a transient toast.
 *
 * <p>The screen id is {@code pair} (the T114 alias of the enrollment flow);
 * the {@code connect} id is the decorative device-connection explainer
 * ({@link ConnectScreen}).
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;

public final class EnrollScreen {

    /** The screen id of the pair route (the alias of this enrollment form). */
    public static final String PAIR_ID = "pair";

    /** The error banner id the enroll action patches on a refusal. */
    public static final String ERROR_ID = "enroll-error";

    private EnrollScreen() {
    }

    /**
     * Builds the pair screen.
     *
     * @return the screen node
     */
    public static UiNode render() {
        return Ui.screen()
                .title("Pair")
                .body(Ui.container()
                        .direction("column")
                        .gap(12)
                        .padding(16)
                        .child(Ui.text("Pair with this environment").style("h2").build())
                        .child(Ui.banner()
                                .id(ERROR_ID)
                                .visible(false)
                                .content("Enrollment failed")
                                .build())
                        .child(Ui.card()
                                .title("Enroll this device")
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
                                .build())
                        .child(Ui.text("Ask your administrator for an enrollment code.")
                                .style("caption").build())
                        .build())
                .build();
    }
}