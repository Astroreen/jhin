/**
 * The action descriptors a button or a form submit posts back to the server:
 * the {@code /ui/action/<name>} wire shape of the SDUI contract. Every screen
 * builds its server round-trips through this factory so the descriptor shape
 * stays in one place.
 */
package com.astroreen.jhin.plugin.ui.screens;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ActionDescriptors {

    private ActionDescriptors() {
    }

    /**
     * The descriptor of one action without payload or included inputs.
     *
     * @param name the action name, matched against {@code /ui/action/{name}}
     * @return the descriptor map
     */
    public static Map<String, Object> of(String name) {
        return of(name, null, null);
    }

    /**
     * The descriptor of one action.
     *
     * @param name    the action name, matched against {@code /ui/action/{name}}
     * @param payload the fixed payload fields, {@code null} or empty for none
     * @param include the local input ids merged into the payload at dispatch,
     *                {@code null} or empty for none
     * @return the descriptor map: {@code path}, {@code method}, {@code name}
     *         plus {@code payload} and {@code include} when present
     */
    public static Map<String, Object> of(String name, Map<String, Object> payload,
                                         List<String> include) {
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("path", "/ui/action/" + name);
        action.put("method", "POST");
        action.put("name", name);
        if (payload != null && !payload.isEmpty()) {
            action.put("payload", Map.copyOf(payload));
        }
        if (include != null && !include.isEmpty()) {
            action.put("include", List.copyOf(include));
        }
        return action;
    }
}
