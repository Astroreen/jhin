/**
 * {@code GET /} web-shell behaviour (T202, T207.2): the served document is
 * the {@code /web/index.html} template — in the production linked branch the
 * token CSS is inlined under a per-response nonce and the two static payloads
 * are linked through {@code /ui/assets/*}, in the inline fallback branch all
 * three payloads are inlined exactly like T202 did. Both branches carry the
 * content-security policy with the nonce the document uses, and no template
 * placeholder survives either one.
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
    void inlinesTheAppCssAndAppJsPayloads() {
        String body = bodyOf(inline());

        // `.jhin-button` is an app.css selector, `jhinFetch` an app.js symbol:
        // both placeholders were replaced with non-empty payloads.
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
                "__JHIN_TOKEN_CSS__", "__JHIN_APP_CSS__", "__JHIN_APP_JS__");
    }

    @Test
    void linksTheStaticPayloadsInTheProductionBranch() {
        String body = bodyOf(linked());

        assertThat(body)
                .contains("<link rel=\"stylesheet\" href=\"/ui/assets/app.css\">")
                .contains("<script src=\"/ui/assets/app.js\" defer");
        // `.jhin-button` and `jhinFetch` stay out of the document body: the
        // payloads are linked, not inlined.
        assertThat(body).doesNotContain(".jhin-button", "jhinFetch");
    }

    @Test
    void keepsTheTokenCssInlineInTheProductionBranch() {
        assertThat(bodyOf(linked())).contains("--color-accent: var(--accent)");
    }

    @Test
    void replacesEveryPlaceholderInTheProductionBranch() {
        assertThat(bodyOf(linked())).doesNotContain(
                "__JHIN_TOKEN_CSS__", "__JHIN_APP_CSS__", "__JHIN_APP_JS__");
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
                .contains("<script id=\"jhin-app-js\" nonce=\"");
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
