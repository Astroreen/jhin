/**
 * The T103 composer control surface: the header row of decorative pickers
 * (model, provider, effort, access mode, workspace, branch, host — each a
 * {@code demo} button whose action opens its dialog; the dialog options
 * dispatch the inline directive composite, {@code setState} + the preview
 * toast), the context chips row (the six upstream ContextChip kinds), the
 * decorative context-window meter (green / yellow / red with the hard stops
 * at 50 / 80%), the footer row (attach, voice, the prompt-stash menu, the
 * queue badge, the real send action, the stop button while a run is live and
 * the Direct/Queue/Steer split menu) and the invisible seed carriers of the
 * decorative defaults.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.sdk.json.Json;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ComposerRowsTest {

    private static final String SESSION_ID = "s-1";

    @Test
    void headerRowCarriesTheSevenDemoPickersWithDialogActions() {
        Map<String, Object> json = render(List.of());

        Map<String, Object> controls = byId(json, ChatScreen.CONTROLS_ID);
        List<Map<String, Object>> dialogs = descendants(controls, "button").stream()
                .filter(node -> node.get("action") instanceof Map<?, ?> action
                        && "dialog".equals(((Map<?, ?>) action).get("op")))
                .toList();
        assertThat(dialogs).hasSize(7);
        assertThat(descendants(controls, "row").stream().map(node -> node.get("id")))
                .contains(
                        ChatScreen.PICKER_MODEL + "-control",
                        ChatScreen.PICKER_PROVIDER + "-control",
                        ChatScreen.PICKER_EFFORT + "-control",
                        ChatScreen.PICKER_MODE + "-control",
                        ChatScreen.PICKER_WORKSPACE + "-control",
                        ChatScreen.PICKER_BRANCH + "-control",
                        ChatScreen.PICKER_HOST + "-control");

        for (Map<String, Object> dialogButton : dialogs) {
            assertThat(dialogButton).containsEntry("demo", true);
            assertThat(byId(json, String.valueOf(dialogButton.get("id")))).isNotNull();
        }
    }

    @Test
    void everyPickerDialogListsOptionsThatSetStateAndToast() {
        Map<String, Object> json = render(List.of());

        Map<String, Object> modelDialog = byId(json, "composer-model-dialog");
        assertThat(modelDialog).isNotNull();
        List<Map<String, Object>> options = descendants(modelDialog, "button").stream()
                .filter(node -> node.get("action") instanceof Map<?, ?> action
                        && action.containsKey("client"))
                .toList();
        assertThat(options).hasSize(4);

        Map<String, Object> first = options.get(0);
        assertThat(first).containsEntry("demo", true).containsEntry("label", "Opus 4.6");
        assertThat(castList(castMap(first.get("action")).get("client"))).hasSize(2);
        Map<String, Object> setState = castMap(castList(castMap(first.get("action")).get("client")).get(0));
        assertThat(setState).containsEntry("op", "setState")
                .containsEntry("id", ChatScreen.STATE_MODEL)
                .containsEntry("value", "Opus 4.6");
        Map<String, Object> toast = castMap(castList(castMap(first.get("action")).get("client")).get(1));
        assertThat(toast).containsEntry("op", "toast");
        assertThat(String.valueOf(toast.get("text"))).contains("preview only");

        // The dialog title row carries the keyboard chord hint (mod+shift+m).
        assertThat(Json.write(modelDialog)).contains("mod+shift+m");
        // The dialog closes through the Done action.
        Map<String, Object> done = descendants(modelDialog, "button").stream()
                .filter(node -> node.get("action") instanceof Map<?, ?> action
                        && "dismissDialog".equals(((Map<?, ?>) action).get("op")))
                .findFirst()
                .orElseThrow();
        assertThat(done).containsEntry("label", "Done");

        // The remaining six dialogs exist with their option lists.
        assertThat(byId(json, "composer-provider-dialog")).isNotNull();
        assertThat(byId(json, "composer-effort-dialog")).isNotNull();
        assertThat(byId(json, "composer-mode-dialog")).isNotNull();
        assertThat(byId(json, "composer-workspace-dialog")).isNotNull();
        assertThat(byId(json, "composer-branch-dialog")).isNotNull();
        assertThat(byId(json, "composer-host-dialog")).isNotNull();
        assertThat(Json.write(byId(json, "composer-effort-dialog")))
                .contains("Low").contains("Med").contains("High");
        assertThat(Json.write(byId(json, "composer-mode-dialog")))
                .contains("Read only").contains("Ask").contains("Full access");
    }

    @Test
    void chipsRowRendersTheSixContextChipKinds() {
        Map<String, Object> json = render(List.of());

        Map<String, Object> chips = byId(json, ChatScreen.CHIPS_ID);
        List<Map<String, Object>> chipNodes = descendants(chips, "chip");
        assertThat(chipNodes).hasSize(6);
        assertThat(chipNodes.stream().map(node -> node.get("kind")))
                .containsExactly("mention", "skill", "thread", "image", "file", "terminal");
        for (Map<String, Object> chip : chipNodes) {
            assertThat(chip).containsEntry("demo", true);
            Map<String, Object> action = castMap(chip.get("action"));
            assertThat(action).containsKey("client");
        }
        assertThat(Json.write(chips))
                .contains("@ada").contains("jhin-plugin").contains("Fix the login bug")
                .contains("screenshot.png").contains("src/auth.java").contains("build output");
    }

    @Test
    void contextMeterIsTheDemoGradientBarWithStopsAtFiftyAndEighty() {
        Map<String, Object> json = render(List.of());

        Map<String, Object> meter = byId(json, ChatScreen.METER_ID);
        assertThat(meter).containsEntry("type", "box")
                .containsEntry("height", 6)
                .containsEntry("demo", true);
        Map<String, Object> gradient = castMap(meter.get("gradient"));
        assertThat(gradient).doesNotContainKey("type")
                .containsEntry("begin", "centerLeft")
                .containsEntry("end", "centerRight");
        assertThat(castList(gradient.get("colors"))).containsExactly(
                "$color.success", "$color.success",
                "$color.warning", "$color.warning",
                "$color.error", "$color.error");
        assertThat(castList(gradient.get("stops"))).containsExactly(0.0, 0.5, 0.5, 0.8, 0.8, 1.0);
    }

    @Test
    void footerRowCarriesAttachVoiceStashQueueSendAndSplit() {
        Map<String, Object> json = render(List.of());

        Map<String, Object> footer = byId(json, ChatScreen.FOOTER_ID);
        List<Map<String, Object>> icons = descendants(footer, "icon_button").stream()
                .filter(node -> Boolean.TRUE.equals(node.get("demo")))
                .toList();
        assertThat(icons.stream().map(node -> node.get("icon")))
                .contains("attach_file", "mic");
        for (Map<String, Object> icon : icons) {
            Map<String, Object> action = castMap(icon.get("action"));
            assertThat(action).containsKey("client");
        }

        // The send split-button menu: the Direct/Queue/Steer items dispatch
        // the composite that flips the dispatch state and toasts.
        Map<String, Object> menu = byId(json, "composer-send-menu");
        List<Map<String, Object>> items = castList(menu.get("items")).stream()
                .map(ComposerRowsTest::castMap)
                .toList();
        assertThat(items.stream().map(node -> node.get("label")))
                .containsExactly("Direct", "Queue", "Steer");
        Map<String, Object> queueAction = castMap(items.get(1).get("action"));
        List<Object> queueOps = castList(queueAction.get("client"));
        assertThat(castMap(queueOps.get(0)))
                .containsEntry("op", "setState")
                .containsEntry("id", ChatScreen.STATE_DISPATCH)
                .containsEntry("value", "queue");

        // The queue badge shows only while the dispatch mode is queue.
        Map<String, Object> badge = byId(json, ChatScreen.QUEUE_BADGE_ID);
        assertThat(badge).containsEntry("demo", true)
                .containsEntry("count", 2)
                .containsEntry("when", ChatScreen.STATE_DISPATCH + " == 'queue'");

        // The prompt-stash menu opens the dialog with the two inputs.
        Map<String, Object> stash = byId(json, "composer-stash-menu");
        assertThat(Json.write(stash)).contains("Stash prompt…").contains("bookmark");
        Map<String, Object> stashDialog = byId(json, "composer-stash-dialog");
        assertThat(descendants(stashDialog, "input").stream().map(node -> node.get("id")))
                .containsExactly("stash-prompt", "stash-name");
    }

    @Test
    void seedCarriersHoldTheDecorativeDefaultsInvisibly() {
        Map<String, Object> json = render(List.of());

        Map<String, Object> seeds = descendants(json, "container").stream()
                .filter(node -> Boolean.FALSE.equals(node.get("visible")))
                .findFirst()
                .orElseThrow();
        List<Map<String, Object>> inputs = descendants(seeds, "input");
        assertThat(inputs).hasSize(8);
        Map<String, Object> model = inputs.stream()
                .filter(node -> ChatScreen.STATE_MODEL.equals(node.get("id")))
                .findFirst()
                .orElseThrow();
        assertThat(model).containsEntry("value", "Opus 4.6").containsEntry("visible", false);
        assertThat(inputs.stream().map(node -> node.get("id"))).contains(
                ChatScreen.STATE_PROVIDER, ChatScreen.STATE_EFFORT, ChatScreen.STATE_MODE,
                ChatScreen.STATE_WORKSPACE, ChatScreen.STATE_BRANCH, ChatScreen.STATE_HOST,
                ChatScreen.STATE_DISPATCH);
    }

    // --- fixture ---

    private static Map<String, Object> render(List<EventRecord> history) {
        Session session = new Session(SESSION_ID, "acc-1", "demo", "/tmp/work",
                null, null, "active", 0L, 0L, false, null, null, null, null,
                false, null, null, false);
        return ChatScreen.render(session, history).toJson();
    }

    private static EventRecord event(long seq, EventType type, String payload) {
        return new EventRecord(SESSION_ID, seq, seq * 1000L, type, payload);
    }

    // --- node walking helpers over the JSON wire shape ---

    private static Map<String, Object> byId(Object fragment, String id) {
        List<Map<String, Object>> found = new java.util.ArrayList<>();
        walk(fragment, map -> {
            if (id.equals(map.get("id"))) {
                found.add(map);
            }
        });
        return found.isEmpty() ? null : found.get(0);
    }

    private static List<Map<String, Object>> descendants(Object fragment, String type) {
        List<Map<String, Object>> found = new java.util.ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

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

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object value) {
        return (List<Object>) value;
    }
}
