/**
 * The default {@code keymap} of the level-2 bootstrap payload (docs/sdui.md
 * section 1): {@code [{key, command, when?}]}, the default layer the client
 * merges user overrides over (last matching rule wins). Commands match the
 * core set the client command registry installs (plan section "T67").
 *
 * <p>T116 aligns the list with the upstream t3code defaults
 * ({@code packages/shared/src/keybindings.ts:21-104}, commit {@code 37de6cb}):
 * the {@code !terminalFocus} guards, {@code mod+[} / {@code mod+]} navigation,
 * {@code mod+alt+n} new-thread-without-project, {@code mod+shift+enter}
 * queue-as-steer, {@code mod+j} terminal toggle, the {@code mod+w} precedence
 * ({@code terminal.close} while {@code terminalFocus}, {@code rightPanel.close}
 * otherwise) and the {@code mod+1..9} thread jumps gated on {@code isDesktop}.
 * The upstream {@code mod+alt+enter} send-and-background is the existing T68
 * {@code ctrl+alt+enter -> composer.sendAndNew} binding (T103 dropped the
 * draft-route branch; see {@code scripts/qa/t103.sh}).
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
        // The T68 send-and-background binding (T103: upstream's
        // mod+alt+enter sendBackground/sendAndNewThread pair collapses to
        // this one background-intent send because Jhin has no draft route).
        keymap.add(binding("ctrl+alt+enter", "composer.sendAndNew", "composerFocus"));
        keymap.add(binding("shift+enter", "composer.newline", "composerFocus"));
        keymap.add(binding("mod+up", "composer.recallPrev", "composerFocus"));
        keymap.add(binding("mod+down", "composer.recallNext", "composerFocus"));
        // The T103 picker chords (packages/shared/src/keybindings.ts:70-76):
        // the upstream `when: "!terminalFocus"` set. T116 adds the
        // terminalFocus context, so the guard is now the upstream one.
        keymap.add(binding("mod+shift+m", "modelPicker.toggle", "!terminalFocus"));
        keymap.add(binding("mod+shift+h", "composer.host", "!terminalFocus"));
        keymap.add(binding("mod+shift+e", "composer.effort", "!terminalFocus"));
        keymap.add(binding("mod+shift+a", "composer.mode", "!terminalFocus"));
        keymap.add(binding("mod+shift+x", "composer.workspace", "!terminalFocus"));
        keymap.add(binding("mod+shift+g", "composer.branch", "!terminalFocus"));
        keymap.add(binding("mod+shift+l", "composer.previousWorktree", "!terminalFocus"));
        keymap.add(binding("ctrl+k", "palette.open", null));
        keymap.add(binding("ctrl+z", "thread.undo", null));
        keymap.add(binding("alt+left", "nav.back", null));
        keymap.add(binding("alt+right", "nav.forward", null));
        keymap.add(binding("mod+n", "thread.new", null));
        // T116 upstream additions (packages/shared/src/keybindings.ts:21-104).
        // The navigation chords carry the upstream `!terminalFocus` guard.
        keymap.add(binding("mod+[", "navigation.back", "!terminalFocus"));
        keymap.add(binding("mod+]", "navigation.forward", "!terminalFocus"));
        keymap.add(binding("mod+j", "terminal.toggle", null));
        // The mod+w precedence: the focused terminal closes first, the right
        // panel otherwise (packages/shared/src/keybindings.ts:30-31).
        keymap.add(binding("mod+w", "terminal.close", "terminalFocus"));
        keymap.add(binding("mod+w", "rightPanel.close", "!terminalFocus"));
        keymap.add(binding("mod+alt+n", "chat.newWithoutProject", "!terminalFocus"));
        keymap.add(binding("mod+shift+enter", "thread.steerQueuedMessage",
                "!terminalFocus"));
        // The mod+1..9 thread jumps, gated on isDesktop (upstream
        // THREAD_JUMP_KEYBINDING_COMMANDS, packages/shared/src/keybindings.ts:87-91).
        for (int i = 1; i <= 9; i++) {
            keymap.add(binding("mod+" + i, "thread.jump" + i, "isDesktop"));
        }
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
