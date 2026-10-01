/**
 * The {@code chat:<session-id>} screen: the live session stream, the message
 * input and the two run controls.
 *
 * <p>The stream view points at {@code /ui/stream/session/<id>} and translates
 * the session events into SDUI frames; the message input carries the reserved
 * id {@code messageInput} the Send action includes. Send posts to the
 * {@code send} action (the run semantics of {@code POST /sessions/{id}/messages});
 * Cancel posts to {@code cancel} (the semantics of
 * {@code POST /sessions/{id}/cancel}) and is present only when the agent
 * plugin is loaded.
 */
package com.astroreen.jhin.plugin.ui.screens;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.List;
import java.util.Map;

public final class ChatScreen {

    /** Path prefix of the session stream endpoint the UI plugin serves. */
    private static final String STREAM_TOPIC_PREFIX = "/ui/stream/session/";

    /** The input id the send action includes. */
    private static final String MESSAGE_INPUT = "messageInput";

    private ChatScreen() {
    }

    /**
     * Builds the chat screen of one session.
     *
     * @param session      the session the screen is opened for
     * @param agentPresent whether the agent plugin is loaded (Cancel button)
     * @return the screen node
     */
    public static UiNode render(Session session, boolean agentPresent) {
        String sessionId = session.id();
        Map<String, Object> runPayload = Map.of("sessionId", sessionId);
        Ui.ContainerBuilder controls = Ui.container()
                .direction("row")
                .gap(8)
                .align("center")
                .child(Ui.input(MESSAGE_INPUT)
                        .label("Message")
                        .required(true)
                        .errorText("Write a message first")
                        .build())
                .child(Ui.button("Send")
                        .style("primary")
                        .action(ActionDescriptors.of(
                                "send", runPayload, List.of(MESSAGE_INPUT)))
                        .build());
        if (agentPresent) {
            controls.child(Ui.button("Cancel")
                    .style("danger")
                    .action(ActionDescriptors.of("cancel", runPayload, List.of()))
                    .build());
        }
        return Ui.screen()
                .title(session.title())
                .body(Ui.container()
                        .direction("column")
                        .gap(12)
                        .padding(16)
                        .child(Ui.streamView("stream", STREAM_TOPIC_PREFIX + sessionId)
                                .mode("append")
                                .itemLimit(50)
                                .autoScroll(true)
                                .empty("No messages yet.")
                                .build())
                        .child(controls.build())
                        .build())
                .build();
    }
}
