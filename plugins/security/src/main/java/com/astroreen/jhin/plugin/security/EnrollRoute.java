/**
 * The enrollment endpoint: {@code POST /enroll} redeems a single-use
 * enrollment code and enrolls a new device.
 *
 * <p>Registered from {@link SecurityPlugin#start} as
 * {@code POST /enroll} (the bearer allow-list admits this one route, so no
 * token is needed to enroll). Request body:
 * {@code {"code":"<enrollment code>","deviceName":"<display name>"}}. On
 * success the route answers {@code 200} with
 * {@code {"token","accountId","accountName","deviceId"}} — {@code 200} rather
 * than {@code 201} because the created device has no URI to point at yet and
 * the payload exists to hand over one secret.
 *
 * <p><b>Secrets.</b> The raw device token appears in this one response and
 * nowhere else: it is never logged and never returned again — exactly the CLI
 * code rule of {@link SecurityCli}.
 *
 * <p><b>Wire codes.</b> Rejections answer with the SDK error shape
 * {@code {"error":code,"message":detail}}: {@code 400 bad_request} for a body
 * that is not a JSON object or misses/blank-flags {@code code} or
 * {@code deviceName} (the message names the offending field), {@code 401
 * unauthorized} for an unknown code, {@code 410 code_used} for an already
 * redeemed code and {@code 410 code_expired} for one whose TTL passed — the
 * {@link SecurityException} wire codes passed through unchanged.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.plugin.security.api.EnrollmentService;
import com.astroreen.jhin.plugin.security.api.Principal;
import com.astroreen.jhin.plugin.security.api.SecurityException;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.util.LinkedHashMap;
import java.util.Map;

final class EnrollRoute {

    /** Path template registered for the enrollment endpoint. */
    static final String PATH = "/enroll";

    /** Wire code of every {@code 400} rejection of this route. */
    static final String CODE_BAD_REQUEST = "bad_request";

    private final EnrollmentServiceImpl enrollment;

    EnrollRoute(EnrollmentServiceImpl enrollment) {
        this.enrollment = enrollment;
    }

    /**
     * Redeems one enrollment code from the request body. Called by the kernel
     * when a request matches {@code POST /enroll}.
     *
     * @param req the request carrying the JSON body
     * @return the token payload, or an error response naming the failure
     */
    HttpResponse handle(HttpRequest req) {
        EnrollBody body;
        try {
            body = req.bodyAs(EnrollBody.class);
        } catch (RuntimeException notJson) {
            return badRequest("request body is not a valid JSON object");
        }
        if (body == null) {
            return badRequest("request body is not a valid JSON object");
        }
        if (body.code() == null || body.code().isBlank()) {
            return badRequest("code must not be null or blank");
        }
        if (body.deviceName() == null || body.deviceName().isBlank()) {
            return badRequest("deviceName must not be null or blank");
        }
        try {
            EnrollmentService.Redeemed result = enrollment.redeem(body.code(), body.deviceName());
            return HttpResponse.json(200, payload(result));
        } catch (SecurityException refused) {
            return HttpResponse.error(refused.httpStatus(), refused.code(), refused.getMessage());
        }
    }

    /** The success payload: the raw token, shown exactly once. */
    private static Map<String, String> payload(EnrollmentService.Redeemed result) {
        Principal principal = result.principal();
        Map<String, String> payload = new LinkedHashMap<>();
        payload.put("token", result.token());
        payload.put("accountId", principal.accountId());
        payload.put("accountName", principal.accountName());
        payload.put("deviceId", principal.deviceId());
        return payload;
    }

    private static HttpResponse badRequest(String message) {
        return HttpResponse.error(400, CODE_BAD_REQUEST, message);
    }

    /**
     * The JSON request body of the endpoint.
     *
     * @param code       the enrollment code as printed at issue time
     * @param deviceName display name of the device being enrolled
     */
    record EnrollBody(String code, String deviceName) {
    }
}
