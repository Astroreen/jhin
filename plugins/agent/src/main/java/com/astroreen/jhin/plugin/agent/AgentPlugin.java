/**
 * Entry point of the agent plugin: owns the agent loop, the prompt builders
 * and the run lifecycle. Not exported — dependants see only the API package
 * {@code com.astroreen.jhin.plugin.agent.api}.
 *
 * <p>Starting with T33 this entry point wires the whole pipeline: the
 * system-prompt builder with its {@code PromptInterceptor} chain, the
 * conversation builder, the streaming agent loop, the tool invoker (guard
 * chain &rarr; execute &rarr; transformer chain) and the run service behind
 * {@code POST /sessions/{id}/messages} and {@code POST /sessions/{id}/cancel}.
 * Until then {@link #start} is a placeholder that only logs.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;

public class AgentPlugin implements JhinPlugin {

    /**
     * Logs that the plugin is loaded. The real wiring (agent loop, prompts,
     * runs) lands in T33.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        ctx.log().info("jhin.agent loaded; agent loop wiring arrives in T33");
    }
}
