/**
 * Typed LLM registry error with a stable wire code and the HTTP status the
 * routes layer must answer with.
 *
 * <p>Mapping contract for route authors (the codes are the exact JSON
 * {@code error} values):
 * <ul>
 *   <li>{@link #CODE_UNKNOWN_FORMAT} — HTTP 400: no registered factory
 *       matches the requested provider format</li>
 *   <li>{@link #CODE_NOT_FOUND} — HTTP 404: the referenced provider is
 *       unknown or owned by another account</li>
 *   <li>{@link #CODE_INVALID_REQUEST} — HTTP 400: a request field is
 *       missing, blank or not a string</li>
 * </ul>
 */
package com.astroreen.jhin.plugin.llm.api;

import com.astroreen.jhin.sdk.PluginException;

public class ProviderException extends PluginException {

    /** No factory registered for the requested provider format. */
    public static final String CODE_UNKNOWN_FORMAT = "unknown_format";

    /** Referenced provider does not exist (or is foreign to the caller). */
    public static final String CODE_NOT_FOUND = "not_found";

    /** Request body field missing, blank or not a string. */
    public static final String CODE_INVALID_REQUEST = "invalid_request";

    private final String code;
    private final int httpStatus;

    /**
     * Creates a provider registry error.
     *
     * @param code       the stable wire code, one of the {@code CODE_*} constants
     * @param httpStatus the HTTP status the routes layer must answer with
     * @param message    human-readable detail, never contains secrets
     */
    public ProviderException(String code, int httpStatus, String message) {
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
