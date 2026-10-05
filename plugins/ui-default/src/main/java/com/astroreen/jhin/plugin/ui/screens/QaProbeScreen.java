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
 * <p>The level-3 primitives have no typed {@code Ui} builders yet (they land
 * with their own todos), so the nodes are authored directly on the
 * {@link UiNode} wire model.
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
                        .child(glassCard())
                        .child(pulseProgress())
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

    /** The scroll fade around one child. */
    private static UiNode scrollFade() {
        return new UiNode("scroll_fade", Map.ofEntries(
                Map.entry("id", "probe-scroll-fade"),
                Map.entry("edge", "top"),
                Map.entry("height", 24),
                Map.entry("mode", "topbar"),
                Map.entry("child", Ui.text("Scrollable body").build())), List.of());
    }

    /** The decorative diff renderer. */
    private static UiNode diffView() {
        return new UiNode("diff_view", Map.ofEntries(
                Map.entry("id", "probe-diff-view"),
                Map.entry("file", "docs/sdui.md"),
                Map.entry("language", "markdown"),
                Map.entry("view", "unified"),
                Map.entry("colorScheme", "default"),
                Map.entry("stats", Map.of("additions", 2, "deletions", 1)),
                Map.entry("demo", true),
                Map.entry("hunks", List.of(
                        Map.of("header", "@@ -1,3 +1,4 @@", "lines", List.of(
                                Map.of("kind", "ctx", "oldNo", 1, "newNo", 1, "text", "unchanged"),
                                Map.of("kind", "del", "oldNo", 2, "text", "old line"),
                                Map.of("kind", "add", "newNo", 2, "text", "new line")))))),
                List.of());
    }

    /** A glass-capable surface carrying the level-3 universal {@code glass}. */
    private static UiNode glassCard() {
        return new UiNode("card", Map.of(
                "id", "probe-glass",
                "glass", true), List.of(Ui.text("Glass card").build()));
    }

    /** An indicator carrying the level-3 universal {@code statusPulse}. */
    private static UiNode pulseProgress() {
        return new UiNode("progress", Map.of(
                "id", "probe-pulse",
                "kind", "linear",
                "statusPulse", "pulse"), List.of());
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
