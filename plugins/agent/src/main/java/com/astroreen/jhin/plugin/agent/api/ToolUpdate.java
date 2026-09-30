/**
 * One incremental output chunk of a running tool, published through
 * {@link ToolContext#publish(ToolUpdate)} before the final
 * {@link ToolResult}.
 *
 * <p>Used for long-running tools (a build, a search) whose output the user
 * should see while it accumulates. Updates never enter the model
 * conversation: they only reach the session event stream for live UI.
 */
package com.astroreen.jhin.plugin.agent.api;

/**
 * @param text one chunk of tool output, for example a line of standard output
 */
public record ToolUpdate(String text) {}
