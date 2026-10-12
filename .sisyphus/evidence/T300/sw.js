/* jhin web-client service worker (T208.2): classic script, no modules. */
var CACHE = "jhin-shell-v2";
var CACHE_PREFIX = "jhin-shell-";
var PRECACHE = ["/", "/ui/assets/tokens.css", "/ui/assets/components.css",
    "/ui/assets/screens.css", "/ui/assets/core.js", "/ui/assets/render.js",
    "/ui/assets/actions.js", "/ui/assets/sse.js", "/ui/assets/keymap.js",
    "/ui/assets/timeline.js"];
var NEVER_CACHE = ["/_jhin/bootstrap", "/ui/screen/", "/ui/action/", "/ui/stream"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE);
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE;
      }).map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.skipWaiting();
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function neverCache(path) {
  for (var i = 0; i < NEVER_CACHE.length; i++) {
    if (path.indexOf(NEVER_CACHE[i]) === 0) {
      return true;
    }
  }
  return false;
}

function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    if (cached) {
      return cached;
    }
    return fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) {
          cache.put(request, copy);
        });
      }
      return response;
    });
  });
}

function networkFirst(request) {
  return fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) {
        cache.put(request, copy);
      });
    }
    return response;
  }).catch(function () {
    return caches.match(request);
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") {
    return;
  }
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (neverCache(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }
  if (url.pathname.indexOf("/ui/assets/") === 0) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.pathname === "/") {
    event.respondWith(networkFirst(request));
    return;
  }
});
