/**
 * The {@code X-Jhin-Keybindings} request header (docs/sdui.md section 8): the
 * client's current user keymap overrides in the store shape
 * {@code {"rules": [{"command": …, "keys": …}]}} so screens and actions can
 * render the chords the client actually uses. Absent or malformed headers
 * degrade to no overrides — the server falls back to its default keymap.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.json.Json;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ClientKeybindings {

    /** The header name, lower-cased like {@link HttpRequest#headers()}. */
    static final String HEADER = "x-jhin-keybindings";

    private ClientKeybindings() {
    }

    /**
     * The override map of one request: command to chord.
     *
     * @param req the request carrying the header
     * @return the overrides, empty when absent or malformed (never throws)
     */
    static Map<String, String> of(HttpRequest req) {
        return parse(req.headers().getOrDefault(HEADER, ""));
    }

    /**
     * The grouped command-palette metadata of one request (T115): the
     * {@link KeybindCatalog} vocabulary with this caller's effective chords
     * (the {@code X-Jhin-Keybindings} override when present, otherwise the
     * server default) as the bootstrap {@code palette} block. Reuses the
     * catalogue as the single command-metadata source.
     *
     * @param req the request carrying the override header
     * @return the four palette groups in render order (never throws)
     */
    static List<Map<String, Object>> paletteMetadata(HttpRequest req) {
        return KeybindCatalog.paletteGroups(of(req));
    }

    /**
     * Parses one header value.
     *
     * @param header the store-shape JSON ({@code {"rules": […]}}, never null)
     * @return command to chord; empty for absent or malformed values
     */
    static Map<String, String> parse(String header) {
        if (header == null || header.isBlank()) {
            return Map.of();
        }
        try {
            Map<String, Object> body = Json.readMap(header);
            Object rules = body.get("rules");
            if (!(rules instanceof List<?> list)) {
                return Map.of();
            }
            Map<String, String> overrides = new LinkedHashMap<>();
            for (Object entry : list) {
                if (!(entry instanceof Map<?, ?> rule)) {
                    continue;
                }
                Object command = rule.get("command");
                Object keys = rule.get("keys");
                if (command instanceof String name && !name.isEmpty()
                        && keys instanceof String chord && !chord.isEmpty()) {
                    overrides.put(name, chord);
                }
            }
            return overrides;
        } catch (RuntimeException e) {
            return Map.of();
        }
    }
}
