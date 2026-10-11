/**
 * The thread-row action table of the {@code sessions} shell: one handler per
 * overflow-menu entry, forwarding to the lifecycle service of
 * {@code jhin.sessions} (the same operations the {@code /sessions/{id}/…}
 * routes serve) and answering with a screen refresh so the sidebar sections
 * re-resolve.
 *
 * <p>Names, exhaustively (13):
 * <ul>
 *   <li>{@code pin} / {@code unpin} — the pin setting;</li>
 *   <li>{@code settle} / {@code unsettle} — the settle transition
 *       ({@code settle} records the {@code manual} reason);</li>
 *   <li>{@code snooze} — with a {@code durationMs} (or {@code until}) payload
 *       field it snoozes; without one it answers the duration-choice
 *       {@code sheet} whose buttons dispatch this same action;</li>
 *   <li>{@code wake} — clears the snooze;</li>
 *   <li>{@code archive} / {@code restore} — the archive transition;</li>
 *   <li>{@code auto-settle} — the {@code Auto-settle behavior} submenu
 *       entries (T98) write the {@code auto_settle} flag;</li>
 *   <li>{@code regenerate-title} — the title regeneration seam;</li>
 *   <li>{@code reorder} — persists the posted full id order;</li>
 *   <li>{@code delete-session} — deletes the thread;</li>
 *   <li>{@code arrange-toggle} — flips the reorder mode and answers with a
 *       {@code setScreen} of the re-rendered shell (nothing is persisted
 *       client-side).</li>
 * </ul>
 *
 * <p>Since T98 the undoable transitions answer the upstream undo notice —
 * the {@code toast} directive carrying the {@code undo} action and the
 * 5&nbsp;s window ({@code Unpinned}/{@code Settled}/{@code Snoozed}/
 * {@code Archived} 1 thread,) before the refresh, the wording of
 * {@code SidebarThreadUndoNotice.tsx:15,20}; pinning, waking, unsetting and
 * restoring show no notice (upstream parity — only the four labels of
 * {@code showThreadUndoNotice.ts:12} exist). Every failure degrades to one
 * error toast: an unknown id, an invalid transition, a missing title service
 * or a malformed payload.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.LifecycleException;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.SettleReason;
import com.astroreen.jhin.plugin.ui.screens.ActionDescriptors;
import com.astroreen.jhin.plugin.ui.screens.SessionsScreen;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.BooleanSupplier;
import java.util.function.Function;

final class SessionActions {

    /**
     * The undo-notice window of the T98 toasts: the upstream 5&nbsp;s undo
     * window ({@code showThreadUndoNotice.ts:104-112}, commit {@code
     * 37de6cb}), carried as the toast {@code duration} so the client card
     * closes with it.
     */
    static final long UNDO_WINDOW_MS = 5_000L;

    /** The snooze duration choices of the {@code Snooze\u2026} sheet. */
    private static final List<Map<String, Object>> SNOOZE_DURATIONS = List.of(
            Map.of("label", "15 minutes", "durationMs", 900_000L),
            Map.of("label", "1 hour", "durationMs", 3_600_000L),
            Map.of("label", "4 hours", "durationMs", 14_400_000L),
            Map.of("label", "Tomorrow", "durationMs", 86_400_000L),
            Map.of("label", "Next week", "durationMs", 604_800_000L));

    private SessionActions() {
    }

    /** {@code pin}: pins the session. Upstream shows no undo notice for pinning. */
    static ActionRoute.ActionHandler pin(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload,
                id -> lifecycle.pin(id, null), null);
    }

    /** {@code unpin}: unpins the session, answering the {@code Unpinned} undo notice. */
    static ActionRoute.ActionHandler unpin(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::unpin, "Unpinned");
    }

    /** {@code settle}: settles the session by hand, answering the {@code Settled} notice. */
    static ActionRoute.ActionHandler settle(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload,
                id -> lifecycle.settle(id, SettleReason.MANUAL), "Settled");
    }

    /** {@code unsettle}: reopens the session. Upstream shows no undo notice. */
    static ActionRoute.ActionHandler unsettle(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::unsettle, null);
    }

    /** {@code wake}: clears the snooze. Upstream shows no undo notice. */
    static ActionRoute.ActionHandler wake(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::wake, null);
    }

    /** {@code archive}: archives the session, answering the {@code Archived} notice. */
    static ActionRoute.ActionHandler archive(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::archive, "Archived");
    }

    /** {@code restore}: restores the session from the archive. */
    static ActionRoute.ActionHandler restore(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::restore, null);
    }

    /** {@code regenerate-title}: regenerates the session title (not undoable). */
    static ActionRoute.ActionHandler regenerateTitle(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::regenerateTitle, null);
    }

    /**
     * {@code auto-settle}: the {@code Auto-settle behavior} submenu entries
     * (T98) — sets the {@code auto_settle} flag through the lifecycle
     * service. A setting, not a transition: no undo notice (the upstream
     * opt-out is a checked submenu, {@code threadActionMenu.logic.ts:184-204}).
     */
    static ActionRoute.ActionHandler autoSettle(SessionLifecycleService lifecycle) {
        return (req, payload) -> {
            String id = ActionSupport.text(payload, "id");
            if (id == null) {
                return ActionSupport.error("A session id is required.");
            }
            Object raw = payload.get("enabled");
            if (!(raw instanceof Boolean enabled)) {
                return ActionSupport.error("An enabled boolean is required.");
            }
            try {
                lifecycle.setAutoSettle(id, enabled);
                return List.of(Directives.refresh());
            } catch (LifecycleException e) {
                return ActionSupport.error(messageOf(e));
            } catch (IllegalArgumentException e) {
                return ActionSupport.error(messageOf(e));
            }
        };
    }

    /**
     * {@code snooze}: with a {@code durationMs} or {@code until} payload field
     * it snoozes the session; without one it answers the duration-choice
     * sheet (the {@code Snooze\u2026} menu entry).
     */
    static ActionRoute.ActionHandler snooze(SessionLifecycleService lifecycle) {
        return (req, payload) -> {
            String id = ActionSupport.text(payload, "id");
            if (id == null) {
                return ActionSupport.error("A session id is required.");
            }
            Long durationMs = longField(payload, "durationMs");
            Long until = longField(payload, "until");
            if (durationMs == null && until == null) {
                return List.of(Directives.dialog(snoozeSheet(id), "sheet"));
            }
            return lifecycleOp(payload, key -> until != null
                    ? lifecycle.snooze(key, until)
                    : lifecycle.snoozeFor(key, durationMs), "Snoozed");
        };
    }

    /**
     * {@code reorder}: persists the posted full id order of one section (the
     * Move up / Move down entries post the post-move order).
     */
    static ActionRoute.ActionHandler reorder(SessionLifecycleService lifecycle) {
        return (req, payload) -> {
            Object raw = payload.get("ids");
            if (!(raw instanceof List<?> ids) || ids.isEmpty()) {
                return ActionSupport.error("An ordered id list is required.");
            }
            List<String> order = ids.stream().map(String::valueOf).toList();
            try {
                lifecycle.reorder(order);
                return List.of(Directives.refresh());
            } catch (LifecycleException e) {
                return ActionSupport.error(messageOf(e));
            } catch (IllegalArgumentException e) {
                return ActionSupport.error(messageOf(e));
            }
        };
    }

    /** {@code delete-session}: deletes the thread. */
    static ActionRoute.ActionHandler deleteSession(SessionStore store) {
        return (req, payload) -> {
            String id = ActionSupport.text(payload, "id");
            if (id == null) {
                return ActionSupport.error("A session id is required.");
            }
            Optional<String> account = ActionSupport.account(req);
            boolean deleted = account
                    .map(owner -> store.delete(owner, id))
                    .orElseGet(() -> store.delete(id));
            return deleted
                    ? List.of(Directives.refresh())
                    : ActionSupport.error("Unknown session.");
        };
    }

    /**
     * {@code arrange-toggle}: flips the reorder mode and re-renders the shell
     * through {@code setScreen}; the mode lives only in the rendered tree.
     */
    static ActionRoute.ActionHandler arrangeToggle(SessionStore store,
                                                   BooleanSupplier providersLink) {
        return (req, payload) -> {
            boolean arrange = Boolean.TRUE.equals(payload.get("arrange"));
            UiNode screen = SessionsScreen.render(
                    store, ActionSupport.account(req), providersLink.getAsBoolean(), arrange);
            return List.of(Directives.setScreen("sessions", screen));
        };
    }

    /**
     * The duration-choice sheet of {@code Snooze\u2026}: one button per
     * duration, each dispatching {@code snooze} with its {@code durationMs}.
     */
    static UiNode snoozeSheet(String sessionId) {
        List<Object> buttons = new ArrayList<>();
        for (Map<String, Object> choice : SNOOZE_DURATIONS) {
            String label = String.valueOf(choice.get("label"));
            long durationMs = (Long) choice.get("durationMs");
            buttons.add(Ui.button(label)
                    .style("secondary")
                    .action(ActionDescriptors.of("snooze",
                            Map.of("id", sessionId, "durationMs", durationMs), null))
                    .build());
        }
        return Ui.sheet()
                .title("Snooze thread")
                .body(Ui.container()
                        .direction("column")
                        .gap(8)
                        .children(buttons)
                        .build())
                .footer(Ui.button("Cancel")
                        .style("text")
                        .action(Directives.dismissDialog())
                        .build())
                .build();
    }

    /**
     * Runs one lifecycle operation and answers a refresh or an error toast.
     * With a non-null {@code notice} label the success answer leads with the
     * T98 undo notice — the upstream wording {@code <label> 1 thread,}
     * ({@code SidebarThreadUndoNotice.tsx:15,20}) carrying the {@code undo}
     * action and the 5&nbsp;s window — before the refresh.
     */
    private static List<Map<String, Object>> lifecycleOp(
            Map<String, Object> payload, Function<String, Session> op, String notice) {
        String id = ActionSupport.text(payload, "id");
        if (id == null) {
            return ActionSupport.error("A session id is required.");
        }
        try {
            op.apply(id);
            if (notice == null) {
                return List.of(Directives.refresh());
            }
            return List.of(
                    Directives.toast(notice + " 1 thread,",
                            ActionDescriptors.of("undo"), UNDO_WINDOW_MS),
                    Directives.refresh());
        } catch (LifecycleException e) {
            return ActionSupport.error(messageOf(e));
        } catch (IllegalArgumentException e) {
            return ActionSupport.error(messageOf(e));
        }
    }

    /** One payload field as a long; {@code null} when absent or malformed. */
    private static Long longField(Map<String, Object> payload, String key) {
        Object value = payload.get(key);
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value instanceof String text && !text.isBlank()) {
            try {
                return Long.parseLong(text.trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}