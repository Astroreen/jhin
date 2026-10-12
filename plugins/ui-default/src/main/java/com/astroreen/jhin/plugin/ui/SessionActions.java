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
 *   <li>{@code settle} / {@code unsettle} — the settle transition; {@code settle}
 *       takes the {@code reason} payload field ({@code manual},
 *       {@code inactive}, {@code closed}, {@code pr_merged}, {@code other} —
 *       the {@link SettleReason#wire() wire names}) and defaults to
 *       {@code manual} when the field is absent; an unknown wire value is
 *       refused with an error toast;</li>
 *   <li>{@code snooze} — computes the absolute {@code snoozed_until} deadline
 *       from the payload: {@code durationMs} (a duration, resolved as
 *       {@code now + durationMs}) or {@code until} (epoch-millis number,
 *       numeric string, or local {@code yyyy-MM-dd[ ]HH:mm[:ss]} datetime in
 *       the host zone). A past or unparseable deadline answers the
 *       {@code Choose a valid date and time in the future.} error toast and
 *       mutates nothing; with no choice present at all it answers the
 *       duration-choice {@code sheet} whose buttons dispatch this same action
 *       (the shared {@code SidebarBuilder.snoozePresets} presets);</li>
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
 * <p>Every lifecycle mutation answers an undo notice: the {@code toast}
 * directive whose text is {@code <Verb> <n> thread(s),} — {@code Pinned},
 * {@code Unpinned}, {@code Settled}, {@code Reopened}, {@code Snoozed},
 * {@code Woken}, {@code Archived}, {@code Restored}, {@code Updated} and
 * {@code Reordered} for pin, unpin, settle, unsettle, snooze, wake, archive,
 * restore, auto-settle and reorder respectively ({@code n} is the number of
 * threads the mutation touched — the posted order size for {@code reorder},
 * {@code 1} elsewhere) — carrying the {@code undo} action and the 5&nbsp;s
 * window, before the refresh. {@code delete-session}, {@code regenerate-title}
 * and {@code arrange-toggle} answer no undo notice (they are not undoable).
 * Every failure degrades to one error toast: an unknown id, an invalid
 * transition, a missing title service or a malformed payload.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.sessions.api.LifecycleException;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.SettleReason;
import com.astroreen.jhin.plugin.ui.screens.ActionDescriptors;
import com.astroreen.jhin.plugin.ui.screens.SessionsScreen;
import com.astroreen.jhin.plugin.ui.screens.SidebarBuilder;
import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
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

    /** The error text of an unparsable or past {@code snoozed_until} choice. */
    private static final String SNOOZE_DEADLINE_HINT =
            "Choose a valid date and time in the future.";

    /**
     * The accepted {@code until} datetime spelling: {@code yyyy-MM-dd[ ]HH:mm[:ss]}
     * in the host zone. A {@code T} date/time separator is normalized to a
     * space before parsing.
     */
    private static final DateTimeFormatter SNOOZE_UNTIL =
            DateTimeFormatter.ofPattern("yyyy-MM-dd[ ]HH:mm[:ss]");

    private SessionActions() {
    }

    /** {@code pin}: pins the session, answering the {@code Pinned} undo notice. */
    static ActionRoute.ActionHandler pin(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload,
                id -> lifecycle.pin(id, null), "Pinned");
    }

    /** {@code unpin}: unpins the session, answering the {@code Unpinned} undo notice. */
    static ActionRoute.ActionHandler unpin(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::unpin, "Unpinned");
    }

    /**
     * {@code settle}: settles the session with the {@code reason} payload
     * field — the {@link SettleReason#wire() wire name}, {@code manual} when
     * absent — answering the {@code Settled} undo notice. An unknown wire
     * value answers an error toast and settles nothing.
     */
    static ActionRoute.ActionHandler settle(SessionLifecycleService lifecycle) {
        return (req, payload) -> {
            String wire = ActionSupport.text(payload, "reason");
            if (wire == null) {
                return lifecycleOp(payload,
                        id -> lifecycle.settle(id, SettleReason.MANUAL), "Settled");
            }
            SettleReason reason = SettleReason.fromWire(wire);
            if (reason == null) {
                return ActionSupport.error("Unknown settle reason.");
            }
            return lifecycleOp(payload, id -> lifecycle.settle(id, reason), "Settled");
        };
    }

    /** {@code unsettle}: reopens the session, answering the {@code Reopened} undo notice. */
    static ActionRoute.ActionHandler unsettle(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::unsettle, "Reopened");
    }

    /** {@code wake}: clears the snooze, answering the {@code Woken} undo notice. */
    static ActionRoute.ActionHandler wake(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::wake, "Woken");
    }

    /** {@code archive}: archives the session, answering the {@code Archived} undo notice. */
    static ActionRoute.ActionHandler archive(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::archive, "Archived");
    }

    /** {@code restore}: restores the session from the archive, answering the {@code Restored} undo notice. */
    static ActionRoute.ActionHandler restore(SessionLifecycleService lifecycle) {
        return (req, payload) -> lifecycleOp(payload, lifecycle::restore, "Restored");
    }

    /**
     * {@code regenerate-title}: regenerates the session title. Not undoable —
     * it answers the bare refresh, no undo notice.
     */
    static ActionRoute.ActionHandler regenerateTitle(SessionLifecycleService lifecycle) {
        return (req, payload) -> {
            String id = ActionSupport.text(payload, "id");
            if (id == null) {
                return ActionSupport.error("A session id is required.");
            }
            try {
                lifecycle.regenerateTitle(id);
                return List.of(Directives.refresh());
            } catch (LifecycleException e) {
                return ActionSupport.error(messageOf(e));
            } catch (IllegalArgumentException e) {
                return ActionSupport.error(messageOf(e));
            }
        };
    }

    /**
     * {@code auto-settle}: the {@code Auto-settle behavior} submenu entries
     * (T98) — sets the {@code auto_settle} flag through the lifecycle
     * service, answering the {@code Updated} undo notice.
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
            return lifecycleOp(payload,
                    key -> lifecycle.setAutoSettle(key, enabled), "Updated");
        };
    }

    /**
     * {@code snooze}: resolves the absolute {@code snoozed_until} deadline
     * from the payload — {@code durationMs} (now + duration) or {@code until}
     * (epoch-millis number, numeric string, or local
     * {@code yyyy-MM-dd[ ]HH:mm[:ss]} datetime) — and snoozes the session,
     * answering the {@code Snoozed} undo notice. A past or unparseable
     * deadline answers the error toast without mutating; with no choice
     * present it answers the duration-choice sheet instead.
     */
    static ActionRoute.ActionHandler snooze(SessionLifecycleService lifecycle) {
        return (req, payload) -> {
            String id = ActionSupport.text(payload, "id");
            if (id == null) {
                return ActionSupport.error("A session id is required.");
            }
            if (payload.get("durationMs") == null && payload.get("until") == null) {
                return List.of(Directives.dialog(snoozeSheet(id), "sheet"));
            }
            long now = System.currentTimeMillis();
            Long deadline = snoozedUntil(payload, now);
            if (deadline == null || deadline <= now) {
                return ActionSupport.error(SNOOZE_DEADLINE_HINT);
            }
            long untilTs = deadline;
            return lifecycleOp(payload,
                    key -> lifecycle.snooze(key, untilTs), "Snoozed");
        };
    }

    /**
     * {@code reorder}: persists the posted full id order of one section (the
     * Move up / Move down entries post the post-move order), answering the
     * {@code Reordered} undo notice over the posted threads.
     */
    static ActionRoute.ActionHandler reorder(SessionLifecycleService lifecycle) {
        return (req, payload) -> {
            Object raw = payload.get("ids");
            if (!(raw instanceof List<?> ids) || ids.isEmpty()) {
                return ActionSupport.error("An ordered id list is required.");
            }
            List<String> order = ids.stream().map(String::valueOf).toList();
            return mutation(() -> lifecycle.reorder(order), "Reordered", order.size());
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
     * The duration-choice sheet of {@code Snooze\u2026}: one button per shared
     * preset, each dispatching {@code snooze} with the preset's absolute
     * {@code until} deadline.
     */
    static UiNode snoozeSheet(String sessionId) {
        List<Object> buttons = new ArrayList<>();
        for (SidebarBuilder.SnoozePreset preset : SidebarBuilder.snoozePresets(
                System.currentTimeMillis(), ZoneId.systemDefault())) {
            buttons.add(Ui.button(preset.label())
                    .style("secondary")
                    .action(ActionDescriptors.of("snooze",
                            Map.of("id", sessionId, "until", preset.until()), null))
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
     * Runs one single-session lifecycle operation and answers its undo notice
     * and refresh: the T98 wording {@code <verb> 1 thread,} carrying the
     * {@code undo} action and the 5&nbsp;s window before the refresh.
     */
    private static List<Map<String, Object>> lifecycleOp(
            Map<String, Object> payload, Function<String, Session> op, String verb) {
        String id = ActionSupport.text(payload, "id");
        if (id == null) {
            return ActionSupport.error("A session id is required.");
        }
        return mutation(() -> op.apply(id), verb, 1);
    }

    /**
     * Runs one undoable lifecycle mutation and answers its undo notice and
     * refresh: the toast text {@code <verb> <n> thread(s),} — pluralized on
     * {@code n}, the number of threads the mutation touched — carrying the
     * {@code undo} action ({@link ActionDescriptors#of(String)}) and the
     * {@link #UNDO_WINDOW_MS} window. An invalid transition or malformed
     * payload degrades to one error toast and no mutation is announced.
     */
    private static List<Map<String, Object>> mutation(
            Runnable op, String verb, int threads) {
        try {
            op.run();
        } catch (LifecycleException e) {
            return ActionSupport.error(messageOf(e));
        } catch (IllegalArgumentException e) {
            return ActionSupport.error(messageOf(e));
        }
        return List.of(
                Directives.toast(verb + " " + threads + (threads == 1 ? " thread," : " threads,"),
                        ActionDescriptors.of("undo"), UNDO_WINDOW_MS),
                Directives.refresh());
    }

    /**
     * The absolute {@code snoozed_until} deadline of one payload:
     * {@code durationMs} resolved as {@code now + durationMs}, otherwise
     * {@code until} as epoch-millis number, numeric string or local
     * {@code yyyy-MM-dd[ ]HH:mm[:ss]} datetime. {@code null} when the present
     * choice is not a valid deadline.
     */
    private static Long snoozedUntil(Map<String, Object> payload, long now) {
        if (payload.get("durationMs") != null) {
            Long ms = longField(payload, "durationMs");
            return ms == null ? null : now + ms;
        }
        return untilMillis(payload.get("until"));
    }

    /**
     * One {@code until} value as epoch milliseconds: a number or numeric
     * string directly, a local {@code yyyy-MM-dd[ ]HH:mm[:ss]} datetime in the
     * host zone otherwise ({@code null} when unparseable).
     */
    private static Long untilMillis(Object raw) {
        if (raw instanceof Number number) {
            return number.longValue();
        }
        if (raw instanceof String text) {
            String trimmed = text.trim();
            if (trimmed.isEmpty()) {
                return null;
            }
            try {
                return Long.parseLong(trimmed);
            } catch (NumberFormatException e) {
                try {
                    return LocalDateTime.parse(
                                    trimmed.replace('T', ' ').replace('t', ' '), SNOOZE_UNTIL)
                            .atZone(ZoneId.systemDefault())
                            .toInstant()
                            .toEpochMilli();
                } catch (DateTimeParseException ex) {
                    return null;
                }
            }
        }
        return null;
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
