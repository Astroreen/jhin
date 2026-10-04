/**
 * {@code GET /_jhin/bootstrap}: the bootstrap payload of the SDUI contract.
 *
 * <p>This route silently replaces the kernel fallback on the same path, so the
 * payload below is what a client sees whenever this plugin is loaded. The
 * negotiated contract level ({@code min(client api, server api)},
 * docs/sdui.md section 6) decides the shape: at level 2 the payload carries
 * the full set — {@code api}, {@code empty:false}, {@code title},
 * {@code contract}, {@code theme}, {@code tokens}, {@code density},
 * {@code keymap}, the {@code entry} screen id, the inline {@code screens},
 * the {@code screenEndpoint} template and the server-authored
 * {@code fallbacks}; at level 1 it is exactly the Appendix A shape —
 * {@code contract}/{@code tokens}/{@code density}/{@code keymap} are absent
 * and {@code theme} is reduced to {@code seedColor}+{@code mode}. The whole
 * payload is tailored to {@code X-Jhin-Client} (D-22) before it is written:
 * level-2-only primitives degrade per the docs/sdui.md section 6 table,
 * stream views degrade to server-side list snapshots without {@code sse} and
 * directives the client cannot honour are dropped from node props.
 *
 * <p>Entry selection: {@code version_gate} when a client that already
 * declared {@code api >= 2} reports a persisted-data {@code schema} below
 * {@link ApiVersion#CLIENT_SCHEMA} (docs/sdui.md section 6, docs/updates.md
 * section 3 rule 6) — gated on the raw declared api, not just the negotiated
 * one, because an api=1 client predates both the {@code schema} header field
 * and the version-gate screen itself and would not understand either;
 * otherwise {@code connect} when the security plugin is loaded and the
 * caller carries no principal, {@code sessions} otherwise.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.UiTokens;
import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.http.ClientInfo;
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

    /** The client-owned "update required" screen id (docs/sdui.md section 6,
     * docs/updates.md section 3 rule 6) — chrome, never a server-authored
     * node tree (C-10); only ever set as {@code entry} for a client that
     * already declared {@code api >= 2} itself, see the class doc. */
    private static final String VERSION_GATE_SCREEN = "version_gate";

    private final ScreenRegistry registry;
    private final boolean securityPresent;
    private final CapabilityTailor tailor;
    private final UiSettings settings;

    BootstrapRoute(ScreenRegistry registry, boolean securityPresent, CapabilityTailor tailor,
                   UiSettings settings) {
        this.registry = registry;
        this.securityPresent = securityPresent;
        this.tailor = tailor;
        this.settings = settings;
    }

    /**
     * Builds the bootstrap payload for one caller.
     *
     * @param req the request carrying the client capabilities and, when a
     *            security plugin is loaded, the principal attribute
     * @return the payload tailored to the caller
     */
    HttpResponse handle(HttpRequest req) {
        ClientInfo client = req.client();
        boolean level2 = tailor.isLevel2(client);
        UiSettings.Snapshot snapshot = settings.current();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("api", tailor.negotiatedApi(client));
        payload.put("empty", false);
        payload.put("title", TITLE);
        if (level2) {
            payload.put("contract", contract());
        }
        payload.put("theme", theme(level2, snapshot));
        if (level2) {
            payload.put("tokens", TokenDefaults.tokens(snapshot.panelMotionMs()));
            payload.put("density", snapshot.density());
            payload.put("keymap", DefaultKeymap.entries());
        }
        payload.put("entry", entry(req));
        payload.put("screens", screens(req));
        payload.put("screenEndpoint", SCREEN_ENDPOINT);
        payload.put("fallbacks", fallbacks(req));
        return HttpResponse.json(200, payload);
    }

    /** The {@code contract} block (docs/sdui.md section 1): fixed constants, not caller-dependent. */
    private Map<String, Object> contract() {
        Map<String, Object> contract = new LinkedHashMap<>();
        contract.put("api", ApiVersion.SDUI_CONTRACT);
        contract.put("minApi", ApiVersion.SDUI_CONTRACT);
        contract.put("schema", ApiVersion.CLIENT_SCHEMA);
        contract.put("minSchema", ApiVersion.CLIENT_SCHEMA);
        return contract;
    }

    /** The entry screen id for one caller; see the class doc for the version-gate rule. */
    private String entry(HttpRequest req) {
        ClientInfo client = req.client();
        if (client.api() >= 2 && client.schema() < ApiVersion.CLIENT_SCHEMA) {
            return VERSION_GATE_SCREEN;
        }
        boolean signIn = securityPresent && !Principals.present(req);
        return signIn ? "connect" : "sessions";
    }

    /** The inline screens, in registration order and tailored per node. */
    private List<Map<String, Object>> screens(HttpRequest req) {
        Map<String, Supplier<UiNode>> screens =
                registry.screens(principalAccount(req), ClientKeybindings.of(req));
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map.Entry<String, Supplier<UiNode>> entry : screens.entrySet()) {
            Map<String, Object> screen = new LinkedHashMap<>();
            screen.put("id", entry.getKey());
            screen.put("node", tailor.tailor(entry.getValue().get(), req.client()).toJson());
            out.add(screen);
        }
        return out;
    }

    /**
     * The server-authored offline and error art, tailored like any node.
     *
     * <p>At contract level 2 the art is the token-driven composition of
     * {@link #offlineArt()} / {@link #errorArt()} — a {@code card} carrying a
     * {@code skeleton} placeholder frame and the retry {@code button}, with
     * every layout and color value a {@code $token} reference (docs/sdui.md
     * section 2.2) resolved client-side. Below level 2 the classic
     * card+text+button art is emitted instead, so a level-1 payload keeps
     * exactly its level-1 behaviour (no skeleton, no token references).
     */
    private Map<String, Object> fallbacks(HttpRequest req) {
        boolean level2 = tailor.isLevel2(req.client());
        Map<String, Object> fallbacks = new LinkedHashMap<>();
        fallbacks.put("offline",
                tailor.tailor(level2 ? offlineArt() : classicOfflineNode(), req.client()).toJson());
        fallbacks.put("error",
                tailor.tailor(level2 ? errorArt() : classicErrorNode(), req.client()).toJson());
        return fallbacks;
    }

    /** Token-driven offline art (level 2): card + skeleton frame + retry button. */
    private UiNode offlineArt() {
        return Ui.card()
                .title("Offline")
                .padding(UiTokens.spacing.lg())
                .child(Ui.text("The server is unreachable. Your screens are shown from the cache.")
                        .style("body").build())
                .child(placeholderFrame(UiTokens.color.accent()))
                .child(Ui.button("Retry").style("primary").action(Directives.refresh()).build())
                .build();
    }

    /** Token-driven error art (level 2): card + skeleton frame + retry and change-server buttons. */
    private UiNode errorArt() {
        return Ui.card()
                .title("Something went wrong")
                .padding(UiTokens.spacing.lg())
                .child(Ui.text("The server could not render this screen.").style("body").build())
                .child(placeholderFrame(UiTokens.color.error()))
                .child(Ui.button("Retry").style("primary").action(Directives.reloadBootstrap()).build())
                .child(Ui.button("Change server").style("text").action(Directives.openProfiles()).build())
                .build();
    }

    /**
     * The skeleton placeholder frame of the fallback art: a token-padded,
     * token-bordered box around a two-line skeleton — "your screens are
     * shown from the cache" made visible instead of a gray box.
     *
     * @param borderColor the {@code $color.*} reference of the frame border
     * @return the placeholder frame node
     */
    private static UiNode placeholderFrame(String borderColor) {
        return Ui.container()
                .padding(UiTokens.spacing.md())
                .border(borderColor)
                .borderWidth(1)
                .borderRadius(UiTokens.radius.md())
                .child(Ui.skeleton().variant("text").lines(2).shimmer(true).build())
                .build();
    }

    /** Level-1 offline art (Appendix A behaviour, unchanged): a card with a retry affordance. */
    private UiNode classicOfflineNode() {
        return Ui.card()
                .title("Offline")
                .child(Ui.text("The server is unreachable. Your screens are shown from the cache.")
                        .style("body").build())
                .child(Ui.button("Retry").style("primary").action(Directives.refresh()).build())
                .build();
    }

    /** Level-1 error art (Appendix A behaviour, unchanged): retry and change-server affordances. */
    private UiNode classicErrorNode() {
        return Ui.card()
                .title("Something went wrong")
                .child(Ui.text("The server could not render this screen.").style("body").build())
                .child(Ui.button("Retry").style("primary").action(Directives.reloadBootstrap()).build())
                .child(Ui.button("Change server").style("text").action(Directives.openProfiles()).build())
                .build();
    }

    /**
     * The {@code theme} block: the full level-2 shape, or the Appendix A
     * reduction ({@code seedColor}+{@code mode}) at level 1. The seed values
     * come from the persisted {@code jhin.ui} settings (T78), so a
     * {@code save-appearance} shows up in the next bootstrap.
     *
     * @param level2   whether the negotiated contract level is 2
     * @param snapshot the effective settings
     * @return the theme block for that level
     */
    private Map<String, Object> theme(boolean level2, UiSettings.Snapshot snapshot) {
        if (!level2) {
            Map<String, Object> reduced = new LinkedHashMap<>();
            reduced.put("seedColor", snapshot.accent());
            reduced.put("mode", snapshot.appearance());
            return reduced;
        }
        Map<String, Object> theme = new LinkedHashMap<>();
        theme.put("appearance", snapshot.appearance());
        theme.put("canvas", snapshot.canvas());
        theme.put("accent", snapshot.accent());
        theme.put("colors", colors());
        // Legacy level-1 spelling of the same idea; MUST equal `appearance` (docs/sdui.md section 1).
        theme.put("mode", snapshot.appearance());
        return theme;
    }

    /** Default {@code theme.colors} overrides (docs/sdui.md section 1 example). */
    private Map<String, Object> colors() {
        Map<String, Object> colors = new LinkedHashMap<>();
        colors.put("error", "#f7768e");
        colors.put("success", "#9ece6a");
        colors.put("warning", "#e0af68");
        colors.put("info", "#7aa2f7");
        return colors;
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
