/**
 * Bootstrap payload behaviour: the entry screen decision, the contract keys,
 * the fallbacks block and the capability tailoring (stream views degrade to
 * server-side snapshots and inline directives are dropped at the source).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BootstrapRouteTest {

    /** Client declaring every capability the tailoring looks at. */
    private static final ClientInfo FULL_CAPS =
            new ClientInfo(1, "0.2.0", Set.of("sse", "open_url", "secure_storage", "multi_profile"));

    /** Client declaring nothing. */
    private static final ClientInfo NO_CAPS = new ClientInfo(1, "0.2.0", Set.of());

    /** A contract level 2 client with every capability and the current schema. */
    private static final ClientInfo LEVEL2_CAPS =
            new ClientInfo(2, "0.3.0", 3, Set.of("sse", "open_url", "secure_storage", "multi_profile"));

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private RecordingStreamRegistry streams;
    private EventLog eventLog;
    private String sessionId;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        eventLog = services.find(EventLog.class).orElseThrow();
        SessionStore store = services.find(SessionStore.class).orElseThrow();
        sessionId = store.create("demo", "/tmp/work").id();
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void entryIsSessionsWithoutTheSecurityPlugin() {
        Map<String, Object> payload = bootstrap(false, request(NO_CAPS), screens());

        assertThat(payload.get("entry")).isEqualTo("sessions");
    }

    @Test
    void entryIsPairWhenSecurityIsPresentWithoutPrincipal() {
        Map<String, Object> payload = bootstrap(true, request(NO_CAPS), screens());

        assertThat(payload.get("entry")).isEqualTo("pair");
    }

    @Test
    void entryIsSessionsWhenTheCallerCarriesAPrincipal() {
        FakeHttpRequest req = request(NO_CAPS);
        req.setAttribute(Principals.PRINCIPAL_ATTRIBUTE, "acc-1");

        Map<String, Object> payload = bootstrap(true, req, screens());

        assertThat(payload.get("entry")).isEqualTo("sessions");
    }

    @Test
    void entryIsSessionsWhenThePrincipalIsAnObjectWithAccountId() {
        FakeHttpRequest req = request(NO_CAPS);
        req.setAttribute(Principals.PRINCIPAL_ATTRIBUTE, new ObjectWithAccount("acc-2"));

        Map<String, Object> payload = bootstrap(true, req, screens());

        assertThat(payload.get("entry")).isEqualTo("sessions");
    }

    @Test
    void payloadCarriesTheContractKeys() {
        Map<String, Object> payload = bootstrap(false, request(FULL_CAPS), screens());

        assertThat(payload).containsEntry("api", 1);
        assertThat(payload).containsEntry("empty", false);
        assertThat(payload).containsEntry("title", "Jhin");
        assertThat(payload).containsEntry("screenEndpoint", "/ui/screen/{id}");
        assertThat(castMap(payload.get("theme"))).containsOnlyKeys("seedColor", "mode");
        List<Object> screens = castList(payload.get("screens"));
        assertThat(screens).isNotEmpty();
        Set<Object> ids = new java.util.HashSet<>();
        for (Object entry : screens) {
            ids.add(castMap(entry).get("id"));
        }
        assertThat(ids).contains("connect", "sessions");
    }

    @Test
    void fallbacksCarryTheOfflineAndErrorKeys() {
        Map<String, Object> payload = bootstrap(false, request(FULL_CAPS), screens());

        Map<String, Object> fallbacks = castMap(payload.get("fallbacks"));
        assertThat(fallbacks.keySet()).containsExactlyInAnyOrder("offline", "error");
        assertThat(castMap(fallbacks.get("offline"))).containsEntry("type", "card");
        assertThat(castMap(fallbacks.get("error"))).containsEntry("type", "card");
    }

    @Test
    void level1FallbacksKeepTheClassicCardArt() {
        Map<String, Object> payload = bootstrap(false, request(FULL_CAPS), screens());

        Map<String, Object> fallbacks = castMap(payload.get("fallbacks"));
        String offline = String.valueOf(fallbacks.get("offline"));
        String error = String.valueOf(fallbacks.get("error"));
        // Level 1 is exactly the Appendix A art: no skeleton, no token refs.
        assertThat(offline).doesNotContain("skeleton").doesNotContain("$");
        assertThat(error).doesNotContain("skeleton").doesNotContain("$");
        assertThat(typesIn(fallbacks)).containsExactlyInAnyOrder("card", "text", "button");
    }

    @Test
    void level2FallbacksAreTokenDrivenSkeletonCompositions() {
        Map<String, Object> payload = bootstrap(false, request(LEVEL2_CAPS), screens());

        Map<String, Object> fallbacks = castMap(payload.get("fallbacks"));
        for (String key : new String[] {"offline", "error"}) {
            Map<String, Object> art = castMap(fallbacks.get(key));
            assertThat(art).containsEntry("type", "card");
            // card + skeleton + button composition.
            assertThat(typesIn(art)).contains("card", "skeleton", "button");
        }
        assertThat(opsIn(castMap(fallbacks.get("offline")))).contains("refresh");
        // Token-driven layout and colors, resolved client-side (§2.2).
        String offline = String.valueOf(fallbacks.get("offline"));
        String error = String.valueOf(fallbacks.get("error"));
        assertThat(offline).contains("$spacing.lg", "$spacing.md", "$color.accent", "$radius.md");
        assertThat(error).contains("$spacing.lg", "$spacing.md", "$color.error", "$radius.md");
        assertThat(opsIn(castMap(fallbacks.get("error"))))
                .contains("reloadBootstrap", "openProfiles");
    }

    @Test
    void streamViewSurvivesForAClientWithSse() {
        Map<String, Object> payload = bootstrap(false, request(FULL_CAPS), screens());

        assertThat(typesIn(payload)).contains("stream_view");
    }

    @Test
    void streamViewBecomesASnapshotListWithoutSse() {
        eventLog.append(sessionId, EventType.USER_MESSAGE, "{\"text\":\"hello\"}");
        eventLog.append(sessionId, EventType.MESSAGE_END, "{\"text\":\"hi\"}");

        Map<String, Object> payload = bootstrap(false, request(NO_CAPS), screens());

        assertThat(typesIn(payload)).doesNotContain("stream_view");
        assertThat(typesIn(payload)).contains("list");
        UiNode list = findList(payload);
        assertThat(list.props()).containsEntry("id", "activity");
        List<Object> items = castList(list.props().get("items"));
        assertThat(items).contains("You: hello", "Assistant: hi");
    }

    @Test
    void snapshotShowsTheEmptyTextWhenTheStreamIsEmpty() {
        Map<String, Object> payload = bootstrap(false, request(NO_CAPS), screens());

        UiNode list = findList(payload);
        assertThat(castList(list.props().get("items"))).containsExactly("No activity yet.");
    }

    @Test
    void inlineDirectivesAreDroppedWithoutTheirCapabilities() {
        Map<String, Object> payload = bootstrap(false, request(NO_CAPS), screens());

        assertThat(opsIn(payload)).doesNotContain("openUrl", "setToken", "clearToken", "setServerUrl");
        assertThat(opsIn(payload)).contains("navigate", "openProfiles");
    }

    @Test
    void inlineDirectivesSurviveWithTheirCapabilities() {
        Map<String, Object> payload = bootstrap(false, request(FULL_CAPS), screens());

        assertThat(opsIn(payload)).contains("openUrl", "setToken", "clearToken", "setServerUrl");
    }

    /** Runs the route: the payload map of a 200 response. */
    private Map<String, Object> bootstrap(boolean securityPresent, FakeHttpRequest req,
                                          ScreenRegistry registry) {
        CapabilityTailor tailor = new CapabilityTailor(eventLog);
        BootstrapRoute route = new BootstrapRoute(registry, securityPresent, tailor,
                UiSettings.open(tmp));
        HttpResponse response = route.handle(req);
        assertThat(response.status()).isEqualTo(200);
        return Json.readMap(new String(response.body()));
    }

    private static FakeHttpRequest request(ClientInfo client) {
        return new FakeHttpRequest("GET", "/_jhin/bootstrap", Map.of(), Map.of(), "",
                client, Map.of());
    }

    /**
     * A fixture registry whose screens exercise every tailoring rule: a stream
     * view plus buttons carrying gated and ungated inline directives.
     */
    private ScreenRegistry screens() {
        UiNode screen = Ui.screen()
                .title("Fixture")
                .body(Ui.container()
                        .direction("column")
                        .child(Ui.streamView("activity", "/ui/stream/session/" + sessionId)
                                .mode("append").itemLimit(20).empty("No activity yet.")
                                .build())
                        .child(Ui.button("Open docs").action(Directives.openUrl("https://example.invalid/docs")).build())
                        .child(Ui.button("Sign in").action(Directives.setToken("t")).build())
                        .child(Ui.button("Sign out").action(Directives.clearToken()).build())
                        .child(Ui.button("Move").action(Directives.setServerUrl("https://example.invalid")).build())
                        .child(Ui.button("Go").action(Directives.navigate("sessions")).build())
                        .child(Ui.button("Servers").action(Directives.openProfiles()).build())
                        .build())
                .build();
        Map<String, Supplier<UiNode>> registry = new LinkedHashMap<>();
        registry.put("connect", () -> screen);
        registry.put("sessions", () -> screen);
        return (account, overrides) -> registry;
    }

    /** Every primitive type name appearing anywhere in a payload fragment. */
    private static Set<String> typesIn(Object fragment) {
        Set<String> types = new java.util.HashSet<>();
        collect(fragment, types, "type", new java.util.HashSet<>());
        return types;
    }

    /** Every {@code op} name appearing anywhere in a payload fragment. */
    private static Set<String> opsIn(Object fragment) {
        Set<String> ops = new java.util.HashSet<>();
        collect(fragment, ops, "op", new java.util.HashSet<>());
        return ops;
    }

    private static void collect(Object fragment, Set<String> out, String key, Set<Object> seen) {
        if (fragment instanceof Map<?, ?> map) {
            if (!seen.add(map)) {
                return;
            }
            Object value = map.get(key);
            if (value != null) {
                out.add(String.valueOf(value));
            }
            for (Object nested : map.values()) {
                collect(nested, out, key, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                collect(nested, out, key, seen);
            }
        }
    }

    /** The degraded snapshot list of a payload; fails when there is none. */
    private static UiNode findList(Map<String, Object> payload) {
        List<Map<String, Object>> screens = castList(payload.get("screens")).stream()
                .map(BootstrapRouteTest::castMap)
                .toList();
        UiNode found = findListNode(screens.get(0).get("node"));
        assertThat(found).as("a list node in the payload").isNotNull();
        return found;
    }

    private static UiNode findListNode(Object fragment) {
        if (fragment instanceof Map<?, ?> map) {
            if ("list".equals(map.get("type")) && map.containsKey("items")) {
                return new UiNode("list", castMap(map), List.of());
            }
            for (Object nested : map.values()) {
                UiNode found = findListNode(nested);
                if (found != null) {
                    return found;
                }
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                UiNode found = findListNode(nested);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }

    /** A principal shape the extraction pattern understands. */
    public static final class ObjectWithAccount {

        private final String accountId;

        ObjectWithAccount(String accountId) {
            this.accountId = accountId;
        }

        public String accountId() {
            return accountId;
        }
    }
}
