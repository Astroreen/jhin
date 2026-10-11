/**
 * T108: the browser-preview panel chrome and the permissions dialog shell.
 *
 * <p>The Preview tab carries the browser-preview section — the read-only URL
 * bar with the decorative Reload button, the {@code preview-loading} progress
 * bar and the illustrated viewport placeholder — over the retained T107 file
 * preview. The permissions dialog is the access-mode picker shell: the three
 * upstream permission modes as a radio group, a demo note and the Save
 * button. Every interactive node is {@code demo}-marked and dispatches inline
 * directives or the decorative {@code preview-reload} action only.
 */
package com.astroreen.jhin.plugin.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.plugin.ui.screens.RightPanelBuilder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PreviewPanelTest {

    private static final String SESSION_ID = "s-1";

    @Test
    void thePreviewTabCarriesTheBrowserChrome() {
        Map<String, Object> json = render();

        Map<String, Object> preview = node(json, "column", RightPanelBuilder.PREVIEW_ID);
        assertThat(preview).isNotNull();
        assertThat(node(json, "column", RightPanelBuilder.PREVIEW_BROWSER_ID)).isNotNull();
        assertThat(node(json, "row", RightPanelBuilder.PREVIEW_URL_BAR_ID)).isNotNull();
        assertThat(node(json, "column", RightPanelBuilder.PREVIEW_VIEWPORT_ID)).isNotNull();
    }

    @Test
    void theUrlBarIsAReadOnlyRequiredInputWithTheDecorativeReload() {
        Map<String, Object> json = render();

        Map<String, Object> input =
                node(json, "input", RightPanelBuilder.PREVIEW_URL_ID);
        assertThat(input).isNotNull()
                .containsEntry("value", RightPanelBuilder.PREVIEW_URL_VALUE)
                .containsEntry("readOnly", true)
                .containsEntry("required", true)
                .containsEntry("errorText", RightPanelBuilder.PREVIEW_URL_ERROR);

        Map<String, Object> reload =
                node(json, "icon_button", RightPanelBuilder.PREVIEW_RELOAD_ID);
        assertThat(reload).isNotNull()
                .containsEntry("icon", "refresh")
                .containsEntry("demo", true);
        Map<String, Object> action = castMap(reload.get("action"));
        assertThat(action).containsEntry("path", "/ui/action/preview-reload")
                .containsEntry("name", "preview-reload");
        assertThat(castList(action.get("include")))
                .containsExactly(RightPanelBuilder.PREVIEW_URL_ID);
    }

    @Test
    void theProgressBarIsThePreviewLoadingModeHiddenUntilReload() {
        Map<String, Object> json = render();

        Map<String, Object> progress =
                node(json, "progress", RightPanelBuilder.PREVIEW_PROGRESS_ID);
        assertThat(progress).isNotNull()
                .containsEntry("statusPulse", RightPanelBuilder.PREVIEW_LOADING_MODE)
                .containsEntry("loading", false);
    }

    @Test
    void theViewportIsTheIllustratedPlaceholder() {
        Map<String, Object> json = render();

        Map<String, Object> figure =
                node(json, "figure", RightPanelBuilder.PREVIEW_FIGURE_ID);
        assertThat(figure).isNotNull()
                .containsEntry("shape", "rectangle")
                .containsEntry("width", 160)
                .containsEntry("height", 96);
        assertThat(textsOf(node(json, "column", RightPanelBuilder.PREVIEW_VIEWPORT_ID)))
                .contains("Preview is not available in this build");
    }

    @Test
    void theFilePreviewIsRetainedBelowTheBrowserChrome() {
        Map<String, Object> json = render();

        assertThat(node(json, "column", RightPanelBuilder.PREVIEW_FILE_ID)).isNotNull();
        Map<String, Object> code =
                node(json, "code_block", RightPanelBuilder.PREVIEW_CODE_ID);
        assertThat(code).isNotNull().containsEntry("language", "typescript");
        assertThat(node(json, "button", RightPanelBuilder.PREVIEW_OPEN_ID)).isNotNull();
    }

    @Test
    void thePermissionsDialogCarriesTheThreeModesTheNoteAndSave() {
        Map<String, Object> json = render();

        String dialog = dialogHtmlOf(json, ChatScreen.PICKER_MODE);
        assertThat(dialog).startsWith("<").contains(ChatScreen.PERMISSIONS_DIALOG_ID);

        assertThat(dialog).contains(ChatScreen.PERMISSIONS_MODES_ID);
        assertThat(dialog).contains(ChatScreen.PERMISSION_MODES.get(0),
                ChatScreen.PERMISSION_MODES.get(1), ChatScreen.PERMISSION_MODES.get(2));
        // Every row is a demo radio row with a leading radio glyph.
        assertThat(dialog).contains("radio_button_checked").contains("radio_button_unchecked");

        assertThat(dialog).contains(ChatScreen.PERMISSIONS_NOTE_ID).contains("Preview only");

        assertThat(dialog).contains(ChatScreen.PERMISSIONS_SAVE_ID).contains("Save");
        assertThat(dialog).contains("toast", "dismissDialog");
    }

    @Test
    void aPermissionRowFlipsTheRadioGroupAndSetsTheMode() {
        Map<String, Object> json = render();

        String dialog = dialogHtmlOf(json, ChatScreen.PICKER_MODE);
        // The row dispatch sets the local mode...
        assertThat(dialog).contains("setState").contains(ChatScreen.STATE_MODE)
                .contains("Full access");
        // ...and flips the three radio glyphs through patch fragments whose
        // html is the glyph re-rendered in its new state (one checked).
        assertThat(dialog).contains("radio_button_checked").contains("radio_button_unchecked");
        assertThat(dialog).contains("selected (preview only)");
    }

    // --- fixture and walkers ---

    private static Map<String, Object> render() {
        Session session = new Session(SESSION_ID, "acc-1", "demo", "/tmp/work",
                "Opus 4.6", "anthropic", "active", 0L, 0L, false, null, null,
                null, null, false, null, null, false);
        return ChatScreen.render(session, List.of()).toJson();
    }

    /** The dialog fragment one picker button opens (the action's {@code html}). */
    private static String dialogHtmlOf(Map<String, Object> tree, String pickerId) {
        Map<String, Object> button = node(tree, "button", pickerId);
        assertThat(button).as("picker " + pickerId).isNotNull();
        return String.valueOf(castMap(button.get("action")).get("html"));
    }

    /** The text values of every descendant text node. */
    private static List<String> textsOf(Object fragment) {
        List<String> texts = new ArrayList<>();
        walk(fragment, map -> {
            if ("text".equals(map.get("type")) && map.get("text") instanceof String text) {
                texts.add(text);
            }
        });
        return texts;
    }

    private static Map<String, Object> node(Map<String, Object> tree, String type, String id) {
        return descendantsOfType(tree, type).stream()
                .filter(found -> id.equals(found.get("id")))
                .findFirst()
                .orElse(null);
    }

    private static List<Map<String, Object>> descendantsOfType(Object fragment, String type) {
        List<Map<String, Object>> found = new ArrayList<>();
        walk(fragment, map -> {
            if (type.equals(map.get("type"))) {
                found.add(map);
            }
        });
        return found;
    }

    private static void walk(Object fragment,
                             java.util.function.Consumer<Map<String, Object>> seen) {
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
