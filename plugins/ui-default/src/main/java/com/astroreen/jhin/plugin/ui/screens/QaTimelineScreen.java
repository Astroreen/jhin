/**
 * The QA timeline probe screen (T101): one row of each of the 14 timeline
 * row kinds, each carrying a fixed {@code rowKind} the QA scripts assert on,
 * plus the continuation pairs (two adjacent {@code work:log} rows and an
 * assistant message followed by its {@code assistant-meta} row) that prove
 * the no-gap grouping over the wire. Since T102 it also renders one event
 * card of each of the 16 event kinds (the {@code event:<kind>} rows built
 * through {@link MessageCardBuilder#dispatchEventRow}), so the event-card
 * contract is provable over the wire from the same fixture. It exists so
 * the row-kind contract is provable without an agent run: the same builders
 * the chat screen and the live frames use render the fixture. Not a product
 * surface — it resolves only while the {@code jhin.ui} config key {@code
 * qaProbe} is set (the switch the {@code qa-level3} probe shares) and no
 * screen links here.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class QaTimelineScreen {

    /** The {@code fixtures/subagent-fixtures.json} scenarios (the subagent bars). */
    public static final String SUBAGENT_FIXTURE = "fixtures/subagent-fixtures.json";

    private QaTimelineScreen() {
    }

    /** The probe tree: {@code screen} → the 14 rows + the 16 event cards. */
    public static UiNode render() {
        return Ui.screen()
                .title("QA timeline probe")
                .body(Ui.column()
                        .id("qa-timeline")
                        .children(new ArrayList<>(MessageCardBuilder.applyContinuation(rows())))
                        .build())
                .build();
    }

    /** One row of each of the 14 kinds, then one event card of each kind. */
    private static List<UiNode> rows() {
        List<UiNode> all = new ArrayList<>(List.of(
                MessageCardBuilder.userMessageRow("Fix the login bug", 1),
                MessageCardBuilder.assistantMessageRow(2, "On it — reading the auth flow."),
                MessageCardBuilder.assistantMetaRow(3, List.of("sonnet-4", "high effort")),
                MessageCardBuilder.eventRow(16, "compaction", "Context compacted",
                        "12k → 4k tokens", "muted"),
                MessageCardBuilder.workRow(4, "read src/auth.java",
                        List.of(MessageCardBuilder.toolArgumentsNode("{\"path\":\"src/auth.java\"}", 4))),
                // The continuation pair: a second work row directly after the
                // first — the two close with no gap.
                MessageCardBuilder.workRow(5, "write src/auth.java result",
                        List.of(MessageCardBuilder.toolResultNode("patched", false, 5))),
                MessageCardBuilder.workLiveRow(6, "Running tests"),
                MessageCardBuilder.workToggleRow(7, "Read 4 files", 4),
                MessageCardBuilder.thinkingRow(8, "The token expiry needs a clock injection."),
                MessageCardBuilder.proposedPlanRow(9, "1. Inject the clock\n2. Fix the expiry check"),
                MessageCardBuilder.workingRow(10),
                MessageCardBuilder.worktreeSetupRow(11, "running", "Creating the worktree"),
                MessageCardBuilder.turnFoldRow(12, "1 earlier turn"),
                MessageCardBuilder.attemptFoldRow(13, "Superseded attempt"),
                MessageCardBuilder.contextCompactionRow(14, "Context compacted", false),
                MessageCardBuilder.unknownRow(15, "holo")));
        all.addAll(eventRows());
        return all;
    }

    /**
     * One event card of each of the 16 kinds (T102), in the plan section 4.5
     * order, each through {@link MessageCardBuilder#dispatchEventRow} with a
     * representative payload — except the {@code subagent} bar, which renders
     * one row per {@link #SUBAGENT_FIXTURE} scenario so the bar contract is
     * fixture-driven.
     */
    private static List<UiNode> eventRows() {
        long seq = 20;
        List<UiNode> rows = new ArrayList<>();
        rows.add(MessageCardBuilder.dispatchEventRow("diff", diffPayload(), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("file-write", Map.of(
                "files", List.of(
                        Map.of("path", "src/auth.java", "additions", 12, "deletions", 3, "status", "M"),
                        Map.of("path", "src/login.java", "additions", 4, "deletions", 0, "status", "A"))),
                seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("shell", Map.of(
                "command", "gradle test --tests auth",
                "output", "BUILD SUCCESSFUL",
                "status", "success", "time", "14:03"), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("message",
                Map.of("text", "Reading the auth flow next."), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("tool-call", Map.of(
                "name", "read", "status", "running",
                "summary", "{\"path\":\"src/auth.java\"}", "time", "14:03"), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("tool-result", Map.of(
                "name", "read", "status", "success",
                "summary", "{\"path\":\"src/auth.java\"}",
                "output", "public class Auth {", "language", "java",
                "time", "14:03"), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("approval-request", Map.of(
                "title", "Command approval", "detail", "gradle test",
                "options", List.of("Allow", "Deny")), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("limit-notice",
                Map.of("resetAt", "2026-10-06 15:00"), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("error",
                Map.of("message", "boom"), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("system-notice",
                Map.of("text", "The provider catalog refreshed."), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("queued-message",
                Map.of("text", "Also run the integration suite."), seq++));
        // The subagent bar comes from the fixture: one row per scenario
        // (the bar with nested steps, the bar alone, the malformed
        // fallback to the unknown card).
        for (Map<String, Object> payload : subagentPayloads()) {
            rows.add(MessageCardBuilder.dispatchEventRow("subagent", payload, seq++));
        }
        rows.add(MessageCardBuilder.dispatchEventRow("citation",
                Map.of("label", "src/auth.java:42"), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("skill-invocation",
                Map.of("name", "jhin-plugin"), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("work-log-entry", Map.of(
                "label", "read 4 files", "time", "14:02"), seq++));
        rows.add(MessageCardBuilder.dispatchEventRow("question", Map.of(
                "question", "Which auth flow?", "answers", List.of("The token one")), seq++));
        // The unknown fallback: an unrecognized event type renders the
        // placeholder card.
        rows.add(MessageCardBuilder.dispatchEventRow("holo", Map.of(), seq++));
        return rows;
    }

    /**
     * The {@code payload} maps of the {@link #SUBAGENT_FIXTURE} scenarios.
     * Loaded from the classpath at build time, never fetched.
     */
    private static List<Map<String, Object>> subagentPayloads() {
        Object scenarios = RightPanelBuilder.loadFixture(SUBAGENT_FIXTURE).get("scenarios");
        List<Map<String, Object>> payloads = new ArrayList<>();
        if (scenarios instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> scenario
                        && scenario.get("payload") instanceof Map<?, ?> payload) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> typed = (Map<String, Object>) payload;
                    payloads.add(typed);
                }
            }
        }
        return payloads;
    }

    /** The representative {@code diff} payload of the probe (3 hunks). */
    private static Map<String, Object> diffPayload() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("file", "src/auth.java");
        payload.put("language", "java");
        payload.put("additions", 12);
        payload.put("deletions", 3);
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("kind", "add");
        line.put("newNo", 42);
        line.put("text", "if (clock.now().isAfter(expiry)) {");
        Map<String, Object> hunk = new LinkedHashMap<>();
        hunk.put("header", "@@ -40,7 +40,8 @@");
        hunk.put("lines", List.of(line));
        payload.put("hunks", List.of(hunk));
        return payload;
    }
}
