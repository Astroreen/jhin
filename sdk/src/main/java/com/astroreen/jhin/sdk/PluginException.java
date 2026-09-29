/**
 * Unchecked error thrown for contract violations: a bad manifest, duplicate
 * service publication, illegal route or migration registrations.
 *
 * <p>Thrown by SDK types themselves (for example by
 * {@link VersionRange#parse(String)} when a version range is malformed) and by
 * kernel implementations of the SDK interfaces when a plugin misuses the
 * contract. It is unchecked so that {@link JhinPlugin#start(PluginContext)} is
 * not forced to declare it.
 */
package com.astroreen.jhin.sdk;

public class PluginException extends RuntimeException {

    /**
     * Creates an exception for a contract violation that has no underlying cause.
     *
     * @param message description of the violated contract
     */
    public PluginException(String message) {
        super(message);
    }

    /**
     * Creates an exception for a contract violation triggered by another error.
     *
     * @param message description of the violated contract
     * @param cause   the underlying error
     */
    public PluginException(String message, Throwable cause) {
        super(message, cause);
    }
}
