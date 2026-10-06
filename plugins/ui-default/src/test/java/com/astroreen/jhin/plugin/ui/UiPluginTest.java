/**
 * Plugin wiring: the four routes land in the HTTP registry, the session
 * services resolve from the cross-plugin registry and the plugin degrades
 * with every optional integration absent (the probe predicate stands in for
 * the class-name probe so both worlds run deterministically).
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
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class UiPluginTest {

    /** Probe resolving nothing: the runtime without any optional plugin. */
    private static final Predicate<String> NONE = name -> false;

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private FakePluginContext context;
    private UiPlugin plugin;

    @AfterEach
    void tearDown() {
        if (plugin != null) {
            plugin.stop();
        }
        if (context != null) {
            context.runShutdownHooks();
        }
        if (db != null) {
            db.close();
        }
    }

    @Test
    void registersTheRoutes() {
        start(NONE);

        List<RouteSpec> routes = context.routes();

        assertThat(routes).extracting(RouteSpec::method, RouteSpec::path)
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple("GET", "/_jhin/bootstrap"),
                        org.assertj.core.groups.Tuple.tuple("GET", "/ui/screen/{id}"),
                        org.assertj.core.groups.Tuple.tuple("POST", "/ui/action/search"),
                        org.assertj.core.groups.Tuple.tuple("POST", "/ui/action/{name}"),
                        org.assertj.core.groups.Tuple.tuple("GET", "/ui/stream/session/{id}"),
                        org.assertj.core.groups.Tuple.tuple("GET", "/ui/stream/sessions-overview"));
    }

    @Test
    void bootstrapDegradesWithEveryOptionalIntegrationAbsent() throws Exception {
        start(NONE);

        Map<String, Object> payload = Json.readMap(new String(bootstrap().body()));

        assertThat(payload).containsEntry("entry", "sessions");
        assertThat(screenIds(payload)).doesNotContain("pair", "providers");
    }

    @Test
    void bootstrapEntryIsPairWhenSecurityIsPresent() throws Exception {
        start(name -> name.endsWith("api.EnrollmentService"));

        Map<String, Object> payload = Json.readMap(new String(bootstrap().body()));

        assertThat(payload).containsEntry("entry", "pair");
        assertThat(screenIds(payload)).contains("pair", "connect");
    }

    @Test
    void actionDispatchIsWiredThroughTheRegistry() throws Exception {
        start(NONE);
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

    /** Starts the sessions and the UI plugin against one shared harness. */
    private void start(Predicate<String> probe) {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        services.find(SessionStore.class).orElseThrow();
        services.find(EventLog.class).orElseThrow();
        context = new FakePluginContext(tmp, "jhin.ui", db, streams, services);
        plugin = new UiPlugin(probe);
        plugin.start(context);
    }

    private HttpResponse bootstrap() throws Exception {
        RouteSpec bootstrap = context.routes().stream()
                .filter(route -> route.path().equals("/_jhin/bootstrap"))
                .findFirst().orElseThrow();
        FakeHttpRequest req = new FakeHttpRequest("GET", "/_jhin/bootstrap", Map.of(), Map.of(), "");
        HttpResponse response = bootstrap.handler().handle(req);
        assertThat(response.status()).isEqualTo(200);
        return response;
    }

    /** The screen ids of one bootstrap payload, in registration order. */
    @SuppressWarnings("unchecked")
    private static List<String> screenIds(Map<String, Object> payload) {
        return ((List<Map<String, Object>>) payload.get("screens")).stream()
                .map(screen -> String.valueOf(screen.get("id")))
                .toList();
    }
}
