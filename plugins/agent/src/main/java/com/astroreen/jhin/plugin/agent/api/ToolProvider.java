/**
 * The tool SPI: one implementation publishes the tool set of a plugin to the
 * agent.
 *
 * <p>Published to the cross-plugin service registry during
 * {@link com.astroreen.jhin.sdk.JhinPlugin#start}; the agent resolves the
 * registry live through {@code services().findAll(ToolProvider.class)} at run
 * start, so a plugin installed later contributes tools without a restart.
 * Several providers may define the same tool name: the first definition in
 * load order wins and the collision is logged with a {@code WARN}.
 *
 * <p>The SPI chain around one tool call, documented on the participating
 * types: {@link ToolCallGuard} (first block wins) &rarr;
 * {@link ToolDefinition#execute} &rarr; {@link ToolResultTransformer} (a
 * throwing transformer is skipped).
 */
package com.astroreen.jhin.plugin.agent.api;

import java.util.List;

public interface ToolProvider {

    /**
     * The tool definitions this plugin contributes. Called by the agent at run
     * start; creating the list must be cheap and free of side effects.
     *
     * @return the contributed tool definitions, never {@code null}
     */
    List<ToolDefinition> tools();
}
