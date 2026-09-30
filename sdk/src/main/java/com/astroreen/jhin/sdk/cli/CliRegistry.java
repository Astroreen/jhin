/**
 * Plugin-facing CLI extension point: host commands.
 *
 * <p>Obtained from {@link com.astroreen.jhin.sdk.PluginContext#cli()} and
 * called during {@link com.astroreen.jhin.sdk.JhinPlugin#start}. Invoked as
 * {@code java -jar jhin-kernel.jar cli <name> [args...]} — plugins are loaded
 * and {@code start()} runs, but the HTTP server never boots.
 */
package com.astroreen.jhin.sdk.cli;

public interface CliRegistry {

    /**
     * Registers a CLI command. Called by a plugin during
     * {@link com.astroreen.jhin.sdk.JhinPlugin#start} for every command it
     * serves; the kernel dispatches {@code cli <name> [args...]} to the
     * matching spec's handler.
     *
     * @param spec the command to register
     */
    void command(CliCommandSpec spec);
}
