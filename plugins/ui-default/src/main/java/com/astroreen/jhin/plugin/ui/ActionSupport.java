/**
 * Shared plumbing of the action handlers: payload field extraction, the
 * one-directive answers and the request-scoped account lookup.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.http.HttpRequest;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class ActionSupport {

    private ActionSupport() {
    }

    /**
     * One payload field as text; {@code null} when absent or blank.
     *
     * @param payload the merged action payload
     * @param key     the field name
     * @return the trimmed text, or {@code null}
     */
    static String text(Map<String, Object> payload, String key) {
        Object value = payload.get(key);
        if (!(value instanceof String text)) {
            return null;
        }
        String trimmed = text.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** The {@code toast} answer of one informational message. */
    static List<Map<String, Object>> toast(String text) {
        return List.of(Directives.toast(text));
    }

    /** The {@code toast} answer of one failure message. */
    static List<Map<String, Object>> error(String text) {
        return List.of(Directives.toast(text, "error"));
    }

    /**
     * The caller's account id, empty when unscoped. An unusable principal
     * counts as unscoped here instead of failing the whole action.
     *
     * @param req the current request
     * @return the account id, or empty
     */
    static Optional<String> account(HttpRequest req) {
        try {
            return Principals.accountId(req);
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }
}
