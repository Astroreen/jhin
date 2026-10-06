/**
 * The T114 {@code welcome} screen: the shell chrome, the three-step wizard
 * card, the step panels gated on the {@code welcomeStep} local field, the
 * inline {@code setState} Next/Back controls and the Finish navigation to
 * {@code chat:new}. Every interactive node carries {@code demo: true} (plan
 * section 14.10).
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.ui.screens.WelcomeScreen;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class WelcomeScreenTest {

    @Test
    void theScreenIsAShellWithTheWizardCard() {
        Map<String, Object> json = WelcomeScreen.render().toJson();

        assertThat(typesIn(json)).contains("screen", "shell", "card");
        Map<String, Object> shell = nodesOfType(json, "shell").get(0);
        assertThat(shell).containsEntry("id", WelcomeScreen.SHELL_ID)
                .containsEntry("breakpoint", WelcomeScreen.BREAKPOINT);
        assertThat(nodesWithId(json, WelcomeScreen.CARD_ID)).hasSize(1);
        assertThat(stringsIn(json)).contains("Welcome", "Set up Jhin");
    }

    @Test
    void theStepStripSeedsTheStepField() {
        Map<String, Object> json = WelcomeScreen.render().toJson();

        Map<String, Object> strip = nodesWithId(json, WelcomeScreen.STEP_ID).get(0);
        assertThat(strip).containsEntry("type", "segmented").containsEntry("value", 0);
        assertThat(castList(strip.get("segments"))).hasSize(3);
    }

    @Test
    void theThreeStepPanelsAreGatedOnTheStepField() {
        Map<String, Object> json = WelcomeScreen.render().toJson();

        assertThat(nodesWithId(json, WelcomeScreen.STEP_THEME_ID).get(0))
                .containsEntry("when", WelcomeScreen.STEP_ID + " == 0");
        assertThat(nodesWithId(json, WelcomeScreen.STEP_HOST_ID).get(0))
                .containsEntry("when", WelcomeScreen.STEP_ID + " == 1");
        assertThat(nodesWithId(json, WelcomeScreen.STEP_THREAD_ID).get(0))
                .containsEntry("when", WelcomeScreen.STEP_ID + " == 2");
        assertThat(stringsIn(json)).contains("Pick a theme", "Connect a host", "Start a thread");
    }

    @Test
    void theNextAndBackControlsWriteTheStepField() {
        Map<String, Object> json = WelcomeScreen.render().toJson();

        List<Map<String, Object>> nexts = nodesWithId(json, WelcomeScreen.NEXT_ID);
        assertThat(nexts).hasSize(2);
        for (Map<String, Object> next : nexts) {
            assertThat(setStateValue(next)).isIn(1, 2);
        }
        List<Map<String, Object>> backs = nodesWithId(json, WelcomeScreen.BACK_ID);
        assertThat(backs).hasSize(2);
        for (Map<String, Object> back : backs) {
            assertThat(setStateValue(back)).isIn(0, 1);
        }
    }

    @Test
    void theFinishControlNavigatesToTheNewChat() {
        Map<String, Object> json = WelcomeScreen.render().toJson();

        Map<String, Object> finish = nodesWithId(json, WelcomeScreen.FINISH_ID).get(0);
        assertThat(finish).containsEntry("type", "button").containsEntry("demo", true);
        Map<String, Object> action = castMap(finish.get("action"));
        List<Object> client = castList(action.get("client"));
        assertThat(castMap(client.get(0))).containsEntry("op", "navigate")
                .containsEntry("screen", "chat:new");
    }

    @Test
    void everyInteractiveNodeCarriesTheDemoMarker() {
        Map<String, Object> json = WelcomeScreen.render().toJson();

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

    private static Object setStateValue(Map<String, Object> node) {
        Map<String, Object> action = castMap(node.get("action"));
        List<Object> client = castList(action.get("client"));
        return castMap(client.get(0)).get("value");
    }

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