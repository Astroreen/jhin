/**
 * The real-payload tool cards and the work family of
 * {@link MessageCardBuilder}: a real {@code tool_use} payload (the raw
 * {@code arguments} JSON text) renders the middle-truncated summary line
 * and the mono header name with the five status chips, a real
 * {@code tool_result} payload renders the output region (the plain
 * {@code content}, the danger-tinted error shape, the {@code structured}
 * {@code hunks} diff and the muted italic "No output." empty state), the
 * output shape detection picks {@code code_block} or {@code markdown}, a
 * blank tool name falls back to the {@code unknown} placeholder card
 * instead of throwing, the work rows carry the shine layer, the terminal
 * chips and the group toggle anatomy, and the card body emits the bare
 * {@code hidden} attribute on {@code ev-<seq>-body}.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.astroreen.jhin.plugin.ui.screens.MessageCardBuilder;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import com.astroreen.jhin.plugin.uikit.text.PathDisplay;
import com.astroreen.jhin.sdk.json.Json;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class MessageCardBuilderTest {

    // --- the real tool_use payload ------------------------------------------

    @Test
    void theRealToolUsePayloadRendersTheTruncatedArgumentsSummaryAndTheMonoName() {
        String arguments = "{\"path\":\"/home/astroreen/Documents/jhin/plugins/ui-default"
                + "/src/main/java/com/astroreen/jhin/plugin/ui/screens"
                + "/MessageCardBuilder.java\",\"pattern\":\"statusChip\"}";
        Map<String, Object> json = MessageCardBuilder.dispatchEventRow("tool-call", Map.of(
                "id", "tu_1", "name", "read_file", "arguments", arguments), 40).toJson();
        // the summary line: the middle-truncated arguments JSON text
        assertThat(textNode(json, PathDisplay.middleTruncate(
                arguments, PathDisplay.DEFAULT_MAX))).isNotNull();
        // the header name rides the mono style
        assertThat(textNode(json, "read_file")).containsEntry("style", "mono");
        assertThat(Json.write(json)).contains("\"id\":\"ev-40-head\"");
    }

    @Test
    void theFiveStatusChipsMapThroughTheRealToolCallCard() {
        assertThat(chipWire("pending"))
                .contains("Pending").contains("$color.warning");
        assertThat(chipWire("running"))
                .contains("Running").contains("$color.info");
        assertThat(chipWire("success"))
                .contains("Done").contains("$color.success");
        assertThat(chipWire("error"))
                .contains("Error").contains("$color.error");
        assertThat(chipWire("cancelled"))
                .contains("Cancelled").contains("$color.muted-foreground");
    }

    // --- the real tool_result payload ---------------------------------------

    @Test
    void theRealToolResultPayloadRendersTheOutputRegionAndTheErrorShape() {
        Map<String, Object> json = MessageCardBuilder.dispatchEventRow("tool-result", Map.of(
                "id", "tr_1", "name", "read", "content", "checked 3 files"), 42).toJson();
        assertThat(Json.write(json))
                .contains("\"type\":\"markdown\"")
                .contains("checked 3 files");

        String failed = Json.write(MessageCardBuilder.dispatchEventRow("tool-result", Map.of(
                "id", "tr_2", "name", "read", "content", "boom", "error", true), 43)
                .toJson());
        assertThat(failed).contains("Error").contains("$color.error");
    }

    @Test
    void theStructuredHunksRenderTheDiffOutputAndTheBlankContentTheMutedEmptyState() {
        String diff = Json.write(MessageCardBuilder.dispatchEventRow("tool-result", Map.of(
                "id", "tr_3", "name", "diff", "content", "ignored",
                "structured", Map.of(
                        "file", "src/auth.java",
                        "additions", 12,
                        "deletions", 3,
                        "hunks", List.of(Map.of("header", "@@ -1 +1 @@", "lines", List.of())))),
                44).toJson());
        assertThat(diff)
                .contains("\"type\":\"diff_view\"")
                .contains("src/auth.java")
                .contains("\"demo\":true");

        String empty = Json.write(MessageCardBuilder.dispatchEventRow("tool-result", Map.of(
                "id", "tr_4", "name", "read", "content", ""), 45).toJson());
        assertThat(empty)
                .contains("No output.")
                .contains("\"id\":\"ev-45-empty\"")
                .contains("\"italic\":true")
                .contains("$color.muted-foreground");
    }

    // --- the output shape detection -----------------------------------------

    @Test
    void theOutputShapeDetectionPicksTheCodeBlockOrTheMarkdownRegion() {
        String withLanguage = Json.write(MessageCardBuilder.dispatchEventRow("tool-result",
                Map.of("id", "tr_5", "name", "write",
                        "content", "public class Auth {\n  int x;\n}",
                        "language", "java"), 46).toJson());
        assertThat(withLanguage)
                .contains("\"type\":\"code_block\"")
                .contains("\"language\":\"java\"");

        String codeLooking = Json.write(MessageCardBuilder.dispatchEventRow("tool-result",
                Map.of("id", "tr_6", "name", "write",
                        "content", "int x = 1;\nint y = 2;"), 47).toJson());
        assertThat(codeLooking).contains("\"type\":\"code_block\"");

        String prose = Json.write(MessageCardBuilder.dispatchEventRow("tool-result",
                Map.of("id", "tr_7", "name", "read",
                        "content", "The build passed."), 48).toJson());
        assertThat(prose)
                .contains("\"type\":\"markdown\"")
                .contains("The build passed.");
    }

    // --- the unknown fallback ------------------------------------------------

    @Test
    void aBlankToolNameOnTheRealPayloadFallsBackToTheUnknownPlaceholderCard() {
        UiNode call = MessageCardBuilder.dispatchEventRow("tool-call",
                Map.of("arguments", "{}", "name", " "), 49);
        assertThat(call.props())
                .containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:unknown");
        assertThat(Json.write(call.toJson())).contains("Unknown event: tool-call");

        UiNode result = MessageCardBuilder.dispatchEventRow("tool-result",
                Map.of("content", "ok", "name", ""), 50);
        assertThat(result.props())
                .containsEntry(MessageCardBuilder.ROW_KEY_PROP, "event:unknown");
        assertThat(Json.write(result.toJson())).contains("Unknown event: tool-result");
    }

    @Test
    void theRealPayloadPathsNeverThrow() {
        assertThatCode(() -> {
            MessageCardBuilder.dispatchEventRow("tool-call",
                    Map.of("name", "read"), 51);
            MessageCardBuilder.dispatchEventRow("tool-result",
                    Map.of("structured", Map.of()), 52);
            MessageCardBuilder.dispatchEventRow(null, null, 53);
        }).doesNotThrowAnyException();
    }

    // --- the work family -----------------------------------------------------

    @Test
    void theWorkLiveToolRowCarriesTheShineLayerAndTheRunningChip() {
        String wire = Json.write(MessageCardBuilder.workLiveToolRow(
                60, "read", "{\"path\":\"src/A.java\"}").toJson());
        assertThat(wire)
                .contains("live-tool-shine")
                .contains("Running")
                .contains("$color.info");
    }

    @Test
    void theWorkDoneToolRowFlipsToTheDoneStatus() {
        String wire = Json.write(MessageCardBuilder.workDoneToolRow(
                61, "read", "success", "ok", false).toJson());
        assertThat(wire)
                .contains("Done")
                .contains("$color.success")
                .doesNotContain("Running");
    }

    @Test
    void theWorkGroupRowCarriesTheCountBadgeAndTheHiddenToggleBody() {
        String wire = Json.write(MessageCardBuilder.workGroupRow(
                62, "read", 3, "running").toJson());
        assertThat(wire)
                .contains("\"count\":3")
                .contains("\"id\":\"ev-62-toggle\"")
                .contains("\"id\":\"ev-62-body\"")
                .contains("\"hidden\":true");
    }

    // --- the card body expansion channel -------------------------------------

    @Test
    void theCardBodyEmitsTheBareHiddenAttributeOnTheEvSeqBody() {
        String html = HtmlRenderer.renderFragment(MessageCardBuilder.toolCardRow(
                "tool-call", 5, Map.of("name", "read", "status", "running")));
        assertThat(html).contains("id=\"ev-5-body\"");
        assertThat(html).containsPattern("data-jhin-id=\"ev-5-body\" hidden[\\s>]");
    }

    // --- helpers ---

    private static String chipWire(String status) {
        return Json.write(MessageCardBuilder.dispatchEventRow("tool-call", Map.of(
                "arguments", "{}", "name", "read", "status", status), 41).toJson());
    }

    private static Map<String, Object> textNode(Object fragment, String text) {
        if (fragment instanceof Map<?, ?> map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> node = (Map<String, Object>) map;
            if ("text".equals(node.get("type")) && text.equals(node.get("text"))) {
                return node;
            }
            for (Object value : node.values()) {
                Map<String, Object> found = textNode(value, text);
                if (found != null) {
                    return found;
                }
            }
        } else if (fragment instanceof List<?> list) {
            for (Object value : list) {
                Map<String, Object> found = textNode(value, text);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }
}
