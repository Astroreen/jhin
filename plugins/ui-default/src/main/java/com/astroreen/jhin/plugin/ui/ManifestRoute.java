/**
 * {@code GET /manifest.json} and {@code GET /ui/icons/{name}}: the PWA
 * manifest and its icon payloads (T208.1).
 *
 * <p>The manifest answers {@code application/manifest+json; charset=utf-8}
 * (the RFC 2557 media type for the {@code <link rel="manifest">} target;
 * {@code application/json} is deliberately not used) and is computed per
 * request exactly like the shell document: the {@code jhin.ui} settings
 * snapshot feeds the same theme map ({@link BootstrapRoute#theme}) the token
 * CSS of {@link com.astroreen.jhin.plugin.uikit.html.TokenCss} derives from,
 * so a save-appearance shows up in the next manifest without a restart. The
 * two colors map from the palette that map carries — the same hex values the
 * CSS tokens carry:
 *
 * <ul>
 *   <li>{@code background_color} ← {@code colors.background} — the canvas
 *       hex behind the {@code --background} token (the app's fill);</li>
 *   <li>{@code theme_color} ← {@code colors.accent} — the accent-surface hex
 *       behind the {@code --accent} token (the OS chrome tint).</li>
 * </ul>
 *
 * Both are normalized to lowercase {@code #rrggbb} (a {@code #AARRGGBB} seed
 * loses its alpha byte; anything unparseable falls back to the raw snapshot
 * seed and then to the built-in token defaults). Identity fields are fixed:
 * {@code name}/{@code short_name} {@code "Jhin"}, {@code display}
 * {@code standalone}, {@code start_url}/{@code scope}/{@code id} {@code "/"}.
 *
 * <p>The two icon PNGs ship as immutable class-path resources
 * ({@code /web/icons/icon-192.png}, {@code /web/icons/icon-512.png}, real
 * 192×192 and 512×512 images) and are served from {@code /ui/icons/{name}} —
 * a separate, strict exact-name allowlist that deliberately does not touch
 * {@link AssetRoute}'s {@code /ui/assets/*} contract (that route stays the
 * nine web payloads only). The icon branch repeats {@link AssetRoute}'s
 * caching discipline: strong {@code "sha256-<hex>"} {@code ETag},
 * {@code Cache-Control: no-cache}, {@code If-None-Match} → {@code 304}, the
 * JSON {@code 404 not_found} envelope for every unknown or traversal-shaped
 * name. The manifest references the icons by URL ({@code /ui/icons/…}).
 *
 * <p>Neither answer carries the shell content-security policy: the manifest
 * and an image are not governed by the document's CSP, and the policy of
 * {@link AssetRoute} exists only to stay consistent for top-level-opened
 * script/style payloads. The manifest is also free of {@code ETag} — its
 * body is settings-derived per request; {@code Cache-Control: no-cache} asks
 * clients to revalidate it every time instead.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ManifestRoute {

    /** The one manifest request path this route serves. */
    private static final String MANIFEST_PATH = "/manifest.json";

    /** The one request path shape the icon branch serves, before the name. */
    private static final String ICON_PATH_PREFIX = "/ui/icons/";

    /** Media type of the manifest body per RFC 2557. */
    private static final String MANIFEST_CONTENT_TYPE =
            "application/manifest+json; charset=utf-8";

    /** Media type of the icon payloads. */
    private static final String ICON_CONTENT_TYPE = "image/png";

    /** The 192×192 icon as the manifest references it. */
    private static final String ICON_192 = "icon-192.png";

    /** The 512×512 icon as the manifest references it. */
    private static final String ICON_512 = "icon-512.png";

    /** Last-resort color fallbacks (the built-in token default seeds). */
    private static final String FALLBACK_CANVAS = "#16161e";

    /** Last-resort color fallbacks (the built-in token default seeds). */
    private static final String FALLBACK_ACCENT = "#7E57C2";

    private final UiSettings settings;

    /**
     * The exact-name icon allowlist: lowercase name to its loaded payload.
     */
    private final Map<String, AssetRoute.Asset> icons;

    /**
     * Loads both icon resources from this plugin's class path and derives
     * their tags once, exactly like {@link AssetRoute} does for its payloads.
     *
     * @param settings the {@code jhin.ui} settings store the manifest colors
     *                 are derived from per request
     * @throws IllegalStateException when a resource is missing or unreadable
     */
    ManifestRoute(UiSettings settings) {
        this.settings = settings;
        Map<String, AssetRoute.Asset> loaded = new LinkedHashMap<>();
        loaded.put(ICON_192, load("/web/icons/" + ICON_192));
        loaded.put(ICON_512, load("/web/icons/" + ICON_512));
        this.icons = Map.copyOf(loaded);
    }

    /**
     * Builds the manifest for one request from the effective settings
     * snapshot.
     *
     * @param req the request (unused — the manifest is not caller-dependent)
     * @return the {@code 200} manifest document
     */
    HttpResponse handle(HttpRequest req) {
        if (!req.path().equals(MANIFEST_PATH)) {
            return HttpResponse.error(404, "not_found", "no manifest at " + req.path());
        }
        UiSettings.Snapshot snapshot = settings.current();
        Map<String, String> colors = colorsOf(snapshot);
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("id", "/");
        manifest.put("name", "Jhin");
        manifest.put("short_name", "Jhin");
        manifest.put("display", "standalone");
        manifest.put("start_url", "/");
        manifest.put("scope", "/");
        manifest.put("theme_color", colors.get("theme"));
        manifest.put("background_color", colors.get("background"));
        manifest.put("icons", icons());
        return HttpResponse.text(200, Json.write(manifest))
                .withHeader("content-type", MANIFEST_CONTENT_TYPE)
                .withHeader("cache-control", "no-cache");
    }

    /**
     * Serves one allowlisted icon, honouring {@code If-None-Match}. The
     * captured name must be an exact lowercase allowlist key and the request
     * path must be exactly {@code /ui/icons/} plus that name — the same
     * strict literal check and traversal refusal as {@link AssetRoute}.
     *
     * @param req the request carrying the {@code name} path capture
     * @return {@code 200} with the PNG, {@code 304} on a matching
     *         conditional request, or the JSON {@code 404 not_found} envelope
     */
    HttpResponse handleIcon(HttpRequest req) {
        String name = req.pathParams().getOrDefault("name", "");
        AssetRoute.Asset icon = icons.get(name);
        if (icon == null || !req.path().equals(ICON_PATH_PREFIX + name)) {
            return HttpResponse.error(404, "not_found", "no icon with name " + name);
        }
        if (AssetRoute.matchesIfNoneMatch(req.headers().get("if-none-match"), icon.etag())) {
            return new HttpResponse(304, Map.of(
                    "ETag", icon.etag(),
                    "Cache-Control", "no-cache"), new byte[0], null);
        }
        return new HttpResponse(200, Map.of(
                "Content-Type", ICON_CONTENT_TYPE,
                "ETag", icon.etag(),
                "Cache-Control", "no-cache"), icon.body(), null);
    }

    /**
     * The manifest icon table: the two committed PNGs referenced by URL.
     */
    private static List<Map<String, Object>> icons() {
        List<Map<String, Object>> icons = new ArrayList<>();
        icons.add(icon(ICON_192, "192x192"));
        icons.add(icon(ICON_512, "512x512"));
        return icons;
    }

    /** One manifest icon entry. */
    private static Map<String, Object> icon(String name, String sizes) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("src", ICON_PATH_PREFIX + name);
        entry.put("sizes", sizes);
        entry.put("type", ICON_CONTENT_TYPE);
        return entry;
    }

    /**
     * The manifest colors of one settings snapshot. The palette entries come
     * from the same {@link BootstrapRoute#theme} map the shell token CSS
     * derives from; see the class comment for the token mapping.
     *
     * @param snapshot the effective settings
     * @return {@code theme} and {@code background}, each {@code #rrggbb}
     */
    private static Map<String, String> colorsOf(UiSettings.Snapshot snapshot) {
        Map<String, String> palette = paletteOf(snapshot);
        String background = rrggbb(orDefault(palette.get("background"), snapshot.canvas()),
                FALLBACK_CANVAS);
        String theme = rrggbb(orDefault(palette.get("accent"), snapshot.accent()),
                FALLBACK_ACCENT);
        return Map.of("background", background, "theme", theme);
    }

    /** The palette of {@link BootstrapRoute#theme}, {@code null} on failure. */
    @SuppressWarnings("unchecked")
    private static Map<String, String> paletteOf(UiSettings.Snapshot snapshot) {
        try {
            Object colors = BootstrapRoute.theme(true, snapshot).get("colors");
            if (colors instanceof Map<?, ?> map) {
                return (Map<String, String>) map;
            }
        } catch (RuntimeException ignored) {
            // Same degradation as the token CSS: fall back to the raw seeds.
        }
        return Map.of();
    }

    /** The first non-null, non-blank candidate. */
    private static String orDefault(String candidate, String fallback) {
        return candidate == null || candidate.isBlank() ? fallback : candidate;
    }

    /**
     * Normalizes one hex color to lowercase {@code #rrggbb}: {@code #AARRGGBB}
     * loses its alpha byte, and anything unparseable falls back to the
     * fallback hex (and then to {@code #000000}).
     *
     * @param raw      the candidate hex, {@code null} allowed
     * @param fallback the fallback hex, also normalized
     * @return the normalized {@code #rrggbb}
     */
    static String rrggbb(String raw, String fallback) {
        String normalized = normalizeHex(raw);
        if (normalized == null) {
            normalized = normalizeHex(fallback);
        }
        return normalized == null ? "#000000" : normalized;
    }

    /** The lowercase {@code #rrggbb} form of one hex color, {@code null} if unparseable. */
    private static String normalizeHex(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.startsWith("#")) {
            value = value.substring(1);
        }
        value = value.toLowerCase(java.util.Locale.ROOT);
        if (value.matches("[0-9a-f]{8}")) {
            value = value.substring(2);
        }
        return value.matches("[0-9a-f]{6}") ? "#" + value : null;
    }

    /** Reads one icon resource as bytes and derives its entity-tag. */
    private static AssetRoute.Asset load(String name) {
        byte[] body;
        try (InputStream in = ManifestRoute.class.getResourceAsStream(name)) {
            if (in == null) {
                throw new IllegalStateException("missing web resource: " + name);
            }
            body = in.readAllBytes();
        } catch (IOException e) {
            throw new IllegalStateException("unreadable web resource: " + name, e);
        }
        return new AssetRoute.Asset(ICON_CONTENT_TYPE, AssetRoute.etagOf(body), body);
    }
}
