/**
 * {@link com.astroreen.jhin.plugin.security.api.EnrollmentService} fake for
 * action tests: redeems any code except the failing one and answers with a
 * fixed token and principal.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.security.api.EnrollmentService;
import com.astroreen.jhin.plugin.security.api.Principal;
import com.astroreen.jhin.plugin.security.api.SecurityException;

final class FakeEnrollmentService implements EnrollmentService {

    /** The code the fake refuses, exercising the failure path. */
    static final String BAD_CODE = "expired-code";

    /** The token every successful redemption returns. */
    static final String TOKEN = "token-under-test";

    @Override
    public Redeemed redeem(String code, String deviceName) {
        if (code == null || code.isBlank() || deviceName == null || deviceName.isBlank()) {
            throw new IllegalArgumentException("code and deviceName are required");
        }
        if (BAD_CODE.equals(code)) {
            throw new SecurityException(SecurityException.CODE_CODE_EXPIRED, 410,
                    "enrollment code expired");
        }
        return new Redeemed(TOKEN, new Principal("acc-1", "alice", "dev-1"));
    }
}
