/**
 * The T70 keybinding actions: {@code keybind-edit} opens the rebind sheet
 * (dialog, {@code kind: "sheet"}) around the reserved {@code keyCapture}
 * capture field, and the three mutation names answer the feedback
 * directives. The user keymap persistence itself is client-side.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.sdk.http.ClientInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class KeybindActionsTest {

    @Test
    void editOpensTheCaptureSheetWithTheCurrentChord() {
        FakeHttpRequest req = requestWithOverrides(
                "{\"rules\":[{\"command\":\"composer.send\",\"keys\":\"mod+shift+enter\"}]}");
        List<Map<String, Object>> directives =
                KeybindActions.edit(req, Map.of("command", "composer.send"));

        assertThat(directives).hasSize(1);
        Map<String, Object> dialog = directives.get(0);
        assertThat(dialog).containsEntry("op", "dialog").containsEntry("kind", "sheet");
        assertThat(dialog).doesNotContainKey("node");

        String html = String.valueOf(dialog.get("html"));
        assertThat(html).startsWith("<").contains("data-jhin-type=");
        assertThat(html).contains("data-jhin-type=\"input\"")
                .contains("data-jhin-type=\"button\"")
                .contains("data-jhin-type=\"row\"");
        // The capture field carries its id, the pre-filled chord and required.
        assertThat(html).contains("keyCapture")
                .contains("mod+shift+enter")
                .contains("required=\"required\"");
        // Save posts back with the captured value included; Cancel is a
        // client-side dismissDialog directive.
        assertThat(html).contains("keybind-save").contains("keyCapture")
                .contains("dismissDialog");
    }

    @Test
    void editWithoutAHeaderPrefillsNoChord() {
        List<Map<String, Object>> directives =
                KeybindActions.edit(requestWithOverrides(""), Map.of("command", "palette.open"));
        String html = String.valueOf(directives.get(0).get("html"));
        assertThat(html).contains("data-jhin-type=\"input\"").contains("value=\"\"");
    }

    @Test
    void saveClosesTheSheetAndRefreshesTheRows() {
        List<Map<String, Object>> directives = KeybindActions.save(
                requestWithOverrides(""), Map.of("command", "composer.send"));
        assertThat(ops(directives)).containsExactly("dismissDialog", "toast", "refresh");
    }

    @Test
    void resetAndRestoreAnswerToastAndRefresh() {
        assertThat(ops(KeybindActions.reset(
                requestWithOverrides(""), Map.of("command", "composer.send"))))
                .containsExactly("toast", "refresh");
        assertThat(ops(KeybindActions.restore(requestWithOverrides(""), Map.of())))
                .containsExactly("toast", "refresh");
    }

    @Test
    void clientKeybindingsParseIsTotal() {
        assertThat(ClientKeybindings.parse("")).isEmpty();
        assertThat(ClientKeybindings.parse("not json at all")).isEmpty();
        assertThat(ClientKeybindings.parse("{\"rules\":\"oops\"}")).isEmpty();
        assertThat(ClientKeybindings.parse(
                "{\"rules\":[{\"command\":\"composer.send\",\"keys\":\"mod+shift+enter\"},"
                        + "{\"command\":\"no-keys\"},\"junk\"]}"))
                .containsExactlyEntriesOf(Map.of("composer.send", "mod+shift+enter"));
        assertThat(ClientKeybindings.of(requestWithOverrides("garbage"))).isEmpty();
    }

    @Test
    void paletteMetadataCarriesTheFourGroupsWithCounts() {
        List<Map<String, Object>> groups =
                ClientKeybindings.paletteMetadata(requestWithOverrides(""));

        assertThat(groups).hasSize(4);
        assertThat(groups).extracting(group -> group.get("value"))
                .containsExactly("actions", "threads", "projects", "models");

        Map<String, Object> actions = group(groups, "actions");
        assertThat(actions).containsEntry("label", "Actions");
        assertThat(actions.get("count")).isEqualTo(KeybindCatalog.commands().size());

        Map<String, Object> models = group(groups, "models");
        assertThat(models).containsEntry("label", "Models");
        assertThat(models.get("count")).isEqualTo(3);
        for (Object item : castList(models.get("items"))) {
            assertThat(castMap(item)).containsEntry("demo", true);
        }

        assertThat(group(groups, "threads").get("count")).isEqualTo(0);
        assertThat(group(groups, "projects").get("count")).isEqualTo(0);
    }

    @Test
    void paletteMetadataAppliesTheClientOverrides() {
        List<Map<String, Object>> groups = ClientKeybindings.paletteMetadata(
                requestWithOverrides(
                        "{\"rules\":[{\"command\":\"composer.send\","
                                + "\"keys\":\"mod+shift+enter\"}]}"));

        Map<String, Object> send = item(group(groups, "actions"), "composer.send");
        assertThat(send)
                .containsEntry("chord", "mod+shift+enter")
                .containsEntry("subtitle", "composer.send")
                .containsEntry("demo", false);
    }

    private static Map<String, Object> group(List<Map<String, Object>> groups, String value) {
        for (Map<String, Object> group : groups) {
            if (value.equals(group.get("value"))) {
                return group;
            }
        }
        throw new AssertionError("no palette group " + value);
    }

    private static Map<String, Object> item(Map<String, Object> group, String id) {
        for (Object entry : castList(group.get("items"))) {
            Map<String, Object> item = castMap(entry);
            if (id.equals(item.get("id"))) {
                return item;
            }
        }
        throw new AssertionError("no palette item " + id);
    }

    private static FakeHttpRequest requestWithOverrides(String header) {
        return new FakeHttpRequest("POST", "/ui/action/keybind-edit",
                Map.of(), Map.of(), "{}", ClientInfo.UNKNOWN,
                Map.of(ClientKeybindings.HEADER, header));
    }

    private static List<String> ops(List<Map<String, Object>> directives) {
        List<String> ops = new ArrayList<>();
        for (Map<String, Object> directive : directives) {
            ops.add(String.valueOf(directive.get("op")));
        }
        return ops;
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
