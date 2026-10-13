/**
 * The T308 model picker actions of {@code POST /ui/action/{name}}:
 * {@code select-model} writes the chosen {@code providerId}/{@code model}
 * onto the session and updates the composer's model line, and
 * {@code toggle-favorite-model} flips the row's star in the composer
 * favourites store.
 *
 * <p>Both are real handlers over the session store of jhin.sessions and the
 * jhin.ui settings store — nothing here is a demo shell. A dispatch with a
 * missing field or an unknown session answers with one error toast and
 * changes nothing, so a raw dispatch — a QA curl, a stale client — still
 * shows why nothing was saved.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.ui.screens.ActionDescriptors;
import com.astroreen.jhin.plugin.ui.screens.ChatScreen;
import com.astroreen.jhin.plugin.ui.screens.MessageCardBuilder;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class ModelPickerActions {

    private ModelPickerActions() {
    }

    /**
     * {@code select-model}: writes the chosen model onto the session.
     *
     * <p>The payload carries the {@code sessionId} (the legacy {@code id}
     * key is accepted as well), the {@code providerId} and the {@code model}.
     * The lookup is scoped to the caller's account when a principal is
     * present. The answer patches the header context chip to its re-render
     * with the new model line, sets the {@code chat_model} state the model
     * picker label reads and closes the dialog.
     *
     * @param store the session store of jhin.sessions
     * @return the handler answering {@code [patch, setState,
     *         dismissDialog]} on success or one error toast on a missing
     *         field or an unknown session
     */
    static ActionRoute.ActionHandler selectModel(SessionStore store) {
        return (HttpRequest req, Map<String, Object> payload) -> {
            String id = sessionId(payload);
            if (id == null) {
                return ActionSupport.error("A session id is required.");
            }
            String providerId = ActionSupport.text(payload, "providerId");
            if (providerId == null) {
                return ActionSupport.error("A provider id is required.");
            }
            String model = ActionSupport.text(payload, "model");
            if (model == null) {
                return ActionSupport.error("A model is required.");
            }
            Optional<String> account = ActionSupport.account(req);
            Optional<Session> found = account.isPresent()
                    ? store.get(account.orElseThrow(), id)
                    : store.get(id);
            if (found.isEmpty()) {
                return ActionSupport.error("Session not found: " + id);
            }
            Session updated;
            try {
                SessionStore.Patch patch =
                        new SessionStore.Patch(null, null, model, providerId, null);
                updated = account.isPresent()
                        ? store.patch(account.orElseThrow(), id, patch)
                        : store.patch(id, patch);
            } catch (RuntimeException e) {
                return ActionSupport.error(messageOf(e));
            }
            return List.of(
                    Directives.patch(ChatScreen.CONTEXT_CHIP_ID,
                            MessageCardBuilder.contextChip(ChatScreen.CONTEXT_CHIP_ID,
                                    updated.model(), updated.providerId(), updated.workdir())),
                    Directives.setState(ChatScreen.STATE_MODEL, updated.model()),
                    Directives.dismissDialog());
        };
    }

    /**
     * {@code toggle-favorite-model}: adds the {@code providerId/model} entry
     * to the composer favourites when absent and removes it when present.
     *
     * <p>The payload carries the {@code providerId}, the {@code model} and
     * the {@code starId} of the toggled star. The answer toasts the new
     * state and patches the star to its flipped re-render — the filled
     * {@code star} when the entry is now favourite, the outline
     * {@code star_border} otherwise — carrying the same action so the next
     * tap toggles back.
     *
     * @param settings the jhin.ui settings store
     * @return the handler answering {@code [toast, patch]} on success or one
     *         error toast on a missing field
     */
    static ActionRoute.ActionHandler toggleFavoriteModel(UiSettings settings) {
        return (HttpRequest req, Map<String, Object> payload) -> {
            String providerId = ActionSupport.text(payload, "providerId");
            if (providerId == null) {
                return ActionSupport.error("A provider id is required.");
            }
            String model = ActionSupport.text(payload, "model");
            if (model == null) {
                return ActionSupport.error("A model is required.");
            }
            String starId = ActionSupport.text(payload, "starId");
            if (starId == null) {
                return ActionSupport.error("A star id is required.");
            }
            boolean favorite = settings.toggleFavoriteModel(providerId + "/" + model);
            Map<String, Object> starPayload = new LinkedHashMap<>();
            String id = sessionId(payload);
            if (id != null) {
                starPayload.put("sessionId", id);
            }
            starPayload.put("providerId", providerId);
            starPayload.put("model", model);
            starPayload.put("starId", starId);
            UiNode star = Ui.iconButton()
                    .id(starId)
                    .icon(favorite ? "star" : "star_border")
                    .action(ActionDescriptors.of("toggle-favorite-model", starPayload, null))
                    .build();
            return List.of(
                    Directives.toast(favorite
                            ? "Added to favorites" : "Removed from favorites"),
                    Directives.patch(starId, star));
        };
    }

    /** The session id of one payload: {@code sessionId}, else the legacy {@code id}. */
    private static String sessionId(Map<String, Object> payload) {
        String id = ActionSupport.text(payload, "sessionId");
        return id != null ? id : ActionSupport.text(payload, "id");
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
