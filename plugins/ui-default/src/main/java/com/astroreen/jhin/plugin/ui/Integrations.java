/**
 * Optional-integration detection: the UI plugin declares its optional
 * dependencies in the manifest and must degrade when they are absent, so
 * presence is resolved by class name instead of a compile-time reference. The
 * named classes come from the exported API packages of the optional plugins
 * and are visible here exactly when that plugin is loaded (plugin-to-plugin
 * class sharing); anything else means the integration is not there.
 */
package com.astroreen.jhin.plugin.ui;

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
}
