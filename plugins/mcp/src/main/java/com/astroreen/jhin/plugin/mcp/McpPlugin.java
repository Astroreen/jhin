package com.astroreen.jhin.plugin.mcp;

import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginException;
import java.nio.file.Path;
import java.util.Optional;

/**
 * Entry point of the mcp plugin: reads {@code $JHIN_HOME/mcp.json}, starts one
 * MCP client per declared server and publishes one live
 * {@link McpToolProvider} to the cross-plugin service registry, where
 * {@code jhin.agent} picks it up at run start.
 *
 * <p>Lifecycle contract: an absent {@code mcp.json} is a logged no-op; a
 * malformed one fails {@link #start(PluginContext)} with a
 * {@link PluginException}; a server that fails to start is skipped with an
 * {@code ERROR} and never blocks the others ({@link McpService}); {@link #stop()}
 * closes every transport, destroying spawned stdio server processes.
 *
 * <p>Configuration ({@code jhin.mcp} section of {@code config.json}, or the
 * {@code JHIN_MCP_*} environment):
 * <ul>
 *   <li>{@code config.file} - overrides the location of {@code mcp.json},
 *       defaulting to {@code <JHIN_HOME>/mcp.json}</li>
 * </ul>
 */
public class McpPlugin implements JhinPlugin {

    /** The config key overriding the location of {@code mcp.json}. */
    static final String CONFIG_FILE_KEY = "config.file";

    /** The file name read from {@code JHIN_HOME} by default. */
    static final String CONFIG_FILE_NAME = "mcp.json";

    private McpService service;

    /**
     * Loads the configuration, starts every configured server and publishes
     * the tool provider.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     * @throws PluginException when {@code mcp.json} is malformed
     */
    @Override
    public void start(PluginContext ctx) {
        Path file = resolveConfigFile(ctx);
        Optional<McpConfig> config = McpConfig.load(file);
        if (config.isEmpty()) {
            ctx.log().info("jhin.mcp: no configuration at {}; no MCP servers to start", file);
            return;
        }
        service = new McpService(config.get(), ctx.log());
        service.start();
        McpToolProvider provider = new McpToolProvider(service);
        ctx.services().publish(ToolProvider.class, provider);
        int configured = config.get().servers().size();
        int skipped = service.startFailures().size();
        ctx.log().info("jhin.mcp started: {} server(s) connected with {} tool(s), {} server(s) skipped: {}",
                configured - skipped, service.tools().size(), skipped, service.startFailures().keySet());
    }

    /**
     * Closes every MCP transport (destroying spawned stdio server processes).
     * Idempotent; errors are logged and swallowed.
     */
    @Override
    public void stop() {
        if (service != null) {
            service.stop();
            service = null;
        }
    }

    /**
     * Resolves the {@code mcp.json} location: the {@code config.file} setting
     * when present, else {@code <JHIN_HOME>/mcp.json}.
     *
     * @param ctx this plugin's context
     * @return the config file path
     */
    private static Path resolveConfigFile(PluginContext ctx) {
        String override = ctx.config().get(CONFIG_FILE_KEY).orElse(null);
        if (override != null && !override.isBlank()) {
            return Path.of(override);
        }
        return ctx.kernel().home().resolve(CONFIG_FILE_NAME);
    }
}
