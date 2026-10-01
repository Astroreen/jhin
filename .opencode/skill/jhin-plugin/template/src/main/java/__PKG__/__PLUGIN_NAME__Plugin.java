/**
 * Entry point of {@code __PLUGIN_ID__}: the class named by the manifest's
 * {@code mainClass}. The kernel instantiates it through the plugin's class
 * loader and calls {@link #start} once, before the HTTP server starts.
 */
package __PKG__;

import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;

public final class __PLUGIN_NAME__Plugin implements JhinPlugin {

    @Override
    public void start(PluginContext ctx) throws Exception {
        // Register EVERYTHING here: routes, filters, migrations, streams, CLI
        // commands and services. Nothing may be registered after the HTTP
        // server is listening; use ctx.onStarted for that.
        Routes.install(ctx);
        ctx.log().info("__PLUGIN_ID__ started");
    }

    /**
     * Releases resources on graceful shutdown, reverse load order. Best
     * effort: errors are logged and do not stop the remaining plugins.
     */
    @Override
    public void stop() {}
}
