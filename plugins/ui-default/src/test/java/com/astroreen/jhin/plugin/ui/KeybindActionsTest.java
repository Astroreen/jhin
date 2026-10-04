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
import java.util.function.Consumer;
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

        Map<String, Object> node = castMap(dialog.get("node"));
        assertThat(typesIn(node)).contains("input", "button", "row");
        assertThat(inputIds(node)).contains(KeybindActions.CAPTURE_ID);
        // The current chord pre-fills the capture field.
        Map<String, Object> capture = nodesOfType(node, "input").get(0);
        assertThat(capture).containsEntry("id", "keyCapture")
                .containsEntry("value", "mod+shift+enter")
                .containsEntry("required", true);

        // Save posts back with the captured value included; Cancel is a
        // client-side dismissDialog directive.
        Map<String, Object> save = button(node, "Save");
        Map<String, Object> action = castMap(save.get("action"));
        assertThat(action).containsEntry("name", "keybind-save");
        assertThat(castList(action.get("include"))).containsExactly("keyCapture");
        Map<String, Object> cancel = button(node, "Cancel");
        assertThat(castMap(cancel.get("action"))).containsEntry("op", "dismissDialog");
    }

    @Test
    void editWithoutAHeaderPrefillsNoChord() {
        List<Map<String, Object>> directives =
                KeybindActions.edit(requestWithOverrides(""), Map.of("command", "palette.open"));
        Map<String, Object> node = castMap(directives.get(0).get("node"));
        Map<String, Object> capture = nodesOfType(node, "input").get(0);
        assertThat(capture).containsEntry("value", "");
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

    private static Map<String, Object> button(Object fragment, String label) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if ("button".equals(map.get("type")) && label.equals(map.get("label"))) {
                found.add(map);
            }
        });
        assertThat(found).as("button " + label).hasSize(1);
        return found.get(0);
    }

    private static List<String> inputIds(Object fragment) {
        List<String> ids = new ArrayList<>();
        walk(fragment, map -> {
            if ("input".equals(map.get("type")) && map.get("id") != null) {
                ids.add(String.valueOf(map.get("id")));
            }
        });
        return ids;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> nodesOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static java.util.Set<String> typesIn(Object fragment) {
        java.util.Set<String> types = new java.util.HashSet<>();
        walk(fragment, map -> {
            if (map.get("type") != null) {
                types.add(String.valueOf(map.get("type")));
            }
        });
        return types;
    }

    @SuppressWarnings("unchecked")
    private static void walk(Object fragment, Consumer<Map<String, Object>> visit) {
        if (fragment instanceof Map<?, ?> map) {
            visit.accept((Map<String, Object>) map);
            for (Object value : map.values()) {
                walk(value, visit);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object item : list) {
                walk(item, visit);
            }
        }
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
