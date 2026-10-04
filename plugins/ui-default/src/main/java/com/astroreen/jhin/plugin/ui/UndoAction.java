/**
 * The {@code undo} action: reverts the most recent lifecycle action inside its
 * 5-second window through the {@link UndoJournal} of {@code jhin.sessions}.
 *
 * <p>Success answers {@code [toast "Undone", refresh]} — the doc's pair
 * ({@code docs/sdui.md} section 3); the refresh re-fetches the screen so the
 * restored rows show up. With no unexpired entry — the window closed, the
 * entry was already undone or the journal is empty — the answer is one
 * {@code toast "Nothing to undo"} with the {@code error} style. The client's
 * {@code thread.undo} command renders whatever {@code client} list comes back,
 * so both answers travel as directives on a {@code 200} (an absent undo
 * endpoint would {@code 404} into the client's own fallback toast with the
 * same wording).
 *
 * <p>The payload is empty in the shipped client: the action undoes the most
 * recently recorded entry across sessions. An explicit {@code sessionId}
 * payload field targets one session instead.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.UndoJournal;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class UndoAction {

    private final UndoJournal journal;

    UndoAction(UndoJournal journal) {
        this.journal = journal;
    }

    /**
     * Restores the last lifecycle change, or the named session's one.
     *
     * @param req     the request that carried the action
     * @param payload the merged payload; the optional {@code sessionId} field
     *                targets one session, an empty payload undoes the most
     *                recent entry
     * @return {@code [toast "Undone", refresh]} on success, one
     *         {@code "Nothing to undo"} error toast otherwise
     */
    List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload) {
        String sessionId = ActionSupport.text(payload, "sessionId");
        Optional<Session> restored = sessionId != null
                ? journal.undo(sessionId)
                : journal.undoLatest();
        if (restored.isEmpty()) {
            return ActionSupport.error("Nothing to undo");
        }
        return List.of(Directives.toast("Undone"), Directives.refresh());
    }
}
