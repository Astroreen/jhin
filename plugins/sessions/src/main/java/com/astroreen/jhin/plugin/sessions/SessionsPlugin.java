/**
 * Entry point of the sessions plugin: migrates the schema, publishes
 * {@link SessionStore}, {@link EventLog}, {@link SessionLifecycleService} and
 * {@link UndoJournal} to the cross-plugin service registry and registers the
 * REST and SSE routes.
 *
 * <p>Routes: {@code GET/POST /sessions}, {@code GET/PATCH/DELETE /sessions/{id}}
 * (see {@link SessionRoutes}), the lifecycle actions
 * {@code POST /sessions/{id}/settle|unsettle|pin|unpin|snooze|wake|archive|restore|auto-settle|title}
 * and {@code POST /sessions/reorder}, and {@code GET /sessions/{id}/events}
 * (see {@link EventRoutes}). The QA helper {@code POST /sessions/{id}/events}
 * is registered only when the {@code qa} configuration flag is enabled — read
 * from the environment variable {@code JHIN_SESSIONS_QA} (or the {@code qa}
 * key of the {@code jhin.sessions} section of {@code config.json}); it exists
 * so the QA script can append deterministic event sequences and is absent by
 * default.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.UndoJournal;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.http.RouteSpec;

public final class SessionsPlugin implements JhinPlugin {

    /** The default undo window: 5 seconds, as the "Undo for 5 seconds" UX. */
    private static final int DEFAULT_UNDO_WINDOW_MS = 5000;

    /**
     * Applies the schema migrations, publishes the session store, the event
     * log, the lifecycle service and the undo journal and registers the
     * session, lifecycle and event routes.
     *
     * @param ctx this plugin's context, valid for the whole plugin lifetime
     */
    @Override
    public void start(PluginContext ctx) {
        ctx.db().migrate(Migrations.all());
        SessionStore store = new SessionStoreImpl(ctx.db());
        EventLog eventLog = new EventLogImpl(ctx.db(), ctx.streams());
        UndoJournal journal = new UndoJournalImpl(store, eventLog,
                ctx.config().getInt("undoWindowMs", DEFAULT_UNDO_WINDOW_MS));
        SessionLifecycleService lifecycle =
                new SessionLifecycleServiceImpl(store, eventLog, ctx.services(), journal);
        ctx.services().publish(SessionStore.class, store);
        ctx.services().publish(EventLog.class, eventLog);
        ctx.services().publish(SessionLifecycleService.class, lifecycle);
        ctx.services().publish(UndoJournal.class, journal);
        SessionRoutes sessionRoutes = new SessionRoutes(store, lifecycle);
        EventRoutes eventRoutes = new EventRoutes(store, eventLog, ctx.streams());
        ctx.http().route(new RouteSpec("GET", "/sessions", sessionRoutes::list));
        ctx.http().route(new RouteSpec("POST", "/sessions", sessionRoutes::create));
        ctx.http().route(new RouteSpec("GET", "/sessions/{id}", sessionRoutes::get));
        ctx.http().route(new RouteSpec("PATCH", "/sessions/{id}", sessionRoutes::patch));
        ctx.http().route(new RouteSpec("DELETE", "/sessions/{id}", sessionRoutes::delete));
        ctx.http().route(new RouteSpec("POST", "/sessions/reorder", sessionRoutes::reorder));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/settle", sessionRoutes::settle));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/unsettle", sessionRoutes::unsettle));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/pin", sessionRoutes::pin));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/unpin", sessionRoutes::unpin));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/snooze", sessionRoutes::snooze));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/wake", sessionRoutes::wake));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/archive", sessionRoutes::archive));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/restore", sessionRoutes::restore));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/auto-settle", sessionRoutes::autoSettle));
        ctx.http().route(new RouteSpec("POST", "/sessions/{id}/title", sessionRoutes::regenerateTitle));
        ctx.http().route(new RouteSpec("GET", "/sessions/{id}/events", eventRoutes::stream));
        if (ctx.config().getBool("qa", false)) {
            ctx.http().route(new RouteSpec("POST", "/sessions/{id}/events", eventRoutes::appendOne));
            ctx.log().warn("QA helper enabled (JHIN_SESSIONS_QA): POST /sessions/{id}/events appends one event");
        }
        ctx.log().info("sessions plugin started: store, event log, lifecycle service, undo journal and routes published");
    }
}
