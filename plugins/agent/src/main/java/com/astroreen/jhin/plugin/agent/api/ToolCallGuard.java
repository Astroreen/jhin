/**
 * The tool-call gate: decides per call whether the agent may execute it.
 *
 * <p>Chain semantics (implemented by the agent plugin): guards run in plugin
 * load order before {@link ToolDefinition#execute}; <strong>first block
 * wins</strong> — the first decision that does not allow the call, or the
 * first guard that throws, blocks the call and the remaining guards are not
 * consulted. A blocked call never executes: it becomes a {@code tool_result}
 * with {@code error: true} whose text starts with {@code Blocked:}.
 */
package com.astroreen.jhin.plugin.agent.api;

public interface ToolCallGuard {

    /**
     * Decides whether one tool call may execute. Called by the agent before
     * every {@link ToolDefinition#execute}, after the call was resolved to a
     * tool. Must be cheap and side-effect free: policy only.
     *
     * @param call the call about to execute
     * @return the decision; {@link ToolCallDecision#allow()} to continue or
     *         {@link ToolCallDecision#block(String)} to stop the chain
     */
    ToolCallDecision check(ToolCall call);
}
