/**
 * The thread-row lifecycle actions of {@link SessionActions}: the settle
 * reason dispatch, the snooze deadline resolution, the undo-notice answer of
 * every mutation, the settle clearing contract and the invalid-transition
 * error toast, all against a real {@code jhin.sessions} lifecycle service.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionActionsTest {

    private static final ClientInfo FULL_CAPS =
            new ClientInfo(1, "0.2.0", Set.of("secure_storage", "open_url", "multi_profile", "sse"));

    private static final DateTimeFormatter SNOOZE_UNTIL =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private SessionStore store;
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
        handlers = Actions.build(store, services, new Features(true, true, true, true, true),
                UiSettings.open(tmp));
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    // --- settle: the reason dispatch ---

    @Test
    void settleDispatchesEachWireReason() {
        for (String wire : List.of("manual", "inactive", "closed", "pr_merged", "other")) {
            Session session = store.create("demo-" + wire, "/tmp/work");

            List<Map<String, Object>> ops = handlers.get("settle")
                    .handle(request(), Map.of("id", session.id(), "reason", wire));

            assertUndoNotice(ops, "Settled", 1);
            assertThat(store.get(session.id()).orElseThrow().settledReason()).isEqualTo(wire);
        }
    }

    @Test
    void settleWithoutReasonDefaultsToManual() {
        Session session = store.create("demo", "/tmp/work");

        List<Map<String, Object>> ops = handlers.get("settle")
                .handle(request(), Map.of("id", session.id()));

        assertUndoNotice(ops, "Settled", 1);
        assertThat(store.get(session.id()).orElseThrow().settledReason()).isEqualTo("manual");
    }

    @Test
    void settleWithAnUnknownReasonAnswersAnErrorToastAndSettlesNothing() {
        Session session = store.create("demo", "/tmp/work");

        List<Map<String, Object>> ops = handlers.get("settle")
                .handle(request(), Map.of("id", session.id(), "reason", "banana"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "toast")
                .containsEntry("style", "error")
                .containsEntry("text", "Unknown settle reason.");
        assertThat(store.get(session.id()).orElseThrow().settledAt()).isNull();
    }

    // --- snooze: the deadline resolution ---

    @Test
    void snoozeDurationMsResolvesToNowPlusTheDuration() {
        Session session = store.create("demo", "/tmp/work");
        long before = System.currentTimeMillis();

        List<Map<String, Object>> ops = handlers.get("snooze").handle(request(),
                Map.of("id", session.id(), "durationMs", 60_000L));

        long after = System.currentTimeMillis();
        assertUndoNotice(ops, "Snoozed", 1);
        Long until = store.get(session.id()).orElseThrow().snoozedUntil();
        assertThat(until).isNotNull()
                .isGreaterThanOrEqualTo(before + 60_000L)
                .isLessThanOrEqualTo(after + 60_000L);
    }

    @Test
    void snoozeUntilEpochResolvesExactly() {
        Session session = store.create("demo", "/tmp/work");
        long target = System.currentTimeMillis() + 3_600_000L;

        List<Map<String, Object>> ops = handlers.get("snooze")
                .handle(request(), Map.of("id", session.id(), "until", target));

        assertUndoNotice(ops, "Snoozed", 1);
        assertThat(store.get(session.id()).orElseThrow().snoozedUntil()).isEqualTo(target);

        Session numericString = store.create("numeric-string", "/tmp/work");
        handlers.get("snooze").handle(request(),
                Map.of("id", numericString.id(), "until", String.valueOf(target)));
        assertThat(store.get(numericString.id()).orElseThrow().snoozedUntil()).isEqualTo(target);
    }

    @Test
    void snoozeUntilDatetimeStringIsParsedInTheHostZone() {
        Session session = store.create("demo", "/tmp/work");
        LocalDateTime future = LocalDateTime.now().plusDays(2).truncatedTo(ChronoUnit.SECONDS);
        long expected = future.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();

        List<Map<String, Object>> ops = handlers.get("snooze").handle(request(),
                Map.of("id", session.id(), "until", future.format(SNOOZE_UNTIL)));

        assertUndoNotice(ops, "Snoozed", 1);
        assertThat(store.get(session.id()).orElseThrow().snoozedUntil()).isEqualTo(expected);
    }

    @Test
    void snoozePastUntilAnswersAnErrorToastWithoutMutating() {
        Session session = store.create("demo", "/tmp/work");

        List<Map<String, Object>> ops = handlers.get("snooze").handle(request(),
                Map.of("id", session.id(), "until", System.currentTimeMillis() - 60_000L));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "toast")
                .containsEntry("style", "error")
                .containsEntry("text", "Choose a valid date and time in the future.");
        assertThat(store.get(session.id()).orElseThrow().snoozedUntil()).isNull();
    }

    @Test
    void snoozeInvalidUntilAnswersAnErrorToast() {
        Session session = store.create("demo", "/tmp/work");

        List<Map<String, Object>> ops = handlers.get("snooze")
                .handle(request(), Map.of("id", session.id(), "until", "garbage"));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "toast")
                .containsEntry("style", "error")
                .containsEntry("text", "Choose a valid date and time in the future.");
        assertThat(store.get(session.id()).orElseThrow().snoozedUntil()).isNull();
    }

    @Test
    void snoozeWithoutAChoiceAnswersTheDurationSheet() {
        Session session = store.create("demo", "/tmp/work");

        List<Map<String, Object>> ops = handlers.get("snooze")
                .handle(request(), Map.of("id", session.id()));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "dialog").containsEntry("kind", "sheet");
        assertThat(String.valueOf(ops.get(0).get("html"))).contains("Snooze thread");
        assertThat(store.get(session.id()).orElseThrow().snoozedUntil()).isNull();
    }

    // --- every lifecycle mutation answers its undo notice ---

    @Test
    void everyLifecycleMutationAnswersTheUndoNoticeAndRefresh() {
        Session pinned = store.create("pinned", "/tmp/work");
        assertUndoNotice(dispatch("pin", Map.of("id", pinned.id())), "Pinned", 1);
        assertUndoNotice(dispatch("unpin", Map.of("id", pinned.id())), "Unpinned", 1);

        Session settled = store.create("settled", "/tmp/work");
        assertUndoNotice(dispatch("settle", Map.of("id", settled.id())), "Settled", 1);
        assertUndoNotice(dispatch("unsettle", Map.of("id", settled.id())), "Reopened", 1);

        Session snoozed = store.create("snoozed", "/tmp/work");
        assertUndoNotice(dispatch("snooze",
                Map.of("id", snoozed.id(), "durationMs", 60_000L)), "Snoozed", 1);
        assertUndoNotice(dispatch("wake", Map.of("id", snoozed.id())), "Woken", 1);

        Session archived = store.create("archived", "/tmp/work");
        assertUndoNotice(dispatch("archive", Map.of("id", archived.id())), "Archived", 1);
        assertUndoNotice(dispatch("restore", Map.of("id", archived.id())), "Restored", 1);

        Session flagged = store.create("flagged", "/tmp/work");
        assertUndoNotice(dispatch("auto-settle",
                Map.of("id", flagged.id(), "enabled", false)), "Updated", 1);

        Session first = store.create("first", "/tmp/first");
        Session second = store.create("second", "/tmp/second");
        assertUndoNotice(dispatch("reorder",
                Map.of("ids", List.of(first.id(), second.id()))), "Reordered", 2);
    }

    // --- the settle clearing contract ---

    @Test
    void settleClearsThePinAndTheSnooze() {
        Session session = store.create("demo", "/tmp/work");
        lifecycle().pin(session.id(), 1);
        lifecycle().snooze(session.id(), System.currentTimeMillis() + 3_600_000L);

        List<Map<String, Object>> ops = handlers.get("settle")
                .handle(request(), Map.of("id", session.id()));

        assertUndoNotice(ops, "Settled", 1);
        Session after = store.get(session.id()).orElseThrow();
        assertThat(after.pinned()).isFalse();
        assertThat(after.pinnedOrder()).isNull();
        assertThat(after.snoozedUntil()).isNull();
        assertThat(after.settledReason()).isEqualTo("manual");
    }

    // --- invalid transitions ---

    @Test
    void settlingASettledSessionAnswersAnErrorToast() {
        Session session = store.create("demo", "/tmp/work");
        lifecycle().settle(session.id(),
                com.astroreen.jhin.plugin.sessions.api.SettleReason.MANUAL);

        List<Map<String, Object>> ops = handlers.get("settle")
                .handle(request(), Map.of("id", session.id()));

        assertThat(ops).hasSize(1);
        assertThat(ops.get(0)).containsEntry("op", "toast")
                .containsEntry("style", "error");
        assertThat(String.valueOf(ops.get(0).get("text"))).contains("already settled");
    }

    private SessionLifecycleService lifecycle() {
        return services.find(SessionLifecycleService.class).orElseThrow();
    }

    private List<Map<String, Object>> dispatch(String action, Map<String, Object> payload) {
        return handlers.get(action).handle(request(), payload);
    }

    /** Asserts the undo-notice answer: the toast, its {@code undo} action and the refresh. */
    private static void assertUndoNotice(List<Map<String, Object>> ops, String verb, int threads) {
        assertThat(ops).extracting(op -> op.get("op")).containsExactly("toast", "refresh");
        assertThat(ops.get(0)).containsEntry("op", "toast")
                .containsEntry("text",
                        verb + " " + threads + (threads == 1 ? " thread," : " threads,"))
                .containsEntry("duration", 5_000L);
        assertThat(castMap(ops.get(0).get("action"))).containsEntry("name", "undo")
                .containsEntry("path", "/ui/action/undo");
    }

    private static HttpRequest request() {
        return new FakeHttpRequest("POST", "/ui/action/test",
                Map.of("name", "test"), Map.of(), "", FULL_CAPS, Map.of());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
