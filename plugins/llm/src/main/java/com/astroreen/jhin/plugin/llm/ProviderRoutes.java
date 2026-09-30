/**
 * JSON CRUD routes over the provider registry.
 *
 * <p>Endpoints: {@code GET /providers} (list), {@code POST /providers}
 * (create), {@code GET /providers/{id}}, {@code DELETE /providers/{id}}
 * (204) and {@code GET /providers/formats} (the sorted registered factory
 * formats). An unknown or foreign provider id is a {@code 404} whose body
 * contains {@code not_found}; a malformed body is a {@code 400} whose body
 * names the offending field; an unresolvable format is a {@code 400} whose
 * body contains {@code unknown_format} and lists the available formats. Every
 * response serializes {@link ProviderRecord} shapes — metadata only, never the
 * api key. Every request is scoped to the account resolved from the request
 * principal (see {@link Principals}); without a security plugin the implicit
 * account {@code local} is used.
 */
package com.astroreen.jhin.plugin.llm;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import com.astroreen.jhin.plugin.llm.api.ProviderException;
import com.astroreen.jhin.plugin.llm.api.ProviderRecord;
import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.json.Json;
import java.util.Map;
import java.util.Optional;

final class ProviderRoutes {

    private final ProviderRegistry registry;

    ProviderRoutes(ProviderRegistry registry) {
        this.registry = registry;
    }

    /**
     * Lists the providers of the caller, newest first. Falls back to the
     * implicit account {@code local} when no principal is present.
     *
     * @param req the request
     * @return the provider metadata list
     */
    HttpResponse list(HttpRequest req) {
        return HttpResponse.json(200, registry.list(accountId(req)));
    }

    /**
     * Creates a provider from a JSON body: {@code format} and {@code model}
     * are required non-blank strings, {@code apiKey} and {@code baseUrl} are
     * optional. {@code format} is validated first, so a body without any
     * field is rejected naming {@code format}.
     *
     * @param req the request carrying the JSON body
     * @return {@code 201} with the created provider metadata, {@code 400}
     *         naming the offending field, or {@code 400} with
     *         {@code unknown_format} listing the available formats
     */
    HttpResponse create(HttpRequest req) {
        try {
            Map<String, Object> body = parseBody(req);
            String format = requireText(body, "format");
            String model = requireText(body, "model");
            Optional<String> apiKey = optionalText(body, "apiKey");
            Optional<String> baseUrl = optionalText(body, "baseUrl");
            ProviderConfig cfg = new ProviderConfig(
                    apiKey.orElse(null), model, baseUrl.orElse(null));
            ProviderRecord created = registry.create(accountId(req), format, cfg);
            return HttpResponse.json(201, created);
        } catch (ProviderException e) {
            return HttpResponse.error(e.httpStatus(), e.code(), e.getMessage());
        } catch (IllegalArgumentException e) {
            return HttpResponse.error(400, ProviderException.CODE_INVALID_REQUEST, e.getMessage());
        }
    }

    /**
     * Fetches one provider by id.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 200} with the provider metadata, or {@code 404}
     *         containing {@code not_found}
     */
    HttpResponse get(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        return registry.get(accountId(req), id)
                .map(found -> HttpResponse.json(200, found))
                .orElseGet(() -> notFound(id));
    }

    /**
     * Deletes one provider. The stored api key is destroyed with the row.
     *
     * @param req the request carrying the {@code id} path capture
     * @return {@code 204} on deletion, or {@code 404} containing
     *         {@code not_found}
     */
    HttpResponse delete(HttpRequest req) {
        String id = req.pathParams().getOrDefault("id", "");
        return registry.delete(accountId(req), id)
                ? HttpResponse.empty(204)
                : notFound(id);
    }

    /**
     * Lists the sorted formats of the currently registered factories,
     * discovered live.
     *
     * @param req the request
     * @return {@code 200} with the sorted JSON array of formats
     */
    HttpResponse formats(HttpRequest req) {
        return HttpResponse.json(200, registry.formats());
    }

    private static String accountId(HttpRequest req) {
        return Principals.accountId(req).orElse(ProviderRegistry.LOCAL_ACCOUNT);
    }

    private static HttpResponse notFound(String id) {
        return HttpResponse.error(404, ProviderException.CODE_NOT_FOUND,
                "provider " + id + " not found");
    }

    private static Map<String, Object> parseBody(HttpRequest req) {
        String body = req.bodyAsString();
        if (body == null || body.isBlank()) {
            return Map.of();
        }
        try {
            return Json.readMap(body);
        } catch (PluginException e) {
            throw new IllegalArgumentException("request body is not valid JSON", e);
        }
    }

    private static String requireText(Map<String, Object> body, String field) {
        return optionalText(body, field)
                .orElseThrow(() -> new IllegalArgumentException(field + " is required"));
    }

    private static Optional<String> optionalText(Map<String, Object> body, String field) {
        Object value = body.get(field);
        if (value == null) {
            return Optional.empty();
        }
        if (!(value instanceof String text)) {
            throw new IllegalArgumentException(field + " must be a string");
        }
        if (text.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return Optional.of(text);
    }
}