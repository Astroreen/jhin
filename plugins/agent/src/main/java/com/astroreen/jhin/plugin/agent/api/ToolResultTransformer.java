/**
 * The result filter: adjusts one finished tool result before it reaches the
 * conversation and the UI.
 *
 * <p>Chain semantics (implemented by the agent plugin): transformers run in
 * plugin load order over the result of {@link ToolDefinition#execute};
 * <strong>a transformer that throws is skipped</strong> — its input result
 * passes through unchanged and the chain continues with the remaining
 * transformers. Transformers are for presentation (redaction, truncation,
 * enrichment), never for control flow: to veto a call use
 * {@link ToolCallGuard}, to fail it throw from the tool body.
 */
package com.astroreen.jhin.plugin.agent.api;

public interface ToolResultTransformer {

    /**
     * Transforms one tool result. Called by the agent after the tool body
     * returned or failed and before the {@code tool_result} event is written.
     *
     * @param r the result produced so far, never {@code null}
     * @return the transformed result; return {@code r} unchanged to pass
     * @throws Exception never fatal: a throwing transformer is skipped and
     *                   the chain continues with its input
     */
    ToolResult transform(ToolResult r);
}
