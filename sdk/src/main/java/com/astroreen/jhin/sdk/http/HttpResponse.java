/**
 * One outgoing HTTP response: status, headers and body — or an SSE marker.
 *
 * <p>Produced by {@link HttpHandler}s and {@link HttpFilter}s and written by
 * the kernel. Header names are lower-cased and the header map is immutable on
 * construction; the factories below set the conventional {@code Content-Type}
 * for their payload. The {@code sse} component is an internal marker the
 * kernel uses to switch into server-sent-events mode; it is {@code null} for
 * normal responses and is never set by plugins.
 *
 * <p>Components: {@code status} — the HTTP status code; {@code headers} —
 * response headers with lower-cased names; {@code body} — the raw body bytes;
 * {@code sse} — internal marker, {@code null} for normal responses.
 */
package com.astroreen.jhin.sdk.http;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

public record HttpResponse(int status, Map<String, String> headers, byte[] body,
                           Object sse /* internal marker, null for normal responses */) {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String JSON_CONTENT_TYPE = "application/json; charset=utf-8";
    private static final String TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

    /**
     * Creates a response, normalizing its header names to lower case and
     * freezing the header map; a {@code null} body becomes empty bytes.
     * Called by the factories below, by {@link #withHeader(String, String)}
     * and by kernel response writers.
     *
     * @param status  the HTTP status code
     * @param headers the response headers; names are lower-cased
     * @param body    the raw body bytes
     * @param sse     internal SSE marker, {@code null} for normal responses
     */
    public HttpResponse {
        Map<String, String> normalized = new LinkedHashMap<>();
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                if (entry.getKey() != null) {
                    normalized.put(entry.getKey().toLowerCase(Locale.ROOT), entry.getValue());
                }
            }
        }
        headers = Collections.unmodifiableMap(normalized);
        body = (body == null) ? new byte[0] : body.clone();
    }

    /**
     * A JSON response: {@code body} serialized with Jackson and
     * {@code Content-Type: application/json; charset=utf-8}. Called by handlers
     * that return structured payloads.
     *
     * @param status the HTTP status code
     * @param body   the payload to serialize
     * @return the response
     */
    public static HttpResponse json(int status, Object body) {
        byte[] bytes;
        try {
            bytes = MAPPER.writeValueAsBytes(body);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("body is not JSON-serializable", e);
        }
        return new HttpResponse(status, Map.of("Content-Type", JSON_CONTENT_TYPE), bytes, null);
    }

    /**
     * A plain-text response: {@code body} encoded as UTF-8 and
     * {@code Content-Type: text/plain; charset=utf-8}. Called by handlers that
     * return human-readable text.
     *
     * @param status the HTTP status code
     * @param body   the text to send
     * @return the response
     */
    public static HttpResponse text(int status, String body) {
        byte[] bytes = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
        return new HttpResponse(status, Map.of("Content-Type", TEXT_CONTENT_TYPE), bytes, null);
    }

    /**
     * A bodyless response (for example {@code 204 No Content}). Called by
     * handlers whose only output is the status code.
     *
     * @param status the HTTP status code
     * @return the response
     */
    public static HttpResponse empty(int status) {
        return new HttpResponse(status, Map.of(), new byte[0], null);
    }

    /**
     * An error response with body {@code {"error":code,"message":msg}} and
     * JSON content type. Called by handlers and filters rejecting a request.
     *
     * @param status  the HTTP status code
     * @param code    a stable machine-readable error code
     * @param message a human-readable description
     * @return the response
     */
    public static HttpResponse error(int status, String code, String message) {
        Map<String, String> payload = new LinkedHashMap<>();
        payload.put("error", code);
        payload.put("message", message);
        byte[] bytes;
        try {
            bytes = MAPPER.writeValueAsBytes(payload);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("error payload is not serializable", e);
        }
        return new HttpResponse(status, Map.of("Content-Type", JSON_CONTENT_TYPE), bytes, null);
    }

    /**
     * Returns a copy of this response with one header added or replaced;
     * {@code name} is lower-cased. Called by filters decorating a response
     * produced by the rest of the chain.
     *
     * @param name  the header name; lower-cased on the copy
     * @param value the header value
     * @return the copy
     */
    public HttpResponse withHeader(String name, String value) {
        Map<String, String> merged = new LinkedHashMap<>(headers);
        merged.put(name.toLowerCase(Locale.ROOT), value);
        return new HttpResponse(status, merged, body, sse);
    }
}
