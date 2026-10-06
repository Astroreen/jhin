/**
 * {@code GET /ui/screen/{id}}: one screen node by id, tailored to the caller's
 * client capabilities exactly like the bootstrap payload. An unknown id is a
 * JSON {@code 404} carrying the {@code unknown_screen} error code; screens the
 * registry does not expose to the caller are indistinguishable from unknown
 * ones.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

final class ScreenRoute {

    private final ScreenRegistry registry;
    private final CapabilityTailor tailor;

    ScreenRoute(ScreenRegistry registry, CapabilityTailor tailor) {
        this.registry = registry;
        this.tailor = tailor;
    }

    /**
     * Renders one screen of the registry, including the dynamic ids the
     * bootstrap does not inline.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code {"id":…,"node":…}} or a {@code 404} named
     *         {@code unknown_screen}
     */
    HttpResponse handle(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        Optional<String> account = account(req);
        Optional<Supplier<UiNode>> screen = registry.screen(
                id, account, ClientKeybindings.of(req), req.client());
        if (screen.isEmpty()) {
            return HttpResponse.error(404, "unknown_screen", "no screen with id " + id);
        }
        UiNode node = tailor.tailor(screen.get().get(), req.client());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", id);
        body.put("node", node.toJson());
        return HttpResponse.json(200, body);
    }

    private static Optional<String> account(HttpRequest req) {
        try {
            return Principals.accountId(req);
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }
}
