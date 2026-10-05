/**
 * The QA level-3 probe screen (T88): one node of every level-3 primitive
 * plus the level-3 universal props, each carrying a fixed {@code id} the QA
 * scripts assert on. It exists so the contract's downgrade map
 * (docs/sdui.md section 6) is provable over the wire: the same tree served to
 * an api=3 client passes through and to an api=2 client comes back per the
 * map. Not a product surface — it resolves only when the operator sets the
 * {@code jhin.ui} config key {@code qaProbe} (default off) and no screen
 * links here.
 *
 * <p>Every level-3 primitive is authored through its typed {@code Ui}
 * builder ({@code split}, {@code hover_card}, {@code toast_stack}, {@code
 * kbd}, {@code scroll_fade}, {@code diff_view}, T92's {@code statusPulse}
 * progress modes).
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;
import java.util.Map;

public final class QaProbeScreen {

    private QaProbeScreen() {
    }

    /** The probe tree: {@code screen} → {@code column} of one node per case. */
    public static UiNode render() {
        return Ui.screen().title("QA level-3 probe")
                .body(Ui.column()
                        .child(split())
                        .child(hoverCard())
                        .child(toastStack())
                        .child(kbd())
                        .child(scrollFade())
                        .child(diffView())
                        .child(diffViewSplitBlueOrange())
                        .child(glassCard())
                        .child(glassSheet())
                        .child(glassDialog())
                        .child(glassMenu())
                        .child(glassBanner())
                        .child(pulseProgress())
                        .child(pingProgress())
                        .child(skeletonProgress())
                        .child(completeProgress())
                        .child(demoButton())
                        .child(safeAreaBox())
                        .build())
                .build();
    }

    /** The resizable two-pane split. */
    private static UiNode split() {
        return new UiNode("split", Map.ofEntries(
                Map.entry("id", "probe-split"),
                Map.entry("first", Ui.text("First pane").build()),
                Map.entry("second", Ui.text("Second pane").build()),
                Map.entry("axis", "horizontal"),
                Map.entry("initial", 256),
                Map.entry("min", 208),
                Map.entry("max", 640),
                Map.entry("minSecond", 640),
                Map.entry("persistKey", "qa_probe_split"),
                Map.entry("handleStyle", "rail")), List.of());
    }

    /** The hover card with a tooltip the downgrade must keep. */
    private static UiNode hoverCard() {
        return new UiNode("hover_card", Map.ofEntries(
                Map.entry("id", "probe-hover-card"),
                Map.entry("tooltip", "kept tooltip"),
                Map.entry("trigger", Ui.text("Hover trigger").build()),
                Map.entry("content", Ui.text("Hover content").build()),
                Map.entry("delay", 500),
                Map.entry("placement", "top")), List.of());
    }

    /** The transient-notice stack with two items. */
    private static UiNode toastStack() {
        return new UiNode("toast_stack", Map.ofEntries(
                Map.entry("id", "probe-toast-stack"),
                Map.entry("direction", "bottom"),
                Map.entry("items", List.of(
                        Map.of("text", "Saved", "style", "success", "duration", 5000),
                        Map.of("text", "Deleted")))), List.of());
    }

    /** The keyboard-hint pill. */
    private static UiNode kbd() {
        return new UiNode("kbd", Map.of(
                "id", "probe-kbd",
                "chord", "mod+shift+m"), List.of());
    }

    /** The scroll fade around one child (the typed T92 builder). */
    private static UiNode scrollFade() {
        return Ui.scrollFade()
                .id("probe-scroll-fade")
                .edge("top")
                .height(24)
                .mode("topbar")
                .child(Ui.text("Scrollable body").build())
                .build();
    }

    /** The decorative diff renderer (the typed T93 builder, unified + default). */
    private static UiNode diffView() {
        return Ui.diffView()
                .id("probe-diff-view")
                .file("docs/sdui.md")
                .language("markdown")
                .view("unified")
                .colorScheme("default")
                .stats(2, 1)
                .demo(true)
                .hunk(Ui.diffHunk("@@ -1,3 +1,4 @@")
                        .line(Ui.diffLine("ctx").oldNo(1).newNo(1).text("unchanged"))
                        .line(Ui.diffLine("del").oldNo(2).text("old line"))
                        .line(Ui.diffLine("add").newNo(2).text("new line")))
                .build();
    }

    /** The decorative diff renderer in the split view and the blue-orange scheme. */
    private static UiNode diffViewSplitBlueOrange() {
        return Ui.diffView()
                .id("probe-diff-view-split")
                .file("lib/agent/run.ts")
                .language("typescript")
                .view("split")
                .colorScheme("blue-orange")
                .stats(2, 1)
                .demo(true)
                .hunk(Ui.diffHunk("@@ -1,2 +1,2 @@")
                        .line(Ui.diffLine("ctx").oldNo(1).newNo(1).text("unchanged"))
                        .line(Ui.diffLine("del").oldNo(2).text("old line"))
                        .line(Ui.diffLine("add").newNo(2).text("new line")))
                .build();
    }

    /** A glass-capable surface carrying the level-3 universal {@code glass}. */
    private static UiNode glassCard() {
        return Ui.card()
                .id("probe-glass")
                .glass(true)
                .glassTint("$color.destructive")
                .child(Ui.text("Glass card").build())
                .build();
    }

    /**
     * The five glass-capable surfaces with the full level-3 glass group
     * (T89): {@code glass} plus {@code glassTint}, authored through the real
     * typed builders. The tint is the upstream {@code --alert-glass-tint}
     * semantics — a {@code $color} token washed at 4% over the glass fill.
     */
    private static UiNode glassSheet() {
        return Ui.sheet()
                .id("probe-glass-sheet")
                .title("Glass sheet")
                .body(Ui.text("Blurred backdrop sheet").build())
                .glass(true)
                .glassTint("$color.destructive")
                .build();
    }

    /** The glass dialog over the {@code dialog-glass} recipe. */
    private static UiNode glassDialog() {
        return Ui.dialog()
                .id("probe-glass-dialog")
                .title("Glass dialog")
                .content(Ui.text("Blurred backdrop dialog").build())
                .action(Ui.button("Close").build())
                .glass(true)
                .glassTint("$color.destructive")
                .build();
    }

    /** The glass menu over the {@code dropdown-glass} recipe. */
    private static UiNode glassMenu() {
        return Ui.menu()
                .id("probe-glass-menu")
                .trigger(Ui.button("Open menu").build())
                .item("One")
                .item("Two")
                .glass(true)
                .glassTint("$color.destructive")
                .build();
    }

    /** The glass banner over the {@code alert-glass} recipe. */
    private static UiNode glassBanner() {
        return Ui.banner()
                .id("probe-glass-banner")
                .content(Ui.text("Blurred backdrop banner").build())
                .glass(true)
                .glassTint("$color.warning")
                .build();
    }

    /** An indicator carrying the level-3 universal {@code statusPulse}. */
    private static UiNode pulseProgress() {
        return Ui.progress().id("probe-pulse").kind("linear").statusPulse("pulse").build();
    }

    /** An indicator carrying the ping mode (the unread-dot ring). */
    private static UiNode pingProgress() {
        return Ui.progress().id("probe-ping").kind("linear").statusPulse("ping").build();
    }

    /** An indicator carrying the skeleton mode (the 2.4 s shimmer). */
    private static UiNode skeletonProgress() {
        return Ui.progress().id("probe-skeleton").kind("linear").statusPulse("skeleton").build();
    }

    /**
     * The complete indicator: {@code value 1.0} plus the ping mode — the
     * complete bar wins, the client must not animate it (the T92 --fail
     * probe asserts the static render over the wire).
     */
    private static UiNode completeProgress() {
        return Ui.progress().id("probe-complete").kind("linear").value(1.0).statusPulse("ping").build();
    }

    /** A decorative node carrying the universal {@code demo} marker (kept at level 2). */
    private static UiNode demoButton() {
        return new UiNode("button", Map.of(
                "id", "probe-demo",
                "label", "Decorative",
                "demo", true), List.of());
    }

    /** A box carrying the level-3 {@code safeArea} prop group. */
    private static UiNode safeAreaBox() {
        return new UiNode("box", Map.of(
                "id", "probe-safe-area",
                "safeArea", Map.of("top", true, "bottom", true)),
                List.of(Ui.text("Safe area body").build()));
    }
}
