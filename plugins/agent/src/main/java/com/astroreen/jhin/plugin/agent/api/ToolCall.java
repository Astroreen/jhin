/**
 * One tool invocation requested by the model: the call identity, the target
 * tool and its raw arguments.
 *
 * <p>Created by the agent from a model tool request, passed through the
 * {@link ToolCallGuard} chain and then to
 * {@link ToolDefinition#execute(ToolCall, ToolContext)}. The same instance
 * identifies the call in the {@code tool_use} / {@code tool_result} event
 * pair of the session log.
 */
package com.astroreen.jhin.plugin.agent.api;

/**
 * @param id        the call id, unique within one run; ties the
 *                  {@code tool_use} and {@code tool_result} events together
 * @param name      the {@link ToolDefinition#name()} of the tool to execute
 * @param arguments the arguments as JSON text (an object), matching the
 *                  tool's {@link ToolDefinition#parametersSchema()}; the tool
 *                  parses and validates them itself
 */
public record ToolCall(String id, String name, String arguments) {}
