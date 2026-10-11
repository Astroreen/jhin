/**
 * The {@code enroll} action: redeems one enrollment code and enrolls this
 * device, answering with {@code setToken} (the raw token, shown exactly once)
 * and a navigation to the session list — the response shape of the enroll
 * screen.
 *
 * <p>Registered only while the security plugin is loaded and published its
 * {@code EnrollmentService}; the token minting is the security plugin's
 * {@code POST /enroll} semantics called directly. A refused code patches the
 * pair screen's {@code enroll-error} banner with the security message (T114),
 * so the failure is shown on the screen and not only as a transient toast —
 * the patch {@code html} is the banner re-rendered visible with the message
 * (contract level 4: an HTML swap, never a prop merge).
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.security.api.EnrollmentService;
import com.astroreen.jhin.plugin.ui.screens.EnrollScreen;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;

final class EnrollAction {

    private final EnrollmentService enrollment;

    EnrollAction(EnrollmentService enrollment) {
        this.enrollment = enrollment;
    }

    /**
     * Redeems the code and device name of the payload.
     *
     * @param req     the request that carried the action
     * @param payload the merged payload: {@code code}, {@code deviceName}
     * @return {@code [setToken, navigate]} on success, the error-banner patch
     *         otherwise
     */
    List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        String code = ActionSupport.text(payload, "code");
        String deviceName = ActionSupport.text(payload, "deviceName");
        if (code == null || deviceName == null) {
            return errorBanner("The enrollment code and a device name are required.");
        }
        try {
            EnrollmentService.Redeemed redeemed = enrollment.redeem(code, deviceName);
            return List.of(
                    Directives.setToken(redeemed.token()),
                    Directives.navigate("sessions"));
        } catch (RuntimeException e) {
            return errorBanner(messageOf(e));
        }
    }

    /**
     * The refusal answer: the pair screen's {@code enroll-error} banner is
     * patched to the banner re-rendered visible with the security message
     * (T114). The patch carries the message so the screen shows the
     * documented error, not only a toast.
     *
     * @param message the security message
     * @return the one-directive answer
     */
    private static List<Map<String, Object>> errorBanner(String message) {
        UiNode banner = Ui.banner()
                .id(EnrollScreen.ERROR_ID)
                .visible(true)
                .content(message)
                .build();
        return List.of(Directives.patch(EnrollScreen.ERROR_ID, banner));
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
