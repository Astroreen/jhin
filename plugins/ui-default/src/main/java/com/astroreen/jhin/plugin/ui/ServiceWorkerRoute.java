/**
 * {@code GET /sw.js}: the web-client service worker (T208.2).
 *
 * <p>One static classic script (no modules, no {@code eval} or
 * {@code Function} constructs — the gate parity of the payload budget rules)
 * serves the offline shell strategy:
 *
 * <ul>
 *   <li>cache name {@code jhin-shell-v2} (T300: the precache set grew from two
 *       payloads to nine); <strong>bump procedure</strong>:
 *       increment the {@code N} literal in {@link #SCRIPT} whenever the shell
 *       contract or any precached payload changes shape (new asset URL, new
 *       precache entry), so {@code activate} drops the previous generation.
 *       ETag changes of the payload <em>bytes</em> alone need no bump — the
 *       versioned asset URL revalidation and the install-time precache pick
 *       them up on the next worker install;</li>
 *   <li>install: precache {@code /} (the shell document) and the nine
 *       {@code /ui/assets/*} payloads (the six runtime chunks and the three
 *       stylesheets) into that cache name;</li>
 *   <li>activate: delete every older cache whose name starts with
 *       {@code jhin-shell-} but is not the current version, then
 *       {@code self.skipWaiting()} and {@code self.clients.claim()};</li>
 *   <li>fetch (GET only, same-origin only): cache-first for
 *       {@code /ui/assets/*} (the ETag-versioned static payloads),
 *       network-first for {@code /} with the cached shell as offline
 *       fallback, and an explicit never-cache bypass
 *       ({@code fetch(request)} passthrough, no {@code cache.put}) for the
 *       bootstrap/screen/action/stream API prefixes {@code /_jhin/bootstrap},
 *       {@code /ui/screen/}, {@code /ui/action/} and {@code /ui/stream} —
 *       live data never enters the shell cache. Everything else passes
 *       through uncached.</li>
 * </ul>
 *
 * <p>Caching headers: {@code Cache-Control: no-cache} (T207's asset
 * discipline, not {@code max-age=0, must-revalidate} — the two are equivalent
 * for this purpose and {@code no-cache} keeps the web routes uniform). The
 * browser already revalidates a service-worker script on every navigation
 * until it changes byte-wise; the header just refuses heuristic caching in
 * between, so a cache-name bump reaches clients promptly.
 *
 * <p>No content-security policy is sent: a service-worker script is fetched
 * by the browser's worker manager outside the page's CSP context, the shell
 * policy is nonce-based and this response must stay byte-static (a nonce
 * here would churn per response and leak into a re-fetched script), and the
 * worker itself needs no policy to run. The registration lives in the shell
 * document ({@link WebShellRoute}), guarded by {@code window.isSecureContext}.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Map;

final class ServiceWorkerRoute {

    /** Media type of the worker script. */
    private static final String CONTENT_TYPE = "application/javascript; charset=utf-8";

    /**
     * The worker script itself. See the class comment for the strategy and
     * the cache-name bump procedure.
     */
    static final String SCRIPT = String.join("\n",
            "/* jhin web-client service worker (T208.2): classic script, no modules. */",
            "var CACHE = \"jhin-shell-v2\";",
            "var CACHE_PREFIX = \"jhin-shell-\";",
            "var PRECACHE = [\"/\", \"/ui/assets/tokens.css\", \"/ui/assets/components.css\",\n"
            + "    \"/ui/assets/screens.css\", \"/ui/assets/core.js\", \"/ui/assets/render.js\",\n"
            + "    \"/ui/assets/actions.js\", \"/ui/assets/sse.js\", \"/ui/assets/keymap.js\",\n"
            + "    \"/ui/assets/timeline.js\"];",
            "var NEVER_CACHE = [\"/_jhin/bootstrap\", \"/ui/screen/\", \"/ui/action/\", \"/ui/stream\"];",
            "",
            "self.addEventListener(\"install\", function (event) {",
            "  event.waitUntil(",
            "    caches.open(CACHE).then(function (cache) {",
            "      return cache.addAll(PRECACHE);",
            "    })",
            "  );",
            "});",
            "",
            "self.addEventListener(\"activate\", function (event) {",
            "  event.waitUntil(",
            "    caches.keys().then(function (keys) {",
            "      return Promise.all(keys.filter(function (key) {",
            "        return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE;",
            "      }).map(function (key) {",
            "        return caches.delete(key);",
            "      }));",
            "    }).then(function () {",
            "      return self.skipWaiting();",
            "    }).then(function () {",
            "      return self.clients.claim();",
            "    })",
            "  );",
            "});",
            "",
            "function neverCache(path) {",
            "  for (var i = 0; i < NEVER_CACHE.length; i++) {",
            "    if (path.indexOf(NEVER_CACHE[i]) === 0) {",
            "      return true;",
            "    }",
            "  }",
            "  return false;",
            "}",
            "",
            "function cacheFirst(request) {",
            "  return caches.match(request).then(function (cached) {",
            "    if (cached) {",
            "      return cached;",
            "    }",
            "    return fetch(request).then(function (response) {",
            "      if (response && response.ok) {",
            "        var copy = response.clone();",
            "        caches.open(CACHE).then(function (cache) {",
            "          cache.put(request, copy);",
            "        });",
            "      }",
            "      return response;",
            "    });",
            "  });",
            "}",
            "",
            "function networkFirst(request) {",
            "  return fetch(request).then(function (response) {",
            "    if (response && response.ok) {",
            "      var copy = response.clone();",
            "      caches.open(CACHE).then(function (cache) {",
            "        cache.put(request, copy);",
            "      });",
            "    }",
            "    return response;",
            "  }).catch(function () {",
            "    return caches.match(request);",
            "  });",
            "}",
            "",
            "self.addEventListener(\"fetch\", function (event) {",
            "  var request = event.request;",
            "  if (request.method !== \"GET\") {",
            "    return;",
            "  }",
            "  var url = new URL(request.url);",
            "  if (url.origin !== self.location.origin) {",
            "    return;",
            "  }",
            "  if (neverCache(url.pathname)) {",
            "    event.respondWith(fetch(request));",
            "    return;",
            "  }",
            "  if (url.pathname.indexOf(\"/ui/assets/\") === 0) {",
            "    event.respondWith(cacheFirst(request));",
            "    return;",
            "  }",
            "  if (url.pathname === \"/\") {",
            "    event.respondWith(networkFirst(request));",
            "    return;",
            "  }",
            "});",
            "");

    /**
     * Serves the static worker script.
     *
     * @param req the request (unused — the script is static)
     * @return the {@code 200} worker script
     */
    HttpResponse handle(HttpRequest req) {
        if (!req.path().equals("/sw.js")) {
            return HttpResponse.error(404, "not_found", "no service worker at " + req.path());
        }
        return new HttpResponse(200, Map.of(
                "Content-Type", CONTENT_TYPE,
                "Cache-Control", "no-cache"),
                SCRIPT.getBytes(StandardCharsets.UTF_8), null);
    }
}
