/**
 * {@code GET /}: the web-client shell document (T202, T207.2).
 *
 * <p>Serves the full HTML document of the browser client: the static
 * {@code /web/index.html} template of this plugin with the token CSS
 * {@link com.astroreen.jhin.plugin.uikit.html.TokenCss#root} derives from the
 * effective {@link UiSettings} snapshot (the same theme map
 * {@link BootstrapRoute} builds, the {@link TokenDefaults} token surface and
 * the saved density). The token CSS is dynamic per client and theme, so it
 * stays inline inside a per-response {@code nonce}-carrying {@code <style>};
 * the two static payloads are served from the asset route as
 * {@code /ui/assets/app.css} and {@code /ui/assets/app.js} links. The
 * {@code inlineAssets} constructor switch exists only as the fallback branch
 * that still renders a complete document when the asset route is unregistered:
 * it inlines the two payloads verbatim, exactly like T202 did. A jar missing
 * one of the resources fails at construction instead of serving a half
 * document.
 *
 * <p>Every response carries the content-security policy of
 * {@link #csp(String)} with a fresh per-response nonce (≥ 128 bits,
 * {@code SecureRandom}, base64url) and the nonce lands in four places under
 * the policy's control: the {@code script-src 'nonce-…'} source, the app
 * {@code <script>} element (both the linked and the inline form), the
 * service-worker registration snippet (T208.3) and the
 * token-CSS {@code <style>} element (plus the inline app-CSS {@code <style>}
 * in the fallback branch).
 *
 * <p>Policy reconciliation (the ADR of {@code docs/web-client.md} §3 states
 * {@code default-src 'self'; script-src 'self' 'nonce-…'; object-src 'none';
 * base-uri 'none'}; the plan's directive set adds {@code style-src}): the
 * {@code script-src} follows the ADR exactly — {@code 'self'} is what lets
 * the external same-origin {@code /ui/assets/app.js} load under source-list
 * matching, while the nonce additionally satisfies CSP3's nonce rule (an
 * element carrying a valid nonce is allowed regardless of the source list)
 * and covers the inline fallback branch, whose inline {@code <script>} has no
 * URL to match. {@code style-src 'unsafe-inline' 'self'} comes from the plan:
 * the ADR string omits {@code style-src}, and left to the {@code default-src
 * 'self'} fallback the inline token CSS would be blocked — {@code 'self'}
 * covers the linked stylesheet, {@code 'unsafe-inline'} the inline
 * {@code <style>} payloads (the element nonces are belt-and-suspenders).
 * No further directives are invented; {@code default-src 'self'} is the
 * fallback for {@code fetch}/{@code EventSource} of {@code /_jhin/bootstrap},
 * {@code /ui/screen/*}, {@code /ui/action/*} and {@code /ui/stream*}.
 *
 * <p>The document also carries the service-worker registration snippet
 * (T208.3) as a second inline {@code <script nonce="…">} after the app
 * payload: it registers {@code /sw.js} only under
 * {@code window.isSecureContext} with a silent failure catch, so a plain-HTTP
 * origin (the QA loopback) skips registration without an error and the app
 * keeps working exactly as before. No {@code beforeinstallprompt} listener
 * ships — the plan only asks the QA report which browsers expose it, and
 * nothing observable can be collected without a browser (see T208 chunk 2).
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.html.TokenCss;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;

final class WebShellRoute {

    /** The inline-payload placeholders of the {@code /web/index.html} template. */
    private static final String TOKEN_CSS_PLACEHOLDER = "/*__JHIN_TOKEN_CSS__*/";

    /** The inline-payload placeholders of the {@code /web/index.html} template. */
    private static final String APP_CSS_PLACEHOLDER = "/*__JHIN_APP_CSS__*/";

    /** The inline-payload placeholders of the {@code /web/index.html} template. */
    private static final String APP_JS_PLACEHOLDER = "/*__JHIN_APP_JS__*/";

    /** The token-CSS style element opening tag of the template. */
    private static final String TOKEN_STYLE_OPEN = "<style id=\"jhin-token-css\">";

    /** The app-CSS style element of the template, placeholder included. */
    private static final String APP_STYLE_ELEMENT =
            "<style id=\"jhin-app-css\">" + APP_CSS_PLACEHOLDER + "</style>";

    /** The app-JS script element of the template, placeholder included. */
    private static final String APP_SCRIPT_ELEMENT =
            "<script id=\"jhin-app-js\">" + APP_JS_PLACEHOLDER + "</script>";

    /** Where {@link AssetRoute} serves the static styles from. */
    private static final String APP_CSS_URL = "/ui/assets/app.css";

    /** Where {@link AssetRoute} serves the static script from. */
    private static final String APP_JS_URL = "/ui/assets/app.js";

    /** Where {@link ServiceWorkerRoute} serves the worker script from. */
    private static final String SW_URL = "/sw.js";

    /** Nonce source: 18 bytes = 144 bits, above the 128-bit floor. */
    private static final int NONCE_BYTES = 18;

    private static final SecureRandom RANDOM = new SecureRandom();

    private final UiSettings settings;
    private final boolean inlineAssets;
    private final String template;
    private final String appCss;
    private final String appJs;

    /**
     * Loads the three static resources of the web client from this plugin's
     * class path.
     *
     * @param settings      the {@code jhin.ui} settings store the token CSS is
     *                      derived from per request
     * @param inlineAssets  {@code false} (the production wiring) links the two
     *                      static payloads through {@link AssetRoute};
     *                      {@code true} is the fallback branch that inlines
     *                      them so the shell still renders when the asset
     *                      route is unregistered
     * @throws IllegalStateException when a resource is missing or unreadable
     */
    WebShellRoute(UiSettings settings, boolean inlineAssets) {
        this.settings = settings;
        this.inlineAssets = inlineAssets;
        this.template = resource("/web/index.html");
        this.appCss = resource("/web/app.css");
        this.appJs = resource("/web/app.js");
    }

    /**
     * Builds the shell document for one request: the template with the token
     * CSS of the effective settings snapshot inlined under a fresh nonce and
     * the two static payloads either linked (production) or inlined
     * (fallback). The same nonce goes into the CSP header of the response.
     *
     * @param req the request (unused — the document is not caller-dependent)
     * @return the {@code 200} HTML document
     */
    HttpResponse handle(HttpRequest req) {
        String nonce = newNonce();
        UiSettings.Snapshot snapshot = settings.current();
        String tokenCss = TokenCss.root(
                BootstrapRoute.theme(true, snapshot),
                TokenDefaults.tokens(snapshot.panelMotionMs()),
                snapshot.density());
        String document = inlineAssets ? inlineDocument(nonce, tokenCss)
                : linkedDocument(nonce, tokenCss);
        return HttpResponse.text(200, document)
                .withHeader("content-type", "text/html; charset=utf-8")
                .withHeader("content-security-policy", csp(nonce));
    }

    /**
     * A fresh per-response content-security-policy nonce. Called per request
     * by this route and by {@link AssetRoute}; never reused across responses.
     *
     * @return the base64url nonce source
     */
    static String newNonce() {
        byte[] raw = new byte[NONCE_BYTES];
        RANDOM.nextBytes(raw);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    /**
     * The content-security policy of the web client. See the class comment
     * for the ADR reconciliation of the directive set.
     *
     * @param nonce the per-response nonce of this answer
     * @return the {@code Content-Security-Policy} header value
     */
    static String csp(String nonce) {
        return "default-src 'self'; script-src 'self' 'nonce-" + nonce
                + "'; style-src 'unsafe-inline' 'self'; object-src 'none'; base-uri 'none'";
    }

    /** The production document: token CSS inline, the two payloads linked. */
    private String linkedDocument(String nonce, String tokenCss) {
        return template
                .replace(TOKEN_STYLE_OPEN, "<style id=\"jhin-token-css\" nonce=\"" + nonce + "\">")
                .replace(TOKEN_CSS_PLACEHOLDER, tokenCss)
                .replace(APP_STYLE_ELEMENT,
                        "<link rel=\"stylesheet\" href=\"" + APP_CSS_URL + "\">")
                .replace(APP_SCRIPT_ELEMENT, "<script src=\"" + APP_JS_URL
                        + "\" defer nonce=\"" + nonce + "\"></script>" + swSnippet(nonce));
    }

    /** The fallback document: token CSS and both payloads inline. */
    private String inlineDocument(String nonce, String tokenCss) {
        return template
                .replace(TOKEN_STYLE_OPEN, "<style id=\"jhin-token-css\" nonce=\"" + nonce + "\">")
                .replace(TOKEN_CSS_PLACEHOLDER, tokenCss)
                .replace("<style id=\"jhin-app-css\">",
                        "<style id=\"jhin-app-css\" nonce=\"" + nonce + "\">")
                .replace(APP_CSS_PLACEHOLDER, appCss)
                .replace(APP_SCRIPT_ELEMENT, "<script id=\"jhin-app-js\" nonce=\"" + nonce
                        + "\">" + appJs + "</script>" + swSnippet(nonce));
    }

    /**
     * The service-worker registration snippet (T208.3): one inline
     * {@code <script>} under the response nonce, appended after the app
     * payload. {@code window.isSecureContext} guards the registration so a
     * plain-HTTP origin skips it silently (no error, app keeps working) and
     * the catch keeps any registration failure silent the same way.
     *
     * @param nonce the per-response nonce of this document
     * @return the registration script element
     */
    private static String swSnippet(String nonce) {
        return "<script nonce=\"" + nonce + "\">"
                + "if (window.isSecureContext && \"serviceWorker\" in navigator) {"
                + " navigator.serviceWorker.register(\"" + SW_URL + "\")"
                + ".catch(function () {});"
                + "}</script>";
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
