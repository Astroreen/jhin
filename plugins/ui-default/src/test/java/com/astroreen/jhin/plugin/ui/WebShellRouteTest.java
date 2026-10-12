/**
 * {@code GET /} web-shell behaviour (T202, T207.2, T208.3, T300): the served
 * document is the {@code /web/index.html} template — in the production linked
 * branch the token CSS is inlined under a per-response nonce and the nine
 * static payloads (six runtime chunks, three stylesheets) are linked through
 * {@code /ui/assets/*} in load order, in the inline fallback branch all ten
 * payloads are inlined exactly like T202 did. Both branches carry the
 * content-security policy with the nonce the document uses, the
 * service-worker registration snippet under the same nonce guarded by
 * {@code window.isSecureContext}, and no template placeholder survives either
 * one.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.HttpResponse;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WebShellRouteTest {

    @TempDir
    Path tmp;

    @Test
    void servesTheShellDocumentWithOk() {
        assertThat(inline().status()).isEqualTo(200);
    }

    @Test
    void declaresTheHtmlContentType() {
        // HttpResponse lower-cases header names.
        assertThat(inline().headers()).containsEntry("content-type", "text/html; charset=utf-8");
    }

    @Test
    void carriesTheClientRoot() {
        assertThat(bodyOf(inline())).contains("id=\"jhin-root\"");
    }

    @Test
    void inlinesTheStylesheetAndChunkPayloads() {
        String body = bodyOf(inline());

        // `.jhin-button` is a components.css selector, `jhinFetch` a core.js
        // symbol: the placeholders were replaced with non-empty payloads.
        assertThat(body).contains(".jhin-button").contains("jhinFetch");
    }

    @Test
    void inlinesTheTokenCssOutput() {
        // The alias layer of TokenCss.root(...): proves the token CSS ran.
        assertThat(bodyOf(inline())).contains("--color-accent: var(--accent)");
    }

    @Test
    void replacesEveryPlaceholder() {
        String body = bodyOf(inline());

        assertThat(body).doesNotContain(
                "__JHIN_NONCE__", "__JHIN_TOKEN_CSS__", "__JHIN_SW__");
    }

    @Test
    void linksTheStaticPayloadsInTheProductionBranch() {
        String body = bodyOf(linked());

        for (String name : WebAssets.CSS) {
            assertThat(body)
                    .as("stylesheet %s", name)
                    .contains("<link rel=\"stylesheet\" href=\"/ui/assets/" + name + "\"");
        }
        for (String name : WebAssets.JS) {
            assertThat(body)
                    .as("chunk %s", name)
                    .contains("<script src=\"/ui/assets/" + name + "\" defer");
        }
        // `.jhin-button` and `jhinFetch` stay out of the document body: the
        // payloads are linked, not inlined.
        assertThat(body).doesNotContain(".jhin-button", "jhinFetch");
    }

    @Test
    void loadsTheChunksInDependencyOrder() {
        String body = bodyOf(linked());

        int core = body.indexOf("/ui/assets/core.js");
        int render = body.indexOf("/ui/assets/render.js");
        int actions = body.indexOf("/ui/assets/actions.js");
        int sse = body.indexOf("/ui/assets/sse.js");
        int keymap = body.indexOf("/ui/assets/keymap.js");
        int timeline = body.indexOf("/ui/assets/timeline.js");

        assertThat(core).isGreaterThan(0);
        assertThat(render).isGreaterThan(core);
        assertThat(actions).isGreaterThan(render);
        assertThat(sse).isGreaterThan(actions);
        assertThat(keymap).isGreaterThan(sse);
        assertThat(timeline).isGreaterThan(keymap);
    }

    @Test
    void linksThePwaManifestInBothBranches() {
        for (HttpResponse response : new HttpResponse[] {linked(), inline()}) {
            assertThat(bodyOf(response))
                    .contains("rel=\"manifest\"")
                    .contains("href=\"/manifest.json\"");
        }
    }

    @Test
    void keepsTheTokenCssInlineInTheProductionBranch() {
        assertThat(bodyOf(linked())).contains("--color-accent: var(--accent)");
    }

    @Test
    void replacesEveryPlaceholderInTheProductionBranch() {
        assertThat(bodyOf(linked())).doesNotContain(
                "__JHIN_NONCE__", "__JHIN_TOKEN_CSS__", "__JHIN_SW__");
    }

    @Test
    void carriesTheContentSecurityPolicy() {
        String policy = linked().headers().get("content-security-policy");

        assertThat(policy)
                .contains("default-src 'self'")
                .contains("object-src 'none'")
                .contains("base-uri 'none'")
                .contains("style-src 'unsafe-inline' 'self'")
                .contains("script-src 'self' 'nonce-");
    }

    @Test
    void headerNonceMatchesTheDocumentNonce() {
        HttpResponse response = linked();
        String policy = response.headers().get("content-security-policy");
        String nonce = policy.split("script-src 'self' 'nonce-", 2)[1].split("'", 2)[0];
        String body = bodyOf(response);

        assertThat(body).contains("nonce=\"" + nonce + "\"");
    }

    @Test
    void theInlineFallbackAlsoCarriesTheNonce() {
        String body = bodyOf(inline());

        assertThat(body)
                .contains("<style id=\"jhin-token-css\" nonce=\"")
                .contains("<script id=\"jhin-core-js\" nonce=\"");
    }

    @Test
    void everyRequestGetsAFreshNonceMatchingItsOwnDocument() {
        HttpResponse first = linked();
        HttpResponse second = linked();

        assertThat(nonceOf(first)).isNotEqualTo(nonceOf(second));
        assertThat(nonceOf(inline())).isNotEqualTo(nonceOf(first));
        assertThat(bodyOf(first)).contains("nonce=\"" + nonceOf(first) + "\"");
        assertThat(bodyOf(second)).contains("nonce=\"" + nonceOf(second) + "\"");
    }

    @Test
    void carriesTheClientRootInTheProductionBranch() {
        // The offline art of module 5 (renderOffline) paints into this root.
        assertThat(bodyOf(linked())).contains("id=\"jhin-root\"");
    }

    @Test
    void registersTheServiceWorkerWithASecureContextGuard() {
        for (HttpResponse response : new HttpResponse[] {linked(), inline()}) {
            assertThat(bodyOf(response))
                    .contains("navigator.serviceWorker.register(\"/sw.js\")")
                    .contains("window.isSecureContext");
        }
    }

    @Test
    void theServiceWorkerSnippetCarriesTheResponseNonce() {
        HttpResponse response = linked();
        String nonce = nonceOf(response);

        assertThat(bodyOf(response))
                .contains("<script nonce=\"" + nonce + "\">if (window.isSecureContext");
    }

    private static String nonceOf(HttpResponse response) {
        String policy = response.headers().get("content-security-policy");
        return policy.split("script-src 'self' 'nonce-", 2)[1].split("'", 2)[0];
    }

    private String bodyOf(HttpResponse response) {
        return new String(response.body());
    }

    private HttpResponse linked() {
        return handle(new WebShellRoute(UiSettings.open(tmp), false));
    }

    private HttpResponse inline() {
        return handle(new WebShellRoute(UiSettings.open(tmp), true));
    }

    private static HttpResponse handle(WebShellRoute route) {
        return route.handle(new FakeHttpRequest("GET", "/", Map.of(), Map.of(), ""));
    }
}