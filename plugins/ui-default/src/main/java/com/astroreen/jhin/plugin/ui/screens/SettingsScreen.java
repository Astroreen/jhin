/**
 * The {@code settings} screen: account info, the client-owned server surface,
 * sign-out, the help link and — while the reload plugin is loaded — the reload
 * button.
 *
 * <p>"Change server" opens the client's own profile surface
 * ({@code openProfiles}); "Sign out" drops the stored bearer token
 * ({@code clearToken}). The reload button posts to the {@code reload} action,
 * which answers with {@code reloadBootstrap}; the plugin restart itself is the
 * reload plugin's {@code POST /admin/reload} behind the client's re-bootstrap.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.Optional;

public final class SettingsScreen {

    /** The product-neutral help link of the surface. */
    private static final String HELP_URL = "https://example.invalid/docs";

    private SettingsScreen() {
    }

    /**
     * Builds the settings screen of one caller.
     *
     * @param account        the caller's account id, empty when unauthenticated
     * @param securityPresent whether the security plugin is loaded (account info)
     * @param reloadPresent  whether the reload plugin is loaded (reload button)
     * @return the screen node
     */
    public static UiNode render(Optional<String> account, boolean securityPresent,
                                boolean reloadPresent) {
        Ui.ContainerBuilder body = Ui.container()
                .direction("column")
                .gap(12)
                .padding(16)
                .child(Ui.text("Settings").style("h2").build());
        if (securityPresent) {
            String info = account
                    .map(id -> "Signed in as " + id)
                    .orElse("Not signed in");
            body.child(Ui.card()
                    .title("Account")
                    .child(Ui.text(info).style("body").build())
                    .build());
        }
        body.child(Ui.button("Change server")
                .style("secondary")
                .action(Directives.openProfiles())
                .build());
        body.child(Ui.button("Sign out")
                .style("danger")
                .action(Directives.clearToken())
                .build());
        body.child(Ui.button("Help")
                .style("text")
                .action(Directives.openUrl(HELP_URL))
                .build());
        if (reloadPresent) {
            body.child(Ui.button("Reload")
                    .style("secondary")
                    .action(ActionDescriptors.of("reload"))
                    .build());
        }
        return Ui.screen().title("Settings").body(body.build()).build();
    }
}
