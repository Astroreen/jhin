/**
 * Entry point of the tools-builtin plugin: builds the built-in tool set and
 * publishes it as ONE {@link ToolProvider} to the cross-plugin service
 * registry, where {@code jhin.agent}'s {@code ToolInvoker} picks it up at run
 * start (first-wins by name).
 *
 * <p>The suite is {@code ls, write, read, edit, edit-diff, find, grep, bash};
 * {@code powershell} is appended only when {@code os.name} starts with
 * {@code Windows}, so non-Windows hosts see exactly eight tools. The
 * registration is testable through {@link #buildTools(String)} and
 * {@link #isWindows(String)} (injectable os name) and
 * {@link #toolNames(List)}.
 *
 * <p>Error contract of every tool: a failure is returned as
 * {@code ToolResult.error(message)} with a stable message (never thrown), so
 * callers and tests observe one surface - see
 * {@link FileToolSupport} for the shared helpers and the documented
 * {@code structured} card family.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import java.util.ArrayList;
import java.util.List;

public class ToolsPlugin implements JhinPlugin {

    /**
     * Builds the tool set for this host and publishes one
     * {@link ToolProvider} carrying it.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        List<ToolDefinition> tools = buildTools(System.getProperty("os.name", ""));
        ctx.services().publish(ToolProvider.class, new BuiltinToolsProvider(tools));
        ctx.log().info("jhin.tools-builtin started: {} tools: {}", tools.size(), String.join(", ", toolNames(tools)));
    }

    /**
     * The tool set for one os name: the eight always-on tools plus
     * {@code powershell} when {@link #isWindows(String)} holds.
     *
     * @param osName the {@code os.name} property value
     * @return the tools in stable registration order
     */
    static List<ToolDefinition> buildTools(String osName) {
        List<ToolDefinition> tools = new ArrayList<>(List.of(
                new LsTool(),
                new WriteTool(),
                new ReadTool(),
                new EditTool(),
                new EditDiffTool(),
                new FindTool(),
                new GrepTool(),
                new BashTool()));
        if (isWindows(osName)) {
            tools.add(new PowerShellTool());
        }
        return List.copyOf(tools);
    }

    /**
     * The registration predicate of {@code powershell}: {@code os.name}
     * starts with {@code Windows}.
     *
     * @param osName the {@code os.name} property value, never {@code null}
     * @return {@code true} on Windows hosts
     */
    static boolean isWindows(String osName) {
        return osName.startsWith("Windows");
    }

    /**
     * The tool names in registration order, for tests and startup logging.
     *
     * @param tools the tool definitions
     * @return the names
     */
    static List<String> toolNames(List<ToolDefinition> tools) {
        List<String> names = new ArrayList<>();
        for (ToolDefinition tool : tools) {
            names.add(tool.name());
        }
        return names;
    }

    /**
     * The single published provider: a named class so registry collision
     * warnings name the owner meaningfully.
     */
    private static final class BuiltinToolsProvider implements ToolProvider {

        private final List<ToolDefinition> tools;

        BuiltinToolsProvider(List<ToolDefinition> tools) {
            this.tools = tools;
        }

        @Override
        public List<ToolDefinition> tools() {
            return tools;
        }
    }
}
