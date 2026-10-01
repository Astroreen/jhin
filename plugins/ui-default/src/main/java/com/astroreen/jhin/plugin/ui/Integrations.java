/**
 * Optional-integration detection: the UI plugin declares its optional
 * dependencies in the manifest and must degrade when they are absent, so
 * presence is resolved without a compile-time reference.
 *
 * <p>Two probes: {@link #present} resolves an exported API class by name —
 * visible exactly when the plugin that exports it is loaded (plugin-to-plugin
 * class sharing) — and {@link #loaded} checks the kernel's plugin-id list for
 * a plugin that exports no API class of its own (like {@code jhin.reload}).
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.KernelInfo;

final class Integrations {

    private Integrations() {
    }

    /**
     * Whether the plugin exporting the named API class is loaded.
     *
     * @param className the fully qualified API class name to probe
     * @return {@code true} when the class resolves in this plugin's loader
     */
    static boolean present(String className) {
        try {
            Class.forName(className);
            return true;
        } catch (ClassNotFoundException | LinkageError e) {
            return false;
        }
    }

    /**
     * Whether a plugin with the given id started in the current load pass.
     * Called for optional plugins that export no API class to probe.
     *
     * @param kernel   the running kernel's facts
     * @param pluginId the manifest id to look for
     * @return {@code true} when the plugin is loaded
     */
    static boolean loaded(KernelInfo kernel, String pluginId) {
        return kernel.plugins().stream().anyMatch(plugin -> pluginId.equals(plugin.id()));
    }
}
