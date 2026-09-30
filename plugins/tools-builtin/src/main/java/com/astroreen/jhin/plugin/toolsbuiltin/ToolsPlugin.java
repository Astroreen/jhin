/**
 * Entry point of the tools-builtin plugin (placeholder). Starting with T34 it
 * registers the built-in {@code ToolProvider} definitions (bash, read, write,
 * edit, find, grep, ls) with the agent; until then it only logs.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;

public class ToolsPlugin implements JhinPlugin {

    /**
     * Logs that the plugin is loaded. The real tool definitions land in T34.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        ctx.log().info("jhin.tools-builtin loaded; built-in tool definitions arrive in T34");
    }
}
