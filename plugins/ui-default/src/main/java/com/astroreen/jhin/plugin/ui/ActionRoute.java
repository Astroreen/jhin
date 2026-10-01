/**
 * {@code POST /ui/action/{name}}: action dispatch of the SDUI contract.
 *
 * <p>The request body is {@code {"action":"<name>","payload":{…}}} (the name in
 * the body is informational; the path capture is authoritative). The handler
 * registered for the name returns an ordered directive list and the response
 * is {@code {"client":[…]}} with the directives the caller cannot honour
 * dropped first (D-22). An unknown name is a JSON {@code 404} carrying the
 * {@code unknown_action} error code; a body that is not a JSON object is a
 * {@code 400} naming the body.
 */
package com.astroreen.jhin.plugin.ui;

import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ActionRoute {

    /** One action body: the merged payload of the dispatch. */
    @FunctionalInterface
    interface ActionHandler {

        /**
         * Runs the action and answers its ordered client directive list.
         *
         * @param req     the request that carried the action
         * @param payload the merged payload ({@code payload} of the body plus
         *                the client-side values of the included input ids)
         * @return the directive list, empty when the action changes nothing
         */
        List<Map<String, Object>> handle(HttpRequest req, Map<String, Object> payload);
    }

    private final Map<String, ActionHandler> handlers;

    ActionRoute(Map<String, ActionHandler> handlers) {
        this.handlers = Map.copyOf(handlers);
    }

    /**
     * Dispatches one named action.
     *
     * @param req the request carrying the {@code name} path capture and the
     *            JSON body
     * @return {@code {"client":[…]}} or a JSON {@code 404}/{@code 400}
     */
    HttpResponse handle(HttpRequest req) {
        String name = req.pathParams().getOrDefault("name", "");
        ActionHandler handler = handlers.get(name);
        if (handler == null) {
            return HttpResponse.error(404, "unknown_action", "no action named " + name);
        }
        Map<String, Object> body;
        try {
            body = parseBody(req.bodyAsString());
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, "invalid_request", e.getMessage());
        }
        Object payload = body.get("payload");
        @SuppressWarnings("unchecked")
        Map<String, Object> arguments = (payload instanceof Map<?, ?> map)
                ? (Map<String, Object>) map
                : Map.of();
        List<Map<String, Object>> ops = handler.handle(req, arguments);
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("client", Directives.filter(ops, req.client()));
        return HttpResponse.json(200, response);
    }

    /** Parses the action body; blank bodies dispatch with an empty payload. */
    private static Map<String, Object> parseBody(String text) {
        if (text == null || text.isBlank()) {
            return Map.of();
        }
        try {
            return Json.readMap(text);
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("body must be a JSON object", e);
        }
    }
}
