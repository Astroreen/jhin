/**
 * The default screen registry of the T37 surface: {@code pair} (the enroll
 * form, only while the security plugin is loaded), {@code connect} (the T114
 * decorative device-connection explainer), {@code welcome} (the T114
 * decorative onboarding wizard), {@code sessions} (the session list with the
 * activity feed and the "New session" form), {@code settings} (the T109
 * settings shell overview) with its fourteen {@code settings:*} sub-routes,
 * {@code plugins} and {@code providers} (only while the LLM plugin is
 * loaded), the T113 decorative {@code usage} and {@code pull-requests}
 * surfaces, plus the dynamic {@code chat:<session-id>} and
 * {@code project:<key>} (T114) screens and the QA-only probes
 * {@code qa-level3} (T88) and {@code qa-timeline} (T101, both only while the
 * {@code qaProbe} config switch is on). All screen classes are built with the
 * {@code jhin.ui-kit} builder; this registry only decides which of them one
 * caller may see.
 *
 * <p>T111: the settings screens are handed a {@link SettingsScreen.Facts}
 * snapshot (the kernel version, the loaded-plugin list, the storage paths, the
 * negotiated contract level, the requesting client's version and the storage
 * counters) so the diagnostics and storage panels render real host data.
 *
 * <p>T112: the settings screens also receive the providers CRUD panel supplier
 * (only built while the LLM plugin is loaded, so the {@code ProviderRegistry}
 * class is never resolved without it) and the caller's archived sessions, so
 * {@code settings:providers} and {@code settings:archived} render real data.
 *
 * <p>T114: the {@code pair} route is the real enrollment form (the bootstrap
 * entry for an unauthenticated caller); {@code connect} is the decorative
 * explainer; {@code project:<key>} resolves the fixture project and lists the
 * caller's sessions whose workdir is the project path.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.plugin.ui.screens.ConnectScreen;
import com.astroreen.jhin.plugin.ui.screens.EnrollScreen;
import com.astroreen.jhin.plugin.ui.screens.PluginsScreen;
import com.astroreen.jhin.plugin.ui.screens.ProjectScreen;
import com.astroreen.jhin.plugin.ui.screens.ProvidersScreen;
import com.astroreen.jhin.plugin.ui.screens.PullRequestsScreen;
import com.astroreen.jhin.plugin.ui.screens.QaProbeScreen;
import com.astroreen.jhin.plugin.ui.screens.QaTimelineScreen;
import com.astroreen.jhin.plugin.ui.screens.SessionsScreen;
import com.astroreen.jhin.plugin.ui.screens.SettingsScreen;
import com.astroreen.jhin.plugin.ui.screens.UsageScreen;
import com.astroreen.jhin.plugin.ui.screens.WelcomeScreen;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.http.ClientInfo;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

final class Screens implements ScreenRegistry {

    /** Id prefix of the dynamic per-session chat screens. */
    private static final String CHAT_PREFIX = "chat:";

    /** Id prefix of the dynamic per-project screens (T114). */
    private static final String PROJECT_PREFIX = "project:";

    private final SessionStore store;
    private final EventLog events;
    private final ServiceRegistry services;
    private final KernelInfo kernel;
    private final Features features;
    private final UiSettings settings;

    Screens(SessionStore store, EventLog events, ServiceRegistry services,
            KernelInfo kernel, Features features, UiSettings settings) {
        this.store = store;
        this.events = events;
        this.services = services;
        this.kernel = kernel;
        this.features = features;
        this.settings = settings;
    }

    @Override
    public Map<String, Supplier<UiNode>> screens(Optional<String> account,
                                                 Map<String, String> overrides) {
        return screens(account, overrides, ClientInfo.UNKNOWN);
    }

    @Override
    public Map<String, Supplier<UiNode>> screens(Optional<String> account,
                                                 Map<String, String> overrides,
                                                 ClientInfo client) {
        UiSettings.Snapshot snapshot = settings.current();
        SettingsScreen.Facts facts = facts(account, client);
        // The providers panel supplier is only built while the LLM plugin is
        // loaded: the lambda body references ProviderRegistry, so creating it
        // without jhin.llm would force the class load and fail the bootstrap.
        Supplier<UiNode> providersPanel = providersPresent()
                ? () -> ProvidersScreen.panel(providerRegistry().orElseThrow(), account)
                : null;
        List<Session> archived = account
                .map(owner -> store.list(owner, SessionStore.StatusFilter.ARCHIVED))
                .orElseGet(() -> store.list(SessionStore.StatusFilter.ARCHIVED));
        Map<String, Supplier<UiNode>> screens = new LinkedHashMap<>();
        if (features.security()) {
            screens.put(EnrollScreen.PAIR_ID, EnrollScreen::render);
        }
        screens.put("connect", ConnectScreen::render);
        screens.put("welcome", WelcomeScreen::render);
        screens.put("sessions", () -> SessionsScreen.render(
                store, account, providersPresent(), false));
        screens.put("settings", () -> SettingsScreen.render(
                account, features.security(), features.reload(),
                DefaultKeymap.entries(), overrides, snapshot));
        for (SettingsScreen.Route route : SettingsScreen.ROUTES) {
            screens.put(route.id(), () -> SettingsScreen.renderRoute(
                    route.id(), account, features.security(), features.reload(),
                    DefaultKeymap.entries(), overrides, snapshot, facts, providersPanel, archived));
        }
        screens.put("plugins", () -> PluginsScreen.render(kernel.plugins()));
        screens.put("usage", UsageScreen::render);
        screens.put("pull-requests", PullRequestsScreen::render);
        if (providersPanel != null) {
            screens.put("providers", () -> ProvidersScreen.render(
                    providerRegistry().orElseThrow(), account));
        }
        if (snapshot.qaProbe()) {
            screens.put("qa-level3", QaProbeScreen::render);
            screens.put("qa-timeline", QaTimelineScreen::render);
        }
        return screens;
    }

    @Override
    public Optional<Supplier<UiNode>> screen(String id, Optional<String> account,
                                             Map<String, String> overrides) {
        return screen(id, account, overrides, ClientInfo.UNKNOWN);
    }

    @Override
    public Optional<Supplier<UiNode>> screen(String id, Optional<String> account,
                                             Map<String, String> overrides,
                                             ClientInfo client) {
        Map<String, Supplier<UiNode>> screens = screens(account, overrides, client);
        Supplier<UiNode> found = screens.get(id);
        if (found != null) {
            return Optional.of(found);
        }
        if (id.startsWith(PROJECT_PREFIX)) {
            String key = id.substring(PROJECT_PREFIX.length());
            List<Session> sessions = account.map(store::list).orElseGet(store::list);
            return ProjectScreen.render(key, sessions)
                    .map(node -> (Supplier<UiNode>) () -> node);
        }
        if (!id.startsWith(CHAT_PREFIX)) {
            return Optional.empty();
        }
        String sessionId = id.substring(CHAT_PREFIX.length());
        Optional<Session> session = account
                .map(owner -> store.get(owner, sessionId))
                .orElseGet(() -> store.get(sessionId));
        return session.map(open -> (Supplier<UiNode>) () ->
                ChatScreen.render(open, events.list(open.id(), 0)));
    }

    /**
     * The T111 facts snapshot of the settings diagnostics and storage panels:
     * the kernel identity, the storage paths, the negotiated contract level,
     * the requesting client's version and the per-status session counters.
     *
     * @param account the caller's account id, empty when unscoped
     * @param client  the parsed {@code X-Jhin-Client} header
     * @return the facts
     */
    private SettingsScreen.Facts facts(Optional<String> account, ClientInfo client) {
        Path home = kernel.home();
        Path data = home.resolve("data");
        Path plugins = home.resolve("plugins");
        return new SettingsScreen.Facts(
                kernel.version(),
                client.api(),
                client.version(),
                client.schema(),
                home.toString(),
                data.toString(),
                plugins.toString(),
                kernel.plugins(),
                count(account, SessionStore.StatusFilter.ACTIVE),
                count(account, SessionStore.StatusFilter.SETTLED),
                count(account, SessionStore.StatusFilter.SNOOZED),
                count(account, SessionStore.StatusFilter.ARCHIVED),
                dbSize(data.resolve("jhin.db")));
    }

    /** The session count of one status view for the caller. */
    private int count(Optional<String> account, SessionStore.StatusFilter filter) {
        return account
                .map(owner -> store.list(owner, filter).size())
                .orElseGet(() -> store.list(filter).size());
    }

    /** The size of the shared SQLite file in bytes, zero when it is absent. */
    private static long dbSize(Path file) {
        try {
            return Files.exists(file) ? Files.size(file) : 0L;
        } catch (IOException e) {
            return 0L;
        }
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
