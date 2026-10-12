/**
 * {@code GET /manifest.json} and {@code GET /ui/icons/{name}} behaviour
 * (T208.1): the manifest answers the RFC media type with the identity fields
 * and token-derived colors, the icon branch serves the two committed PNGs —
 * real 192×192 and 512×512 images — with {@link AssetRoute}'s strong-ETag
 * discipline, and every unknown or traversal-shaped name answers the JSON
 * {@code 404 not_found} envelope.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ManifestRouteTest {

    @TempDir
    Path tmp;

    @Test
    void servesTheManifestWithOk() {
        assertThat(manifest().status()).isEqualTo(200);
    }

    @Test
    void declaresTheManifestContentType() {
        // HttpResponse lower-cases header names.
        assertThat(manifest().headers())
                .containsEntry("content-type", "application/manifest+json; charset=utf-8");
    }

    @Test
    void theManifestIsNotHeuristicallyCacheable() {
        assertThat(manifest().headers()).containsEntry("cache-control", "no-cache");
    }

    @Test
    void parsesAsJsonAndCarriesTheIdentityFields() throws Exception {
        Map<String, Object> payload = Json.readMap(new String(manifest().body()));

        assertThat(payload)
                .containsEntry("name", "Jhin")
                .containsEntry("short_name", "Jhin")
                .containsEntry("display", "standalone")
                .containsEntry("start_url", "/")
                .containsEntry("scope", "/");
    }

    @Test
    void colorsAreLowercaseHexShaped() throws Exception {
        Map<String, Object> payload = Json.readMap(new String(manifest().body()));

        assertThat(payload.get("theme_color")).asString().matches("#[0-9a-f]{6}");
        assertThat(payload.get("background_color")).asString().matches("#[0-9a-f]{6}");
    }

    @Test
    void colorsFollowTheTokenPipelinePerRequest() throws Exception {
        String before = (String) Json.readMap(new String(manifest().body())).get("theme_color");

        settings().saveAppearance("dark", "t3-chat", "#16161e", "#ff0000", "comfortable", 150);
        String after = (String) Json.readMap(new String(manifest().body())).get("theme_color");

        // The palette the token CSS derives from re-runs per request, so a
        // saved appearance moves the manifest colors without a restart.
        assertThat(after).isNotEqualTo(before).matches("#[0-9a-f]{6}");
    }

    @Test
    void iconsReferenceTheCommittedPngs() throws Exception {
        Map<String, Object> payload = Json.readMap(new String(manifest().body()));

        assertThat(payload.get("icons")).isInstanceOf(List.class);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> icons = (List<Map<String, Object>>) payload.get("icons");
        assertThat(icons).hasSize(2);
        assertThat(icons.get(0))
                .containsEntry("src", "/ui/icons/icon-192.png")
                .containsEntry("sizes", "192x192")
                .containsEntry("type", "image/png");
        assertThat(icons.get(1))
                .containsEntry("src", "/ui/icons/icon-512.png")
                .containsEntry("sizes", "512x512")
                .containsEntry("type", "image/png");
    }

    @Test
    void servesThe192IconAsAPngOf192By192() throws IOException {
        HttpResponse response = icon("icon-192.png", "/ui/icons/icon-192.png", Map.of());

        assertThat(response.status()).isEqualTo(200);
        assertThat(response.headers()).containsEntry("content-type", "image/png");
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(response.body()));
        assertThat(image.getWidth()).isEqualTo(192);
        assertThat(image.getHeight()).isEqualTo(192);
    }

    @Test
    void servesThe512IconAsAPngOf512By512() throws IOException {
        HttpResponse response = icon("icon-512.png", "/ui/icons/icon-512.png", Map.of());

        assertThat(response.status()).isEqualTo(200);
        assertThat(response.headers()).containsEntry("content-type", "image/png");
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(response.body()));
        assertThat(image.getWidth()).isEqualTo(512);
        assertThat(image.getHeight()).isEqualTo(512);
    }

    @Test
    void iconsCarryAStableStrongEtagAndNoCache() {
        HttpResponse first = icon("icon-192.png", "/ui/icons/icon-192.png", Map.of());
        HttpResponse second = icon("icon-192.png", "/ui/icons/icon-192.png", Map.of());

        assertThat(first.headers())
                .containsEntry("cache-control", "no-cache")
                .containsKey("etag");
        assertThat(first.headers().get("etag")).matches("\"sha256-[0-9a-f]{64}\"");
        assertThat(second.headers()).containsEntry("etag", first.headers().get("etag"));
    }

    @Test
    void answersNotModifiedWhenTheClientHasTheCurrentTag() {
        String etag = icon("icon-512.png", "/ui/icons/icon-512.png", Map.of())
                .headers().get("etag");

        HttpResponse response = icon("icon-512.png", "/ui/icons/icon-512.png",
                Map.of("if-none-match", etag));

        assertThat(response.status()).isEqualTo(304);
        assertThat(response.body()).isEmpty();
        assertThat(response.headers()).containsEntry("etag", etag);
    }

    @Test
    void refusesUnknownIconsWithTheNotFoundEnvelope() throws Exception {
        for (String name : new String[] {"", "icon-100.png", "icon-192.PNG", "core.js",
                "icon-192.png.map", "icon"}) {
            HttpResponse response = icon(name, "/ui/icons/" + name, Map.of());

            assertThat(response.status()).as("name %s", name).isEqualTo(404);
            Map<String, Object> payload = Json.readMap(new String(response.body()));
            assertThat(payload).containsEntry("error", "not_found");
        }
    }

    @Test
    void refusesEveryTraversalShapedIconName() {
        String[] names = {
            "../icon-192.png", "..", "..%2ficon-192.png", "..\\icon-192.png", "icon-192.png%00",
            "icon-192.png\0", "icon-192.png/", "./icon-192.png", "%2e%2e%2ficon-192.png",
            "%2e%2e", "x/icon-192.png", "//icon-192.png", "/icon-192.png", "icon-192.png/x",
            "sub/icon-512.png", "icon-192.png/.", "icon-192.png#x", "icon-192.png?x"
        };
        for (String name : names) {
            HttpResponse response = icon(name, "/ui/icons/" + name, Map.of());

            assertThat(response.status()).as("name %s", name).isEqualTo(404);
            assertThat(new String(response.body())).as("name %s", name)
                    .doesNotContain("web/", "classpath", "resource");
        }
    }

    @Test
    void refusesPathShapeTricksOnAnAllowlistedIcon() {
        assertThat(icon("icon-192.png", "/ui/icons/icon-192.png/", Map.of()).status())
                .isEqualTo(404);
        assertThat(icon("icon-192.png", "/ui/icons//icon-192.png", Map.of()).status())
                .isEqualTo(404);
        assertThat(icon("icon-192.png", "/ui/icons/x/icon-192.png", Map.of()).status())
                .isEqualTo(404);
        assertThat(icon("icon-192.png", "//icon-192.png", Map.of()).status()).isEqualTo(404);
        assertThat(icon("icon-192.png", "/ui/icons/icon-192.png/..", Map.of()).status())
                .isEqualTo(404);
    }

    private UiSettings settings() {
        return UiSettings.open(tmp);
    }

    private HttpResponse manifest() {
        ManifestRoute route = new ManifestRoute(settings());
        return route.handle(new FakeHttpRequest("GET", "/manifest.json",
                Map.of(), Map.of(), ""));
    }

    private HttpResponse icon(String name, String path, Map<String, String> headers) {
        ManifestRoute route = new ManifestRoute(settings());
        HttpRequest req = new FakeHttpRequest("GET", path,
                name.isEmpty() ? Map.of() : Map.of("name", name), Map.of(), "",
                com.astroreen.jhin.sdk.http.ClientInfo.UNKNOWN, headers);
        return route.handleIcon(req);
    }
}
