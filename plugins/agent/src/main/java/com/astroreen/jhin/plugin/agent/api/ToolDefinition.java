/**
 * One tool the agent can call: its identity, its prompt contribution and its
 * executable body.
 *
 * <p>A definition is contributed by a {@link ToolProvider} and used for two
 * different jobs: the prompt builder embeds {@link #promptSnippet()} and
 * {@link #promptGuidelines()} into the system prompt, and the tool invoker
 * routes a matching {@link ToolCall} to {@link #execute}. Definitions are
 * immutable value objects; all mutable state lives in the executing plugin or
 * behind the {@link ToolContext}.
 */
package com.astroreen.jhin.plugin.agent.api;

public interface ToolDefinition {

    /**
     * The unique machine name of the tool, for example {@code read}. It is the
     * key for first-wins resolution across {@link ToolProvider}s and the value
     * carried by {@link ToolCall#name()} and in {@code tool_use} events.
     *
     * @return the tool name, unique across all registered providers
     */
    String name();

    /**
     * The short human-readable label for UI surfaces, for example {@code Read}.
     *
     * @return the display label
     */
    String label();

    /**
     * The one-line description of what the tool does. Shown in tool pickers
     * and used by the model to choose a tool.
     *
     * @return the tool description
     */
    String description();

    /**
     * The JSON Schema of {@link ToolCall#arguments()}, as JSON text (an object
     * schema with named properties). The agent validates nothing itself: the
     * tool parses and checks its own arguments.
     *
     * @return the JSON Schema text of the arguments
     */
    String parametersSchema();

    /**
     * The compact prompt fragment describing this tool, typically one usage
     * line. The system-prompt builder embeds every registered snippet after
     * the base prompt.
     *
     * @return the prompt snippet, never {@code null}
     */
    String promptSnippet();

    /**
     * The longer prompt fragment with the rules and edge cases of this tool.
     * Embedded by the system-prompt builder right after
     * {@link #promptSnippet()}.
     *
     * @return the prompt guidelines, never {@code null}
     */
    String promptGuidelines();

    /**
     * Executes one tool call. The invoker has already run the
     * {@link ToolCallGuard} chain (first block wins) and executes this method
     * only for allowed calls. A thrown exception is captured by the agent as
     * an error {@code tool_result}; a cancellation is signalled through
     * {@link ToolContext#isCancelled()}, which the body should poll on long
     * operations.
     *
     * @param call the call to execute, with the parsed arguments text
     * @param ctx  the per-run tool context (workdir, cancellation, updates)
     * @return the result of the call, never {@code null}
     * @throws Exception when the tool fails; the agent turns it into an error
     *                   result instead of failing the run
     */
    ToolResult execute(ToolCall call, ToolContext ctx) throws Exception;
}
