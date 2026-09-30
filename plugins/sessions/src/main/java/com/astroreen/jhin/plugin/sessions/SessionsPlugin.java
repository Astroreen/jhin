/**
 * Entry point of the sessions plugin: migrates the schema and publishes
 * {@link SessionStore} and {@link EventLog} to the cross-plugin service
 * registry.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;

public final class SessionsPlugin implements JhinPlugin {

    /**
     * Applies the schema migrations and publishes the session store and the
     * event log.
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
        ctx.log().info("sessions plugin started: store and event log published");
    }
}
