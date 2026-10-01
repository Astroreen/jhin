/**
 * Device enrollment: the token-minting seam published to the cross-plugin
 * service registry so a user-interface plugin can enroll a device exactly like
 * {@code POST /enroll} does, without speaking HTTP to itself.
 *
 * <p>One method, one secret: {@link #redeem} exchanges a single-use enrollment
 * code for a raw device token that is returned once and never recoverable
 * afterwards. Consumers hand the token to the client (the {@code setToken}
 * directive of the SDUI contract) and never store it themselves.
 */
package com.astroreen.jhin.plugin.security.api;

public interface EnrollmentService {

    /**
     * Redeems one enrollment code and enrolls a new device. The code is
     * single-use: the validity check and the redemption mark happen in one
     * serialized write unit, so a second redemption can never pass.
     *
     * @param code       the enrollment code as printed at issue time
     * @param deviceName display name of the device being enrolled
     * @return the raw device token (shown once) and the enrolled principal
     * @throws IllegalArgumentException when {@code code} or {@code deviceName}
     *                                  is null or blank
     * @throws SecurityException         with code {@code unauthorized} (HTTP 401)
     *                                   when the code is unknown,
     *                                   {@code code_used} (HTTP 410) when it
     *                                   was already redeemed,
     *                                   {@code code_expired} (HTTP 410) when
     *                                   its TTL has passed
     */
    Redeemed redeem(String code, String deviceName);

    /**
     * The outcome of a successful redemption: the raw device token (never
     * stored, shown once) and the principal of the enrolled device.
     *
     * @param token     the raw device token, 256 bits rendered as hex
     * @param principal the enrolled device principal
     */
    record Redeemed(String token, Principal principal) {
    }
}
