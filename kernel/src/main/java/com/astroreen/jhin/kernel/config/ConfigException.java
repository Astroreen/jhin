/**
 * Unchecked fatal error raised while loading the installation configuration.
 *
 * <p>Distinguishes broken local state (a malformed {@code config.json}) from
 * contract violations of a plugin, which surface as SDK errors instead.
 */
package com.astroreen.jhin.kernel.config;

public class ConfigException extends IllegalStateException {

    /**
     * Creates an error for configuration state that has no underlying cause.
     *
     * @param detail description of what is wrong
     */
    public ConfigException(String detail) {
        super(detail);
    }

    /**
     * Creates an error for configuration state broken by another error.
     *
     * @param detail description of what is wrong
     * @param cause  the underlying error
     */
    public ConfigException(String detail, Throwable cause) {
        super(detail, cause);
    }
}
