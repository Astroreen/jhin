/**
 * The action table of {@code POST /ui/action/{name}}: one handler per screen
 * action, registered always and degrading to an explanatory toast when the
 * plugin that would serve it is not loaded.
 *
 * <p>Names, exhaustively (11):
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
 *   <li>{@code keybind-edit} / {@code keybind-save} / {@code keybind-reset}
 *       / {@code keybind-restore} — the T70 keybinding surface: the rebind
 *       sheet and the feedback directives; the user keymap itself is
 *       persisted client-side (see {@code KeybindActions}).</li>
 * </ul>
 *
 * <p>The optional integrations are constructed behind their flag, so a
 * runtime without that plugin never loads its API classes through this map.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.agent.api.RunService;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.security.api.EnrollmentService;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.ServiceRegistry;
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
     * @return action name to handler
     */
    static Map<String, ActionRoute.ActionHandler> build(
            SessionStore store, ServiceRegistry services, Features features) {
        Map<String, ActionRoute.ActionHandler> handlers = new LinkedHashMap<>();
        handlers.put("enroll", enroll(services, features));
        handlers.put("create-session", new CreateSessionAction(store)::handle);
        handlers.put("send", send(store, services, features));
        handlers.put("cancel", cancel(services, features));
        handlers.put("create-provider", createProvider(services, features));
        handlers.put("delete-provider", deleteProvider(services, features));
        handlers.put("reload", ReloadAction::handle);
        handlers.put("keybind-edit", KeybindActions::edit);
        handlers.put("keybind-save", KeybindActions::save);
        handlers.put("keybind-reset", KeybindActions::reset);
        handlers.put("keybind-restore", KeybindActions::restore);
        return Map.copyOf(handlers);
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
}
