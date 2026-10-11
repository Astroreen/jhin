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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BootstrapRouteTest {

    /** Client declaring every capability the tailoring looks at. */
    private static final ClientInfo FULL_CAPS =
            new ClientInfo(4, "0.4.0", 5, Set.of("sse", "open_url", "secure_storage", "multi_profile"));

    /** Client declaring nothing. */
    private static final ClientInfo NO_CAPS = new ClientInfo(4, "0.4.0", 5, Set.of());

    /** A capability-rich client at the current contract level (the token-driven
     * fallback art needs a negotiated level of at least 2). */
    private static final ClientInfo LEVEL2_CAPS =
            new ClientInfo(4, "0.4.0", 5, Set.of("sse", "open_url", "secure_storage", "multi_profile"));

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

        assertThat(payload).containsEntry("api", 4);
        assertThat(payload).containsEntry("empty", false);
        assertThat(payload).containsEntry("title", "Jhin");
        assertThat(payload).containsEntry("screenEndpoint", "/ui/screen/{id}");
        assertThat(castMap(payload.get("theme")))
                .containsKeys("id", "appearance", "canvas", "accent", "colors", "mode");
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
        assertThat(String.valueOf(fallbacks.get("offline")))
                .startsWith("<").contains("data-jhin-type=\"card\"");
        assertThat(String.valueOf(fallbacks.get("error")))
                .startsWith("<").contains("data-jhin-type=\"card\"");
    }

    @Test
    void level1ClientsGetTheContractUpgradeRefusal() {
        // The level-1 wire shape (classic card art, reduced theme) is gone
        // behind the contract-level-4 gate: an api=1 caller is refused before
        // any payload is built (docs/sdui.md section 1).
        CapabilityTailor tailor = new CapabilityTailor(eventLog);
        BootstrapRoute route = new BootstrapRoute(screens(), false, tailor, UiSettings.open(tmp));
        FakeHttpRequest req = new FakeHttpRequest("GET", "/_jhin/bootstrap", Map.of(), Map.of(), "",
                new ClientInfo(1, "0.2.0", 1, Set.of()), Map.of());

        HttpResponse response = route.handle(req);

        assertThat(response.status()).isEqualTo(426);
        assertThat(Json.readMap(new String(response.body())))
                .containsEntry("error", "contract_upgrade")
                .containsEntry("minApi", 4);
    }

    @Test
    void level2FallbacksAreTokenDrivenSkeletonCompositions() {
        Map<String, Object> payload = bootstrap(false, request(LEVEL2_CAPS), screens());

        Map<String, Object> fallbacks = castMap(payload.get("fallbacks"));
        for (String key : new String[] {"offline", "error"}) {
            String art = String.valueOf(fallbacks.get(key));
            assertThat(art).startsWith("<").contains("data-jhin-type=\"card\"");
            // card + skeleton + button composition.
            assertThat(typesIn(art)).contains("card", "skeleton", "button");
        }
        assertThat(opsIn(String.valueOf(fallbacks.get("offline")))).contains("refresh");
        // Token-driven layout and colors, resolved into CSS variables (§2.2).
        String offline = String.valueOf(fallbacks.get("offline"));
        String error = String.valueOf(fallbacks.get("error"));
        assertThat(offline).contains("var(--spacing-lg)", "var(--spacing-md)",
                "var(--color-accent)", "var(--radius-md)");
        assertThat(error).contains("var(--spacing-lg)", "var(--spacing-md)",
                "var(--color-error)", "var(--radius-md)");
        assertThat(opsIn(String.valueOf(fallbacks.get("error"))))
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
        String html = screensHtml(payload);
        assertThat(html).contains("data-jhin-type=\"list\"", "id=\"activity\"",
                "You: hello", "Assistant: hi");
    }

    @Test
    void snapshotShowsTheEmptyTextWhenTheStreamIsEmpty() {
        Map<String, Object> payload = bootstrap(false, request(NO_CAPS), screens());

        String html = screensHtml(payload);
        assertThat(html).contains("No activity yet.").doesNotContain("You:");
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

    /** The wire vocabulary of an HTML fragment: {@code data-jhin-type="…"} attributes. */
    private static final Pattern TYPE_ATTR = Pattern.compile("data-jhin-type=\"([^\"]+)\"");

    /** The wire vocabulary of an HTML fragment: the {@code op} field of the
     * action JSON inside {@code data-jhin-action}. */
    private static final Pattern OP_ATTR = Pattern.compile("\"op\":\"([\\w]+)\"");

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
        } else if (fragment instanceof String text) {
            // Contract level 4: screens and fallbacks are HTML strings, so the
            // wire vocabulary lives in the attributes instead of node maps.
            // The action JSON arrives with HTML-escaped quotes — decode the
            // quote entities first (HtmlEsc escapes all five).
            String amp = String.valueOf((char) 38);
            String decoded = text
                    .replace(amp + "quot;", "\"")
                    .replace(amp + "#39;", "'");
            Matcher matcher = ("type".equals(key) ? TYPE_ATTR : OP_ATTR).matcher(decoded);
            while (matcher.find()) {
                out.add(matcher.group(1));
            }
        }
    }

    /** The concatenated HTML of every inline screen. */
    private static String screensHtml(Map<String, Object> payload) {
        StringBuilder html = new StringBuilder();
        for (Object entry : castList(payload.get("screens"))) {
            html.append(castMap(entry).get("html"));
        }
        return html.toString();
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
