/**
 * Contract level 4 directive wire shapes (docs/sdui.md section 4): the three
 * HTML-carrying ops {@code patch} / {@code setScreen} / {@code dialog} emit
 * {@code html} and never {@code props} or {@code node}, the fourteen other ops
 * are byte-identical to level 3, and the control plane — {@link
 * com.astroreen.jhin.plugin.uikit.UiNode#toJson()} — still emits the node
 * tree. Escaping is proven through a directive payload: a node whose text
 * carries {@code <script>alert(1)</script>} ships escaped in the fragment.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.plugin.uikit.html.HtmlRenderer;
import com.astroreen.jhin.sdk.json.Json;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class HtmlDirectiveShapeTest {

    private static final String FRAGMENT = "<div data-jhin-type=\"column\"></div>";

    // --- the three changed ops (docs/sdui.md section 4) ---

    @Test
    void patchCarriesIdAndHtmlAndNoProps() {
        Map<String, Object> patch = Directives.patch("msg-7", FRAGMENT);

        assertThat(Json.write(patch)).isEqualTo(
                "{\"op\":\"patch\",\"id\":\"msg-7\",\"html\":\""
                        + "<div data-jhin-type=\\\"column\\\"></div>\"}");
        assertThat(patch).containsOnlyKeys("op", "id", "html");
        assertThat(patch).doesNotContainKey("props").doesNotContainKey("node");
    }

    @Test
    void setScreenCarriesIdAndHtmlAndNoNode() {
        Map<String, Object> setScreen = Directives.setScreen("sessions", FRAGMENT);

        assertThat(Json.write(setScreen)).isEqualTo(
                "{\"op\":\"setScreen\",\"id\":\"sessions\",\"html\":\""
                        + "<div data-jhin-type=\\\"column\\\"></div>\"}");
        assertThat(setScreen).containsOnlyKeys("op", "id", "html");
        assertThat(setScreen).doesNotContainKey("node").doesNotContainKey("props");
    }

    @Test
    void dialogCarriesHtmlAndOptionalKindAndNoNode() {
        Map<String, Object> dialog = Directives.dialog(FRAGMENT);

        assertThat(Json.write(dialog)).isEqualTo(
                "{\"op\":\"dialog\",\"html\":\""
                        + "<div data-jhin-type=\\\"column\\\"></div>\"}");
        assertThat(dialog).containsOnlyKeys("op", "html");

        Map<String, Object> sheet = Directives.dialog(FRAGMENT, "sheet");
        assertThat(Json.write(sheet)).isEqualTo(
                "{\"op\":\"dialog\",\"html\":\""
                        + "<div data-jhin-type=\\\"column\\\"></div>\",\"kind\":\"sheet\"}");
        assertThat(sheet).containsOnlyKeys("op", "html", "kind");
        assertThat(sheet).doesNotContainKey("node");
    }

    /** The {@link UiNode} overloads emit exactly the {@code String} shapes. */
    @Test
    void nodeOverloadsRenderTheFragmentThroughHtmlRenderer() {
        UiNode node = Ui.column().id("dialog-body").child(Ui.text("hi").build()).build();

        assertThat(Directives.patch("x", node))
                .isEqualTo(Directives.patch("x", HtmlRenderer.renderFragment(node)));
        assertThat(Directives.setScreen("x", node))
                .isEqualTo(Directives.setScreen("x", HtmlRenderer.renderFragment(node)));
        assertThat(Directives.dialog(node))
                .isEqualTo(Directives.dialog(HtmlRenderer.renderFragment(node)));
        assertThat(Directives.dialog(node, "sheet"))
                .isEqualTo(Directives.dialog(HtmlRenderer.renderFragment(node), "sheet"));
    }

    // --- the fourteen unchanged ops (byte-shape spot checks) ---

    @Test
    void theOtherOpsKeepTheirLevel3ByteShape() {
        assertThat(Json.write(Directives.navigate("sessions")))
                .isEqualTo("{\"op\":\"navigate\",\"screen\":\"sessions\"}");
        assertThat(Json.write(Directives.back())).isEqualTo("{\"op\":\"back\"}");
        assertThat(Json.write(Directives.replace("chat:1")))
                .isEqualTo("{\"op\":\"replace\",\"screen\":\"chat:1\"}");
        assertThat(Json.write(Directives.refresh())).isEqualTo("{\"op\":\"refresh\"}");
        assertThat(Json.write(Directives.reloadBootstrap()))
                .isEqualTo("{\"op\":\"reloadBootstrap\"}");
        assertThat(Json.write(Directives.dismissDialog()))
                .isEqualTo("{\"op\":\"dismissDialog\"}");
        assertThat(Json.write(Directives.setState("chat_model", "Opus")))
                .isEqualTo("{\"op\":\"setState\",\"id\":\"chat_model\",\"value\":\"Opus\"}");
        assertThat(Json.write(Directives.toast("hi")))
                .isEqualTo("{\"op\":\"toast\",\"text\":\"hi\"}");
        assertThat(Json.write(Directives.toast("hi", "error")))
                .isEqualTo("{\"op\":\"toast\",\"text\":\"hi\",\"style\":\"error\"}");
        assertThat(Json.write(Directives.setToken("t")))
                .isEqualTo("{\"op\":\"setToken\",\"value\":\"t\"}");
        assertThat(Json.write(Directives.clearToken())).isEqualTo("{\"op\":\"clearToken\"}");
        assertThat(Json.write(Directives.setServerUrl("https://jhin")))
                .isEqualTo("{\"op\":\"setServerUrl\",\"value\":\"https://jhin\"}");
        assertThat(Json.write(Directives.openProfiles())).isEqualTo("{\"op\":\"openProfiles\"}");
        assertThat(Json.write(Directives.openUrl("https://jhin")))
                .isEqualTo("{\"op\":\"openUrl\",\"value\":\"https://jhin\"}");
    }

    @Test
    void theUndoNoticeToastKeepsItsActionAndDuration() {
        Map<String, Object> toast = Directives.toast(
                "Settled 1 thread,", Map.of("op", "undo"), 5000);

        assertThat(Json.write(toast)).isEqualTo(
                "{\"op\":\"toast\",\"text\":\"Settled 1 thread,\","
                        + "\"action\":{\"op\":\"undo\"},\"duration\":5000}");
    }

    @Test
    void theInlineClientCompositeKeepsItsShape() {
        Map<String, Object> composite = Directives.client(List.of(
                Directives.setState("chat_dispatch", "queue"),
                Directives.refresh()));

        assertThat(Json.write(composite)).isEqualTo(
                "{\"client\":[{\"op\":\"setState\",\"id\":\"chat_dispatch\","
                        + "\"value\":\"queue\"},{\"op\":\"refresh\"}]}");
    }

    // --- escaping through the fragment ---

    @Test
    void scriptPayloadsRenderEscapedInDirectiveHtml() {
        UiNode hostile = Ui.text("<script>alert(1)</script>").build();

        for (Map<String, Object> directive : List.of(
                Directives.patch("x", hostile),
                Directives.setScreen("x", hostile),
                Directives.dialog(hostile))) {
            String wire = Json.write(directive);
            assertThat(wire).contains("&lt;script");
            assertThat(wire).doesNotContain("<script");
        }
    }

    // --- the control plane stays intact ---

    @Test
    void uiNodeToJsonStillEmitsTheNodeTreeShape() {
        Map<String, Object> json = Ui.text("hi").id("t-1").build().toJson();

        assertThat(json).containsEntry("type", "text")
                .containsEntry("text", "hi")
                .containsEntry("id", "t-1");
    }
}
