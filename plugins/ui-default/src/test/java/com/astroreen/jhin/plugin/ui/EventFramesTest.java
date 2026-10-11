/**
 * The level-4 stream frame shapes of {@link EventFrames} (docs/sdui.md
 * section 5): every {@code node}/{@code patch}/{@code replace} frame carries
 * the {@code {id, html}} envelope and no {@code props}/{@code node} tree
 * key ever reaches the stream, {@code text_delta} events coalesce into one
 * {@code patch} per {@link EventFrames#DELTA_FLUSH_WINDOW_MILLIS} window
 * (driven on an injected clock — no sleeps), streamed text renders script
 * payloads escaped, and {@code session_updated} renders the sidebar row
 * fragment.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.sdk.json.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;
import org.junit.jupiter.api.Test;

class EventFramesTest {

    /** A settable wall clock: the flush window is driven, never slept on. */
    private static final class FakeClock implements LongSupplier {
        private long now = 1_000;

        @Override
        public long getAsLong() {
            return now;
        }
    }

    private final FakeClock clock = new FakeClock();

    // --- frame shapes (docs/sdui.md section 5) ---

    @Test
    void nodeFrameCarriesTheRowHtmlAndNoTree() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);

        List<Map<String, Object>> frames =
                translator.frames("user_message", json("text", "hi"), 1);

        assertThat(frames).hasSize(1);
        Map<String, Object> item = payload(frames.get(0), "node");
        assertThat(item).containsOnlyKeys("id", "html");
        assertThat(item.get("id")).isEqualTo("ev-1");
        String html = String.valueOf(item.get("html"));
        assertThat(html).contains("data-jhin-id=\"ev-1\"").contains("hi");
        assertThat(Json.write(frames.get(0))).doesNotContain("\"props\"");
    }

    @Test
    void patchFrameCarriesIdAndInnerHtml() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);
        translator.frames("message_start", json("role", "assistant"), 2);
        translator.frames("text_delta", json("text", "Hel"), 3);
        translator.frames("text_delta", json("text", "lo"), 4);

        List<Map<String, Object>> frames =
                translator.frames("message_end", json("text", "Hello"), 5);

        assertThat(frames).hasSize(1);
        Map<String, Object> item = payload(frames.get(0), "patch");
        assertThat(item).containsOnlyKeys("id", "html");
        assertThat(item.get("id")).isEqualTo("msg-2");
        String html = String.valueOf(item.get("html"));
        assertThat(html).contains("<p>Hello</p>");
        // a patch swaps inner HTML — the target element is not re-emitted
        assertThat(html).doesNotContain("data-jhin-id=\"msg-2\"");
        assertThat(Json.write(frames.get(0))).doesNotContain("\"props\"");
    }

    @Test
    void replaceFrameCarriesIdAndTheFullElement() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);

        List<Map<String, Object>> frames =
                translator.frames("run_end", json("runId", "r1"), 5);

        assertThat(frames).hasSize(1);
        Map<String, Object> item = payload(frames.get(0), "replace");
        assertThat(item).containsOnlyKeys("id", "html");
        assertThat(item.get("id")).isEqualTo("runStatus");
        String html = String.valueOf(item.get("html"));
        assertThat(html).contains("data-jhin-id=\"runStatus\"");
        assertThat(Json.write(frames.get(0))).doesNotContain("\"props\"");
    }

    @Test
    void removeFrameCarriesTheWorkingRowId() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);
        translator.frames("run_start", json("runId", "r1"), 6);

        List<Map<String, Object>> frames =
                translator.frames("run_end", json("runId", "r1"), 7);

        assertThat(frames).hasSize(1);
        assertThat(frames.get(0)).containsExactly(Map.entry("remove", "ev-6"));
        assertThat(Json.write(frames.get(0))).doesNotContain("\"props\"");
    }

    @Test
    void everyFrameShapeCarriesHtmlAndNoPropsOrNodeKeys() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);
        List<Map<String, Object>> all = new ArrayList<>();
        all.addAll(translator.frames("user_message", json("text", "hi"), 1));
        all.addAll(translator.frames("run_start", json("runId", "r"), 2));
        all.addAll(translator.frames("message_start", json("role", "assistant"), 3));
        all.addAll(translator.frames("message_end", json("text", "hey"), 4));
        all.addAll(translator.frames("run_end", json("runId", "r"), 5));
        // a second run_end with no tracked working row settles the composer
        // badge through the replace shape
        all.addAll(translator.frames("run_end", json("runId", "r"), 6));

        List<String> shapes = all.stream()
                .flatMap(frame -> frame.keySet().stream())
                .toList();
        assertThat(shapes).contains("node", "patch", "replace", "remove");
        for (Map<String, Object> frame : all) {
            String shape = String.valueOf(frame.keySet().iterator().next());
            if ("remove".equals(shape)) {
                continue;
            }
            Map<String, Object> item = payload(frame, shape);
            assertThat(item).containsKey("html");
            assertThat(item).containsKey("id");
        }
        assertThat(Json.write(all)).doesNotContain("\"props\"");
    }

    // --- delta batching (T205: <= 60 ms flush window) ---

    @Test
    void deltasInsideOneFlushWindowProduceOnePatch() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);
        translator.frames("message_start", json("role", "assistant"), 1);

        for (String delta : List.of("H", "e", "l", "l", "o")) {
            assertThat(translator.frames("text_delta", json("text", delta), 2))
                    .isEmpty();
        }
        List<Map<String, Object>> frames =
                translator.frames("message_end", json("text", "Hello"), 7);

        assertThat(frames).hasSize(1);
        Map<String, Object> item = payload(frames.get(0), "patch");
        assertThat(item.get("id")).isEqualTo("msg-1");
        assertThat(String.valueOf(item.get("html"))).contains("<p>Hello</p>");
    }

    @Test
    void theFlushWindowBoundsThePatchRate() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);
        translator.frames("message_start", json("role", "assistant"), 1);
        assertThat(translator.frames("text_delta", json("text", "A"), 2)).isEmpty();
        clock.now += 30;
        assertThat(translator.frames("text_delta", json("text", "B"), 3)).isEmpty();
        clock.now += 30;

        List<Map<String, Object>> frames =
                translator.frames("text_delta", json("text", "C"), 4);

        assertThat(frames).hasSize(1);
        assertThat(String.valueOf(payload(frames.get(0), "patch").get("html")))
                .contains("<p>ABC</p>");
    }

    @Test
    void nonDeltaEventsFlushThePendingBatchFirst() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);
        translator.frames("message_start", json("role", "assistant"), 1);
        assertThat(translator.frames("text_delta", json("text", "Hi"), 2)).isEmpty();

        List<Map<String, Object>> frames = translator.frames(
                "tool_use", Json.write(Map.of("id", "c1", "name", "read")), 3);

        assertThat(frames).hasSize(2);
        assertThat(frames.get(0)).containsKey("patch");
        assertThat(String.valueOf(payload(frames.get(0), "patch").get("html")))
                .contains("<p>Hi</p>");
        assertThat(frames.get(1)).containsKey("node");
    }

    @Test
    void closeFlushesTheTrailingBatch() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);
        translator.frames("message_start", json("role", "assistant"), 1);
        assertThat(translator.frames("text_delta", json("text", "draft"), 2)).isEmpty();

        List<Map<String, Object>> flush = translator.flush();

        assertThat(flush).hasSize(1);
        assertThat(String.valueOf(payload(flush.get(0), "patch").get("html")))
                .contains("<p>draft</p>");
        assertThat(translator.flush()).isEmpty();
    }

    @Test
    void absorbedDeltasDoNotFlushHistoryText() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);
        translator.absorb("message_start", json("role", "assistant"), 1);
        translator.absorb("text_delta", json("text", "Hello "), 2);

        List<Map<String, Object>> tool = translator.frames(
                "tool_use", Json.write(Map.of("id", "c1", "name", "read")), 3);

        assertThat(tool).hasSize(1);
        assertThat(tool.get(0)).containsKey("node");

        translator.frames("text_delta", json("text", "world"), 4);
        List<Map<String, Object>> end = translator.frames("message_end", "{}", 5);
        assertThat(end).hasSize(1);
        assertThat(String.valueOf(payload(end.get(0), "patch").get("html")))
                .contains("<p>Hello world</p>");
    }

    // --- escaping (docs/web-client.md section 3) ---

    @Test
    void streamedTextRendersScriptPayloadsEscaped() {
        EventFrames.Translator translator = new EventFrames.Translator(clock);
        translator.frames("message_start", json("role", "assistant"), 1);
        translator.frames("text_delta", json("text", "<script>alert(1)</script>"), 2);

        List<Map<String, Object>> frames = translator.flush();

        assertThat(frames).hasSize(1);
        String html = String.valueOf(payload(frames.get(0), "patch").get("html"));
        assertThat(html).contains("&lt;script&gt;alert(1)&lt;/script&gt;");
        assertThat(html).doesNotContain("<script>");
    }

    // --- session_updated -> sidebar-row patch ---

    @Test
    void sessionUpdatedRendersTheSidebarRowFragment() {
        Session session = new Session("s1", "local", "demo", "/tmp/work",
                null, null, "active", 1, 1);

        Map<String, Object> frame = EventFrames.sessionUpdatedFrame(Json.write(session));

        Map<String, Object> item = payload(frame, "patch");
        assertThat(item).containsOnlyKeys("id", "html");
        assertThat(item.get("id")).isEqualTo("session-row:s1");
        String html = String.valueOf(item.get("html"));
        assertThat(html).contains("demo").contains("/tmp/work");
        assertThat(html).contains("data-jhin-type=\"text\"");
        assertThat(Json.write(frame)).doesNotContain("\"props\"");
    }

    // --- helpers ---

    /** One JSON object with a single string field. */
    private static String json(String key, String value) {
        return Json.write(Map.of(key, value));
    }

    /** The payload object of one frame shape. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> payload(Map<String, Object> frame, String shape) {
        return (Map<String, Object>) frame.get(shape);
    }
}
