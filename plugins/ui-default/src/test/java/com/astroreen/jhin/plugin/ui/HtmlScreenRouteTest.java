/**
 * The level-4 screen route wire: {@code GET /ui/screen/{id}} answers
 * {@code {"id":…,"html":…}} — the tailored node rendered through
 * {@code HtmlRenderer}, never a node tree — for the static and the dynamic
 * registry ids; an unknown id is the {@code 404 unknown_screen} failure; a
 * client below {@code ApiVersion.SDUI_CONTRACT_MIN} (including the absent
 * {@code X-Jhin-Client} header) is refused with the exact
 * {@code 426 contract_upgrade} body.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class HtmlScreenRouteTest {

    /** The exact {@code 426} body of the contract-upgrade refusal. */
    private static final String CONTRACT_UPGRADE_BODY =
            "{\"error\":\"contract_upgrade\","
                    + "\"message\":\"This server speaks the HTML UI contract (api=4). Upgrade your client.\","
                    + "\"minApi\":4}";

    private static final ClientInfo API4 = new ClientInfo(4, "0.4.0", 5, Set.of("sse"));
    private static final ClientInfo API3 = new ClientInfo(3, "0.3.0", 4, Set.of("sse"));

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private EventLog eventLog;
    private ScreenRoute route;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        store = services.find(SessionStore.class).orElseThrow();
        eventLog = services.find(EventLog.class).orElseThrow();
        Screens screens = new Screens(store, eventLog, services, kernel(),
                new Features(true, false, false, false), UiSettings.open(tmp));
        route = new ScreenRoute(screens, new CapabilityTailor(eventLog));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void staticScreenAnswersHtmlWithNoNodeKey() {
        HttpResponse response = route.handle(request("sessions", API4));

        assertThat(response.status()).isEqualTo(200);
        Map<String, Object> body = Json.readMap(new String(response.body()));
        assertThat(body).containsOnlyKeys("id", "html").containsEntry("id", "sessions");
        String html = String.valueOf(body.get("html"));
        assertThat(html).startsWith("<").contains("data-jhin-type=");
    }

    @Test
    void dynamicChatScreenIdResolves() {
        Session session = store.create("demo", "/tmp/work");

        HttpResponse response = route.handle(request("chat:" + session.id(), API4));

        assertThat(response.status()).isEqualTo(200);
        Map<String, Object> body = Json.readMap(new String(response.body()));
        assertThat(body).containsEntry("id", "chat:" + session.id());
        assertThat(String.valueOf(body.get("html")))
                .startsWith("<").contains("data-jhin-type=");
        assertThat(body).doesNotContainKey("node");
    }

    @Test
    void thePairScreenResolvesWhileSecurityIsLoaded() {
        HttpResponse response = route.handle(request("pair", API4));

        assertThat(response.status()).isEqualTo(200);
        Map<String, Object> body = Json.readMap(new String(response.body()));
        assertThat(body).containsEntry("id", "pair");
        assertThat(String.valueOf(body.get("html")))
                .startsWith("<").contains("data-jhin-type=\"screen\"");
    }

    @Test
    void unknownScreenIs404NamedUnknownScreen() {
        HttpResponse response = route.handle(request("nope", API4));

        assertThat(response.status()).isEqualTo(404);
        assertThat(new String(response.body())).contains("unknown_screen");
    }

    @Test
    void api3ClientGetsTheContractUpgradeRefusal() {
        HttpResponse response = route.handle(request("sessions", API3));

        assertThat(response.status()).isEqualTo(426);
        assertThat(new String(response.body())).isEqualTo(CONTRACT_UPGRADE_BODY);
    }

    @Test
    void absentClientHeaderGetsTheContractUpgradeRefusal() {
        HttpResponse response = route.handle(
                request("sessions", ClientInfo.UNKNOWN));

        assertThat(response.status()).isEqualTo(426);
        assertThat(new String(response.body())).isEqualTo(CONTRACT_UPGRADE_BODY);
        assertThat(ClientInfo.UNKNOWN.api()).isLessThan(ApiVersion.SDUI_CONTRACT_MIN);
    }

    private static FakeHttpRequest request(String id, ClientInfo client) {
        return new FakeHttpRequest("GET", "/ui/screen/" + id, Map.of("id", id), Map.of(), "",
                client, Map.of());
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
}
