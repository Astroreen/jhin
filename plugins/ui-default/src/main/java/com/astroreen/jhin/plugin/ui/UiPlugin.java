/**
 * Entry point of the default SDUI plugin: resolves the session services of
 * {@code jhin.sessions}, detects which optional integrations are loaded,
 * assembles the default screens, the action table and the seven routes and
 * registers them. {@code GET /} serves the web-client shell document and
 * {@code GET /_jhin/bootstrap} replaces the kernel fallback on
 * the same path silently (a plugin route always supersedes a fallback).
 *
 * <p>The optional integrations (jhin.security, jhin.llm, jhin.agent,
 * jhin.reload) are detected once at start through the {@link Integrations}
 * probes and flow into every screen and handler as the {@link Features}
 * snapshot: an absent plugin means an absent screen, an action that answers
 * with an explanatory toast and no reference to its API classes.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.util.Map;
import java.util.function.Predicate;

public final class UiPlugin implements JhinPlugin {

    /** API class of the security plugin, probed for the enroll surface. */
    private static final String SECURITY_API =
            "com.astroreen.jhin.plugin.security.api.EnrollmentService";

    /** API class of the LLM plugin, probed for the providers surface. */
    private static final String LLM_API = "com.astroreen.jhin.plugin.llm.api.ProviderRegistry";

    /** API class of the agent plugin, probed for the run actions. */
    private static final String AGENT_API = "com.astroreen.jhin.plugin.agent.api.RunService";

    /** Plugin id of the reload plugin, which exports no API class to probe. */
    private static final String RELOAD_ID = "jhin.reload";

    /** Class-name probe of the optional integrations; injectable for tests. */
    private final Predicate<String> probe;

    private StreamRoute streamRoute;

    /** Production constructor: probes the class path of this plugin. */
    public UiPlugin() {
        this(Integrations::present);
    }

    /**
     * Test constructor: probes through the supplied predicate instead of the
     * class path, so the degradation paths run deterministically.
     *
     * @param probe class name to presence
     */
    UiPlugin(Predicate<String> probe) {
        this.probe = probe;
    }

    /**
     * Publishes nothing and registers the web shell, bootstrap, screen,
     * action, search and stream routes. Optional integrations degrade: without
     * the security
     * plugin there
     * is no enroll screen, without the LLM plugin no providers screen, without
     * the agent plugin the run actions answer with a toast.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        SessionStore store = ctx.services().find(SessionStore.class)
                .orElseThrow(() -> new PluginException("jhin.sessions did not publish SessionStore"));
        EventLog events = ctx.services().find(EventLog.class)
                .orElseThrow(() -> new PluginException("jhin.sessions did not publish EventLog"));
        Features features = new Features(
                probe.test(SECURITY_API),
                probe.test(LLM_API),
                probe.test(AGENT_API),
                Integrations.loaded(ctx.kernel(), RELOAD_ID));

        UiSettings settings = new UiSettings(ctx.config(), ctx.dataDir());
        ScreenRegistry screens = new Screens(store, events, ctx.services(), ctx.kernel(),
                features, settings);
        CapabilityTailor tailor = new CapabilityTailor(events);
        streamRoute = new StreamRoute(store, events, ctx.streams());
        ctx.onShutdown(streamRoute::shutdown);
        Map<String, ActionRoute.ActionHandler> handlers =
                Actions.build(store, ctx.services(), features, settings);

        BootstrapRoute bootstrap = new BootstrapRoute(screens, features.security(), tailor, settings);
        WebShellRoute webShell = new WebShellRoute(settings);
        ScreenRoute screen = new ScreenRoute(screens, tailor);
        ActionRoute action = new ActionRoute(handlers);
        SearchRoute search = new SearchRoute(store, events);
        // The literal root template is expected to match an exact `/` request
        // (RouteMatcher prefers literal segments over the `/*` dispatch); the
        // T202 QA script proves the runtime dispatch.
        ctx.http().route(new RouteSpec("GET", "/", webShell::handle));
        ctx.http().route(new RouteSpec("GET", "/_jhin/bootstrap", bootstrap::handle));
        ctx.http().route(new RouteSpec("GET", "/ui/screen/{id}", screen::handle));
        // The literal `search` segment wins over the `{name}` capture of the
        // action route (RouteMatcher prefers literal segments), so the
        // palette search answers its own result-list shape.
        ctx.http().route(new RouteSpec("POST", "/ui/action/search", search::handle));
        ctx.http().route(new RouteSpec("POST", "/ui/action/{name}", action::handle));
        ctx.http().route(new RouteSpec("GET", "/ui/stream/session/{id}", streamRoute::handle));
        ctx.http().route(new RouteSpec("GET", "/ui/stream/sessions-overview", streamRoute::handleOverview));
        ctx.log().info("ui plugin started: web shell, bootstrap, screen, action, search and stream routes registered");
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
