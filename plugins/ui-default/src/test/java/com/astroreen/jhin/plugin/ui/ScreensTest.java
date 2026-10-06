/**
 * The six default screens: node shapes per screen (the form contracts, the
 * action descriptors with their included inputs, the navigation drawer, the
 * stream view, the tables) and the registry rules — the optional screens
 * appear only with their integration and their service, the dynamic
 * {@code chat:<id>} screens resolve per session.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.llm.api.ProviderRecord;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.plugin.ui.screens.EnrollScreen;
import com.astroreen.jhin.plugin.ui.screens.PluginsScreen;
import com.astroreen.jhin.plugin.ui.screens.ProvidersScreen;
import com.astroreen.jhin.plugin.ui.screens.SessionsScreen;
import com.astroreen.jhin.plugin.ui.screens.SettingsScreen;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.KernelInfo;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ScreensTest {

    private static final Features NO_PLUGINS = new Features(false, false, false, false);
    private static final Features EVERYTHING = new Features(true, true, true, true);

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private EventLog events;
    private FakeProviderRegistry providers;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        store = services.find(SessionStore.class).orElseThrow();
        events = services.find(EventLog.class).orElseThrow();
        providers = new FakeProviderRegistry(List.of("mock", "anthropic"));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void enrollScreenIsARequiredFieldFormSubmittingToEnroll() {
        Map<String, Object> json = EnrollScreen.render().toJson();

        assertThat(typesIn(json)).contains("screen", "form", "input");
        List<Map<String, Object>> inputs = nodesOfType(json, "input");
        assertThat(inputs).extracting(input -> input.get("id"))
                .containsExactly("code", "deviceName");
        assertThat(inputs).allSatisfy(input -> assertThat(input).containsEntry("required", true));
        Map<String, Object> submit = castMap(findSubmit(json));
        assertThat(submit).containsEntry("label", "Enroll");
        Map<String, Object> action = castMap(submit.get("action"));
        assertThat(action).containsEntry("path", "/ui/action/enroll");
        assertThat(action).containsEntry("name", "enroll");
        assertThat(castList(action.get("include"))).containsExactly("code", "deviceName");
    }

    @Test
    void sessionsScreenIsAThreadShellWhoseRowsNavigateToChat() {
        Session session = store.create("demo", "/tmp/work");

        Map<String, Object> json = SessionsScreen.render(store, Optional.empty(), false, false)
                .toJson();

        assertThat(typesIn(json)).contains("shell", "list", "list_row");
        assertThat(screensOf(json)).contains("chat:" + session.id());
        assertThat(nodesOfType(json, "list_row"))
                .extracting(row -> row.get("id"))
                .contains("session-row:" + session.id());
    }

    @Test
    void sessionsScreenDrawerLinksDependOnTheLoadedPlugins() {
        Map<String, Object> bare = SessionsScreen.render(store, Optional.empty(), false, false)
                .toJson();
        Map<String, Object> linked = SessionsScreen.render(store, Optional.empty(), true, false)
                .toJson();

        assertThat(screensOf(bare)).contains("sessions", "settings", "plugins");
        assertThat(screensOf(bare)).doesNotContain("providers");
        assertThat(screensOf(linked)).contains("providers");
    }

    @Test
    void sessionsScreenBodyIsTheChatPlaceholder() {
        Map<String, Object> json = SessionsScreen.render(store, Optional.empty(), false, false)
                .toJson();

        assertThat(stringsIn(json)).contains("Select a thread");
    }

    @Test
    void chatScreenBindsTheStreamTheInputAndTheSendAction() {
        Session session = store.create("demo", "/tmp/work");

        Map<String, Object> json = ChatScreen.render(session, List.of()).toJson();

        List<Map<String, Object>> streams = nodesOfType(json, "stream_view");
        assertThat(streams).hasSize(1);
        assertThat(streams.get(0))
                .containsEntry("topic", "/ui/stream/session/" + session.id() + "?fromSeq=0")
                .containsEntry("itemLimit", 200)
                .containsEntry("autoScroll", true);
        assertThat(nodesOfType(json, "textarea"))
                .extracting(input -> input.get("id"))
                .containsExactly("messageInput");
        Map<String, Object> send = button(json, "Send");
        Map<String, Object> action = castMap(send.get("action"));
        assertThat(action).containsEntry("name", "send");
        assertThat(castList(action.get("include"))).containsExactly("messageInput");
        assertThat(castMap(action.get("payload"))).containsEntry("sessionId", session.id());
    }

    @Test
    void chatScreenCarriesStopOnlyWhileARunIsLive() {
        Session session = store.create("demo", "/tmp/work");
        EventRecord runStart = new EventRecord(session.id(), 1, 1L, EventType.RUN_START,
                "{\"runId\":\"r1\"}");

        Map<String, Object> idle = ChatScreen.render(session, List.of()).toJson();
        Map<String, Object> running = ChatScreen.render(session, List.of(runStart)).toJson();

        assertThat(nodesWithId(idle, "composer-stop")).isEmpty();
        assertThat(nodesWithId(running, "composer-stop")).hasSize(1);
        assertThat(castMap(nodesWithId(running, "composer-stop").get(0).get("action")))
                .containsEntry("name", "cancel");
    }

    @Test
    void settingsScreenCarriesTheAccountInfoAndTheClientOwnedControls() {
        Map<String, Object> json = SettingsScreen.render(
                Optional.of("acc-1"), true, false, keymapFixture(), Map.of(), UiSettings.Snapshot.defaults()).toJson();

        assertThat(stringsIn(json)).anyMatch(text -> text.contains("Signed in as acc-1"));
        assertThat(opsIn(json)).contains("openProfiles", "clearToken", "openUrl");
        assertThat(labels(json)).doesNotContain("Reload");
    }

    @Test
    void settingsScreenReloadButtonAppearsOnlyWithTheReloadPlugin() {
        Map<String, Object> withReload = SettingsScreen.render(
                Optional.empty(), true, true, keymapFixture(), Map.of(), UiSettings.Snapshot.defaults()).toJson();
        Map<String, Object> without = SettingsScreen.render(
                Optional.empty(), true, false, keymapFixture(), Map.of(), UiSettings.Snapshot.defaults()).toJson();

        assertThat(labels(withReload)).contains("Reload");
        assertThat(castMap(button(withReload, "Reload").get("action")))
                .containsEntry("name", "reload");
        assertThat(labels(without)).doesNotContain("Reload");
    }

    @Test
    void settingsScreenShowsNotSignedInWithoutAPrincipal() {
        Map<String, Object> json = SettingsScreen.render(
                Optional.empty(), true, false, keymapFixture(), Map.of(), UiSettings.Snapshot.defaults()).toJson();

        assertThat(stringsIn(json)).contains("Not signed in");
    }

    @Test
    void settingsScreenKeyboardRowsShowTheEffectiveChords() {
        Map<String, Object> json = SettingsScreen.render(
                Optional.empty(), true, false, keymapFixture(),
                Map.of("composer.send", "mod+shift+enter"),
                UiSettings.Snapshot.defaults()).toJson();

        assertThat(stringsIn(json)).contains("composer.send", "palette.open");
        // The client override wins per command; un-overridden commands keep
        // their default chord (T70).
        assertThat(stringsIn(json)).contains("mod+shift+enter", "ctrl+k");
        assertThat(stringsIn(json)).doesNotContain("mod+enter");
        assertThat(labels(json)).contains("Edit", "Reset", "Restore defaults");
        assertThat(opsIn(json)).contains(
                "keybind-edit", "keybind-reset", "keybind-restore");
    }

    @Test
    void providersScreenPopulatesTheFormatDropdownAndListsRows() {
        ProviderRecord created = providers.create("mock",
                new com.astroreen.jhin.plugin.llm.api.ProviderConfig(null, "echo", null));

        Map<String, Object> json = ProvidersScreen.render(providers, Optional.empty()).toJson();

        Map<String, Object> dropdown = nodesOfType(json, "dropdown").get(0);
        assertThat(dropdown).containsEntry("id", "format");
        assertThat(castList(dropdown.get("items")).toString()).contains("mock", "anthropic");
        Map<String, Object> submit = castMap(findSubmit(json));
        assertThat(castMap(submit.get("action")))
                .containsEntry("name", "create-provider");
        assertThat(castList(castMap(submit.get("action")).get("include")))
                .containsExactly("format", "model", "apiKey", "baseUrl");
        assertThat(opsIn(json)).contains("delete-provider");
        assertThat(stringsIn(json)).anyMatch(text -> text.contains(created.id()));
    }

    @Test
    void pluginsScreenIsACardOfListRowsOfTheLoadedCatalog() {
        List<KernelInfo.Loaded> plugins = List.of(
                new KernelInfo.Loaded("jhin.ui", "0.2.0", "UI", List.of()),
                new KernelInfo.Loaded("jhin.sessions", "0.2.0", "Sessions", List.of()));

        Map<String, Object> json = PluginsScreen.render(plugins).toJson();

        assertThat(nodesOfType(json, "card")).isNotEmpty();
        List<Map<String, Object>> rows = nodesOfType(json, "list_row");
        assertThat(rows).hasSize(2);
        assertThat(stringsIn(json)).contains("jhin.ui", "jhin.sessions", "0.2.0", "UI", "Sessions");
    }

    @Test
    void registryOmitsTheOptionalScreensWithoutTheirIntegrations() {
        Screens screens = registry(NO_PLUGINS);

        Set<String> ids = screens.screens(Optional.empty(), Map.of()).keySet();
        assertThat(ids).contains("sessions", "settings", "plugins");
        assertThat(ids).doesNotContain("connect", "providers");
        assertThat(ids).containsAll(
                SettingsScreen.ROUTES.stream().map(SettingsScreen.Route::id).toList());
    }

    @Test
    void registryAddsConnectForSecurityAndProvidersForTheLlmService() {
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        services.publish(ProviderRegistry.class, providers);
        Screens screens = new Screens(store, events, services, kernel(), EVERYTHING,
                UiSettings.open(tmp));

        Set<String> ids = screens.screens(Optional.empty(), Map.of()).keySet();
        assertThat(ids).contains("connect", "sessions", "settings", "plugins", "providers");
        assertThat(ids).containsAll(
                SettingsScreen.ROUTES.stream().map(SettingsScreen.Route::id).toList());
    }

    @Test
    void registryResolvesEverySettingsSubRoute() {
        Screens screens = registry(NO_PLUGINS);

        for (SettingsScreen.Route route : SettingsScreen.ROUTES) {
            Optional<Supplier<UiNode>> screen =
                    screens.screen(route.id(), Optional.empty(), Map.of());
            assertThat(screen).as(route.id()).isPresent();
            assertThat(typesIn(screen.get().get().toJson())).contains("screen", "shell", "nav");
        }
        assertThat(screens.screen("settings:nope", Optional.empty(), Map.of())).isEmpty();
    }

    @Test
    void registryKeepsProvidersOutWhileTheServiceIsMissing() {
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        Screens screens = new Screens(store, events, services, kernel(), EVERYTHING,
                UiSettings.open(tmp));

        assertThat(screens.screens(Optional.empty(), Map.of()).keySet()).doesNotContain("providers");
    }

    @Test
    void registryResolvesDynamicChatScreenIds() {
        Session session = store.create("demo", "/tmp/work");
        Screens screens = registry(NO_PLUGINS);

        Optional<Supplier<UiNode>> chat = screens.screen("chat:" + session.id(), Optional.empty(), Map.of());
        assertThat(chat).isPresent();
        Map<String, Object> json = chat.get().get().toJson();
        assertThat(typesIn(json)).contains("stream_view");
        assertThat(screens.screen("chat:missing", Optional.empty(), Map.of())).isEmpty();
        assertThat(screens.screen("nope", Optional.empty(), Map.of())).isEmpty();
    }

    @Test
    void registryRendersTheClientVersionOnTheDiagnosticsPanel() {
        Screens screens = registry(NO_PLUGINS);

        Optional<Supplier<UiNode>> diagnostics = screens.screen(
                "settings:diagnostics", Optional.empty(), Map.of(),
                new com.astroreen.jhin.sdk.http.ClientInfo(3, "9.9.9", 4, Set.of()));

        assertThat(diagnostics).isPresent();
        assertThat(stringsIn(diagnostics.get().get().toJson())).contains("9.9.9");
    }

    private Screens registry(Features features) {
        return new Screens(store, events, new FakePluginContext.FakeServices(), kernel(),
                features, UiSettings.open(tmp));
    }

    /** The default keymap rows the Keyboard section renders. */
    private static List<Map<String, Object>> keymapFixture() {
        return List.of(
                Map.of("key", "mod+enter", "command", "composer.send"),
                Map.of("key", "ctrl+k", "command", "palette.open"));
    }

    private static KernelInfo kernel() {
        return new KernelInfo() {

            @Override
            public String version() {
                return "0.2.0";
            }

            @Override
            public int apiVersion() {
                return ApiVersion.CURRENT;
            }

            @Override
            public Path home() {
                return Path.of("/tmp");
            }

            @Override
            public List<Loaded> plugins() {
                return List.of(new Loaded("jhin.ui", "0.2.0", "UI", List.of()));
            }
        };
    }

    // --- node walking helpers over the JSON wire shape ---

    private static List<Map<String, Object>> nodesOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static Object findSubmit(Object fragment) {
        List<Object> found = new ArrayList<>();
        walk(fragment, map -> {
            if (map.containsKey("submit")) {
                found.add(map.get("submit"));
            }
        });
        assertThat(found).as("a form submit in the node tree").isNotEmpty();
        return found.get(0);
    }

    private static Map<String, Object> button(Object fragment, String label) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if ("button".equals(map.get("type")) && label.equals(map.get("label"))) {
                found.add(map);
            }
        });
        assertThat(found).as("button " + label).hasSize(1);
        return found.get(0);
    }

    private static List<Map<String, Object>> nodesWithId(Object fragment, String id) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (id.equals(map.get("id"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static List<String> labels(Object fragment) {
        List<String> labels = new ArrayList<>();
        walk(fragment, map -> {
            if ("button".equals(map.get("type"))) {
                labels.add(String.valueOf(map.get("label")));
            }
        });
        return labels;
    }

    private static Set<String> typesIn(Object fragment) {
        Set<String> types = new HashSet<>();
        walk(fragment, map -> {
            if (map.get("type") != null) {
                types.add(String.valueOf(map.get("type")));
            }
        });
        return types;
    }

    private static Set<String> opsIn(Object fragment) {
        Set<String> ops = new HashSet<>();
        walk(fragment, map -> {
            if (map.get("op") != null) {
                ops.add(String.valueOf(map.get("op")));
            }
            Object action = map.get("action");
            if (action instanceof Map<?, ?> descriptor && descriptor.get("name") != null) {
                ops.add(String.valueOf(descriptor.get("name")));
            }
        });
        return ops;
    }

    private static Set<String> screensOf(Object fragment) {
        Set<String> screens = new HashSet<>();
        walk(fragment, map -> {
            if (map.get("screen") != null) {
                screens.add(String.valueOf(map.get("screen")));
            }
        });
        return screens;
    }

    private static List<String> stringsIn(Object fragment) {
        List<String> texts = new ArrayList<>();
        collectStrings(fragment, texts);
        return texts;
    }

    private static void collectStrings(Object fragment, List<String> texts) {
        if (fragment instanceof String text) {
            texts.add(text);
        } else if (fragment instanceof Map<?, ?> map) {
            for (Object value : map.values()) {
                collectStrings(value, texts);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                collectStrings(nested, texts);
            }
        }
    }

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                copy.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            seen.accept(copy);
            for (Object nested : map.values()) {
                walk(nested, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                walk(nested, seen);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}
