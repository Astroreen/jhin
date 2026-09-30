/**
 * The outcome of one tool call: text for the conversation, optional
 * structured JSON for rich UI cards and an error flag.
 *
 * <p>Produced by {@link ToolDefinition#execute} and passed through the
 * {@link ToolResultTransformer} chain (a throwing transformer is skipped)
 * before it becomes a {@code tool_result} event and lands in the model
 * conversation. Guard-blocked calls never execute and surface as
 * {@code error} results whose text starts with {@code Blocked:}.
 *
 * <p>Use the factories instead of the canonical constructor: {@link #ok},
 * {@link #ok(String, String)} and {@link #error} fix the error flag
 * consistently.
 */
package com.astroreen.jhin.plugin.agent.api;

/**
 * @param content    the text result shown in the conversation and fed back to
 *                   the model, never {@code null}
 * @param structured optional JSON text a UI card renders instead of the plain
 *                   content (for example a diff or a table); {@code null} when
 *                   the result is text-only
 * @param error      {@code true} when the call failed; the content then holds
 *                   the failure description
 */
public record ToolResult(String content, String structured, boolean error) {

    /**
     * A successful text-only result.
     *
     * @param content the result text, never {@code null}
     * @return the successful result
     */
    public static ToolResult ok(String content) {
        return new ToolResult(content, null, false);
    }

    /**
     * A successful result with structured payload.
     *
     * @param content    the result text, never {@code null}
     * @param structured the JSON text a UI card renders; {@code null} allowed
     * @return the successful result
     */
    public static ToolResult ok(String content, String structured) {
        return new ToolResult(content, structured, false);
    }

    /**
     * A failed result, for example a guard block or an invalid argument.
     *
     * @param message the failure description, never {@code null}
     * @return the error result
     */
    public static ToolResult error(String message) {
        return new ToolResult(message, null, true);
    }
}
