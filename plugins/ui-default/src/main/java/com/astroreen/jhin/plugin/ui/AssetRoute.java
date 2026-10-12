/**
 * {@code GET /ui/assets/{name}}: the immutable web-client payloads as
 * class-path resources with strong {@code ETag} revalidation (T207.1, T300).
 *
 * <p>Exactly nine names are served — the six runtime chunks
 * ({@code core.js}, {@code render.js}, {@code actions.js}, {@code sse.js},
 * {@code keymap.js}, {@code timeline.js}) and the three stylesheets
 * ({@code tokens.css}, {@code components.css}, {@code screens.css}), all
 * matched as exact lowercase literals. Everything else answers the standard
 * JSON {@code 404 not_found} envelope: unknown names, wrong case, nested
 * segments, empty or traversal-shaped captures. The matcher is an in-memory
 * allowlist lookup, so the refusal path never touches a filesystem and never
 * reflects anything beyond the captured name the client sent.
 *
 * <p>Assets are immutable jar resources, so the bytes and their strong
 * {@code ETag} are loaded once at construction. The tag is
 * {@code "sha256-<hex>"} — the quoted strong entity-tag whose opaque part is
 * {@code sha256-} plus the lowercase hex SHA-256 of the exact payload bytes.
 * {@code Cache-Control: no-cache} forces every client to revalidate through
 * {@code If-None-Match}; a matching conditional request answers {@code 304}
 * with the same {@code ETag} and an empty body. {@code If-None-Match} is
 * parsed per RFC 9110 with weak comparison: the {@code *} wildcard matches,
 * comma-separated lists are checked entry by entry, an optional {@code W/}
 * prefix on the candidate is ignored when comparing opaque tags, and any
 * malformed entry simply fails open to a full {@code 200}.
 *
 * <p>Every answer repeats the shell's content-security policy
 * ({@link WebShellRoute#csp}) with a fresh per-response nonce — not because a
 * subresource is governed by it, but because the same header is harmless
 * here and keeps the two web routes trivially consistent if a payload is ever
 * opened as a top-level document.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;

final class AssetRoute {

    /** The one request path shape this route serves, before the name. */
    private static final String PATH_PREFIX = "/ui/assets/";

    /** Media type of the {@code .js} runtime chunks. */
    private static final String JS_CONTENT_TYPE = "application/javascript; charset=utf-8";

    /** Media type of the {@code .css} stylesheets. */
    private static final String CSS_CONTENT_TYPE = "text/css; charset=utf-8";

    /**
     * The exact-name allowlist: lowercase name to its loaded payload. A
     * request only ever serves through one of these nine keys; the media type
     * follows the name extension.
     */
    private final Map<String, Asset> assets;

    /**
     * One immutable payload. Components: {@code contentType} — the response
     * media type; {@code etag} — the strong quoted entity-tag derived from
     * {@code body}; {@code body} — the exact class-path bytes.
     */
    record Asset(String contentType, String etag, byte[] body) {
    }

    /**
     * Loads all nine payloads from this plugin's class path and derives their
     * tags once.
     *
     * @throws IllegalStateException when a resource is missing or unreadable
     */
    AssetRoute() {
        Map<String, Asset> loaded = new LinkedHashMap<>();
        for (String name : WebAssets.NAMES) {
            String contentType = name.endsWith(".css") ? CSS_CONTENT_TYPE : JS_CONTENT_TYPE;
            loaded.put(name, load("/web/" + WebAssets.dirOf(name) + name, contentType));
        }
        this.assets = Map.copyOf(loaded);
    }

    /**
     * Serves one allowlisted asset, honouring {@code If-None-Match}. The
     * captured name must be an exact lowercase allowlist key and the request
     * path must be exactly {@code /ui/assets/} plus that name — the strict
     * literal check collapses trailing-slash, doubled-slash and other
     * path-shape tricks to the same {@code 404} as an unknown name.
     *
     * @param req the request carrying the {@code name} path capture
     * @return {@code 200} with the payload, {@code 304} on a matching
     *         conditional request, or the JSON {@code 404 not_found} envelope
     */
    HttpResponse handle(HttpRequest req) {
        String name = req.pathParams().getOrDefault("name", "");
        Asset asset = assets.get(name);
        if (asset == null || !req.path().equals(PATH_PREFIX + name)) {
            return HttpResponse.error(404, "not_found", "no asset with name " + name);
        }
        String policy = WebShellRoute.csp(WebShellRoute.newNonce());
        if (matchesIfNoneMatch(req.headers().get("if-none-match"), asset.etag())) {
            return new HttpResponse(304, Map.of(
                    "ETag", asset.etag(),
                    "Cache-Control", "no-cache",
                    "Content-Security-Policy", policy), new byte[0], null);
        }
        return new HttpResponse(200, Map.of(
                "Content-Type", asset.contentType(),
                "ETag", asset.etag(),
                "Cache-Control", "no-cache",
                "Content-Security-Policy", policy), asset.body(), null);
    }

    /**
     * RFC 9110 {@code If-None-Match} weak comparison against one strong tag:
     * {@code *} matches, a comma-separated list matches when any entry does,
     * an optional {@code W/} weak prefix on an entry is ignored, and a
     * malformed or absent header falls through to a full response.
     *
     * @param header the raw header value, {@code null} when absent
     * @param etag   the strong quoted entity-tag of the payload
     * @return whether the caller already holds the current representation
     */
    static boolean matchesIfNoneMatch(String header, String etag) {
        if (header == null || header.isBlank()) {
            return false;
        }
        for (String entry : header.split(",")) {
            String tag = entry.trim();
            if (tag.equals("*")) {
                return true;
            }
            if (tag.startsWith("W/")) {
                tag = tag.substring(2);
            }
            if (tag.equals(etag)) {
                return true;
            }
        }
        return false;
    }

    /** Reads one class-path resource as bytes and derives its entity-tag. */
    private static Asset load(String name, String contentType) {
        byte[] body;
        try (InputStream in = AssetRoute.class.getResourceAsStream(name)) {
            if (in == null) {
                throw new IllegalStateException("missing web resource: " + name);
            }
            body = in.readAllBytes();
        } catch (IOException e) {
            throw new IllegalStateException("unreadable web resource: " + name, e);
        }
        return new Asset(contentType, etagOf(body), body);
    }

    /** The strong entity-tag {@code "sha256-<hex>"} of exact payload bytes. */
    static String etagOf(byte[] body) {
        byte[] digest;
        try {
            digest = MessageDigest.getInstance("SHA-256").digest(body);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return "\"sha256-" + hex + "\"";
    }
}
