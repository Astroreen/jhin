package com.astroreen.jhin.plugin.mcp;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Publishes every remote MCP tool as a {@code jhin.agent}
 * {@link ToolDefinition}.
 *
 * <p>Registration is live by construction: the provider is published once
 * from {@code McpPlugin.start()} and delegates to the {@link McpService} on
 * every {@link #tools()} call, so the agent always sees the tools of the
 * currently connected servers. One definition per remote tool, named
 * {@code mcp__<server>__<tool>} (double underscores); the prompt fragments
 * name the origin server and {@link RemoteToolDefinition#execute} forwards the
 * call arguments to the remote {@code tools/call} unchanged.
 */
public final class McpToolProvider implements ToolProvider {

    /** The infix of every contributed tool name. */
    static final String NAME_INFIX = "mcp__";

    private final McpService service;

    /**
     * Creates the provider over a started service.
     *
     * @param service the MCP service holding the connected servers
     */
    public McpToolProvider(McpService service) {
        this.service = service;
    }

    /**
     * The tool definitions of every currently connected remote tool. Cheap and
     * free of side effects: a thin wrapper per remote tool over the live
     * service snapshot.
     *
     * @return the contributed tool definitions, never {@code null}
     */
    @Override
    public List<ToolDefinition> tools() {
        List<ToolDefinition> definitions = new ArrayList<>();
        for (McpService.RemoteTool tool : service.tools()) {
            definitions.add(new RemoteToolDefinition(service, tool));
        }
        return List.copyOf(definitions);
    }

    /**
     * The machine name of one remote tool.
     *
     * @param server the server name
     * @param tool   the remote tool name
     * @return {@code mcp__<server>__<tool>}
     */
    static String toolName(String server, String tool) {
        return NAME_INFIX + server + "__" + tool;
    }

    /**
     * Parses the raw arguments JSON of one call into a map.
     *
     * @param name      the tool name (for the failure message)
     * @param arguments the arguments as JSON text, may be blank
     * @return the parsed object, empty for blank input
     * @throws PluginException when the text is not a JSON object
     */
    private static Map<String, Object> parseArguments(String name, String arguments) {
        if (arguments == null || arguments.isBlank()) {
            return Map.of();
        }
        try {
            return Json.readMap(arguments);
        } catch (PluginException e) {
            throw new PluginException("arguments of " + name + " are not a JSON object", e);
        }
    }

    /**
     * One remote MCP tool as a {@link ToolDefinition}. The record carries the
     * owning {@link McpService} so {@link #execute} forwards to the live
     * connection.
     *
     * @param service the service owning the server connection
     * @param tool    the remote tool description
     */
    private record RemoteToolDefinition(McpService service, McpService.RemoteTool tool)
            implements ToolDefinition {

        @Override
        public String name() {
            return toolName(tool.server(), tool.name());
        }

        @Override
        public String label() {
            return tool.label();
        }

        @Override
        public String description() {
            return tool.description();
        }

        @Override
        public String parametersSchema() {
            return Json.write(tool.inputSchema());
        }

        @Override
        public String promptSnippet() {
            return name() + " (MCP server \"" + tool.server() + "\"): " + tool.description();
        }

        @Override
        public String promptGuidelines() {
            return "Arguments of " + name() + " are forwarded unchanged to the MCP server \""
                    + tool.server() + "\", which validates them. A remote failure is returned as an error result.";
        }

        @Override
        public ToolResult execute(ToolCall call, ToolContext ctx) {
            Map<String, Object> arguments;
            try {
                arguments = parseArguments(name(), call.arguments());
            } catch (PluginException e) {
                return ToolResult.error(e.getMessage());
            }
            McpService.RemoteCallResult result = service.call(tool.server(), tool.name(), arguments);
            return result.error()
                    ? ToolResult.error(result.text())
                    : ToolResult.ok(result.text(), result.structured());
        }
    }
}
