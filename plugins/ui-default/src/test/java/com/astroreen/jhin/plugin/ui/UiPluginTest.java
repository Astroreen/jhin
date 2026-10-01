/**
 * Plugin wiring: the four routes land in the HTTP registry, the session
 * services resolve from the cross-plugin registry and the plugin starts and
 * degrades with every optional integration absent (the probe classes are not
 * on this classpath).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class UiPluginTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private FakePluginContext context;
    private UiPlugin plugin;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        services.find(SessionStore.class).orElseThrow();
        services.find(EventLog.class).orElseThrow();
        context = new FakePluginContext(tmp, "jhin.ui", db, streams, services);
        plugin = new UiPlugin();
        plugin.start(context);
    }

    @AfterEach
    void tearDown() {
        plugin.stop();
        context.runShutdownHooks();
        db.close();
    }

    @Test
    void registersTheFourRoutes() {
        List<RouteSpec> routes = context.routes();

        assertThat(routes).extracting(RouteSpec::method, RouteSpec::path)
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple("GET", "/_jhin/bootstrap"),
                        org.assertj.core.groups.Tuple.tuple("GET", "/ui/screen/{id}"),
                        org.assertj.core.groups.Tuple.tuple("POST", "/ui/action/{name}"),
                        org.assertj.core.groups.Tuple.tuple("GET", "/ui/stream/session/{id}"));
    }

    @Test
    void bootstrapDegradesWithEveryOptionalIntegrationAbsent() throws Exception {
        RouteSpec bootstrap = context.routes().stream()
                .filter(route -> route.path().equals("/_jhin/bootstrap"))
                .findFirst().orElseThrow();
        FakeHttpRequest req = new FakeHttpRequest("GET", "/_jhin/bootstrap", Map.of(), Map.of(), "");

        HttpResponse response = bootstrap.handler().handle(req);

        assertThat(response.status()).isEqualTo(200);
        String body = new String(response.body());
        Map<String, Object> payload = Json.readMap(body);
        assertThat(payload).containsEntry("entry", "sessions");
        assertThat(body).doesNotContain("providers");
    }

    @Test
    void actionDispatchIsWiredThroughTheRegistry() throws Exception {
        RouteSpec action = context.routes().stream()
                .filter(route -> route.path().equals("/ui/action/{name}"))
                .findFirst().orElseThrow();
        FakeHttpRequest req = new FakeHttpRequest("POST", "/ui/action/enroll",
                Map.of("name", "enroll"), Map.of(), "{\"payload\":{}}");

        HttpResponse response = action.handler().handle(req);

        assertThat(response.status()).isEqualTo(200);
        Map<String, Object> payload = Json.readMap(new String(response.body()));
        List<?> client = (List<?>) payload.get("client");
        assertThat(client).hasSize(1);
        assertThat(client.get(0).toString()).contains("toast");
    }
}
