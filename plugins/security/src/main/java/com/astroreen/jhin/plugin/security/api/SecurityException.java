/**
 * Typed security error with a stable wire code and the HTTP status the routes
 * layer must answer with.
 *
 * <p>Mapping contract for route/filter authors (the codes are the exact JSON
 * {@code error} values):
 * <ul>
 *   <li>{@link #CODE_UNAUTHORIZED} — HTTP 401: unknown device token, unknown
 *       enrollment code or a missing credential</li>
 *   <li>{@link #CODE_FORBIDDEN} — HTTP 403: the device exists but is revoked</li>
 *   <li>{@link #CODE_CONFLICT} — HTTP 409: the account name is already taken</li>
 *   <li>{@link #CODE_NOT_FOUND} — HTTP 404: the referenced account is unknown</li>
 *   <li>{@link #CODE_CODE_USED} — HTTP 410: the enrollment code was already
 *       redeemed</li>
 *   <li>{@link #CODE_CODE_EXPIRED} — HTTP 410: the enrollment code TTL passed</li>
 * </ul>
 */
package com.astroreen.jhin.plugin.security.api;

import com.astroreen.jhin.sdk.PluginException;

public class SecurityException extends PluginException {

    /** Unknown credential: unknown token, unknown code, missing header. */
    public static final String CODE_UNAUTHORIZED = "unauthorized";

    /** Known device that has been revoked. */
    public static final String CODE_FORBIDDEN = "forbidden";

    /** Account name already taken. */
    public static final String CODE_CONFLICT = "conflict";

    /** Referenced account does not exist. */
    public static final String CODE_NOT_FOUND = "not_found";

    /** Enrollment code was already redeemed (single use). */
    public static final String CODE_CODE_USED = "code_used";

    /** Enrollment code TTL has passed. */
    public static final String CODE_CODE_EXPIRED = "code_expired";

    private final String code;
    private final int httpStatus;

    /**
     * Creates a security error.
     *
     * @param code       the stable wire code, one of the {@code CODE_*} constants
     * @param httpStatus the HTTP status the routes layer must answer with
     * @param message    human-readable detail, never contains secrets
     */
    public SecurityException(String code, int httpStatus, String message) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }

    /**
     * The stable wire code, used as the JSON {@code error} value.
     *
     * @return the wire code
     */
    public String code() {
        return code;
    }

    /**
     * The HTTP status the routes layer must answer with.
     *
     * @return the intended HTTP status
     */
    public int httpStatus() {
        return httpStatus;
    }
}
