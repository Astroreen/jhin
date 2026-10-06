/**
 * The T70 keybinding actions of {@code POST /ui/action/{name}}:
 * {@code keybind-edit} opens the rebind sheet (a {@code dialog} with
 * {@code kind: "sheet"} carrying the reserved {@code keyCapture} capture
 * field) and {@code keybind-save} / {@code keybind-reset} /
 * {@code keybind-restore} answer the feedback directives. The user keymap
 * itself is persisted client-side (store key {@code keybindings}) as a
 * dispatch side effect of these action names; the server only renders —
 * the current chords arrive per request in {@code X-Jhin-Keybindings}.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.ui.screens.ActionDescriptors;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;

final class KeybindActions {

    /** The reserved key-capture input id (docs/sdui.md section 2.6). */
    static final String CAPTURE_ID = "keyCapture";

    private KeybindActions() {
    }

    /**
     * {@code keybind-edit}: the rebind sheet — a capture field that records
     * the next keystroke as a chord spec plus Save (posts back with the
     * captured value included) and Cancel.
     *
     * @param req     the request carrying the current chord header
     * @param payload the merged payload ({@code command} names the row)
     * @return the {@code dialog} directive opening the sheet
     */
    static List<Map<String, Object>> edit(HttpRequest req, Map<String, Object> payload) {
        String command = String.valueOf(payload.getOrDefault("command", ""));
        String current = ClientKeybindings.of(req).getOrDefault(command, "");
        UiNode form = Ui.container()
                .direction("column")
                .gap(12)
                .padding(16)
                .child(Ui.text("Press the new chord for " + KeybindCatalog.label(command))
                        .style("h3")
                        .build())
                .child(Ui.text(command).style("caption").build())
                .child(Ui.input(CAPTURE_ID)
                        .label("Chord")
                        .placeholder("Press a chord…")
                        .value(current)
                        .required(true)
                        .errorText("Press a chord first")
                        .build())
                .child(Ui.row()
                        .child(Ui.button("Save")
                                .action(ActionDescriptors.of("keybind-save",
                                        Map.of("command", command), List.of(CAPTURE_ID)))
                                .build())
                        .child(Ui.button("Cancel")
                                .style("text")
                                .action(Directives.dismissDialog())
                                .build())
                        .build())
                .build();
        return List.of(Directives.dialog(form.toJson(), "sheet"));
    }

    /**
     * {@code keybind-save}: close the sheet and re-render the rows.
     *
     * @param req     the request
     * @param payload the merged payload ({@code command} + the included
     *                {@code keyCapture} chord; the client persisted it)
     * @return {@code [dismissDialog, toast, refresh]}
     */
    static List<Map<String, Object>> save(HttpRequest req, Map<String, Object> payload) {
        String command = String.valueOf(payload.getOrDefault("command", ""));
        return List.of(
                Directives.dismissDialog(),
                Directives.toast("Saved " + command, null),
                Directives.refresh());
    }

    /**
     * {@code keybind-reset}: the row falls back to its server default.
     *
     * @param req     the request
     * @param payload the merged payload ({@code command})
     * @return {@code [toast, refresh]}
     */
    static List<Map<String, Object>> reset(HttpRequest req, Map<String, Object> payload) {
        String command = String.valueOf(payload.getOrDefault("command", ""));
        return List.of(
                Directives.toast("Reset " + command, null),
                Directives.refresh());
    }

    /**
     * {@code keybind-restore}: every override is cleared.
     *
     * @param req     the request
     * @param payload the merged payload (ignored)
     * @return {@code [toast, refresh]}
     */
    static List<Map<String, Object>> restore(HttpRequest req, Map<String, Object> payload) {
        return List.of(
                Directives.toast("Defaults restored", null),
                Directives.refresh());
    }
}
