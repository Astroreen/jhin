/**
 * The seven action handlers: the directive lists of the happy paths (enroll
 * answers {@code [setToken, navigate]}, create-session navigates to the fresh
 * chat, send posts the included {@code messageInput} to the run service,
 * cancel always answers with a toast), the error toasts of the failure paths
 * and the absent-plugin stand-ins.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ActionsTest {

    private static final ClientInfo NO_CAPS = new ClientInfo(1, "0.2.0", Set.of());
    private static final ClientInfo FULL_CAPS =
            new ClientInfo(1, "0.2.0", Set.of("secure_storage", "open_url", "multi_profile", "sse"));

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
    private FakeRunService runs;
    private FakeProviderRegistry providers;
    private Map<String, ActionRoute.ActionHandler> handlers;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        store = services.find(SessionStore.class).orElseThrow();
        runs = new FakeRunService();
        providers = new FakeProviderRegistry(List.of("mock"));
        services.publish(com.astroreen.jhin.plugin.security.api.EnrollmentService.class,
                new FakeEnrollmentService());
        services.publish(com.astroreen.jhin.plugin.agent.api.RunService.class, runs);
        services.publish(ProviderRegistry.class, providers);
        handlers = Actions.build(store, services, new Features(true, true, true, true));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void enrollAnswersSetTokenAndNavigate() {
        List<Map<String, Object>> ops = handlers.get("enroll").handle(
                request(), Map.of("code", "good-code", "deviceName", "qa-device"));

        assertThat(ops).extracting(op -> op.get("op"))
                .containsExactly("setToken", "navigate");
        assertThat(ops.get(0)).containsEntry("value", FakeEnrollmentService.TOKEN);
        assertThat(ops.get(1)).containsEntry("screen", "sessions");
    }

    @Test
    void enrollSetTokenIsDroppedWithoutSecureStorage() {
        ActionRoute route = new ActionRoute(handlers);

        var response = route.handle(new FakeHttpRequest("POST", "/ui/action/enroll",
                Map.of("name", "enroll"), Map.of(),
                "{\"payload\":{\"code\":\"good-code\",\"deviceName\":\"qa-device\"}}",
                NO_CAPS, Map.of()));
        Map<String, Object> body =
                com.astroreen.jhin.sdk.json.Json.readMap(new String(response.body()));

        List<Object> client = castList(body.get("client"));
        assertThat(client).hasSize(1);
        assertThat(castMap(client.get(0))).containsEntry("op", "navigate");
    }

    @Test
    void enrollFailureSurfacesTheSecurityMessage() {
        List<Map<String, Object>> ops = handlers.get("enroll").handle(request(),
                Map.of("code", FakeEnrollmentService.BAD_CODE, "deviceName", "qa-device"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "toast").containsEntry("style", "error");
        assertThat(String.valueOf(ops.get(0).get("text"))).contains("enrollment code expired");
    }

    @Test
    void enrollRequiresBothFields() {
        List<Map<String, Object>> ops = handlers.get("enroll").handle(request(), Map.of("code", "x"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "toast").containsEntry("style", "error");
    }

    @Test
    void createSessionNavigatesToTheFreshChatScreen() {
        List<Map<String, Object>> ops = handlers.get("create-session").handle(
                request(), Map.of("title", "demo", "workdir", "/tmp/work"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "navigate");
        String screen = String.valueOf(ops.get(0).get("screen"));
        assertThat(screen).startsWith("chat:");
        assertThat(store.get(screen.substring("chat:".length()))).isPresent();
    }

    @Test
    void createSessionRequiresTitleAndWorkdir() {
        List<Map<String, Object>> ops = handlers.get("create-session").handle(
                request(), Map.of("title", "demo"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("style", "error");
    }

    @Test
    void sendPostsTheIncludedMessageToTheRunService() {
        Session session = store.create("demo", "/tmp/work");
        store.patch(session.id(), new SessionStore.Patch(
                null, null, null, "provider-1", null));

        List<Map<String, Object>> ops = handlers.get("send").handle(request(),
                Map.of("sessionId", session.id(), "messageInput", "hello"));

        assertThat(ops).isEmpty();
        assertThat(runs.started()).hasSize(1);
        assertThat(runs.started().get(0).sessionId()).isEqualTo(session.id());
        assertThat(runs.started().get(0).text()).isEqualTo("hello");
    }

    @Test
    void sendWarnsWhenTheSessionHasNoProvider() {
        Session session = store.create("demo", "/tmp/work");

        List<Map<String, Object>> ops = handlers.get("send").handle(request(),
                Map.of("sessionId", session.id(), "messageInput", "hello"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "toast").containsEntry("style", "error");
        assertThat(String.valueOf(ops.get(0).get("text"))).contains("no provider configured");
        assertThat(runs.started()).hasSize(1);
    }

    @Test
    void sendRequiresSessionAndMessage() {
        List<Map<String, Object>> ops = handlers.get("send").handle(request(), Map.of());

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("style", "error");
    }

    @Test
    void cancelAlwaysAnswersWithOneToast() {
        List<Map<String, Object>> cancelled = handlers.get("cancel").handle(
                request(), Map.of("sessionId", "s-live"));

        assertThat(cancelled).hasSize(1);
        assertThat(cancelled.get(0)).containsEntry("op", "toast");
        assertThat(String.valueOf(cancelled.get(0).get("text"))).contains("Run cancelled");
        assertThat(runs.cancelled()).containsExactly("s-live");

        List<Map<String, Object>> idle = handlers.get("cancel").handle(
                request(), Map.of("sessionId", "idle-1"));
        assertThat(idle).hasSize(1);
        assertThat(String.valueOf(idle.get(0).get("text"))).contains("no active run");
    }

    @Test
    void createProviderRefreshesTheScreen() {
        List<Map<String, Object>> ops = handlers.get("create-provider").handle(request(),
                Map.of("format", "mock", "model", "echo"));

        assertThat(ops).extracting(op -> op.get("op")).containsExactly("toast", "refresh");
        assertThat(providers.list(ProviderRegistry.LOCAL_ACCOUNT)).hasSize(1);
    }

    @Test
    void createProviderRejectsAnUnknownFormat() {
        List<Map<String, Object>> ops = handlers.get("create-provider").handle(request(),
                Map.of("format", "nope", "model", "echo"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("style", "error");
    }

    @Test
    void deleteProviderRefreshesTheScreen() {
        providers.create("mock", new com.astroreen.jhin.plugin.llm.api.ProviderConfig(null, "echo", null));
        String id = providers.list(ProviderRegistry.LOCAL_ACCOUNT).get(0).id();

        List<Map<String, Object>> ops = handlers.get("delete-provider").handle(
                request(), Map.of("id", id));

        assertThat(ops).extracting(op -> op.get("op")).containsExactly("toast", "refresh");
        assertThat(providers.list(ProviderRegistry.LOCAL_ACCOUNT)).isEmpty();
    }

    @Test
    void reloadAsksForABootstrapReload() {
        List<Map<String, Object>> ops = handlers.get("reload").handle(request(), Map.of());

        assertThat(ops).extracting(op -> op.get("op"))
                .containsExactly("toast", "reloadBootstrap");
    }

    @Test
    void absentIntegrationsAnswerWithExplanatoryToasts() {
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        Map<String, ActionRoute.ActionHandler> degraded =
                Actions.build(store, services, new Features(false, false, false, false));

        assertThat(degraded.keySet()).containsExactlyInAnyOrder(
                "enroll", "create-session", "send", "cancel",
                "create-provider", "delete-provider", "reload");
        for (String name : List.of("enroll", "send", "cancel",
                "create-provider", "delete-provider")) {
            List<Map<String, Object>> ops = degraded.get(name).handle(request(), Map.of());
            assertThat(ops).as(name).hasSize(1);
            assertThat(ops.get(0)).as(name).containsEntry("op", "toast");
        }
    }

    private static HttpRequest request() {
        return new FakeHttpRequest("POST", "/ui/action/test",
                Map.of("name", "test"), Map.of(), "", FULL_CAPS, Map.of());
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
