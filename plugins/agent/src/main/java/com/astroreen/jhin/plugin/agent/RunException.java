/**
 * Typed run-lifecycle error with a stable wire code and the HTTP status the
 * routes layer must answer with.
 *
 * <p>Mapping contract for route authors (the codes are the exact JSON
 * {@code error} values):
 * <ul>
 *   <li>{@link #CODE_RUN_ACTIVE} — HTTP 409: the session already has an
 *       active run; one active run per session</li>
 *   <li>{@link #CODE_NO_ACTIVE_RUN} — HTTP 404: cancellation requested for a
 *       session without an active run</li>
 * </ul>
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.sdk.PluginException;

final class RunException extends PluginException {

    /** The session already has an active run. */
    static final String CODE_RUN_ACTIVE = "run_active";

    /** Cancellation requested for a session without an active run. */
    static final String CODE_NO_ACTIVE_RUN = "no_active_run";

    private final String code;
    private final int httpStatus;

    RunException(String code, int httpStatus, String message) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }

    String code() {
        return code;
    }

    int httpStatus() {
        return httpStatus;
    }
}
