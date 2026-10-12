/**
 * The nine static web-client payloads of T300: the six runtime chunks and the
 * three stylesheets, in the load order the shell document uses. One shared
 * list keeps {@link AssetRoute}, {@link WebShellRoute} and
 * {@link ServiceWorkerRoute} trivially consistent.
 */
package com.astroreen.jhin.plugin.ui;

final class WebAssets {

    /** The six runtime chunks, in load order. */
    static final String[] JS = {
        "core.js", "render.js", "actions.js", "sse.js", "keymap.js", "timeline.js"
    };

    /** The three stylesheets, in load order. */
    static final String[] CSS = {
        "tokens.css", "components.css", "screens.css"
    };

    /** All nine names, stylesheets first then the chunks (document order). */
    static final String[] NAMES = {
        "tokens.css", "components.css", "screens.css",
        "core.js", "render.js", "actions.js", "sse.js", "keymap.js", "timeline.js"
    };

    private WebAssets() {
    }

    /** The class-path directory of one payload: {@code js/} or {@code css/}. */
    static String dirOf(String name) {
        return name.endsWith(".css") ? "css/" : "js/";
    }
}