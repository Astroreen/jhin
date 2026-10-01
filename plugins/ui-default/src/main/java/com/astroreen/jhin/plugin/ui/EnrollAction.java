/**
 * The {@code enroll} action: redeems one enrollment code and enrolls this
 * device, answering with {@code setToken} (the raw token, shown exactly once)
 * and a navigation to the session list — the response shape of the enroll
 * screen.
 *
 * <p>Registered only while the security plugin is loaded and published its
 * {@code EnrollmentService}; the token minting is the security plugin's
 * {@code POST /enroll} semantics called directly. A refused code surfaces as
 * an error toast carrying the security message.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.security.api.EnrollmentService;
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
     * @return {@code [setToken, navigate]} on success, one error toast otherwise
     */
    List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        String code = ActionSupport.text(payload, "code");
        String deviceName = ActionSupport.text(payload, "deviceName");
        if (code == null || deviceName == null) {
            return ActionSupport.error("The enrollment code and a device name are required.");
        }
        try {
            EnrollmentService.Redeemed redeemed = enrollment.redeem(code, deviceName);
            return List.of(
                    Directives.setToken(redeemed.token()),
                    Directives.navigate("sessions"));
        } catch (RuntimeException e) {
            return ActionSupport.error(messageOf(e));
        }
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
