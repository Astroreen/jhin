/**
 * The default screen registry of the T36 surface: {@code connect} (the enroll
 * form placeholder), {@code sessions} (the basic session list with the activity
 * stream of the newest session) and {@code providers} (registered only when the
 * LLM plugin is loaded — the optional-dependency degrade rule). Everything is
 * built with the {@code jhin.ui-kit} builder; the full screen classes replace
 * this registry later without touching the routes.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

final class Screens implements ScreenRegistry {

    /** Path prefix of the session stream endpoint this plugin serves. */
    private static final String STREAM_TOPIC_PREFIX = "/ui/stream/session/";

    private final SessionStore store;
    private final boolean llmPresent;

    Screens(SessionStore store, boolean llmPresent) {
        this.store = store;
        this.llmPresent = llmPresent;
    }

    @Override
    public Map<String, Supplier<UiNode>> screens(Optional<String> account) {
        Map<String, Supplier<UiNode>> screens = new LinkedHashMap<>();
        screens.put("connect", this::connect);
        screens.put("sessions", () -> sessions(account));
        if (llmPresent) {
            screens.put("providers", this::providers);
        }
        return screens;
    }

    /**
     * The action descriptor a button or form submit posts to
     * {@code /ui/action/<name>}.
     */
    static Map<String, Object> action(String name, List<String> include) {
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("path", "/ui/action/" + name);
        action.put("method", "POST");
        action.put("name", name);
        if (include != null && !include.isEmpty()) {
            action.put("include", include);
        }
        return action;
    }

    /** The enroll form placeholder of the connect screen. */
    private UiNode connect() {
        return Ui.screen()
                .title("Connect")
                .body(Ui.container()
                        .direction("column")
                        .gap(12)
                        .padding(16)
                        .child(Ui.text("Sign in to continue").style("h2").build())
                        .child(Ui.form()
                                .field(Ui.input("code").label("Enrollment code").required(true).build())
                                .field(Ui.input("deviceName").label("Device name").required(true).build())
                                .submit("Enroll", action("enroll", List.of("code", "deviceName")))
                                .build())
                        .child(Ui.text("Ask your administrator for an enrollment code.")
                                .style("caption").build())
                        .child(Ui.button("Documentation").style("text")
                                .action(Directives.openUrl("https://example.invalid/docs")).build())
                        .child(Ui.button("Clear stored credentials").style("text")
                                .action(Directives.clearToken()).build())
                        .build())
                .build();
    }

    /** The basic session list screen, scoped to the caller. */
    private UiNode sessions(Optional<String> account) {
        List<Session> sessions = account.map(store::list).orElseGet(store::list);
        Ui.ListBuilder list = Ui.list();
        for (Session session : sessions) {
            list.item(Ui.card()
                    .title(session.title())
                    .child(Ui.text(session.workdir()).style("mono").build())
                    .build());
        }
        Ui.ContainerBuilder body = Ui.container()
                .direction("column")
                .gap(12)
                .padding(16)
                .child(Ui.text("Sessions").style("h2").build());
        if (sessions.isEmpty()) {
            body.child(Ui.text("No sessions yet.").style("caption").build());
        } else {
            body.child(list.build());
            String newest = sessions.get(0).id();
            body.child(Ui.streamView("activity", STREAM_TOPIC_PREFIX + newest)
                    .mode("append")
                    .itemLimit(20)
                    .autoScroll(true)
                    .empty("No activity yet.")
                    .build());
        }
        return Ui.screen().title("Sessions").body(body.build()).build();
    }

    /** The providers placeholder, only present when the LLM plugin is loaded. */
    private UiNode providers() {
        return Ui.screen()
                .title("Providers")
                .body(Ui.container()
                        .direction("column")
                        .gap(12)
                        .padding(16)
                        .child(Ui.text("Providers").style("h2").build())
                        .child(Ui.text("No providers configured.").style("caption").build())
                        .build())
                .build();
    }
}
