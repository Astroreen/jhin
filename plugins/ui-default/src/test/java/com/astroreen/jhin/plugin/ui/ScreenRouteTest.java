/**
 * Screen route behaviour: the {@code {"id":…,"html":…}} contract of a known
 * screen (tailored to the caller's client capabilities) and the
 * {@code unknown_screen} failure code.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ScreenRouteTest {

    private static final ClientInfo NO_CAPS = new ClientInfo(4, "0.4.0", Set.of());
    private static final ClientInfo SSE_CAPS = new ClientInfo(4, "0.4.0", Set.of("sse"));

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private EventLog eventLog;
    private ScreenRoute route;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        eventLog = services.find(EventLog.class).orElseThrow();
        services.find(SessionStore.class).orElseThrow();
        UiNode screen = Ui.screen()
                .title("Fixture")
                .body(Ui.streamView("feed", "/ui/stream/session/none")
                        .mode("append").empty("quiet").build())
                .build();
        Map<String, Supplier<UiNode>> registry = new LinkedHashMap<>();
        registry.put("known", () -> screen);
        route = new ScreenRoute((account, overrides) -> registry, new CapabilityTailor(eventLog));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void knownScreenAnswersWithIdAndHtml() {
        HttpResponse response = route.handle(request("known", SSE_CAPS));

        assertThat(response.status()).isEqualTo(200);
        Map<String, Object> body = Json.readMap(new String(response.body()));
        assertThat(body).containsEntry("id", "known");
        assertThat(body).doesNotContainKey("node");
        String html = String.valueOf(body.get("html"));
        assertThat(html).startsWith("<").contains("data-jhin-type=\"screen\"")
                .contains("Fixture");
    }

    @Test
    void knownScreenIsTailoredToTheClient() {
        HttpResponse response = route.handle(request("known", NO_CAPS));

        Map<String, Object> body = Json.readMap(new String(response.body()));
        assertThat(jsonText(body)).doesNotContain("stream_view");
        assertThat(jsonText(body)).contains("list");
    }

    @Test
    void unknownScreenIs404NamedUnknownScreen() {
        HttpResponse response = route.handle(request("nope", NO_CAPS));

        assertThat(response.status()).isEqualTo(404);
        assertThat(new String(response.body())).contains("unknown_screen");
    }

    @Test
    void screenRouteThreadsTheHeaderOverridesToTheRegistry() {
        Map<String, String> seen = new LinkedHashMap<>();
        UiNode screen = Ui.screen()
                .title("Fixture")
                .body(Ui.text("hello").build())
                .build();
        ScreenRegistry recording = (account, overrides) -> {
            seen.putAll(overrides);
            return new LinkedHashMap<>(Map.of("known", (Supplier<UiNode>) () -> screen));
        };
        ScreenRoute custom = new ScreenRoute(recording, new CapabilityTailor(eventLog));
        FakeHttpRequest req = new FakeHttpRequest("GET", "/ui/screen/known",
                Map.of("id", "known"), Map.of(), "", NO_CAPS,
                Map.of(ClientKeybindings.HEADER,
                        "{\"rules\":[{\"command\":\"composer.send\","
                                + "\"keys\":\"mod+shift+enter\"}]}"));

        HttpResponse response = custom.handle(req);

        assertThat(response.status()).isEqualTo(200);
        assertThat(seen).containsExactlyEntriesOf(
                Map.of("composer.send", "mod+shift+enter"));
    }

    private static FakeHttpRequest request(String id, ClientInfo client) {
        return new FakeHttpRequest("GET", "/ui/screen/" + id, Map.of("id", id), Map.of(), "",
                client, Map.of());
    }

    private static String jsonText(Map<String, Object> body) {
        return Json.write(body);
    }
}
