/**
 * The pluggable screen registry: screen id to node factory. The routes only
 * ever see this interface, so the default screens are replaceable wholesale.
 *
 * <p>Two lookups with different scopes: {@link #screens} is the inline subset
 * the bootstrap payload embeds (the static screens), {@link #screen} resolves
 * any id the client navigates to — including dynamic ones like
 * {@code chat:<session-id>} the bootstrap deliberately leaves out.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.UiNode;
import com.astroreen.jhin.sdk.http.ClientInfo;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

@FunctionalInterface
interface ScreenRegistry {

    /**
     * The screens inlined into the bootstrap payload, in registration order.
     * Called per request so a screen can render request-scoped state (the
     * caller's sessions, for example).
     *
     * @param account   the caller's account id, empty when unscoped
     * @param overrides the caller's keybinding overrides (command to chord,
     *                  {@code X-Jhin-Keybindings}; empty when absent) so a
     *                  screen can render the client's current chords
     * @return screen id to node supplier
     */
    Map<String, Supplier<UiNode>> screens(Optional<String> account,
                                         Map<String, String> overrides);

    /**
     * The screens with the requesting client's identity (T111): a screen may
     * render the client version and negotiated level (the diagnostics panel).
     * The default ignores the client and delegates to
     * {@link #screens(Optional, Map)}, so a registry that does not care stays
     * a two-argument lambda.
     *
     * @param account   the caller's account id, empty when unscoped
     * @param overrides the caller's keybinding overrides
     * @param client    the parsed {@code X-Jhin-Client} header
     * @return screen id to node supplier
     */
    default Map<String, Supplier<UiNode>> screens(Optional<String> account,
                                                  Map<String, String> overrides,
                                                  ClientInfo client) {
        return screens(account, overrides);
    }

    /**
     * One screen by id, including the dynamic ids {@link #screens} does not
     * inline. The default resolves against {@link #screens}; implementations
     * with dynamic screens override it.
     *
     * @param id        the screen id (may name a dynamic screen)
     * @param account   the caller's account id, empty when unscoped
     * @param overrides the caller's keybinding overrides (see
     *                  {@link #screens})
     * @return the node supplier, or empty when the id is unknown to the caller
     */
    default Optional<Supplier<UiNode>> screen(String id, Optional<String> account,
                                              Map<String, String> overrides) {
        return Optional.ofNullable(screens(account, overrides).get(id));
    }

    /**
     * One screen by id with the requesting client's identity (T111). The
     * default delegates to {@link #screen(String, Optional, Map)}; an
     * implementation that renders the client identity overrides it.
     *
     * @param id        the screen id (may name a dynamic screen)
     * @param account   the caller's account id, empty when unscoped
     * @param overrides the caller's keybinding overrides
     * @param client    the parsed {@code X-Jhin-Client} header
     * @return the node supplier, or empty when the id is unknown to the caller
     */
    default Optional<Supplier<UiNode>> screen(String id, Optional<String> account,
                                              Map<String, String> overrides,
                                              ClientInfo client) {
        return screen(id, account, overrides);
    }
}
