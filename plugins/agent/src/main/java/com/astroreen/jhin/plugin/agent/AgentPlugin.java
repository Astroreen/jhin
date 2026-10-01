/**
 * Entry point of the agent plugin: owns the agent loop, the prompt builders
 * and the run lifecycle. Not exported — dependants see only the API package
 * {@code com.astroreen.jhin.plugin.agent.api}.
 *
 * <p>Starting wires the whole pipeline: {@link SystemPromptBuilder} with its
 * {@code PromptInterceptor} chain, {@link ConversationBuilder}, the streaming
 * {@link AgentLoop}, {@link ToolInvoker} (guard chain &rarr; execute &rarr;
 * transformer chain) and {@link RunServiceImpl} behind {@code POST
 * /sessions/{id}/messages} and {@code POST /sessions/{id}/cancel}, with
 * {@link RunRecovery} clearing stale {@code running} ledger rows first. The
 * sessions, llm and tool SPI services are resolved through the cross-plugin
 * service registry; a missing dependency fails the start with a clear error.
 * The run lifecycle is published as {@link RunService} so a user-interface
 * plugin can start and cancel runs with the route semantics.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.agent.api.PromptInterceptor;
import com.astroreen.jhin.plugin.agent.api.RunService;
import com.astroreen.jhin.plugin.agent.api.ToolCallGuard;
import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.plugin.agent.api.ToolResultTransformer;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.util.List;

public class AgentPlugin implements JhinPlugin {

    /**
     * Wires the agent pipeline and registers the two run routes. A service the
     * manifest {@code requires} but nobody published fails the start.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        ServiceRegistry services = ctx.services();
        SessionStore sessions = require(services, SessionStore.class);
        EventLog events = require(services, EventLog.class);
        ProviderRegistry providers = require(services, ProviderRegistry.class);
        ToolInvoker invoker = new ToolInvoker(
                () -> services.findAll(ToolProvider.class),
                () -> services.findAll(ToolCallGuard.class),
                () -> services.findAll(ToolResultTransformer.class),
                ctx.log());
        SystemPromptBuilder prompts = new SystemPromptBuilder(
                () -> List.copyOf(invoker.resolveTools().values()),
                () -> services.findAll(PromptInterceptor.class));
        ConversationBuilder conversations = new ConversationBuilder(events);
        AgentLoop loop = new AgentLoop(events, prompts, conversations, invoker, providers, ctx.log());
        RunServiceImpl runs = new RunServiceImpl(ctx.db(), events, ctx.streams(), loop::run, ctx.log());
        ctx.services().publish(RunService.class, runs);
        new RunRecovery(ctx.db(), ctx.log()).recover();
        MessageRoutes routes = new MessageRoutes(sessions, runs);
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/messages", routes::messages));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/cancel", routes::cancel));
        ctx.log().info("agent plugin started: run service, prompt pipeline and message routes active");
    }

    private static <T> T require(ServiceRegistry services, Class<T> type) {
        return services.find(type).orElseThrow(() -> new PluginException(
                "jhin.agent requires the service " + type.getName()
                        + "; start order or a required plugin is wrong"));
    }
}
