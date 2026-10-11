/**
 * The action table of {@code POST /ui/action/{name}}: one handler per screen
 * action, registered always and degrading to an explanatory toast when the
 * plugin that would serve it is not loaded.
 *
 * <p>Names, exhaustively (28):
 * <ul>
 *   <li>{@code enroll} — redeem an enrollment code, answer
 *       {@code [setToken, navigate:sessions]} (jhin.security);</li>
 *   <li>{@code create-session} — create a session, answer
 *       {@code [navigate chat:<id>]} (jhin.sessions, always);</li>
 *   <li>{@code send} — post one message and start a run (jhin.agent);</li>
 *   <li>{@code cancel} — cancel the active run (jhin.agent);</li>
 *   <li>{@code create-provider} — store one LLM provider (jhin.llm);</li>
 *   <li>{@code delete-provider} — remove one LLM provider (jhin.llm);</li>
 *   <li>{@code reload} — answer {@code [toast, reloadBootstrap]}
 *       (always; the reload button only shows while jhin.reload is loaded);</li>
 *   <li>{@code undo} — revert the last lifecycle action inside the 5-second
 *       window, answer {@code [toast "Undone", refresh]} or one
 *       {@code "Nothing to undo"} toast (jhin.sessions, always);</li>
 *   <li>{@code keybind-edit} / {@code keybind-save} / {@code keybind-reset}
 *       / {@code keybind-restore} — the T70 keybinding surface: the rebind
 *       sheet and the feedback directives; the user keymap itself is
 *       persisted client-side (see {@code KeybindActions});</li>
 *   <li>{@code save-appearance} / {@code save-thread-behavior} — the T78
 *       settings surface: persist the Appearance / Thread-behavior cards
 *       into the jhin.ui settings store and answer {@code reloadBootstrap}
 *       / {@code refresh} (see {@code SettingsActions});</li>
 *   <li>the T76 thread-row table of {@code SessionActions} — {@code pin},
 *       {@code unpin}, {@code settle}, {@code unsettle}, {@code snooze},
 *       {@code wake}, {@code archive}, {@code restore},
 *       {@code regenerate-title}, {@code reorder}, {@code auto-settle}
 *       (T98), {@code delete-session} and {@code arrange-toggle}, forwarding
 *       to the lifecycle service of jhin.sessions (always loaded);</li>
 *   <li>{@code demo-snooze} (T98) — the {@code Custom\u2026} snooze dialog's
 *       confirm: answers {@code [dismissDialog, toast]} and persists
 *       nothing — the decorative picker shell of the plan's T98 step 2.</li>
 *   <li>{@code preview-reload} (T108) — the browser-preview reload: answers
 *       {@code [patch progress loading:true, toast]} and persists nothing —
 *       the decorative shell of the plan's T108 step 1.</li>
 * </ul>
 *
 * <p>The optional integrations are constructed behind their flag, so a
 * runtime without that plugin never loads its API classes through this map.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.agent.api.RunService;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.security.api.EnrollmentService;
import com.astroreen.jhin.plugin.sessions.api.SessionLifecycleService;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.plugin.sessions.api.UndoJournal;
import com.astroreen.jhin.plugin.ui.screens.RightPanelBuilder;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class Actions {

    private Actions() {
    }

    /**
     * Builds the dispatch table for one runtime.
     *
     * @param store    the session store of jhin.sessions
     * @param services the cross-plugin service registry
     * @param features which optional integrations are loaded
     * @param settings the jhin.ui settings store (T78 settings actions)
     * @return action name to handler
     */
    static Map<String, ActionRoute.ActionHandler> build(
            SessionStore store, ServiceRegistry services, Features features,
            UiSettings settings) {
        Map<String, ActionRoute.ActionHandler> handlers = new LinkedHashMap<>();
        handlers.put("enroll", enroll(services, features));
        handlers.put("create-session", new CreateSessionAction(store)::handle);
        handlers.put("send", send(store, services, features));
        handlers.put("cancel", cancel(services, features));
        handlers.put("create-provider", createProvider(services, features));
        handlers.put("delete-provider", deleteProvider(services, features));
        handlers.put("reload", ReloadAction::handle);
        handlers.put("preview-reload", Actions::previewReload);
        handlers.put("undo", undo(services));
        handlers.put("keybind-edit", KeybindActions::edit);
        handlers.put("keybind-save", KeybindActions::save);
        handlers.put("keybind-reset", KeybindActions::reset);
        handlers.put("keybind-restore", KeybindActions::restore);
        handlers.put("save-appearance", SettingsActions.saveAppearance(settings));
        handlers.put("save-thread-behavior", SettingsActions.saveThreadBehavior(settings));
        registerThreadRowActions(handlers, store, services, features);
        return Map.copyOf(handlers);
    }

    /**
     * Registers the T76 thread-row actions: the lifecycle forwards of
     * {@link SessionActions} plus the arrange toggle. The lifecycle service
     * of jhin.sessions is part of the mandatory session API, so its absence
     * degrades to the explanatory toast like every optional integration.
     */
    private static void registerThreadRowActions(
            Map<String, ActionRoute.ActionHandler> handlers,
            SessionStore store, ServiceRegistry services, Features features) {
        Optional<SessionLifecycleService> lifecycle =
                services.find(SessionLifecycleService.class);
        if (lifecycle.isPresent()) {
            SessionLifecycleService service = lifecycle.orElseThrow();
            handlers.put("pin", SessionActions.pin(service));
            handlers.put("unpin", SessionActions.unpin(service));
            handlers.put("settle", SessionActions.settle(service));
            handlers.put("unsettle", SessionActions.unsettle(service));
            handlers.put("snooze", SessionActions.snooze(service));
            handlers.put("wake", SessionActions.wake(service));
            handlers.put("archive", SessionActions.archive(service));
            handlers.put("restore", SessionActions.restore(service));
            handlers.put("regenerate-title", SessionActions.regenerateTitle(service));
            handlers.put("reorder", SessionActions.reorder(service));
            handlers.put("auto-settle", SessionActions.autoSettle(service));
        } else {
            ActionRoute.ActionHandler unavailable = (req, payload) -> ActionSupport.error(
                    "The session lifecycle service is unavailable.");
            for (String name : List.of("pin", "unpin", "settle", "unsettle", "snooze",
                    "wake", "archive", "restore", "regenerate-title", "reorder",
                    "auto-settle")) {
                handlers.put(name, unavailable);
            }
        }
        handlers.put("delete-session", SessionActions.deleteSession(store));
        handlers.put("arrange-toggle", SessionActions.arrangeToggle(store,
                () -> features.llm() && services.find(ProviderRegistry.class).isPresent()));
        handlers.put("demo-snooze", Actions::demoSnooze);
    }

    /**
     * The {@code Custom\u2026} snooze dialog's confirm (T98): the decorative
     * picker shell — the answer closes the dialog and toasts the preview
     * wording, persisting nothing (plan section 14.10: no fake success that
     * claims real work happened).
     */
    private static List<Map<String, Object>> demoSnooze(
            @SuppressWarnings("unused") HttpRequest req,
            @SuppressWarnings("unused") Map<String, Object> payload) {
        return List.of(Directives.dismissDialog(), Directives.toast(
                "Custom snooze is a preview in this build."));
    }

    /**
     * The T108 browser-preview reload: the decorative shell that starts the
     * {@code preview-loading} bar. The client validates the included URL
     * first (the input is {@code required}), so an empty address never
     * reaches this handler — it shows the inline error instead. The answer
     * patches the progress node to its {@code loading: true} re-render and
     * toasts the preview wording; there is no browser automation (plan
     * section 14.1).
     */
    private static List<Map<String, Object>> previewReload(
            @SuppressWarnings("unused") HttpRequest req,
            @SuppressWarnings("unused") Map<String, Object> payload) {
        return List.of(
                Directives.patch(RightPanelBuilder.PREVIEW_PROGRESS_ID,
                        RightPanelBuilder.previewProgress(true)),
                Directives.toast("Reloading preview (preview only)"));
    }

    /** The enroll handler, or its absent-plugin stand-in. */
    private static ActionRoute.ActionHandler enroll(ServiceRegistry services, Features features) {
        if (!features.security()) {
            return (req, payload) -> List.of(Directives.toast(
                    "This server has no security plugin installed.", "info"));
        }
        Optional<EnrollmentService> enrollment = services.find(EnrollmentService.class);
        return enrollment
                .map(service -> (ActionRoute.ActionHandler) new EnrollAction(service)::handle)
                .orElseGet(() -> (req, payload) -> ActionSupport.error(
                        "The enrollment service is unavailable."));
    }

    /** The send handler, or its absent-plugin stand-in. */
    private static ActionRoute.ActionHandler send(
            SessionStore store, ServiceRegistry services, Features features) {
        if (!features.agent()) {
            return (req, payload) -> List.of(Directives.toast(
                    "This server has no agent plugin installed.", "info"));
        }
        Optional<RunService> runs = services.find(RunService.class);
        return runs
                .map(service -> (ActionRoute.ActionHandler) new SendAction(store, service)::handle)
                .orElseGet(() -> (req, payload) -> ActionSupport.error(
                        "The agent run service is unavailable."));
    }

    /** The cancel handler, or its absent-plugin stand-in. */
    private static ActionRoute.ActionHandler cancel(ServiceRegistry services, Features features) {
        if (!features.agent()) {
            return (req, payload) -> List.of(Directives.toast(
                    "This server has no agent plugin installed.", "info"));
        }
        Optional<RunService> runs = services.find(RunService.class);
        return runs
                .map(service -> (ActionRoute.ActionHandler) new CancelAction(service)::handle)
                .orElseGet(() -> (req, payload) -> ActionSupport.error(
                        "The agent run service is unavailable."));
    }

    /** The create-provider handler, or its absent-plugin stand-in. */
    private static ActionRoute.ActionHandler createProvider(
            ServiceRegistry services, Features features) {
        if (!features.llm()) {
            return (req, payload) -> List.of(Directives.toast(
                    "This server has no LLM plugin installed.", "info"));
        }
        Optional<ProviderRegistry> providers = services.find(ProviderRegistry.class);
        return providers
                .map(service -> (ActionRoute.ActionHandler)
                        new CreateProviderAction(service)::handle)
                .orElseGet(() -> (req, payload) -> ActionSupport.error(
                        "The provider registry is unavailable."));
    }

    /** The delete-provider handler, or its absent-plugin stand-in. */
    private static ActionRoute.ActionHandler deleteProvider(
            ServiceRegistry services, Features features) {
        if (!features.llm()) {
            return (req, payload) -> List.of(Directives.toast(
                    "This server has no LLM plugin installed.", "info"));
        }
        Optional<ProviderRegistry> providers = services.find(ProviderRegistry.class);
        return providers
                .map(service -> (ActionRoute.ActionHandler)
                        new DeleteProviderAction(service)::handle)
                .orElseGet(() -> (req, payload) -> ActionSupport.error(
                        "The provider registry is unavailable."));
    }

    /**
     * The undo handler, or its absent-journal stand-in. Without the undo
     * journal there is nothing to undo, so the answer is the client's own
     * fallback wording instead of an explanation.
     */
    private static ActionRoute.ActionHandler undo(ServiceRegistry services) {
        Optional<UndoJournal> journal = services.find(UndoJournal.class);
        return journal
                .map(service -> (ActionRoute.ActionHandler) new UndoAction(service)::handle)
                .orElseGet(() -> (req, payload) -> ActionSupport.error("Nothing to undo"));
    }
}
