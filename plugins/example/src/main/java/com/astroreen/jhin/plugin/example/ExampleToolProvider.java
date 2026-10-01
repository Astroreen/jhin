/**
 * The optional tool surface of the reference plugin (surface 5): one tiny
 * {@code example_echo} tool contributed to the agent.
 *
 * <p>This class compiles against the exported SPI of {@code jhin.agent}
 * ({@code compileOnly} in build.gradle) and is loaded only after
 * {@link ExamplePlugin}'s probe resolved an agent API class, so a missing
 * agent never causes a linkage error. When present, the provider is published
 * to the cross-plugin service registry and the agent picks it up live through
 * {@code services().findAll(ToolProvider.class)}.
 */
package com.astroreen.jhin.plugin.example;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.json.Json;
import java.util.List;
import java.util.Map;

final class ExampleToolProvider implements ToolProvider {

    /**
     * Publishes one provider instance to the service registry.
     *
     * @param ctx the plugin context of jhin.example
     * @return the number of contributed tools
     */
    static int register(PluginContext ctx) {
        ExampleToolProvider provider = new ExampleToolProvider();
        ctx.services().publish(ToolProvider.class, provider);
        return provider.tools().size();
    }

    @Override
    public List<ToolDefinition> tools() {
        return List.of(new EchoTool());
    }

    /** The demo tool: echoes its {@code text} argument back to the model. */
    private static final class EchoTool implements ToolDefinition {

        @Override
        public String name() {
            return "example_echo";
        }

        @Override
        public String label() {
            return "Echo";
        }

        @Override
        public String description() {
            return "Echoes the given text back.";
        }

        @Override
        public String parametersSchema() {
            return "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}";
        }

        @Override
        public String promptSnippet() {
            return "example_echo(text): echoes the text back.";
        }

        @Override
        public String promptGuidelines() {
            return "Use example_echo to verify that plugin tools are wired; it never touches the filesystem.";
        }

        @Override
        public ToolResult execute(ToolCall call, ToolContext ctx) {
            Map<String, Object> args = Json.readMap(call.arguments());
            Object text = args.get("text");
            if (text == null) {
                return ToolResult.error("missing required argument: text");
            }
            return ToolResult.ok("echo: " + text);
        }
    }
}
