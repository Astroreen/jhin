/**
 * Entry point of the ui-kit plugin. API-only by design: the plugin exists to
 * export {@link UiNode} and {@link Ui} to dependant plugins, so {@link #start}
 * registers nothing and {@link #stop} releases nothing.
 */
package com.astroreen.jhin.plugin.uikit;

import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.PluginContext;

public final class UiKitPlugin implements JhinPlugin {

    /**
     * Does nothing: ui-kit owns no routes, no tables and no services.
     *
     * @param ctx this plugin's context, unused
     */
    @Override
    public void start(PluginContext ctx) {
        // API-only plugin: the exports are the whole product.
    }
}
