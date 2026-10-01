/**
 * {@code GET /_jhin/bootstrap}: the bootstrap payload of the SDUI contract.
 *
 * <p>This route silently replaces the kernel fallback on the same path, so the
 * payload below is what a client sees whenever this plugin is loaded. It
 * carries {@code api}, {@code empty:false}, {@code title}, {@code theme}, the
 * {@code entry} screen id, the inline {@code screens}, the
 * {@code screenEndpoint} template and the server-authored {@code fallbacks}
 * (offline and error art the client caches on first success). The whole
 * payload is tailored to {@code X-Jhin-Client} (D-22) before it is written:
 * stream views degrade to server-side list snapshots without {@code sse} and
 * directives the client cannot honour are dropped from node props.
 *
 * <p>Entry selection: {@code connect} when the security plugin is loaded and
 * the caller carries no principal; {@code sessions} otherwise.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

final class BootstrapRoute {

    /** Wire path of the screen endpoint template. */
    private static final String SCREEN_ENDPOINT = "/ui/screen/{id}";

    /** The product title shown by the runtime. */
    private static final String TITLE = "Jhin";

    /** The seed color of the product theme. */
    private static final String SEED_COLOR = "#7E57C2";

    private final ScreenRegistry registry;
    private final boolean securityPresent;
    private final CapabilityTailor tailor;

    BootstrapRoute(ScreenRegistry registry, boolean securityPresent, CapabilityTailor tailor) {
        this.registry = registry;
        this.securityPresent = securityPresent;
        this.tailor = tailor;
    }

    /**
     * Builds the bootstrap payload for one caller.
     *
     * @param req the request carrying the client capabilities and, when a
     *            security plugin is loaded, the principal attribute
     * @return the payload tailored to the caller
     */
    HttpResponse handle(HttpRequest req) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("api", 1);
        payload.put("empty", false);
        payload.put("title", TITLE);
        payload.put("theme", theme());
        payload.put("entry", entry(req));
        payload.put("screens", screens(req));
        payload.put("screenEndpoint", SCREEN_ENDPOINT);
        payload.put("fallbacks", fallbacks(req));
        return HttpResponse.json(200, payload);
    }

    /** The entry screen id for one caller. */
    private String entry(HttpRequest req) {
        boolean signIn = securityPresent && !Principals.present(req);
        return signIn ? "connect" : "sessions";
    }

    /** The inline screens, in registration order and tailored per node. */
    private List<Map<String, Object>> screens(HttpRequest req) {
        Map<String, Supplier<UiNode>> screens =
                registry.screens(principalAccount(req));
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map.Entry<String, Supplier<UiNode>> entry : screens.entrySet()) {
            Map<String, Object> screen = new LinkedHashMap<>();
            screen.put("id", entry.getKey());
            screen.put("node", tailor.tailor(entry.getValue().get(), req.client()).toJson());
            out.add(screen);
        }
        return out;
    }

    /** The server-authored offline and error art, tailored like any node. */
    private Map<String, Object> fallbacks(HttpRequest req) {
        Map<String, Object> fallbacks = new LinkedHashMap<>();
        fallbacks.put("offline", tailor.tailor(offlineNode(), req.client()).toJson());
        fallbacks.put("error", tailor.tailor(errorNode(), req.client()).toJson());
        return fallbacks;
    }

    /** Product-neutral offline art: a card with a retry affordance. */
    private UiNode offlineNode() {
        return Ui.card()
                .title("Offline")
                .child(Ui.text("The server is unreachable. Your screens are shown from the cache.")
                        .style("body").build())
                .child(Ui.button("Retry").style("primary").action(Directives.refresh()).build())
                .build();
    }

    /** Product-neutral error art: a card with retry and change-server affordances. */
    private UiNode errorNode() {
        return Ui.card()
                .title("Something went wrong")
                .child(Ui.text("The server could not render this screen.").style("body").build())
                .child(Ui.button("Retry").style("primary").action(Directives.reloadBootstrap()).build())
                .child(Ui.button("Change server").style("text").action(Directives.openProfiles()).build())
                .build();
    }

    /** The theme block of the payload. */
    private Map<String, Object> theme() {
        Map<String, Object> theme = new LinkedHashMap<>();
        theme.put("seedColor", SEED_COLOR);
        theme.put("mode", "system");
        return theme;
    }

    /** The caller's account id for request-scoped screens. */
    private static Optional<String> principalAccount(HttpRequest req) {
        try {
            return Principals.accountId(req);
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }
}
