/**
 * Minimal {@link com.astroreen.jhin.sdk.http.HttpRequest} fake for filter and
 * route tests: fixed method, path, lower-cased headers, remote address and
 * body, with a local attribute map for the principal seam.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

final class FakeHttpRequest implements HttpRequest {

    private final String method;
    private final String path;
    private final Map<String, String> headers;
    private final String remoteAddr;
    private final byte[] body;
    private final Map<String, Object> attributes = new HashMap<>();

    FakeHttpRequest(String method, String path) {
        this(method, path, Map.of(), "127.0.0.1", "");
    }

    FakeHttpRequest(String method, String path, Map<String, String> headers, String remoteAddr, String body) {
        this.method = method;
        this.path = path;
        Map<String, String> normalized = new LinkedHashMap<>();
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                normalized.put(entry.getKey().toLowerCase(Locale.ROOT), entry.getValue());
            }
        }
        this.headers = Map.copyOf(normalized);
        this.remoteAddr = remoteAddr;
        this.body = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
    }

    @Override
    public String method() {
        return method;
    }

    @Override
    public String path() {
        return path;
    }

    @Override
    public Map<String, String> pathParams() {
        return Map.of();
    }

    @Override
    public Map<String, List<String>> query() {
        return Map.of();
    }

    @Override
    public Map<String, String> headers() {
        return headers;
    }

    @Override
    public byte[] body() {
        return body.clone();
    }

    @Override
    public String bodyAsString() {
        return new String(body, StandardCharsets.UTF_8);
    }

    @Override
    public <T> T bodyAs(Class<T> type) {
        return Json.read(body(), type);
    }

    @Override
    public String remoteAddr() {
        return remoteAddr;
    }

    @Override
    public ClientInfo client() {
        return ClientInfo.UNKNOWN;
    }

    @Override
    public Optional<Object> attribute(String key) {
        return Optional.ofNullable(attributes.get(key));
    }

    @Override
    public void setAttribute(String key, Object value) {
        attributes.put(key, value);
    }
}
