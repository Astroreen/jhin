/**
 * Entry point of the tools-builtin plugin: builds the built-in tool set and
 * publishes it as ONE {@link ToolProvider} to the cross-plugin service
 * registry, where {@code jhin.agent}'s {@code ToolInvoker} picks it up at run
 * start (first-wins by name).
 *
 * <p>The suite is {@code ls, write, read, edit, edit-diff, find, grep, bash,
 * ask_user}; {@code powershell} is appended only when {@code os.name} starts
 * with {@code Windows}, so non-Windows hosts see exactly nine tools. The
 * registration is testable through {@link #buildTools(String, QuestionBridge)}
 * and {@link #isWindows(String)} (injectable os name) and
 * {@link #toolNames(List)}.
 *
 * <p>The plugin also publishes the {@link QuestionBridge} - the
 * pending-question seam a tool uses to wait for the user's answer - through
 * the exported api package {@code com.astroreen.jhin.plugin.toolsbuiltin.api}.
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
import com.astroreen.jhin.plugin.toolsbuiltin.api.QuestionBridge;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import java.util.ArrayList;
import java.util.List;

public class ToolsPlugin implements JhinPlugin {

    /**
     * Builds the tool set for this host and publishes one
     * {@link ToolProvider} carrying it, plus the {@link QuestionBridge}
     * shared by tools that must wait for the user's answer.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        QuestionBridge bridge = new QuestionBridgeImpl();
        List<ToolDefinition> tools = buildTools(System.getProperty("os.name", ""), bridge);
        ctx.services().publish(ToolProvider.class, new BuiltinToolsProvider(tools));
        ctx.services().publish(QuestionBridge.class, bridge);
        ctx.log().info("jhin.tools-builtin started: {} tools: {}", tools.size(), String.join(", ", toolNames(tools)));
    }

    /**
     * The tool set for one os name: the nine always-on tools plus
     * {@code powershell} when {@link #isWindows(String)} holds.
     *
     * @param osName the {@code os.name} property value
     * @param bridge the question bridge {@code ask_user} blocks on; the same
     *               instance the plugin publishes to the service registry
     * @return the tools in stable registration order
     */
    static List<ToolDefinition> buildTools(String osName, QuestionBridge bridge) {
        List<ToolDefinition> tools = new ArrayList<>(List.of(
                new LsTool(),
                new WriteTool(),
                new ReadTool(),
                new EditTool(),
                new EditDiffTool(),
                new FindTool(),
                new GrepTool(),
                new BashTool(),
                new AskUserTool(bridge)));
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
