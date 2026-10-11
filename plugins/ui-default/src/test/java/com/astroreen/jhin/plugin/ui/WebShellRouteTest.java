/**
 * {@code GET /} web-shell behaviour (T202): the served document is the
 * {@code /web/index.html} template with the token CSS, the app CSS and the
 * app JS inlined — the three placeholders are gone, the client root and both
 * static payloads are present.
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
        assertThat(handle().status()).isEqualTo(200);
    }

    @Test
    void declaresTheHtmlContentType() {
        // HttpResponse lower-cases header names.
        assertThat(handle().headers()).containsEntry("content-type", "text/html; charset=utf-8");
    }

    @Test
    void carriesTheClientRoot() {
        assertThat(body()).contains("id=\"jhin-root\"");
    }

    @Test
    void inlinesTheAppCssAndAppJsPayloads() {
        String body = body();

        // `.jhin-button` is an app.css selector, `jhinFetch` an app.js symbol:
        // both placeholders were replaced with non-empty payloads.
        assertThat(body).contains(".jhin-button").contains("jhinFetch");
    }

    @Test
    void inlinesTheTokenCssOutput() {
        // The alias layer of TokenCss.root(...): proves the token CSS ran.
        assertThat(body()).contains("--color-accent: var(--accent)");
    }

    @Test
    void replacesEveryPlaceholder() {
        String body = body();

        assertThat(body).doesNotContain(
                "__JHIN_TOKEN_CSS__", "__JHIN_APP_CSS__", "__JHIN_APP_JS__");
    }

    private String body() {
        return new String(handle().body());
    }

    private HttpResponse handle() {
        WebShellRoute route = new WebShellRoute(UiSettings.open(tmp));
        return route.handle(new FakeHttpRequest("GET", "/", Map.of(), Map.of(), ""));
    }
}
