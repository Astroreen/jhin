/**
 * Entry point of the sessions plugin: migrates the schema, publishes
 * {@link SessionStore} and {@link EventLog} to the cross-plugin service
 * registry and registers the REST and SSE routes.
 *
 * <p>Routes: {@code GET/POST /sessions}, {@code GET/PATCH/DELETE /sessions/{id}}
 * (see {@link SessionRoutes}) and {@code GET /sessions/{id}/events} (see
 * {@link EventRoutes}). The QA helper {@code POST /sessions/{id}/events} is
 * registered only when the {@code qa} configuration flag is enabled — read
 * from the environment variable {@code JHIN_SESSIONS_QA} (or the {@code qa}
 * key of the {@code jhin.sessions} section of {@code config.json}); it exists
 * so the QA script can append deterministic event sequences and is absent by
 * default.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.http.RouteSpec;

public final class SessionsPlugin implements JhinPlugin {

    /**
     * Applies the schema migrations, publishes the session store and the event
     * log and registers the session and event routes.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        ctx.db().migrate(Migrations.all());
        SessionStore store = new SessionStoreImpl(ctx.db());
        EventLog eventLog = new EventLogImpl(ctx.db(), ctx.streams());
        ctx.services().publish(SessionStore.class, store);
        ctx.services().publish(EventLog.class, eventLog);
        SessionRoutes sessionRoutes = new SessionRoutes(store);
        EventRoutes eventRoutes = new EventRoutes(store, eventLog, ctx.streams());
        ctx.http().route(new RouteSpec("GET", "/sessions", sessionRoutes::list));
        ctx.http().route(new RouteSpec("POST", "/sessions", sessionRoutes::create));
        ctx.http().route(new RouteSpec("GET", "/sessions/{id}", sessionRoutes::get));
        ctx.http().route(new RouteSpec("PATCH", "/sessions/{id}", sessionRoutes::patch));
        ctx.http().route(new RouteSpec("DELETE", "/sessions/{id}", sessionRoutes::delete));
        ctx.http().route(new RouteSpec("GET", "/sessions/{id}/events", eventRoutes::stream));
        if (ctx.config().getBool("qa", false)) {
            ctx.http().route(new RouteSpec("POST", "/sessions/{id}/events", eventRoutes::appendOne));
            ctx.log().warn("QA helper enabled (JHIN_SESSIONS_QA): POST /sessions/{id}/events appends one event");
        }
        ctx.log().info("sessions plugin started: store, event log and routes published");
    }
}
