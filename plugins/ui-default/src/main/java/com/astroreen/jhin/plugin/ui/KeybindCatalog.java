/**
 * The command catalogue of the {@code settings:keybindings} panel (T111): the
 * client command vocabulary the panel renders, the upstream command labels and
 * the category grouping of the keybinding table.
 *
 * <p>Two layers. The <b>T67 set</b> is the client's dispatchable vocabulary
 * ({@code frontend/lib/sdui/keyboard/command_registry.dart:66-100}) — every id
 * there is a real command the client dispatches; the panel renders these rows
 * with a live {@code Change} affordance. The <b>upstream additions</b> are the
 * command ids of t3code's {@code STATIC_KEYBINDING_COMMANDS}
 * ({@code packages/contracts/src/keybindings.ts:59-111}) that Jhin does not
 * dispatch; the panel lists them for parity but marks every interactive node
 * {@code demo: true} because a binding for them has no runtime effect (plan
 * section 14.10).
 *
 * <p>The labels are the port of upstream's {@code commandLabel}
 * ({@code apps/web/src/components/settings/KeybindingsSettings.logic.ts:314-340},
 * commit {@code 37de6cb}): the six special-case names verbatim plus the
 * {@code Segment: Segment} title-casing of the dotted id. The category grouping
 * follows the plan's five groups (Composer / Threads / Navigation / Panels /
 * General).
 */
package com.astroreen.jhin.plugin.ui;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class KeybindCatalog {

    /** The five table groups of the keybindings panel, in render order. */
    public enum Category {
        COMPOSER("Composer"),
        THREADS("Threads"),
        NAVIGATION("Navigation"),
        PANELS("Panels"),
        GENERAL("General");

        private final String label;

        Category(String label) {
            this.label = label;
        }

        /** The group header text. */
        public String label() {
            return label;
        }
    }

    /**
     * The four command-palette result groups (T115), in render order. Mirrors
     * the client's {@code PaletteGroup} enum
     * ({@code frontend/lib/sdui/keyboard/palette.dart}); the wire name is the
     * lower-case group value the bootstrap {@code palette} block carries and
     * the client renders as the upper-case header.
     */
    public enum PaletteGroup {
        ACTIONS("actions", "Actions"),
        THREADS("threads", "Threads"),
        PROJECTS("projects", "Projects"),
        MODELS("models", "Models");

        private final String wire;
        private final String label;

        PaletteGroup(String wire, String label) {
            this.wire = wire;
            this.label = label;
        }

        /** The wire value of the group. */
        public String wire() {
            return wire;
        }

        /** The header text of the group. */
        public String label() {
            return label;
        }
    }

    /**
     * One command-palette metadata item (T115): the command id, its upstream
     * label, the muted subtitle (the command id, the {@code ThreadCommandSubtitle}
     * analogue) and the effective chord the right-aligned {@code kbd} hint
     * shows.
     *
     * @param id       the command id (or the decorative model id)
     * @param label    the human-readable label
     * @param subtitle the muted subtitle
     * @param group    the palette group
     * @param chord    the effective chord, empty when unassigned
     * @param demo     whether the item is an inert decorative row
     */
    public record PaletteCommand(String id, String label, String subtitle, PaletteGroup group,
                                 String chord, boolean demo) {
    }

    /** The three decorative model rows of the palette (T115, never dispatch). */
    private static final List<PaletteCommand> PALETTE_MODELS = List.of(
            new PaletteCommand("model:sonnet", "Claude Sonnet", "model",
                    PaletteGroup.MODELS, "", true),
            new PaletteCommand("model:gpt", "GPT-5", "model",
                    PaletteGroup.MODELS, "", true),
            new PaletteCommand("model:gemini", "Gemini Pro", "model",
                    PaletteGroup.MODELS, "", true));

    /**
     * One keybinding row.
     *
     * @param id       the command id
     * @param label    the upstream command label
     * @param category the table group
     * @param chord    the default chord, empty when unassigned
     * @param when     the default {@code when} expression, empty for always
     * @param demo     whether the command is an inert upstream addition
     */
    public record Command(String id, String label, Category category, String chord, String when,
                          boolean demo) {
    }

    /** The client's dispatchable command vocabulary (T67), in registry order. */
    private static final List<String> T67 = List.of(
            "composer.send",
            "composer.sendAndNew",
            "composer.sendAlternate",
            "composer.newline",
            "composer.recallPrev",
            "composer.recallNext",
            "modelPicker.toggle",
            "composer.host",
            "composer.effort",
            "composer.mode",
            "composer.workspace",
            "composer.branch",
            "composer.previousWorktree",
            "thread.next",
            "thread.prev",
            "thread.jump1",
            "thread.jump2",
            "thread.jump3",
            "thread.jump4",
            "thread.jump5",
            "thread.jump6",
            "thread.jump7",
            "thread.jump8",
            "thread.jump9",
            "thread.undo",
            "thread.settle",
            "thread.pin",
            "thread.new",
            "palette.open",
            "nav.back",
            "nav.forward",
            "appearance.cycle",
            "theme.pick");

    /**
     * The upstream command ids Jhin does not dispatch, with their t3code
     * default chords ({@code packages/shared/src/keybindings.ts:21-104}). They
     * are listed for parity and marked {@code demo}.
     */
    private static final List<Command> ADDITIONS = List.of(
            new Command("composer.sendBackground", label("composer.sendBackground"),
                    Category.COMPOSER, "mod+enter", "composerFocus && draftThreadRoute", true),
            new Command("composer.sendAndNewThread", label("composer.sendAndNewThread"),
                    Category.COMPOSER, "mod+alt+enter", "composerFocus && !draftThreadRoute", true),
            new Command("composer.cycleHost", label("composer.cycleHost"),
                    Category.COMPOSER, "", "", true),
            new Command("composer.stash", label("composer.stash"),
                    Category.COMPOSER, "mod+s", "!terminalFocus", true),
            new Command("thread.steerQueuedMessage", label("thread.steerQueuedMessage"),
                    Category.THREADS, "mod+shift+enter", "!terminalFocus", true),
            new Command("thread.editQueuedMessage", label("thread.editQueuedMessage"),
                    Category.THREADS, "alt+arrowup", "composerFocus", true),
            new Command("thread.copyReference", label("thread.copyReference"),
                    Category.THREADS, "mod+shift+c", "!terminalFocus", true),
            new Command("rightPanel.toggle", label("rightPanel.toggle"),
                    Category.PANELS, "mod+alt+b", "", true),
            new Command("terminal.toggle", label("terminal.toggle"),
                    Category.PANELS, "mod+j", "", true),
            new Command("preview.toggle", label("preview.toggle"),
                    Category.PANELS, "mod+shift+j", "", true),
            new Command("diff.toggle", label("diff.toggle"),
                    Category.PANELS, "mod+d", "!terminalFocus", true),
            new Command("sidebar.toggle", label("sidebar.toggle"),
                    Category.PANELS, "mod+b", "", true),
            new Command("usage.open", label("usage.open"),
                    Category.GENERAL, "mod+u", "!terminalFocus", true),
            new Command("theme.select", label("theme.select"),
                    Category.GENERAL, "mod+alt+a", "!terminalFocus", true));

    private KeybindCatalog() {
    }

    /**
     * The full catalogue in render order: the T67 rows first, grouped by
     * category, then the upstream additions of each category. The T67 default
     * chords come from the server keymap ({@link DefaultKeymap#entries()}); a
     * command with no default binding carries an empty chord.
     *
     * @return the catalogue rows, category-grouped
     */
    public static List<Command> commands() {
        Map<String, Map<String, Object>> defaults = defaultBindings();
        List<Command> rows = new ArrayList<>();
        for (Category category : Category.values()) {
            for (String id : T67) {
                if (categoryOf(id) != category) {
                    continue;
                }
                Map<String, Object> binding = defaults.get(id);
                String chord = binding == null ? "" : String.valueOf(binding.getOrDefault("key", ""));
                String when = binding == null || binding.get("when") == null
                        ? "" : String.valueOf(binding.get("when"));
                rows.add(new Command(id, label(id), category, chord, when, false));
            }
            for (Command addition : ADDITIONS) {
                if (addition.category() == category) {
                    rows.add(addition);
                }
            }
        }
        return List.copyOf(rows);
    }

    /**
     * The flat command-palette metadata (T115): every catalogue command in the
     * {@link PaletteGroup#ACTIONS} group with the caller's effective chord
     * (the override when present, otherwise the server default) followed by
     * the decorative {@link PaletteGroup#MODELS} rows. The dynamic
     * {@code threads} and {@code projects} groups are populated by the client
     * from the search route and the screen registry — this catalogue carries
     * only the static vocabulary.
     *
     * @param overrides the caller's keymap overrides (command to chord)
     * @return the palette metadata items in render order
     */
    public static List<PaletteCommand> paletteCommands(Map<String, String> overrides) {
        List<PaletteCommand> rows = new ArrayList<>();
        for (Command command : commands()) {
            String chord = overrides.getOrDefault(command.id(), command.chord());
            rows.add(new PaletteCommand(command.id(), command.label(), command.id(),
                    PaletteGroup.ACTIONS, chord == null ? "" : chord, command.demo()));
        }
        rows.addAll(PALETTE_MODELS);
        return List.copyOf(rows);
    }

    /**
     * The grouped palette metadata (T115): all four {@link PaletteGroup}s in
     * render order, each as {@code {value, label, count, items}} where an item
     * is a {@link PaletteCommand} rendered as
     * {@code {id, label, subtitle, chord, demo}}. The {@code threads} and
     * {@code projects} groups are always present with zero items — the client
     * fills them from the search route and its registry.
     *
     * @param overrides the caller's keymap overrides (command to chord)
     * @return the four groups in render order
     */
    public static List<Map<String, Object>> paletteGroups(Map<String, String> overrides) {
        List<PaletteCommand> commands = paletteCommands(overrides);
        List<Map<String, Object>> groups = new ArrayList<>();
        for (PaletteGroup group : PaletteGroup.values()) {
            List<Map<String, Object>> items = new ArrayList<>();
            for (PaletteCommand command : commands) {
                if (command.group() == group) {
                    items.add(paletteItem(command));
                }
            }
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("value", group.wire());
            entry.put("label", group.label());
            entry.put("count", items.size());
            entry.put("items", items);
            groups.add(entry);
        }
        return List.copyOf(groups);
    }

    /** One palette item as the wire map of the bootstrap {@code palette} block. */
    private static Map<String, Object> paletteItem(PaletteCommand command) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", command.id());
        item.put("label", command.label());
        item.put("subtitle", command.subtitle());
        item.put("chord", command.chord());
        item.put("demo", command.demo());
        return item;
    }

    /**
     * The category of one command id: the prefix grouping of the panel.
     *
     * @param command the command id
     * @return the table group
     */
    public static Category categoryOf(String command) {
        if (command.startsWith("composer.")) {
            return Category.COMPOSER;
        }
        if (command.startsWith("thread.")) {
            return Category.THREADS;
        }
        if (command.startsWith("nav.") || command.equals("palette.open")) {
            return Category.NAVIGATION;
        }
        if (command.startsWith("modelPicker.") || command.startsWith("rightPanel.")
                || command.startsWith("terminal.") || command.startsWith("preview.")
                || command.startsWith("diff.") || command.startsWith("sidebar.")) {
            return Category.PANELS;
        }
        return Category.GENERAL;
    }

    /**
     * The upstream command label of one id, ported verbatim from
     * {@code commandLabel} ({@code KeybindingsSettings.logic.ts:314-340}).
     *
     * @param command the command id
     * @return the human-readable label
     */
    public static String label(String command) {
        switch (command) {
            case "composer.sendAlternate":
                return "Composer: Opposite Queue or Steer Action";
            case "composer.sendBackground":
                return "Composer: Start in Background";
            case "composer.sendAndNewThread":
                return "Composer: Send and Start New Thread";
            case "thread.steerQueuedMessage":
                return "Queue: Send First Queued Message as Steer";
            case "thread.editQueuedMessage":
                return "Queue: Edit Last Queued Message";
            case "thread.copyReference":
                return "Pull Request: Copy Link or Thread ID";
            default:
                StringBuilder label = new StringBuilder();
                for (String segment : command.split("\\.")) {
                    if (label.length() > 0) {
                        label.append(": ");
                    }
                    label.append(titleCase(segment));
                }
                return label.toString();
        }
    }

    /** The default binding of one command id, or empty when it has none. */
    public static Optional<String> defaultChord(String command) {
        Map<String, Object> binding = defaultBindings().get(command);
        if (binding == null || binding.get("key") == null) {
            return Optional.empty();
        }
        return Optional.of(String.valueOf(binding.get("key")));
    }

    /** The server default bindings keyed by command (first binding wins). */
    private static Map<String, Map<String, Object>> defaultBindings() {
        Map<String, Map<String, Object>> defaults = new LinkedHashMap<>();
        for (Map<String, Object> binding : DefaultKeymap.entries()) {
            String command = String.valueOf(binding.get("command"));
            defaults.putIfAbsent(command, binding);
        }
        return defaults;
    }

    /** The upstream {@code titleCaseCommandSegment} port. */
    private static String titleCase(String segment) {
        String spaced = segment.replaceAll("([a-z0-9])([A-Z])", "$1 $2");
        StringBuilder out = new StringBuilder();
        for (String part : spaced.split("[-_\\s]+")) {
            if (part.isEmpty()) {
                continue;
            }
            if (out.length() > 0) {
                out.append(' ');
            }
            out.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
        }
        return out.toString();
    }
}
