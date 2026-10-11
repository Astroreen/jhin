/**
 * {@code GET /}: the web-client shell document (T202, contract level 4).
 *
 * <p>Serves the full HTML document of the browser client: the static
 * {@code /web/index.html} template of this plugin with the three inline
 * payloads filled in — the token CSS {@link com.astroreen.jhin.plugin.uikit.html.TokenCss#root}
 * derives from the effective {@link UiSettings} snapshot (the same theme map
 * {@link BootstrapRoute} builds, the {@link TokenDefaults} token surface and
 * the saved density), the raw {@code app.css} runtime styles and the raw
 * {@code app.js} runtime script. The three {@code __JHIN_*__} placeholders
 * of the template are replaced verbatim; a jar missing one of the resources
 * fails at construction instead of serving a half document.
 *
 * <p>No caching headers and no CSP yet — T207 adds the asset routes, the
 * ETag handling and the policy.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.html.TokenCss;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

final class WebShellRoute {

    /** The inline-payload placeholders of the {@code /web/index.html} template. */
    private static final String TOKEN_CSS_PLACEHOLDER = "/*__JHIN_TOKEN_CSS__*/";

    /** The inline-payload placeholders of the {@code /web/index.html} template. */
    private static final String APP_CSS_PLACEHOLDER = "/*__JHIN_APP_CSS__*/";

    /** The inline-payload placeholders of the {@code /web/index.html} template. */
    private static final String APP_JS_PLACEHOLDER = "/*__JHIN_APP_JS__*/";

    private final UiSettings settings;
    private final String template;
    private final String appCss;
    private final String appJs;

    /**
     * Loads the three static resources of the web client from this plugin's
     * class path.
     *
     * @param settings the {@code jhin.ui} settings store the token CSS is
     *                 derived from per request
     * @throws IllegalStateException when a resource is missing or unreadable
     */
    WebShellRoute(UiSettings settings) {
        this.settings = settings;
        this.template = resource("/web/index.html");
        this.appCss = resource("/web/app.css");
        this.appJs = resource("/web/app.js");
    }

    /**
     * Builds the shell document for one request: the template with the token
     * CSS of the effective settings snapshot and the two static payloads
     * inlined.
     *
     * @param req the request (unused — the document is not caller-dependent)
     * @return the {@code 200} HTML document
     */
    HttpResponse handle(HttpRequest req) {
        UiSettings.Snapshot snapshot = settings.current();
        String tokenCss = TokenCss.root(
                BootstrapRoute.theme(true, snapshot),
                TokenDefaults.tokens(snapshot.panelMotionMs()),
                snapshot.density());
        String document = template
                .replace(TOKEN_CSS_PLACEHOLDER, tokenCss)
                .replace(APP_CSS_PLACEHOLDER, appCss)
                .replace(APP_JS_PLACEHOLDER, appJs);
        return HttpResponse.text(200, document)
                .withHeader("content-type", "text/html; charset=utf-8");
    }

    /** Reads one class-path resource of this plugin as UTF-8 text. */
    private static String resource(String name) {
        try (InputStream in = WebShellRoute.class.getResourceAsStream(name)) {
            if (in == null) {
                throw new IllegalStateException("missing web resource: " + name);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("unreadable web resource: " + name, e);
        }
    }
}
