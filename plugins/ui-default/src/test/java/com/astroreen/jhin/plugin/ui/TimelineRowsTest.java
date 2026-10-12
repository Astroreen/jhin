/**
 * The T101 row kinds: every one of the 14 {@code MessageCardBuilder} kinds
 * renders its distinct token-driven anatomy with the {@code rowKind} and
 * {@code rowKey} props, the alignment contract (the user bubble and the
 * centered folds against everything else), the continuation gap table and
 * the unknown-kind fallback. The {@code qa-timeline} probe renders the same
 * fixture so the QA scripts can assert the kinds over the wire.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.ui.screens.MessageCardBuilder;
import com.astroreen.jhin.plugin.ui.screens.QaTimelineScreen;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.json.Json;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TimelineRowsTest {

    @Test
    void theRowKindVocabularyHasTheFourteenKinds() {
        assertThat(MessageCardBuilder.ROW_KINDS).containsExactlyInAnyOrder(
                "message", "assistant-meta", "event", "work", "work-live",
                "work-toggle", "thinking", "proposed-plan", "working",
                "worktree-setup", "turn-fold", "attempt-fold",
                "context-compaction", "unknown");
        assertThat(MessageCardBuilder.isRowKind("work")).isTrue();
        assertThat(MessageCardBuilder.isRowKind("holo")).isFalse();
        assertThat(MessageCardBuilder.isRowKind(null)).isFalse();
    }

    @Test
    void userMessageRowIsTheRightAlignedMessageSurfaceBubble() {
        UiNode row = MessageCardBuilder.userMessageRow("Fix the bug", 2);
        Map<String, Object> json = row.toJson();

        assertThat(json).containsEntry("rowKind", "message")
                .containsEntry("rowKey", "message:user")
                .containsEntry("align", "centerRight");
        String wire = Json.write(json);
        assertThat(wire)
                .contains("$color.message")
                .contains("$color.message-foreground")
                .contains("$radius.xl2")
                .contains("Fix the bug");
        // The hover-action stubs: Copy / Edit / Retry, demo-marked, inline
        // setState only.
        assertThat(wire).contains("Copy").contains("Edit").contains("Retry");
        assertThat(wire).contains("\"demo\":true");
        assertThat(wire).contains("\"op\":\"setState\"");
    }

    @Test
    void assistantMessageRowIsTheBorderedCardAroundTheMarkdownTarget() {
        UiNode row = MessageCardBuilder.assistantMessageRow(3, "Let me look.");
        Map<String, Object> json = row.toJson();

        assertThat(json).containsEntry("rowKind", "message")
                .containsEntry("rowKey", "message:assistant")
                .containsEntry("align", "centerLeft");
        String wire = Json.write(json);
        assertThat(wire)
                .contains("$color.border")
                .contains("$radius.xl2")
                .contains("\"id\":\"msg-3\"")
                .contains("Let me look.");
    }

    @Test
    void assistantMetaRowCarriesTheLabelsAndTheCopyForkStubs() {
        UiNode row = MessageCardBuilder.assistantMetaRow(4, List.of("sonnet-4", "high effort"));
        String wire = Json.write(row.toJson());

        assertThat(row.props()).containsEntry("rowKind", "assistant-meta")
                .containsEntry("rowKey", "assistant-meta:assistant");
        assertThat(wire).contains("sonnet-4").contains("high effort")
                .contains("Copy").contains("Fork").contains("\"demo\":true");
    }

    @Test
    void contextChipCarriesModelProviderAndTheWorkdirPathChip() {
        UiNode row = MessageCardBuilder.assistantMetaRow(5, List.of("sonnet-4"),
                "sonnet-4", "anthropic", "/home/astroreen/Documents/jhin/plugins");
        String wire = Json.write(row.toJson());

        assertThat(wire).contains("\"id\":\"ev-5-context\"")
                .contains("\"label\":\"sonnet-4\"")
                .contains("\"label\":\"anthropic\"")
                .contains("\"kind\":\"file\"")
                .contains("/home/astroreen/Documents/jhin/plugins");
    }

    @Test
    void contextChipRendersOnlyThePresentParts() {
        Map<String, Object> json = MessageCardBuilder
                .contextChip("context-chip", null, null, "/tmp/work").toJson();

        assertThat(json).containsEntry("id", "context-chip");
        String wire = Json.write(json);
        assertThat(wire).contains("/tmp/work").contains("\"kind\":\"file\"");
        // No empty model/provider chips on the wire.
        assertThat(wire).doesNotContain("\"label\":\"\"");
    }

    @Test
    void eventRowTonesMapToTheTokenColors() {
        assertThat(Json.write(MessageCardBuilder.eventRow(1, "error", "Error", "boom", "danger")
                .toJson())).contains("$color.error");
        assertThat(Json.write(MessageCardBuilder.eventRow(2, "limit", "Limited", "", "warning")
                .toJson())).contains("$color.warning");
        assertThat(Json.write(MessageCardBuilder.eventRow(3, "done", "Done", "", "success")
                .toJson())).contains("$color.success");
        assertThat(Json.write(MessageCardBuilder.eventRow(4, "note", "Note", "", "muted")
                .toJson())).contains("$color.border");
        // The row key carries the event type as the subtype.
        assertThat(MessageCardBuilder.eventRow(5, "compaction", "Context compacted", "", "muted")
                .props()).containsEntry("rowKey", "event:compaction");
    }

    @Test
    void theErrorWireEventDispatchesToTheDangerEventRow() {
        UiNode row = MessageCardBuilder.dispatchEventRow("error",
                Map.of("message", "boom"), 9);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry("rowKind", "event")
                .containsEntry("rowKey", "event:error");
        assertThat(wire).contains("Error").contains("boom").contains("$color.error");
    }

    @Test
    void workRowsAreTheCollapsibleLogEntries() {
        UiNode use = MessageCardBuilder.workRow(7, "write {\"path\":\"/tmp/a\"}",
                List.of(MessageCardBuilder.toolArgumentsNode("{\"path\":\"/tmp/a\"}", 7)));
        Map<String, Object> useJson = use.toJson();
        assertThat(useJson).containsEntry("rowKind", "work").containsEntry("rowKey", "work:log");
        String useWire = Json.write(useJson);
        assertThat(useWire)
                .contains("write ")
                .contains("/tmp/a")
                .contains("\"collapsed\":true")
                .contains("\"language\":\"json\"");

        UiNode result = MessageCardBuilder.workRow(8, "write result",
                List.of(MessageCardBuilder.toolResultNode("ok", false, 8)));
        assertThat(Json.write(result.toJson())).contains("ok");
        UiNode failed = MessageCardBuilder.workRow(9, "write result",
                List.of(MessageCardBuilder.toolResultNode("boom", true, 9)));
        assertThat(Json.write(failed.toJson())).contains("$color.error");
    }

    @Test
    void liveToggleAndThinkingRowsCarryTheWorkLogKey() {
        assertThat(MessageCardBuilder.workLiveRow(1, "Running tests").props())
                .containsEntry("rowKind", "work-live").containsEntry("rowKey", "work-live:log");
        assertThat(Json.write(MessageCardBuilder.workLiveRow(1, "Running tests").toJson()))
                .contains("$color.accent").contains("statusPulse");
        assertThat(MessageCardBuilder.workToggleRow(2, "Read 4 files", 4).props())
                .containsEntry("rowKind", "work-toggle").containsEntry("rowKey", "work-toggle:log");
        assertThat(Json.write(MessageCardBuilder.workToggleRow(2, "Read 4 files", 4).toJson()))
                .contains("Read 4 files");
        assertThat(MessageCardBuilder.thinkingRow(3, "the expiry check").props())
                .containsEntry("rowKind", "thinking").containsEntry("rowKey", "thinking:log");
        assertThat(Json.write(MessageCardBuilder.thinkingRow(3, "the expiry check").toJson()))
                .contains("Thinking").contains("\"collapsed\":true");
    }

    @Test
    void decorativeRowsCarryTheDemoMarker() {
        for (UiNode row : List.of(
                MessageCardBuilder.proposedPlanRow(1, "1. Do it"),
                MessageCardBuilder.worktreeSetupRow(2, "running", "Creating the worktree"),
                MessageCardBuilder.turnFoldRow(3, "1 earlier turn"),
                MessageCardBuilder.attemptFoldRow(4, "Superseded attempt"))) {
            assertThat(Json.write(row.toJson())).contains("\"demo\":true");
        }
        // The plan card carries the accept/reject decorative pair.
        assertThat(Json.write(MessageCardBuilder.proposedPlanRow(1, "1. Do it").toJson()))
                .contains("Accept").contains("Reject");
    }

    @Test
    void workingFoldsAndCompactionRowsRenderTheirStrips() {
        assertThat(MessageCardBuilder.workingRow(1).props())
                .containsEntry("rowKind", "working").containsEntry("rowKey", "working:run");
        assertThat(Json.write(MessageCardBuilder.workingRow(1).toJson()))
                .contains("agent is working");

        assertThat(MessageCardBuilder.turnFoldRow(2, "1 earlier turn").props())
                .containsEntry("rowKey", "turn-fold:fold")
                .containsEntry("align", "center");
        assertThat(MessageCardBuilder.attemptFoldRow(3, "Superseded attempt").props())
                .containsEntry("rowKey", "attempt-fold:fold")
                .containsEntry("align", "center");

        Map<String, Object> compaction = MessageCardBuilder
                .contextCompactionRow(4, "Context compacted", false).toJson();
        assertThat(compaction).containsEntry("rowKind", "context-compaction")
                .containsEntry("rowKey", "context-compaction:compaction");
        assertThat(Json.write(compaction)).contains("Context compacted");
    }

    @Test
    void unknownKindFallsBackToThePlaceholderRow() {
        UiNode row = MessageCardBuilder.unknownRow(5, "holo");
        assertThat(row.props()).containsEntry("rowKind", "unknown")
                .containsEntry("rowKey", "unknown:unknown");
        assertThat(Json.write(row.toJson())).contains("Unknown row: holo");
    }

    @Test
    void theGapTableFollowsTheUpstreamPaddingScale() {
        // pb-4 (16) for the message family, pb-2 (8) for the work/event
        // family, pb-1.5 (6) for the fold and working strips.
        assertThat(MessageCardBuilder.rowGap("message")).isEqualTo(16);
        assertThat(MessageCardBuilder.rowGap("assistant-meta")).isEqualTo(16);
        assertThat(MessageCardBuilder.rowGap("proposed-plan")).isEqualTo(16);
        assertThat(MessageCardBuilder.rowGap("context-compaction")).isEqualTo(16);
        assertThat(MessageCardBuilder.rowGap("work")).isEqualTo(8);
        assertThat(MessageCardBuilder.rowGap("work-live")).isEqualTo(8);
        assertThat(MessageCardBuilder.rowGap("work-toggle")).isEqualTo(8);
        assertThat(MessageCardBuilder.rowGap("thinking")).isEqualTo(8);
        assertThat(MessageCardBuilder.rowGap("event")).isEqualTo(8);
        assertThat(MessageCardBuilder.rowGap("worktree-setup")).isEqualTo(8);
        assertThat(MessageCardBuilder.rowGap("attempt-fold")).isEqualTo(8);
        assertThat(MessageCardBuilder.rowGap("unknown")).isEqualTo(8);
        assertThat(MessageCardBuilder.rowGap("turn-fold")).isEqualTo(6);
        assertThat(MessageCardBuilder.rowGap("working")).isEqualTo(6);
        // An unrecognized kind takes the default instead of throwing.
        assertThat(MessageCardBuilder.rowGap("holo")).isEqualTo(16);
        assertThat(MessageCardBuilder.rowGap(null)).isEqualTo(16);
    }

    @Test
    void applyContinuationBakesTheNoGapMarginsIntoTheHistory() {
        List<UiNode> rows = List.of(
                MessageCardBuilder.workRow(1, "read", List.of()),
                MessageCardBuilder.workRow(2, "write result", List.of()),
                MessageCardBuilder.userMessageRow("hi", 3));
        List<UiNode> gapped = MessageCardBuilder.applyContinuation(rows);

        assertThat(castMap(gapped.get(0).props().get("margin"))).containsEntry("bottom", 0);
        assertThat(castMap(gapped.get(1).props().get("margin"))).containsEntry("bottom", 8);
        assertThat(castMap(gapped.get(2).props().get("margin"))).containsEntry("bottom", 16);
        // The untouched rows keep their props and children.
        assertThat(gapped.get(0).props().get("id")).isEqualTo("ev-1");
        assertThat(gapped.get(2).props().get("align")).isEqualTo("centerRight");
    }

    @Test
    void theQaTimelineProbeRendersOneRowOfEachKind() {
        Map<String, Object> json = QaTimelineScreen.render().toJson();
        List<String> kinds = new java.util.ArrayList<>();
        walk(json, node -> {
            Object kind = node.get(MessageCardBuilder.ROW_KIND_PROP);
            if (kind instanceof String text) {
                kinds.add(text);
            }
        });
        assertThat(kinds.stream().distinct().toList())
                .containsExactlyInAnyOrderElementsOf(MessageCardBuilder.ROW_KINDS);
    }

    @Test
    void theQaTimelineProbeCarriesTheContinuationPairs() {
        Map<String, Object> json = QaTimelineScreen.render().toJson();
        List<Map<String, Object>> rows = new java.util.ArrayList<>();
        walk(json, node -> {
            if (node.get(MessageCardBuilder.ROW_KIND_PROP) != null) {
                rows.add(node);
            }
        });
        // Rows 4 and 5 are both work:log — the first closes with no gap.
        Map<String, Object> firstWork = rows.stream()
                .filter(row -> "work".equals(row.get("rowKind")))
                .findFirst().orElseThrow();
        assertThat(firstWork).containsEntry("rowKey", "work:log");
        assertThat(castMap(firstWork.get("margin"))).containsEntry("bottom", 0);
    }

    // --- helpers ---

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) map;
            seen.accept(typed);
            for (Object value : map.values()) {
                walk(value, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object value : list) {
                walk(value, seen);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
