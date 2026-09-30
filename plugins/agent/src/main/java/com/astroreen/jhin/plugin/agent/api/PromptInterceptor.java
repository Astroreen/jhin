/**
 * The system-prompt hook: adjusts or vetoes one composed system prompt before
 * the model is called.
 *
 * <p>Chain semantics (implemented by the agent plugin): interceptors run in
 * plugin load order after the system prompt is composed from the base prompt
 * and every registered tool's {@link ToolDefinition#promptSnippet()} /
 * {@link ToolDefinition#promptGuidelines()}. An interceptor continues the
 * chain by returning the context (the same instance or a modified one);
 * returning {@code null} or throwing {@link PluginVetoException}
 * <strong>aborts the run</strong>: the run ends with a single {@code error}
 * event and the model is never called.
 */
package com.astroreen.jhin.plugin.agent.api;

public interface PromptInterceptor {

    /**
     * Intercepts one composed system prompt. Called by the agent at run start,
     * before any model call.
     *
     * @param ctx the composed prompt context, never {@code null}
     * @return the context to continue with (possibly modified); {@code null}
     *         aborts the run
     * @throws PluginVetoException to abort the run with the given reason
     */
    PromptContext intercept(PromptContext ctx) throws PluginVetoException;
}
