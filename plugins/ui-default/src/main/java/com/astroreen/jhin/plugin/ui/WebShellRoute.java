/**
 * {@code GET /}: the web-client shell document (T202, T207.2, T300).
 *
 * <p>Serves the full HTML document of the browser client: the static
 * {@code /web/index.html} template of this plugin with the token CSS
 * {@link com.astroreen.jhin.plugin.uikit.html.TokenCss#root} derives from the
 * effective {@link UiSettings} snapshot (the same theme map
 * {@link BootstrapRoute} builds, the {@link TokenDefaults} token surface and
 * the saved density). The token CSS is dynamic per client and theme, so it
 * stays inline inside a per-response {@code nonce}-carrying {@code <style>};
 * the nine static payloads (T300's six runtime chunks and three stylesheets)
 * are served from the asset route as {@code /ui/assets/*} links. The
 * {@code inlineAssets} constructor switch exists only as the fallback branch
 * that still renders a complete document when the asset route is unregistered:
 * it inlines the nine payloads verbatim, exactly like T202 did with the two.
 * A jar missing one of the resources fails at construction instead of serving
 * a half document.
 *
 * <p>Every response carries the content-security policy of
 * {@link #csp(String)} with a fresh per-response nonce (≥ 128 bits,
 * {@code SecureRandom}, base64url). The template carries the
 * {@code __JHIN_NONCE__} placeholder in every element under the policy's
 * control — the three stylesheet links, the token-CSS {@code <style>} and the
 * six chunk {@code <script>} tags — and the same nonce lands in the
 * {@code script-src 'nonce-…'} source and the service-worker registration
 * snippet (T208.3).
 *
 * <p>Policy reconciliation (the ADR of {@code docs/web-client.md} §3 states
 * {@code default-src 'self'; script-src 'self' 'nonce-…'; object-src 'none';
 * base-uri 'none'}; the plan's directive set adds {@code style-src}): the
 * {@code script-src} follows the ADR exactly — {@code 'self'} is what lets
 * the external same-origin {@code /ui/assets/*.js} chunks load under
 * source-list matching, while the nonce additionally satisfies CSP3's nonce
 * rule (an element carrying a valid nonce is allowed regardless of the source
 * list) and covers the inline fallback branch, whose inline {@code <script>}
 * elements have no URL to match. {@code style-src 'unsafe-inline' 'self'}
 * comes from the plan: the ADR string omits {@code style-src}, and left to
 * the {@code default-src 'self'} fallback the inline token CSS would be
 * blocked — {@code 'self'} covers the linked stylesheets, {@code
 * 'unsafe-inline'} the inline {@code <style>} payloads (the element nonces
 * are belt-and-suspenders). No further directives are invented;
 * {@code default-src 'self'} is the fallback for {@code fetch}/
 * {@code EventSource} of {@code /_jhin/bootstrap}, {@code /ui/screen/*},
 * {@code /ui/action/*} and {@code /ui/stream*}.
 *
 * <p>The document also carries the service-worker registration snippet
 * (T208.3) as an inline {@code <script nonce="…">} where the template's
 * {@code /*__JHIN_SW__*&#47;} placeholder stands: it registers {@code /sw.js}
 * only under {@code window.isSecureContext} with a silent failure catch, so a
 * plain-HTTP origin (the QA loopback) skips registration without an error and
 * the app keeps working exactly as before. No {@code beforeinstallprompt}
 * listener ships — the plan only asks the QA report which browsers expose it,
 * and nothing observable can be collected without a browser (see T208 chunk
 * 2).
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
import java.util.LinkedHashMap;
import java.util.Map;

final class WebShellRoute {

    /** The per-response nonce placeholder of the {@code /web/index.html} template. */
    private static final String NONCE_PLACEHOLDER = "__JHIN_NONCE__";

    /** The inline token-CSS placeholder of the {@code /web/index.html} template. */
    private static final String TOKEN_CSS_PLACEHOLDER = "/*__JHIN_TOKEN_CSS__*/";

    /** The service-worker snippet placeholder of the {@code /web/index.html} template. */
    private static final String SW_PLACEHOLDER = "/*__JHIN_SW__*/";

    /** Where {@link ServiceWorkerRoute} serves the worker script from. */
    private static final String SW_URL = "/sw.js";

    /** Nonce source: 18 bytes = 144 bits, above the 128-bit floor. */
    private static final int NONCE_BYTES = 18;

    private static final SecureRandom RANDOM = new SecureRandom();

    private final UiSettings settings;
    private final boolean inlineAssets;
    private final String template;
    private final Map<String, String> payloads;

    /**
     * Loads the static resources of the web client from this plugin's class
     * path: the template plus the nine payloads of {@link WebAssets}.
     *
     * @param settings      the {@code jhin.ui} settings store the token CSS is
     *                      derived from per request
     * @param inlineAssets  {@code false} (the production wiring) links the
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
        Map<String, String> loaded = new LinkedHashMap<>();
        for (String name : WebAssets.NAMES) {
            loaded.put(name, resource("/web/" + WebAssets.dirOf(name) + name));
        }
        this.payloads = Map.copyOf(loaded);
    }

    /**
     * Builds the shell document for one request: the template with the token
     * CSS of the effective settings snapshot inlined under a fresh nonce and
     * the nine static payloads either linked (production) or inlined
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

    /** The production document: token CSS inline, the nine payloads linked. */
    private String linkedDocument(String nonce, String tokenCss) {
        return template
                .replace(NONCE_PLACEHOLDER, nonce)
                .replace(TOKEN_CSS_PLACEHOLDER, tokenCss)
                .replace(SW_PLACEHOLDER, swSnippet(nonce));
    }

    /** The fallback document: token CSS and all nine payloads inline. */
    private String inlineDocument(String nonce, String tokenCss) {
        String document = template.replace(NONCE_PLACEHOLDER, nonce)
                .replace(TOKEN_CSS_PLACEHOLDER, tokenCss)
                .replace(SW_PLACEHOLDER, swSnippet(nonce));
        for (String name : WebAssets.NAMES) {
            String tag = name.endsWith(".css")
                    ? "<link rel=\"stylesheet\" href=\"" + assetUrl(name) + "\" nonce=\"" + nonce + "\">"
                    : "<script src=\"" + assetUrl(name) + "\" defer nonce=\"" + nonce + "\"></script>";
            String element = name.endsWith(".css")
                    ? "<style id=\"jhin-" + name.replace('.', '-') + "\" nonce=\"" + nonce + "\">"
                            + payloads.get(name) + "</style>"
                    : "<script id=\"jhin-" + name.replace('.', '-') + "\" nonce=\"" + nonce + "\">"
                            + payloads.get(name) + "</script>";
            document = document.replace(tag, element);
        }
        return document;
    }

    /** Where {@link AssetRoute} serves one payload from. */
    private static String assetUrl(String name) {
        return "/ui/assets/" + name;
    }

    /**
     * The service-worker registration snippet (T208.3): one inline
     * {@code <script>} under the response nonce, standing where the
     * template's {@code /*__JHIN_SW__*&#47;} placeholder is.
     * {@code window.isSecureContext} guards the registration so a plain-HTTP
     * origin skips it silently (no error, app keeps working) and the catch
     * keeps any registration failure silent the same way.
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