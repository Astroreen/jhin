/**
 * The typed failure of a tool body or of tool-context path resolution.
 *
 * <p>Unchecked on purpose: {@link ToolDefinition#execute(ToolCall, ToolContext)}
 * stays free of forced try/catch plumbing and the agent catches this together
 * with any other thrown error, turning it into a {@code tool_result} with
 * {@code error: true} and the message as content. The canonical case is
 * {@link ToolContext#resolvePath(String)}, which throws
 * {@code ToolException("Path goes outside of workspace")} when a path escapes
 * the session workdir.
 */
package com.astroreen.jhin.plugin.agent.api;

public class ToolException extends RuntimeException {

    /**
     * Creates a tool failure.
     *
     * @param message the failure description, shown to the model as the error
     *                result content
     */
    public ToolException(String message) {
        super(message);
    }

    /**
     * Creates a tool failure triggered by another error.
     *
     * @param message the failure description, shown to the model as the error
     *                result content
     * @param cause   the underlying error
     */
    public ToolException(String message, Throwable cause) {
        super(message, cause);
    }
}
