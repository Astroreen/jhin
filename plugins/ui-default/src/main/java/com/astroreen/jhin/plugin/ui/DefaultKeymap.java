/**
 * The default {@code keymap} of the level-2 bootstrap payload (docs/sdui.md
 * section 1): {@code [{key, command, when?}]}, the default layer the client
 * merges user overrides over (last matching rule wins). Commands match the
 * core set the client command registry installs (plan section "T67").
 */
package com.astroreen.jhin.plugin.ui;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class DefaultKeymap {

    private DefaultKeymap() {
    }

    /** The default binding list, in registration order. */
    static List<Map<String, Object>> entries() {
        List<Map<String, Object>> keymap = new ArrayList<>();
        keymap.add(binding("mod+enter", "composer.send", "composerFocus"));
        // The T103 upstream chord (packages/shared/src/keybindings.ts:51-52,
        // commit 37de6cb): the opposite queue/steer action while a turn runs.
        // Registered AFTER the send rule — the last matching rule wins, so
        // the running-turn gate takes the chord only while it holds.
        keymap.add(binding("mod+enter", "composer.sendAlternate",
                "composerFocus && turnRunning"));
        keymap.add(binding("ctrl+alt+enter", "composer.sendAndNew", "composerFocus"));
        keymap.add(binding("shift+enter", "composer.newline", "composerFocus"));
        keymap.add(binding("mod+up", "composer.recallPrev", "composerFocus"));
        keymap.add(binding("mod+down", "composer.recallNext", "composerFocus"));
        // The T103 picker chords (packages/shared/src/keybindings.ts:70-76):
        // the upstream `when: "!terminalFocus"` set expressed over the Jhin
        // command contexts — fires in the composer and outside editables,
        // never inside another field.
        keymap.add(binding("mod+shift+m", "modelPicker.toggle",
                "composerFocus || !editableFocus"));
        keymap.add(binding("mod+shift+h", "composer.host",
                "composerFocus || !editableFocus"));
        keymap.add(binding("mod+shift+e", "composer.effort",
                "composerFocus || !editableFocus"));
        keymap.add(binding("mod+shift+a", "composer.mode",
                "composerFocus || !editableFocus"));
        keymap.add(binding("mod+shift+x", "composer.workspace",
                "composerFocus || !editableFocus"));
        keymap.add(binding("mod+shift+g", "composer.branch",
                "composerFocus || !editableFocus"));
        keymap.add(binding("mod+shift+l", "composer.previousWorktree",
                "composerFocus || !editableFocus"));
        keymap.add(binding("ctrl+k", "palette.open", null));
        keymap.add(binding("ctrl+z", "thread.undo", null));
        keymap.add(binding("alt+left", "nav.back", null));
        keymap.add(binding("alt+right", "nav.forward", null));
        keymap.add(binding("mod+n", "thread.new", null));
        return keymap;
    }

    private static Map<String, Object> binding(String key, String command, String when) {
        Map<String, Object> binding = new LinkedHashMap<>();
        binding.put("key", key);
        binding.put("command", command);
        if (when != null) {
            binding.put("when", when);
        }
        return binding;
    }
}
