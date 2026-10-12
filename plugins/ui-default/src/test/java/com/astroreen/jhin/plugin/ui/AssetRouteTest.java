/**
 * {@code GET /ui/assets/{name}} behaviour (T207.1, T300): the nine allowlisted
 * payloads answer with their media type, a strong SHA-256 {@code ETag} and
 * {@code Cache-Control: no-cache}; a matching {@code If-None-Match} answers
 * {@code 304}; every other name — unknown, wrong case, traversal-shaped or
 * path-shape tricks — answers the JSON {@code 404 not_found} envelope.
 *
 * <p>Layering note for the traversal matrix: these cases drive the route
 * handler with the captures and paths a client could produce. At the HTTP
 * layer the embedded Tomcat connector answers {@code 400} for raw
 * {@code %2F} before dispatch (the T203 precedent), resolves {@code .} and
 * {@code ..} segments pre-dispatch, and {@link com.astroreen.jhin.kernel.http.RouteMatcher}-style
 * segment splitting drops empty and trailing segments — so several of these
 * never reach a handler in production. The handler still refuses every one of
 * them on its own, which is what these tests pin down.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.util.Map;
import org.junit.jupiter.api.Test;

class AssetRouteTest {

    private final AssetRoute route = new AssetRoute();

    @Test
    void servesEveryJsChunkAsJavascript() {
        for (String name : WebAssets.JS) {
            HttpResponse response = handle("/ui/assets/" + name, name, Map.of());

            assertThat(response.status()).as("name %s", name).isEqualTo(200);
            assertThat(response.headers())
                    .as("name %s", name)
                    .containsEntry("content-type", "application/javascript; charset=utf-8");
            assertThat(response.body()).as("name %s", name).isNotEmpty();
        }
    }

    @Test
    void servesEveryStylesheetAsStylesheet() {
        for (String name : WebAssets.CSS) {
            HttpResponse response = handle("/ui/assets/" + name, name, Map.of());

            assertThat(response.status()).as("name %s", name).isEqualTo(200);
            assertThat(response.headers())
                    .as("name %s", name)
                    .containsEntry("content-type", "text/css; charset=utf-8");
            assertThat(response.body()).as("name %s", name).isNotEmpty();
        }
    }

    @Test
    void carriesAStableStrongEtagAndNoCache() {
        HttpResponse first = handle("/ui/assets/core.js", "core.js", Map.of());
        HttpResponse second = handle("/ui/assets/core.js", "core.js", Map.of());

        assertThat(first.headers())
                .containsEntry("cache-control", "no-cache")
                .containsKey("etag");
        // Strong quoted tag of the form "sha256-<hex>".
        assertThat(first.headers().get("etag")).matches("\"sha256-[0-9a-f]{64}\"");
        assertThat(second.headers()).containsEntry("etag", first.headers().get("etag"));
    }

    @Test
    void answersNotModifiedWhenTheClientHasTheCurrentTag() {
        String etag = handle("/ui/assets/core.js", "core.js", Map.of()).headers().get("etag");

        HttpResponse response = handle("/ui/assets/core.js", "core.js",
                Map.of("if-none-match", etag));

        assertThat(response.status()).isEqualTo(304);
        assertThat(response.body()).isEmpty();
        assertThat(response.headers()).containsEntry("etag", etag);
    }

    @Test
    void answersNotModifiedForTheWildcardAndWeakAndListForms() {
        String etag = handle("/ui/assets/tokens.css", "tokens.css", Map.of()).headers().get("etag");

        assertThat(handle("/ui/assets/tokens.css", "tokens.css",
                Map.of("if-none-match", "*")).status()).isEqualTo(304);
        assertThat(handle("/ui/assets/tokens.css", "tokens.css",
                Map.of("if-none-match", "W/" + etag)).status()).isEqualTo(304);
        assertThat(handle("/ui/assets/tokens.css", "tokens.css",
                Map.of("if-none-match", "\"other\", " + etag)).status()).isEqualTo(304);
        assertThat(handle("/ui/assets/tokens.css", "tokens.css",
                Map.of("if-none-match", "\"other\"")).status()).isEqualTo(200);
        assertThat(handle("/ui/assets/tokens.css", "tokens.css",
                Map.of("if-none-match", "")).status()).isEqualTo(200);
    }

    @Test
    void refusesUnknownNamesWithTheNotFoundEnvelope() throws Exception {
        for (String name : new String[] {"", "index.html", "core.js.map", "core", "core.js.txt"}) {
            HttpResponse response = handle("/ui/assets/" + name, name, Map.of());

            assertThat(response.status()).as("name %s", name).isEqualTo(404);
            Map<String, Object> payload = Json.readMap(new String(response.body()));
            assertThat(payload).containsEntry("error", "not_found");
        }
    }

    @Test
    void refusesWrongCase() {
        for (String name : new String[] {"CORE.JS", "Tokens.css", "TOKENS.CSS", "Core.js"}) {
            HttpResponse response = handle("/ui/assets/" + name, name, Map.of());

            // Documented case policy: exact lowercase names only.
            assertThat(response.status()).as("name %s", name).isEqualTo(404);
        }
    }

    @Test
    void refusesEveryTraversalShapedName() {
        String[] names = {
            "../core.js", "..", "..%2fcore.js", "..\\core.js", "core.js%00", "core.js\0",
            "core.js/", "./core.js", "%2e%2e%2fcore.js", "%2e%2e", "x/core.js", "//core.js",
            "/core.js", "core.js/x", "sub/tokens.css", "tokens.css/.", "core.js#x", "core.js?x"
        };
        for (String name : names) {
            HttpResponse response = handle("/ui/assets/" + name, name, Map.of());

            assertThat(response.status()).as("name %s", name).isEqualTo(404);
            assertThat(new String(response.body())).as("name %s", name)
                    .doesNotContain("web/", "classpath", "resource");
        }
    }

    @Test
    void refusesPathShapeTricksOnAnAllowlistedName() {
        // The name capture is allowlisted, but the path is not the strict
        // literal /ui/assets/<name>: trailing slash, doubled slash, extra
        // segments. All answer 404 without exception.
        assertThat(handle("/ui/assets/core.js/", "core.js", Map.of()).status()).isEqualTo(404);
        assertThat(handle("/ui/assets//core.js", "core.js", Map.of()).status()).isEqualTo(404);
        assertThat(handle("/ui/assets/x/core.js", "core.js", Map.of()).status()).isEqualTo(404);
        assertThat(handle("//core.js", "core.js", Map.of()).status()).isEqualTo(404);
        assertThat(handle("/ui/assets/core.js/..", "core.js", Map.of()).status()).isEqualTo(404);
    }

    @Test
    void assetResponsesCarryTheShellPolicy() {
        String policy = handle("/ui/assets/core.js", "core.js", Map.of())
                .headers().get("content-security-policy");

        assertThat(policy)
                .contains("default-src 'self'")
                .contains("object-src 'none'")
                .contains("base-uri 'none'");
    }

    private HttpResponse handle(String path, String name, Map<String, String> headers) {
        HttpRequest req = new FakeHttpRequest("GET", path,
                name.isEmpty() ? Map.of() : Map.of("name", name), Map.of(), "",
                ClientInfo.UNKNOWN, headers);
        return route.handle(req);
    }
}
