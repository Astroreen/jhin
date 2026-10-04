/**
 * Why a lifecycle operation failed; carried to the routes as
 * {@code 404 not_found}, {@code 409 invalid_transition} or
 * {@code 503 title_service_unavailable}.
 */
package com.astroreen.jhin.plugin.sessions.api;

import com.astroreen.jhin.sdk.PluginException;

/**
 * A failed lifecycle operation. The {@link Failure() failure kind} tells the
 * routes which status code and error code to answer with; the message is
 * human-readable detail for the {@code message} field of the error body.
 */
public class LifecycleException extends PluginException {

    /** The failure kinds a lifecycle operation can fail with. */
    public enum Failure {

        /** The session id is unknown (or owned by another account). */
        NOT_FOUND("not_found"),

        /** The operation does not apply to the session's current state. */
        INVALID_TRANSITION("invalid_transition"),

        /** No title service is published (or it failed to produce a title). */
        TITLE_UNAVAILABLE("title_service_unavailable");

        private final String code;

        Failure(String code) {
            this.code = code;
        }

        /**
         * The error code of this failure kind: the {@code error} field of the
         * JSON error body.
         *
         * @return the error code
         */
        public String code() {
            return code;
        }
    }

    private final Failure failure;

    /**
     * Creates a lifecycle failure.
     *
     * @param failure the failure kind
     * @param message human-readable detail for the error body
     */
    public LifecycleException(Failure failure, String message) {
        super(message);
        this.failure = failure;
    }

    /**
     * Creates a lifecycle failure with an underlying cause.
     *
     * @param failure the failure kind
     * @param message human-readable detail for the error body
     * @param cause   the underlying error
     */
    public LifecycleException(Failure failure, String message, Throwable cause) {
        super(message, cause);
        this.failure = failure;
    }

    /**
     * The failure kind of this exception.
     *
     * @return the failure kind
     */
    public Failure failure() {
        return failure;
    }
}
