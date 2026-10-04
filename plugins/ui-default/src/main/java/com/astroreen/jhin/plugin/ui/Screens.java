/**
 * The default screen registry of the T37 surface: {@code connect} (the enroll
 * form, only while the security plugin is loaded), {@code sessions} (the
 * session list with the activity feed and the "New session" form),
 * {@code settings}, {@code plugins} and {@code providers} (only while the LLM
 * plugin is loaded), plus the dynamic {@code chat:<session-id>} screens. All
 * six screen classes are built with the {@code jhin.ui-kit} builder; this
 * registry only decides which of them one caller may see.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.plugin.ui.screens.EnrollScreen;
import com.astroreen.jhin.plugin.ui.screens.PluginsScreen;
import com.astroreen.jhin.plugin.ui.screens.ProvidersScreen;
import com.astroreen.jhin.plugin.ui.screens.SessionsScreen;
import com.astroreen.jhin.plugin.ui.screens.SettingsScreen;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.ServiceRegistry;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

final class Screens implements ScreenRegistry {

    /** Id prefix of the dynamic per-session chat screens. */
    private static final String CHAT_PREFIX = "chat:";

    private final SessionStore store;
    private final ServiceRegistry services;
    private final KernelInfo kernel;
    private final Features features;

    Screens(SessionStore store, ServiceRegistry services, KernelInfo kernel, Features features) {
        this.store = store;
        this.services = services;
        this.kernel = kernel;
        this.features = features;
    }

    @Override
    public Map<String, Supplier<UiNode>> screens(Optional<String> account,
                                                 Map<String, String> overrides) {
        Map<String, Supplier<UiNode>> screens = new LinkedHashMap<>();
        if (features.security()) {
            screens.put("connect", EnrollScreen::render);
        }
        screens.put("sessions", () -> SessionsScreen.render(
                store, account, providersPresent(), false));
        screens.put("settings", () -> SettingsScreen.render(
                account, features.security(), features.reload(),
                DefaultKeymap.entries(), overrides));
        screens.put("plugins", () -> PluginsScreen.render(kernel.plugins()));
        if (providersPresent()) {
            ProviderRegistry providers = providerRegistry().orElseThrow();
            screens.put("providers", () -> ProvidersScreen.render(providers, account));
        }
        return screens;
    }

    @Override
    public Optional<Supplier<UiNode>> screen(String id, Optional<String> account,
                                             Map<String, String> overrides) {
        Map<String, Supplier<UiNode>> screens = screens(account, overrides);
        Supplier<UiNode> found = screens.get(id);
        if (found != null) {
            return Optional.of(found);
        }
        if (!id.startsWith(CHAT_PREFIX)) {
            return Optional.empty();
        }
        String sessionId = id.substring(CHAT_PREFIX.length());
        Optional<Session> session = account
                .map(owner -> store.get(owner, sessionId))
                .orElseGet(() -> store.get(sessionId));
        return session.map(open -> (Supplier<UiNode>) () ->
                ChatScreen.render(open, features.agent()));
    }

    /** Whether the providers screen exists for this caller. */
    private boolean providersPresent() {
        return features.llm() && providerRegistry().isPresent();
    }

    /**
     * The published provider registry; empty when the LLM plugin is absent or
     * published nothing. Only called under the {@code llm} feature flag, so
     * the API class is never loaded without that plugin.
     */
    private Optional<ProviderRegistry> providerRegistry() {
        return features.llm() ? services.find(ProviderRegistry.class) : Optional.empty();
    }
}
