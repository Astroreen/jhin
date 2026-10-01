/**
 * Entry point of the default SDUI plugin: resolves the session services of
 * {@code jhin.sessions}, detects which optional integrations are loaded,
 * assembles the default screens, the action map and the four routes and
 * registers them. {@code GET /_jhin/bootstrap} replaces the kernel fallback on
 * the same path silently (a plugin route always supersedes a fallback).
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class UiPlugin implements JhinPlugin {

    /** API class of the security plugin, probed for the entry decision. */
    private static final String SECURITY_API = "com.astroreen.jhin.plugin.security.api.Principal";

    /** API class of the LLM plugin, probed for the providers screen. */
    private static final String LLM_API = "com.astroreen.jhin.plugin.llm.api.ProviderRegistry";

    private StreamRoute streamRoute;

    /**
     * Publishes nothing and registers the bootstrap, screen, action and stream
     * routes. Optional integrations degrade: without the security plugin the
     * entry screen is the session list, without the LLM plugin there is no
     * providers screen.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        SessionStore store = ctx.services().find(SessionStore.class)
                .orElseThrow(() -> new PluginException("jhin.sessions did not publish SessionStore"));
        EventLog events = ctx.services().find(EventLog.class)
                .orElseThrow(() -> new PluginException("jhin.sessions did not publish EventLog"));
        boolean securityPresent = Integrations.present(SECURITY_API);
        boolean llmPresent = Integrations.present(LLM_API);

        ScreenRegistry screens = new Screens(store, llmPresent);
        CapabilityTailor tailor = new CapabilityTailor(events);
        streamRoute = new StreamRoute(store, events, ctx.streams());
        ctx.onShutdown(streamRoute::shutdown);

        Map<String, ActionRoute.ActionHandler> handlers = new LinkedHashMap<>();
        handlers.put("enroll", (req, payload) -> List.of(Directives.toast(
                securityPresent
                        ? "Cannot enroll this device right now."
                        : "This server has no security plugin installed.",
                "info")));

        BootstrapRoute bootstrap = new BootstrapRoute(screens, securityPresent, tailor);
        ScreenRoute screen = new ScreenRoute(screens, tailor);
        ActionRoute action = new ActionRoute(handlers);
        ctx.http().route(new RouteSpec("GET", "/_jhin/bootstrap", bootstrap::handle));
        ctx.http().route(new RouteSpec("GET", "/ui/screen/{id}", screen::handle));
        ctx.http().route(new RouteSpec("POST", "/ui/action/{name}", action::handle));
        ctx.http().route(new RouteSpec("GET", "/ui/stream/session/{id}", streamRoute::handle));
        ctx.log().info("ui plugin started: bootstrap, screen, action and stream routes registered");
    }

    /**
     * Releases the live stream forwarders. Called by the kernel on shutdown,
     * after {@code start} has run.
     */
    @Override
    public void stop() {
        if (streamRoute != null) {
            streamRoute.shutdown();
        }
    }
}
