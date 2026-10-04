/**
 * The {@code plugins} screen: a read-only catalog of the loaded plugins behind
 * {@code GET /_jhin/health}, rendered as {@code card} + {@code list_row} rows.
 *
 * <p>The rows are the loaded plugins of the current load pass ({@code id},
 * {@code version}, {@code name} — exactly the health payload's {@code plugins}
 * entries) as reported by {@link com.astroreen.jhin.sdk.KernelInfo#plugins()}.
 * Load failures have no plugin-visible seam (the health {@code failed} list
 * lives kernel-side), so they surface in the kernel log and the health answer
 * and are not listed here.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.KernelInfo;
import java.util.List;

public final class PluginsScreen {

    private PluginsScreen() {
    }

    /**
     * Builds the plugin catalog screen.
     *
     * @param plugins the loaded plugins, in load order
     * @return the screen node
     */
    public static UiNode render(List<KernelInfo.Loaded> plugins) {
        Ui.ContainerBuilder body = Ui.container()
                .direction("column")
                .gap(12)
                .padding(16)
                .child(Ui.text("Plugins").style("h2").build());
        if (plugins.isEmpty()) {
            body.child(Ui.card()
                    .title("Plugins")
                    .child(Ui.text("No plugins loaded.").style("caption").build())
                    .build());
        } else {
            Ui.ContainerBuilder rows = Ui.container().direction("column").gap(8);
            for (KernelInfo.Loaded plugin : plugins) {
                rows.child(Ui.listRow()
                        .title(plugin.id())
                        .subtitle(plugin.name())
                        .trailing(Ui.badge().label(plugin.version()).build())
                        .build());
            }
            body.child(Ui.card()
                    .title("Plugins")
                    .child(rows.build())
                    .build());
        }
        return Ui.screen().title("Plugins").body(body.build()).build();
    }
}