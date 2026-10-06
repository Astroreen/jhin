/**
 * The T114 {@code connect} screen: the shell chrome, the device-connection
 * explainer card, the connect command, the decorative connection-code input,
 * the docs link and the decorative Connect control. Every interactive node
 * carries {@code demo: true} (plan section 14.10).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.ui.screens.ConnectScreen;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ConnectScreenTest {

    @Test
    void theScreenIsAShellWithTheExplainerCard() {
        Map<String, Object> json = ConnectScreen.render().toJson();

        assertThat(typesIn(json)).contains("screen", "shell", "card");
        Map<String, Object> shell = nodesOfType(json, "shell").get(0);
        assertThat(shell).containsEntry("id", ConnectScreen.SHELL_ID)
                .containsEntry("breakpoint", ConnectScreen.BREAKPOINT);
        assertThat(nodesWithId(json, ConnectScreen.CARD_ID)).hasSize(1);
        assertThat(stringsIn(json)).contains("Connect", "Connect your terminal");
    }

    @Test
    void theCardCarriesTheConnectCommandAndTheCodeInput() {
        Map<String, Object> json = ConnectScreen.render().toJson();

        assertThat(nodesOfType(json, "code_block")).hasSize(1);
        assertThat(stringsIn(json)).contains("npx jhin connect");
        Map<String, Object> input = nodesWithId(json, ConnectScreen.CODE_INPUT_ID).get(0);
        assertThat(input).containsEntry("type", "input").containsEntry("demo", true);
    }

    @Test
    void theDocsLinkOpensTheDocsUrl() {
        Map<String, Object> json = ConnectScreen.render().toJson();

        Map<String, Object> docs = nodesWithId(json, ConnectScreen.DOCS_ID).get(0);
        assertThat(docs).containsEntry("demo", true);
        assertThat(castMap(docs.get("action"))).containsEntry("op", "openUrl")
                .containsEntry("value", ConnectScreen.DOCS_URL);
    }

    @Test
    void theConnectControlOnlyToastsThePreviewNotice() {
        Map<String, Object> json = ConnectScreen.render().toJson();

        Map<String, Object> connect = nodesWithId(json, ConnectScreen.CONNECT_ID).get(0);
        assertThat(connect).containsEntry("demo", true);
        Map<String, Object> action = castMap(connect.get("action"));
        List<Object> client = castList(action.get("client"));
        assertThat(castMap(client.get(0))).containsEntry("op", "toast");
    }

    @Test
    void everyInteractiveNodeCarriesTheDemoMarker() {
        Map<String, Object> json = ConnectScreen.render().toJson();

        List<Map<String, Object>> interactive = new ArrayList<>();
        walk(json, map -> {
            String type = String.valueOf(map.get("type"));
            if ("button".equals(type) || "icon_button".equals(type) || "switch".equals(type)
                    || "segmented".equals(type) || "list_row".equals(type)
                    || "dropdown".equals(type) || "input".equals(type)) {
                interactive.add(map);
            }
        });
        assertThat(interactive).isNotEmpty();
        assertThat(interactive).allSatisfy(node ->
                assertThat(node).containsEntry("demo", true));
    }

    // --- node walking helpers over the JSON wire shape ---

    private static List<Map<String, Object>> nodesOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static List<Map<String, Object>> nodesWithId(Object fragment, String id) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (id.equals(map.get("id"))) {
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

    private static List<String> stringsIn(Object fragment) {
        List<String> texts = new ArrayList<>();
        collectStrings(fragment, texts);
        return texts;
    }

    private static void collectStrings(Object fragment, List<String> texts) {
        if (fragment instanceof String text) {
            texts.add(text);
        } else if (fragment instanceof Map<?, ?> map) {
            for (Object value : map.values()) {
                collectStrings(value, texts);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                collectStrings(nested, texts);
            }
        }
    }

    private static void walk(Object fragment, java.util.function.Consumer<Map<String, Object>> seen) {
        if (fragment instanceof Map<?, ?> map) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                copy.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            seen.accept(copy);
            for (Object nested : map.values()) {
                walk(nested, seen);
            }
        } else if (fragment instanceof List<?> list) {
            for (Object nested : list) {
                walk(nested, seen);
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