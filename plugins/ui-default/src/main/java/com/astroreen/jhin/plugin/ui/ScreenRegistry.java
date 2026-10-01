/**
 * The pluggable screen registry: screen id to node factory. The routes only
 * ever see this interface, so the default screens below are replaceable
 * wholesale (the full screen classes arrive with the screens task).
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.plugin.uikit.UiNode;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

@FunctionalInterface
interface ScreenRegistry {

    /**
     * The screens visible to the caller, in registration order. Called per
     * request so a screen can render request-scoped state (the caller's
     * sessions, for example).
     *
     * @param account the caller's account id, empty when unscoped
     * @return screen id to node supplier
     */
    Map<String, Supplier<UiNode>> screens(Optional<String> account);
}
