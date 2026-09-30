/**
 * The veto a {@link PromptInterceptor} throws to abort a run before the model
 * is called.
 *
 * <p>Unchecked on purpose: the SPI signature
 * {@link PromptInterceptor#intercept(PromptContext)} stays free of forced
 * try/catch plumbing and only declares this one type to make a deliberate
 * veto explicit. The agent turns the message into the payload of a single
 * {@code error} event and ends the run.
 */
package com.astroreen.jhin.plugin.agent.api;

public class PluginVetoException extends RuntimeException {

    /**
     * Creates a run veto.
     *
     * @param message the reason surfaced in the {@code error} event
     */
    public PluginVetoException(String message) {
        super(message);
    }

    /**
     * Creates a run veto triggered by another error.
     *
     * @param message the reason surfaced in the {@code error} event
     * @param cause   the underlying error
     */
    public PluginVetoException(String message, Throwable cause) {
        super(message, cause);
    }
}
