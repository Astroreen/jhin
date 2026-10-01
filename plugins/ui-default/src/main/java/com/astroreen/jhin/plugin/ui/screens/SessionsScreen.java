/**
 * The {@code sessions} screen: the caller's session list, the navigation
 * drawer of the loaded surfaces and the "New session" form.
 *
 * <p>Every list row navigates to its {@code chat:<id>} screen; the form
 * submits to the {@code create-session} action, which answers with a
 * navigation to the fresh chat screen. The drawer links at the settings,
 * plugins and — when the LLM plugin is loaded — providers screens. The
 * activity stream of the newest session stays on this screen so a client
 * sees movement without opening a chat.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.ui.Directives;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;
import java.util.Optional;

public final class SessionsScreen {

    /** Path prefix of the session stream endpoint the UI plugin serves. */
    private static final String STREAM_TOPIC_PREFIX = "/ui/stream/session/";

    private SessionsScreen() {
    }

    /**
     * Builds the session list screen of one caller.
     *
     * @param store         the session store to list from
     * @param account       the caller's account id, empty when unscoped
     * @param providersLink whether the providers screen exists to link at
     * @return the screen node
     */
    public static UiNode render(SessionStore store, Optional<String> account,
                                boolean providersLink) {
        List<Session> sessions = account.map(store::list).orElseGet(store::list);
        Ui.ListBuilder rows = Ui.list();
        for (Session session : sessions) {
            rows.item(Ui.card()
                    .title(session.title())
                    .child(Ui.text(session.workdir()).style("mono").build())
                    .child(Ui.button("Open")
                            .style("secondary")
                            .action(Directives.navigate("chat:" + session.id()))
                            .build())
                    .build());
        }
        Ui.NavBuilder nav = Ui.nav()
                .kind("drawer")
                .item("Sessions", "sessions")
                .item("Settings", "settings")
                .item("Plugins", "plugins");
        if (providersLink) {
            nav.item("Providers", "providers");
        }
        Ui.ContainerBuilder body = Ui.container()
                .direction("column")
                .gap(12)
                .padding(16)
                .child(nav.build())
                .child(Ui.text("Sessions").style("h2").build())
                .child(Ui.form()
                        .field(Ui.input("title").label("Title").required(true).build())
                        .field(Ui.input("workdir").label("Working directory").required(true).build())
                        .submit("New session", ActionDescriptors.of(
                                "create-session", null, List.of("title", "workdir")))
                        .build());
        if (sessions.isEmpty()) {
            body.child(Ui.text("No sessions yet.").style("caption").build());
        } else {
            body.child(rows.build());
            body.child(Ui.streamView("activity", STREAM_TOPIC_PREFIX + sessions.get(0).id())
                    .mode("append")
                    .itemLimit(20)
                    .autoScroll(true)
                    .empty("No activity yet.")
                    .build());
        }
        return Ui.screen().title("Sessions").body(body.build()).build();
    }
}
