/**
 * The composed system prompt of one run, handed to every
 * {@link PromptInterceptor}.
 *
 * <p>An immutable value on purpose: an interceptor rewrites the prompt by
 * returning a new context from {@link #withSystemPrompt(String)} instead of
 * mutating shared state, so a misbehaving plugin cannot corrupt the prompt of
 * a concurrent run. The chain rule is documented on
 * {@link PromptInterceptor}: {@code null} return or
 * {@link PluginVetoException} aborts the run.
 */
package com.astroreen.jhin.plugin.agent.api;

/**
 * @param sessionId     the session the prompt belongs to
 * @param systemPrompt  the fully composed system prompt: the base prompt plus
 *                      every registered tool's snippet and guidelines
 */
public record PromptContext(String sessionId, String systemPrompt) {

    /**
     * The same context with a replaced system prompt. Every other field stays
     * unchanged.
     *
     * @param newSystemPrompt the rewritten prompt, never {@code null}
     * @return the new context
     */
    public PromptContext withSystemPrompt(String newSystemPrompt) {
        return new PromptContext(sessionId, newSystemPrompt);
    }
}
