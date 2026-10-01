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
 *
 * <p>Extended in T33 with the pieces an interceptor may inspect and rewrite
 * beyond the prompt text: the tool set reference ({@link #tools()}, replaceable
 * through {@link #withTools(java.util.List)}) and the session metadata
 * ({@link #workdir()}, replaceable through {@link #withWorkdir(String)}).
 */
package com.astroreen.jhin.plugin.agent.api;

import java.util.List;

/**
 * @param sessionId     the session the prompt belongs to
 * @param systemPrompt  the fully composed system prompt: the base prompt plus
 *                      every registered tool's snippet and guidelines
 * @param workdir       the session workspace directory as configured;
 *                      {@code null} when unknown. Session metadata for
 *                      interceptors that shape the prompt; the authoritative
 *                      path confinement lives in {@link ToolContext}
 * @param tools         the resolved tool set the prompt was composed from,
 *                      first-wins per {@link ToolDefinition#name()},
 *                      unmodifiable and never {@code null}
 */
public record PromptContext(String sessionId, String systemPrompt, String workdir,
                            List<ToolDefinition> tools) {

    /**
     * Creates a prompt context with the minimal components, for callers that
     * have no tool set or workspace metadata yet. The tool set is empty and
     * the workdir is {@code null}.
     *
     * @param sessionId    the session the prompt belongs to
     * @param systemPrompt the composed system prompt
     */
    public PromptContext(String sessionId, String systemPrompt) {
        this(sessionId, systemPrompt, null, List.of());
    }

    /**
     * Creates a prompt context, copying the tool list so later mutation of the
     * caller's list cannot leak into the immutable context.
     *
     * @param sessionId     the session the prompt belongs to
     * @param systemPrompt  the fully composed system prompt
     * @param workdir       the session workspace directory, or {@code null}
     * @param tools         the resolved tool set, or {@code null} for none
     */
    public PromptContext {
        tools = (tools == null) ? List.of() : List.copyOf(tools);
    }

    /**
     * The same context with a replaced system prompt. Every other field stays
     * unchanged.
     *
     * @param newSystemPrompt the rewritten prompt, never {@code null}
     * @return the new context
     */
    public PromptContext withSystemPrompt(String newSystemPrompt) {
        return new PromptContext(sessionId, newSystemPrompt, workdir, tools);
    }

    /**
     * The same context with a replaced tool set reference. Every other field
     * stays unchanged.
     *
     * @param newTools the rewritten tool set, never {@code null}
     * @return the new context
     */
    public PromptContext withTools(List<ToolDefinition> newTools) {
        return new PromptContext(sessionId, systemPrompt, workdir, newTools);
    }

    /**
     * The same context with a replaced workdir. Every other field stays
     * unchanged.
     *
     * @param newWorkdir the rewritten workspace metadata, or {@code null}
     * @return the new context
     */
    public PromptContext withWorkdir(String newWorkdir) {
        return new PromptContext(sessionId, systemPrompt, newWorkdir, tools);
    }
}
