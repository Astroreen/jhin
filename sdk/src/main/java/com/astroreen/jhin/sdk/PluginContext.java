/**
 * Everything a plugin may touch.
 *
 * <p>Created by the kernel per plugin and passed as the sole argument to
 * {@link JhinPlugin#start(PluginContext)}; stays valid for the whole plugin
 * lifetime. Called by the plugin during startup and from the code it registers
 * (routes, hooks, services).
 */
package com.astroreen.jhin.sdk;

public interface PluginContext {

    /**
     * This plugin's own manifest. Called when the plugin needs its id, version
     * or declared exports.
     */
    PluginManifest manifest();

    /**
     * This plugin's logger, already named after the plugin id. Called for all
     * plugin output; never configure it yourself.
     */
    org.slf4j.Logger log();

    /**
     * Per-plugin writable directory. Called when the plugin needs to persist
     * state on disk.
     */
    java.nio.file.Path dataDir();          // JHIN_HOME/data/<id>/, created 0700

    /**
     * This plugin's config section. Called to read settings; see
     * {@link ConfigView} for the resolution order.
     */
    ConfigView config();                   // this plugin's config section

    /**
     * Cross-plugin service registry. Called to publish or consume services;
     * see {@link ServiceRegistry} for the publication rules.
     */
    ServiceRegistry services();

    /**
     * The HTTP extension registry. Called during {@link JhinPlugin#start} to
     * register routes, filters and TLS.
     */
    com.astroreen.jhin.sdk.http.HttpRegistry http();

    /**
     * Database access. Called when the plugin needs persistent storage shared
     * with the host schema.
     */
    com.astroreen.jhin.sdk.db.DbAccess db();

    /**
     * Event-stream registry. Called when the plugin publishes or consumes
     * session streams.
     */
    com.astroreen.jhin.sdk.stream.StreamRegistry streams();

    /**
     * The scheduler seam for deferred and periodic work. Called to run
     * one-shot or repeating work on the host-owned executor; see
     * {@link com.astroreen.jhin.sdk.sched.SchedulerRegistry} for the runtime
     * contract (a duplicate name replaces the previous task, cancel is
     * idempotent, a throwing task is logged and swallowed, everything is
     * dropped at host shutdown).
     *
     * <p>A default method keeps contexts compiled against earlier revisions
     * of this interface loadable — the plugin contract level stays at
     * {@link ApiVersion#CURRENT}; a context that does not implement the seam
     * throws {@link UnsupportedOperationException} on first use.
     */
    default com.astroreen.jhin.sdk.sched.SchedulerRegistry sched() {
        throw new UnsupportedOperationException(
                "sched() is not available on this context implementation");
    }

    /**
     * CLI extension registry. Called when the plugin adds host commands.
     */
    com.astroreen.jhin.sdk.cli.CliRegistry cli();

    /**
     * Host facts (versions, home, loaded plugins). Called for compatibility
     * checks and cross-plugin discovery; see {@link KernelInfo}.
     */
    KernelInfo kernel();

    /**
     * Registers a hook to run once when the host is fully up. Called during
     * {@link JhinPlugin#start} to defer work that needs a listening server.
     */
    void onStarted(Runnable hook);         // after the HTTP server is listening

    /**
     * Registers a hook to run on graceful shutdown. Called during
     * {@link JhinPlugin#start} to release resources the kernel should clean up.
     */
    void onShutdown(Runnable hook);
}
