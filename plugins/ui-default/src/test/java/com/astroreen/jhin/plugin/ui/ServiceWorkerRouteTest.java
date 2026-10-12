/**
 * {@code GET /sw.js} behaviour (T208.2): the static worker script answers the
 * JavaScript media type with the {@code jhin-shell-v2} cache name, the
 * install/activate lifecycle ({@code skipWaiting}, {@code clients.claim},
 * old-cache cleanup) and the three fetch strategies — cache-first for
 * {@code /ui/assets/*}, network-first for {@code /}, and the explicit
 * never-cache bypass of the bootstrap/screen/action/stream prefixes. The
 * payload stays classic-script safe: no {@code eval}/{@code Function}
 * constructs, same gate parity as the client payload budget rules.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ServiceWorkerRouteTest {

    private final ServiceWorkerRoute route = new ServiceWorkerRoute();

    @Test
    void servesTheWorkerWithOk() {
        assertThat(handle("/sw.js", Map.of()).status()).isEqualTo(200);
    }

    @Test
    void declaresTheJavascriptContentType() {
        // HttpResponse lower-cases header names.
        assertThat(handle("/sw.js", Map.of()).headers())
                .containsEntry("content-type", "application/javascript; charset=utf-8");
    }

    @Test
    void refusesHeuristicCachingSoBumpsRollOutPromptly() {
        assertThat(handle("/sw.js", Map.of()).headers())
                .containsEntry("cache-control", "no-cache");
    }

    @Test
    void carriesTheCacheNameAndThePrecacheSet() {
        String body = body();

        assertThat(body)
                .contains("\"jhin-shell-v2\"")
                .contains("\"jhin-shell-\"")
                .contains("\"/\"");
        for (String name : WebAssets.NAMES) {
            assertThat(body).as("precache %s", name).contains("\"/ui/assets/" + name + "\"");
        }
    }

    @Test
    void installsAndActivatesWithSkipWaitingAndClaim() {
        String body = body();

        assertThat(body)
                .contains("\"install\"")
                .contains("\"activate\"")
                .contains("cache.addAll(PRECACHE)")
                .contains("self.skipWaiting()")
                .contains("self.clients.claim()");
    }

    @Test
    void activateDeletesOlderShellCaches() {
        String body = body();

        assertThat(body)
                .contains("key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE")
                .contains("caches.delete(key)");
    }

    @Test
    void strategiesAreCacheFirstAssetsNetworkFirstShellAndBypassForApiTraffic() {
        String body = body();

        // cache-first for /ui/assets/*.
        assertThat(body)
                .contains("event.respondWith(cacheFirst(request))")
                .contains("url.pathname.indexOf(\"/ui/assets/\") === 0");
        // network-first for / with the cached shell as offline fallback.
        assertThat(body)
                .contains("event.respondWith(networkFirst(request))")
                .contains("url.pathname === \"/\"")
                .contains("return caches.match(request);");
        // The explicit never-cache list of the API prefixes.
        assertThat(body)
                .contains("var NEVER_CACHE = [\"/_jhin/bootstrap\", \"/ui/screen/\","
                        + " \"/ui/action/\", \"/ui/stream\"]")
                .contains("event.respondWith(fetch(request))");
    }

    @Test
    void onlyHandlesSameOriginGetRequests() {
        String body = body();

        assertThat(body)
                .contains("if (request.method !== \"GET\")")
                .contains("url.origin !== self.location.origin");
    }

    @Test
    void carriesNoDynamicOrEvalConstructs() {
        String body = body();

        assertThat(body)
                .doesNotContain("eval(")
                .doesNotContain("new Function(")
                .doesNotContain("nonce");
    }

    @Test
    void refusesWrongPathsWithTheNotFoundEnvelope() {
        assertThat(handle("/sw", Map.of()).status()).isEqualTo(404);
        assertThat(handle("/sw.js/x", Map.of()).status()).isEqualTo(404);
        assertThat(handle("/ui/sw.js", Map.of()).status()).isEqualTo(404);
    }

    private String body() {
        return new String(handle("/sw.js", Map.of()).body(), StandardCharsets.UTF_8);
    }

    private HttpResponse handle(String path, Map<String, String> headers) {
        return route.handle(new FakeHttpRequest("GET", path, Map.of(), Map.of(), "",
                com.astroreen.jhin.sdk.http.ClientInfo.UNKNOWN, headers));
    }
}
