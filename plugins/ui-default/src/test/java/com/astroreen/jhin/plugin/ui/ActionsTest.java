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
import com.astroreen.jhin.plugin.ui.screens.EnrollScreen;
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
    private FakePluginContext.FakeServices services;
    private Map<String, ActionRoute.ActionHandler> handlers;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        RecordingStreamRegistry streams = new RecordingStreamRegistry();
        services = new FakePluginContext.FakeServices();
        new com.astroreen.jhin.plugin.sessions.SessionsPlugin()
                .start(new FakePluginContext(tmp, "jhin.sessions", db, streams, services));
        store = services.find(SessionStore.class).orElseThrow();
        runs = new FakeRunService();
        providers = new FakeProviderRegistry(List.of("mock"));
        services.publish(com.astroreen.jhin.plugin.security.api.EnrollmentService.class,
                new FakeEnrollmentService());
        services.publish(com.astroreen.jhin.plugin.agent.api.RunService.class, runs);
        services.publish(ProviderRegistry.class, providers);
        handlers = Actions.build(store, services, new Features(true, true, true, true),
                UiSettings.open(tmp));
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
        assertThat(ops.get(0)).containsEntry("op", "patch")
                .containsEntry("id", EnrollScreen.ERROR_ID);
        Map<String, Object> props = castMap(ops.get(0).get("props"));
        assertThat(props).containsEntry("visible", true);
        assertThat(String.valueOf(props.get("content"))).contains("enrollment code expired");
    }

    @Test
    void enrollRequiresBothFields() {
        List<Map<String, Object>> ops = handlers.get("enroll").handle(request(), Map.of("code", "x"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "patch")
                .containsEntry("id", EnrollScreen.ERROR_ID);
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
    void createSessionReturnsTheNewIdInTheActionResponse() {
        List<Map<String, Object>> ops = handlers.get("create-session").handle(
                request(), Map.of("title", "demo", "workdir", "/tmp/work"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "navigate");
        String screen = String.valueOf(ops.get(0).get("screen"));
        assertThat(screen).startsWith("chat:");
        String id = screen.substring("chat:".length());
        assertThat(store.list()).extracting(Session::id).containsExactly(id);
    }

    @Test
    void createSessionCarriesTheDraftModelToTheNewSession() {
        List<Map<String, Object>> ops = handlers.get("create-session").handle(
                request(), Map.of("title", "demo", "workdir", "/tmp/work", "model", "echo-1"));

        String screen = String.valueOf(ops.get(0).get("screen"));
        Session created = store.get(screen.substring("chat:".length())).orElseThrow();
        assertThat(created.workdir()).isEqualTo("/tmp/work");
        assertThat(created.model()).isEqualTo("echo-1");
    }

    @Test
    void sendEnqueuesTheRunAndAnswersWithoutWaitingForIt() {
        Session session = store.create("demo", "/tmp/work");
        store.patch(session.id(), new SessionStore.Patch(
                null, null, null, "provider-1", null));

        List<Map<String, Object>> ops = handlers.get("send").handle(request(),
                Map.of("sessionId", session.id(), "messageInput", "hello"));

        assertThat(ops).isEmpty();
        assertThat(runs.started()).hasSize(1);
        assertThat(runs.finished()).isEmpty();
        runs.finish("run-1");
        assertThat(runs.finished()).containsExactly("run-1");
    }

    @Test
    void unknownActionIsA404AndMalformedBodyIsA400() {
        ActionRoute route = new ActionRoute(handlers);

        var missing = route.handle(new FakeHttpRequest("POST", "/ui/action/nope",
                Map.of("name", "nope"), Map.of(), "", FULL_CAPS, Map.of()));
        assertThat(missing.status()).isEqualTo(404);
        Map<String, Object> body =
                com.astroreen.jhin.sdk.json.Json.readMap(new String(missing.body()));
        assertThat(body).containsEntry("error", "unknown_action");

        var malformed = route.handle(new FakeHttpRequest("POST", "/ui/action/create-session",
                Map.of("name", "create-session"), Map.of(), "not json", FULL_CAPS, Map.of()));
        assertThat(malformed.status()).isEqualTo(400);
        Map<String, Object> bad =
                com.astroreen.jhin.sdk.json.Json.readMap(new String(malformed.body()));
        assertThat(bad).containsEntry("error", "invalid_request");
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
    void undoRestoresTheLastLifecycleChangeAndAnswersToastAndRefresh() {
        Session session = store.create("demo", "/tmp/work");
        services.find(com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService.class)
                .orElseThrow()
                .settle(session.id(), com.astroreen.jhin.plugin.sessions.api.SettleReason.MANUAL);

        List<Map<String, Object>> ops = handlers.get("undo").handle(request(), Map.of());

        assertThat(ops).extracting(op -> op.get("op")).containsExactly("toast", "refresh");
        assertThat(ops.get(0)).containsEntry("text", "Undone");
        assertThat(store.get(session.id()).orElseThrow().settledAt()).isNull();
    }

    // --- T98: the undo notices and the auto-settle action ---

    private com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService lifecycle() {
        return services.find(
                com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService.class)
                .orElseThrow();
    }

    @Test
    void unpinAnswersTheUpstreamUndoNotice() {
        Session session = store.create("demo", "/tmp/work");
        lifecycle().pin(session.id(), null);

        List<Map<String, Object>> ops = handlers.get("unpin")
                .handle(request(), Map.of("id", session.id()));

        assertThat(ops).extracting(op -> op.get("op")).containsExactly("toast", "refresh");
        assertThat(ops.get(0)).containsEntry("op", "toast")
                .containsEntry("text", "Unpinned 1 thread,")
                .containsEntry("duration", 5_000L);
        assertThat(castMap(ops.get(0).get("action"))).containsEntry("name", "undo")
                .containsEntry("path", "/ui/action/undo");
        // The undo inside the window restores the pin.
        assertThat(handlers.get("undo").handle(request(), Map.of())).hasSize(2);
        assertThat(store.get(session.id()).orElseThrow().pinned()).isTrue();
    }

    @Test
    void settleSnoozeAndArchiveAnswerTheirUpstreamNotices() {
        Session session = store.create("demo", "/tmp/work");

        assertThat(handlers.get("settle").handle(request(), Map.of("id", session.id()))
                .get(0)).containsEntry("text", "Settled 1 thread,");
        lifecycle().unsettle(session.id());
        assertThat(handlers.get("snooze")
                .handle(request(), Map.of("id", session.id(), "durationMs", 60_000L))
                .get(0)).containsEntry("text", "Snoozed 1 thread,");
        lifecycle().wake(session.id());
        assertThat(handlers.get("archive").handle(request(), Map.of("id", session.id()))
                .get(0)).containsEntry("text", "Archived 1 thread,");
    }

    @Test
    void pinAnswersRefreshWithoutANotice() {
        Session session = store.create("demo", "/tmp/work");

        List<Map<String, Object>> ops = handlers.get("pin")
                .handle(request(), Map.of("id", session.id()));

        // Upstream parity: pinning shows no undo notice
        // (useThreadActions.ts has no showThreadUndoNotice call in pinThread).
        assertThat(ops).extracting(op -> op.get("op")).containsExactly("refresh");
    }

    @Test
    void autoSettleWritesTheFlagAndAnswersRefresh() {
        Session session = store.create("demo", "/tmp/work");
        assertThat(store.get(session.id()).orElseThrow().autoSettle()).isTrue();

        List<Map<String, Object>> ops = handlers.get("auto-settle")
                .handle(request(), Map.of("id", session.id(), "enabled", false));

        assertThat(ops).extracting(op -> op.get("op")).containsExactly("refresh");
        assertThat(store.get(session.id()).orElseThrow().autoSettle()).isFalse();
    }

    @Test
    void autoSettleRequiresTheEnabledBoolean() {
        Session session = store.create("demo", "/tmp/work");

        List<Map<String, Object>> ops = handlers.get("auto-settle")
                .handle(request(), Map.of("id", session.id()));

        assertThat(ops.get(0)).containsEntry("op", "toast")
                .containsEntry("style", "error");
    }

    @Test
    void demoSnoozeAnswersDismissDialogAndThePreviewToast() {
        List<Map<String, Object>> ops = handlers.get("demo-snooze")
                .handle(request(), Map.of());

        assertThat(ops).extracting(op -> op.get("op"))
                .containsExactly("dismissDialog", "toast");
        assertThat(ops.get(1)).containsEntry("text",
                "Custom snooze is a preview in this build.");
    }

    @Test
    void undoWithoutAnEntryAnswersNothingToUndo() {
        List<Map<String, Object>> ops = handlers.get("undo").handle(request(), Map.of());

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "toast")
                .containsEntry("text", "Nothing to undo")
                .containsEntry("style", "error");
    }

    @Test
    void undoConsumesTheEntrySoASecondUndoFindsNothing() {
        Session session = store.create("demo", "/tmp/work");
        services.find(com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService.class)
                .orElseThrow()
                .settle(session.id(), com.astroreen.jhin.plugin.sessions.api.SettleReason.MANUAL);

        assertThat(handlers.get("undo").handle(request(), Map.of()))
                .extracting(op -> op.get("op"))
                .containsExactly("toast", "refresh");
        List<Map<String, Object>> second = handlers.get("undo").handle(request(), Map.of());
        assertThat(second).hasSize(1);
        assertThat(second.get(0)).containsEntry("text", "Nothing to undo");
    }

    @Test
    void undoActionResponseIsTheClientDirectiveArray() {
        Session session = store.create("demo", "/tmp/work");
        services.find(com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService.class)
                .orElseThrow()
                .settle(session.id(), com.astroreen.jhin.plugin.sessions.api.SettleReason.MANUAL);
        ActionRoute route = new ActionRoute(handlers);

        var response = route.handle(new FakeHttpRequest("POST", "/ui/action/undo",
                Map.of("name", "undo"), Map.of(), "{\"action\":\"undo\",\"payload\":{}}",
                FULL_CAPS, Map.of()));
        Map<String, Object> body =
                com.astroreen.jhin.sdk.json.Json.readMap(new String(response.body()));

        assertThat(response.status()).isEqualTo(200);
        List<Object> client = castList(body.get("client"));
        assertThat(client).hasSize(2);
        assertThat(castMap(client.get(0)))
                .containsEntry("op", "toast").containsEntry("text", "Undone");
        assertThat(castMap(client.get(1))).containsEntry("op", "refresh");

        var nothing = route.handle(new FakeHttpRequest("POST", "/ui/action/undo",
                Map.of("name", "undo"), Map.of(), "{\"action\":\"undo\",\"payload\":{}}",
                FULL_CAPS, Map.of()));
        Map<String, Object> emptyBody =
                com.astroreen.jhin.sdk.json.Json.readMap(new String(nothing.body()));
        assertThat(nothing.status()).isEqualTo(200);
        List<Object> emptyClient = castList(emptyBody.get("client"));
        assertThat(emptyClient).hasSize(1);
        assertThat(castMap(emptyClient.get(0)))
                .containsEntry("op", "toast")
                .containsEntry("text", "Nothing to undo")
                .containsEntry("style", "error");
    }

    @Test
    void undoTargetsOneSessionThroughTheSessionIdPayload() {
        Session first = store.create("first", "/tmp/first");
        Session second = store.create("second", "/tmp/second");
        var lifecycle = services
                .find(com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService.class)
                .orElseThrow();
        lifecycle.pin(first.id(), 1);
        lifecycle.pin(second.id(), 2);

        List<Map<String, Object>> ops = handlers.get("undo").handle(
                request(), Map.of("sessionId", first.id()));

        assertThat(ops).extracting(op -> op.get("op")).containsExactly("toast", "refresh");
        assertThat(store.get(first.id()).orElseThrow().pinned()).isFalse();
        assertThat(store.get(second.id()).orElseThrow().pinned()).isTrue();
    }

    @Test
    void absentIntegrationsAnswerWithExplanatoryToasts() {
        FakePluginContext.FakeServices services = new FakePluginContext.FakeServices();
        Map<String, ActionRoute.ActionHandler> degraded =
                Actions.build(store, services, new Features(false, false, false, false),
                        UiSettings.open(tmp));

        assertThat(degraded.keySet()).containsExactlyInAnyOrder(
                "enroll", "create-session", "send", "cancel",
                "create-provider", "delete-provider", "reload", "undo",
                "keybind-edit", "keybind-save", "keybind-reset", "keybind-restore",
                "save-appearance", "save-thread-behavior",
                "pin", "unpin", "settle", "unsettle", "snooze", "wake",
                "archive", "restore", "regenerate-title", "reorder",
                "auto-settle", "delete-session", "arrange-toggle", "demo-snooze",
                "preview-reload");
        for (String name : List.of("enroll", "send", "cancel",
                "create-provider", "delete-provider", "undo",
                "pin", "unpin", "settle", "unsettle", "snooze", "wake",
                "archive", "restore", "regenerate-title", "reorder",
                "auto-settle")) {
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
