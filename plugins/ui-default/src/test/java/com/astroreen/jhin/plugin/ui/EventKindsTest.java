/**
 * The T102 event kinds: every one of the 16 {@code MessageCardBuilder} event
 * kinds dispatches to its recognisable card with the plan section 4.5
 * anatomy — the tool-call card (header icon + name + status chip + chevron,
 * the collapsible argument summary, the output region, the footer timestamp
 * + copy button, the row-id-keyed expansion), the status chip vocabulary
 * (the five states on their token colours) and the per-kind cards. The
 * {@code structured} {@code tool_result} path renders the event cards over
 * the wire (EventFrames and the chat history alike); an unknown kind falls
 * back to the placeholder card.
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

class EventKindsTest {

    // --- the vocabulary -------------------------------------------------

    @Test
    void theEventKindVocabularyHasTheSixteenKinds() {
        assertThat(MessageCardBuilder.EVENT_KINDS).containsExactlyInAnyOrder(
                "diff", "file-write", "shell", "message", "tool-call", "tool-result",
                "approval-request", "limit-notice", "error", "system-notice",
                "queued-message", "subagent", "citation", "skill-invocation",
                "work-log-entry", "question");
        assertThat(MessageCardBuilder.isEventKind("diff")).isTrue();
        assertThat(MessageCardBuilder.isEventKind("tool-result")).isTrue();
        assertThat(MessageCardBuilder.isEventKind("holo")).isFalse();
        assertThat(MessageCardBuilder.isEventKind(null)).isFalse();
    }

    @Test
    void theDispatcherCoversEveryKindAndFallsBackForUnknown() {
        for (String kind : MessageCardBuilder.EVENT_KINDS) {
            UiNode row = MessageCardBuilder.dispatchEventRow(kind, Map.of(), 1);
            assertThat(row.props())
                    .containsEntry(MessageCardBuilder.ROW_KIND_PROP, "event")
                    .containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:" + kind);
        }
        UiNode unknown = MessageCardBuilder.dispatchEventRow("holo", Map.of(), 2);
        assertThat(unknown.props())
                .containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:unknown");
        assertThat(Json.write(unknown.toJson())).contains("Unknown event: holo");
    }

    // --- the status chips -------------------------------------------------

    @Test
    void theStatusChipsCarryTheUpstreamLabelWordsOnTheTokenColors() {
        assertThat(Json.write(MessageCardBuilder.statusChip("pending").toJson()))
                .contains("Pending").contains("$color.warning");
        assertThat(Json.write(MessageCardBuilder.statusChip("running").toJson()))
                .contains("Running").contains("$color.info");
        assertThat(Json.write(MessageCardBuilder.statusChip("success").toJson()))
                .contains("Done").contains("$color.success");
        assertThat(Json.write(MessageCardBuilder.statusChip("error").toJson()))
                .contains("Error").contains("$color.error");
        assertThat(Json.write(MessageCardBuilder.statusChip("cancelled").toJson()))
                .contains("Cancelled").contains("$color.muted-foreground");
        // The upstream lifecycle synonyms resolve to the same five chips.
        assertThat(Json.write(MessageCardBuilder.statusChip("completed").toJson()))
                .contains("Done");
        assertThat(Json.write(MessageCardBuilder.statusChip("failed").toJson()))
                .contains("Error");
        // An unrecognized status renders the muted chip with the raw text.
        assertThat(Json.write(MessageCardBuilder.statusChip("holo").toJson()))
                .contains("holo").contains("$color.muted-foreground");
        // A blank status is the pending chip, never a throw.
        assertThat(Json.write(MessageCardBuilder.statusChip(null).toJson()))
                .contains("Pending");
    }

    // --- the standard tool card (T102.1) ----------------------------------

    @Test
    void theToolCallCardCarriesTheFourPartAnatomy() {
        UiNode row = MessageCardBuilder.toolCardRow("tool-call", 5, Map.of(
                "name", "read",
                "status", "running",
                "summary", "{\"path\":\"src/auth.java\"}",
                "time", "14:03"));
        Map<String, Object> json = row.toJson();
        assertThat(json)
                .containsEntry(MessageCardBuilder.ROW_KIND_PROP, "event")
                .containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:tool-call");
        String wire = Json.write(json);
        // header: tool icon + name + status chip + chevron
        assertThat(wire)
                .contains("\"id\":\"ev-5-head\"")
                .contains("\"icon\":\"construction\"")
                .contains("read")
                .contains("Running")
                .contains("$color.info")
                .contains("\"id\":\"ev-5-chevron\"")
                .contains("expand_more");
        // the collapsible argument summary line
        assertThat(wire).contains("src/auth.java");
        // the expansion: the chevron patches the row-id-keyed body visible
        assertThat(wire).contains("\"id\":\"ev-5-body\"").contains("\"hidden\":true");
        assertThat(wire).contains("\"op\":\"patch\"").contains("ev-5-body");
        // the footer: timestamp + copy button (the demo-marked stub)
        assertThat(wire).contains("\"id\":\"ev-5-footer\"").contains("14:03");
        assertThat(wire).contains("\"id\":\"ev-5-copy\"").contains("\"demo\":true");
    }

    @Test
    void theToolResultCardRendersTheOutputRegionAndTheCollapseAffordance() {
        UiNode row = MessageCardBuilder.toolCardRow("tool-result", 6, Map.of(
                "name", "read",
                "status", "success",
                "summary", "{\"path\":\"src/auth.java\"}",
                "output", "public class Auth {",
                "language", "java",
                "time", "14:03"));
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP,
                "event:tool-result");
        // the output region: the code block with the language and the copy
        assertThat(wire)
                .contains("\"type\":\"code_block\"")
                .contains("public class Auth {")
                .contains("\"language\":\"java\"")
                .contains("\"copyable\":true");
        // the collapse affordance patches the body back to hidden
        assertThat(wire).contains("unfold_less");
        assertThat(wire).contains("\"hidden\":true");
    }

    @Test
    void theOutputRegionRendersMarkdownCodeOrDiff() {
        assertThat(Json.write(MessageCardBuilder.toolCardRow("tool-result", 1, Map.of(
                "name", "t", "output", "**bold**", "outputKind", "markdown"))
                .toJson())).contains("\"type\":\"markdown\"").contains("**bold**");
        assertThat(Json.write(MessageCardBuilder.toolCardRow("tool-result", 2, Map.of(
                "name", "t", "output", "plain", "outputKind", "code"))
                .toJson())).contains("\"type\":\"code_block\"");
        String diff = Json.write(MessageCardBuilder.toolCardRow("tool-result", 3, Map.of(
                "name", "t",
                "outputKind", "diff",
                "file", "src/auth.java",
                "additions", 12,
                "deletions", 3,
                "hunks", List.of(Map.of("header", "@@ -1 +1 @@", "lines", List.of()))))
                .toJson());
        assertThat(diff).contains("\"type\":\"diff_view\"").contains("src/auth.java")
                .contains("\"demo\":true");
    }

    @Test
    void aToolCallWithNoOutputRendersTheEmptyStateRegionNotABlankCard() {
        UiNode row = MessageCardBuilder.toolCardRow("tool-call", 7, Map.of(
                "name", "read", "status", "running"));
        String wire = Json.write(row.toJson());
        // The empty-state region: the muted italic "No output." node — the
        // card is never blank.
        assertThat(wire)
                .contains("\"id\":\"ev-7-empty\"")
                .contains("No output.")
                .contains("\"italic\":true");
    }

    // --- the per-kind cards (T102.2) ---------------------------------------

    @Test
    void theDiffKindRendersTheDiffViewCard() {
        UiNode row = MessageCardBuilder.dispatchEventRow("diff", Map.of(
                "file", "src/auth.java",
                "language", "java",
                "additions", 12,
                "deletions", 3,
                "hunks", List.of(Map.of("header", "@@ -1 +1 @@", "lines", List.of()))), 10);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:diff");
        assertThat(wire)
                .contains("\"type\":\"diff_view\"")
                .contains("\"demo\":true")
                .contains("src/auth.java")
                .contains("\"additions\":12");
    }

    @Test
    void theFileWriteKindRendersTheChangedFilesCardWithLineStats() {
        UiNode row = MessageCardBuilder.dispatchEventRow("file-write", Map.of(
                "files", List.of(
                        Map.of("path", "src/auth.java", "additions", 12, "deletions", 3,
                                "status", "M"),
                        Map.of("path", "src/login.java", "additions", 4, "deletions", 0,
                                "status", "A"))), 11);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP,
                "event:file-write");
        assertThat(wire)
                .contains("2 changed files")
                .contains("+16")
                .contains("-3")
                .contains("src/auth.java")
                .contains("src/login.java")
                .contains("$color.diff-addition")
                .contains("$color.diff-deletion");
    }

    @Test
    void theShellKindRendersTheCommandAndTheCodeBlockOutput() {
        UiNode row = MessageCardBuilder.dispatchEventRow("shell", Map.of(
                "command", "gradle test",
                "output", "BUILD SUCCESSFUL",
                "status", "success", "time", "14:03"), 12);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:shell");
        assertThat(wire)
                .contains("gradle test")
                .contains("\"type\":\"code_block\"")
                .contains("BUILD SUCCESSFUL")
                .contains("shell");
    }

    @Test
    void theMessageKindRendersTheInlineText() {
        UiNode row = MessageCardBuilder.dispatchEventRow("message",
                Map.of("text", "Reading the auth flow next."), 13);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:message");
        assertThat(wire).contains("Reading the auth flow next.");
        // inline text: no card chrome around it
        assertThat(wire).doesNotContain("\"type\":\"card\"");
    }

    @Test
    void theApprovalRequestKindRendersTheQuestionCardWithOptionChips() {
        UiNode row = MessageCardBuilder.dispatchEventRow("approval-request", Map.of(
                "title", "Command approval", "detail", "gradle test",
                "options", List.of("Allow", "Deny")), 14);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP,
                "event:approval-request");
        assertThat(wire)
                .contains("Command approval")
                .contains("$color.warning")
                .contains("gradle test")
                .contains("\"type\":\"chip\"")
                .contains("Allow").contains("Deny")
                .contains("\"op\":\"setState\"")
                .contains("\"demo\":true");
    }

    @Test
    void theLimitNoticeKindRendersTheWarningBannerWithDemoResumeButtons() {
        UiNode row = MessageCardBuilder.dispatchEventRow("limit-notice",
                Map.of("resetAt", "2026-10-06 15:00"), 15);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP,
                "event:limit-notice");
        assertThat(wire)
                .contains("\"type\":\"banner\"")
                .contains("Usage limit reached")
                .contains("Resets 2026-10-06 15:00")
                .contains("Resume")
                .contains("Resume at reset")
                .contains("$color.warning");
        // the decorative buttons carry the demo marker
        assertThat(wire).contains("\"demo\":true");
    }

    @Test
    void theErrorAndSystemNoticeKindsRenderTheirTones() {
        UiNode error = MessageCardBuilder.dispatchEventRow("error",
                Map.of("message", "boom"), 16);
        assertThat(error.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:error");
        assertThat(Json.write(error.toJson()))
                .contains("Error").contains("boom").contains("$color.error");

        UiNode notice = MessageCardBuilder.dispatchEventRow("system-notice",
                Map.of("text", "The provider catalog refreshed."), 17);
        assertThat(notice.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP,
                "event:system-notice");
        assertThat(Json.write(notice.toJson()))
                .contains("The provider catalog refreshed.").contains("$color.border");
    }

    @Test
    void theQueuedMessageKindRendersThePendingCardWithTheStripe() {
        UiNode row = MessageCardBuilder.dispatchEventRow("queued-message",
                Map.of("text", "Also run the integration suite."), 18);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP,
                "event:queued-message");
        assertThat(wire)
                .contains("Also run the integration suite.")
                .contains("\"width\":3")
                .contains("$color.warning");
    }

    @Test
    void theSubagentKindRendersTheRightAlignedBar() {
        UiNode row = MessageCardBuilder.dispatchEventRow("subagent", Map.of(
                "title", "Scout: find the token expiry", "status", "running"), 19);
        Map<String, Object> json = row.toJson();
        assertThat(json)
                .containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:subagent")
                .containsEntry("align", "centerRight");
        assertThat(Json.write(json))
                .contains("Scout: find the token expiry")
                .contains("Running")
                .contains("smart_toy");
    }

    @Test
    void theCitationAndSkillKindsRenderTheInlinePills() {
        UiNode citation = MessageCardBuilder.dispatchEventRow("citation",
                Map.of("label", "src/auth.java:42"), 20);
        assertThat(citation.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP,
                "event:citation");
        assertThat(Json.write(citation.toJson()))
                .contains("src/auth.java:42").contains("$color.info");

        UiNode skill = MessageCardBuilder.dispatchEventRow("skill-invocation",
                Map.of("name", "jhin-plugin"), 21);
        assertThat(skill.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP,
                "event:skill-invocation");
        assertThat(Json.write(skill.toJson()))
                .contains("jhin-plugin").contains("$color.primary");
    }

    @Test
    void theWorkLogEntryKindRendersTheWorkLogRow() {
        UiNode row = MessageCardBuilder.dispatchEventRow("work-log-entry", Map.of(
                "label", "read 4 files", "time", "14:02"), 22);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP,
                "event:work-log-entry");
        assertThat(wire)
                .contains("read 4 files")
                .contains("14:02")
                .contains("construction");
    }

    @Test
    void theQuestionKindRendersTheQuestionCardWithAnswers() {
        UiNode row = MessageCardBuilder.dispatchEventRow("question", Map.of(
                "question", "Which auth flow?", "answers", List.of("The token one")), 23);
        String wire = Json.write(row.toJson());
        assertThat(row.props()).containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:question");
        assertThat(wire)
                .contains("Which auth flow?")
                .contains("The token one")
                .contains("check_circle");
    }

    // --- the structured tool_result path -----------------------------------

    @Test
    void theQaProbeRendersOneEventCardOfEachKind() {
        Map<String, Object> json = QaTimelineScreen.render().toJson();
        List<String> keys = new java.util.ArrayList<>();
        walk(json, node -> {
            Object key = node.get(MessageCardBuilder.ROW_KEY_PROP);
            if (key instanceof String text && text.startsWith("event:")) {
                keys.add(text);
            }
        });
        // The 16 kinds + the unknown fallback; the T101 compaction event row
        // adds one more distinct key.
        assertThat(keys.stream().distinct().toList()).hasSize(18);
        for (String kind : MessageCardBuilder.EVENT_KINDS) {
            assertThat(keys).contains("event:" + kind);
        }
        assertThat(keys).contains("event:unknown");
    }

    @Test
    void theStructuredToolResultRendersTheEventCardOverTheFramePath() {
        EventFrames.Translator translator = new EventFrames.Translator();
        List<Map<String, Object>> frames = translator.frames("tool_result", Json.write(Map.of(
                "id", "c1",
                "name", "diff",
                "content", "ignored",
                "structured", Json.write(Map.of(
                        "type", "diff",
                        "file", "src/auth.java",
                        "additions", 12,
                        "deletions", 3,
                        "hunks", List.of(Map.of("header", "@@ -1 +1 @@", "lines", List.of())))))),
                30);
        assertThat(frames).hasSize(1);
        @SuppressWarnings("unchecked")
        Map<String, Object> node = (Map<String, Object>) frames.get(0).get("node");
        assertThat(node).isNotNull();
        String html = String.valueOf(node.get("html"));
        assertThat(html)
                .contains("data-jhin-type=\"diff_view\"")
                .contains("src/auth.java");
    }

    @Test
    void thePlainToolResultStillRendersTheWorkRow() {
        EventFrames.Translator translator = new EventFrames.Translator();
        List<Map<String, Object>> frames = translator.frames("tool_result", Json.write(Map.of(
                "id", "c1", "name", "read", "content", "ok", "error", false)), 31);
        @SuppressWarnings("unchecked")
        Map<String, Object> node = (Map<String, Object>) frames.get(0).get("node");
        assertThat(node).isNotNull();
        assertThat(String.valueOf(node.get("html")))
                .contains("data-jhin-type=\"list\"").contains("ok");
        // A malformed structured payload degrades to the work row too.
        List<Map<String, Object>> malformedFrames = translator.frames("tool_result", Json.write(Map.of(
                "id", "c2", "name", "read", "content", "ok",
                "structured", "{\"type\":\"holo\"}")), 32);
        @SuppressWarnings("unchecked")
        Map<String, Object> malformedNode =
                (Map<String, Object>) malformedFrames.get(0).get("node");
        assertThat(String.valueOf(malformedNode.get("html")))
                .contains("data-jhin-type=\"list\"").contains("ok");
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
}
