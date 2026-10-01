/**
 * Minimal {@link com.astroreen.jhin.sdk.http.HttpRequest} fake for route
 * tests: fixed method and path with an empty body.
 */
package com.astroreen.jhin.plugin.reload;

import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class FakeHttpRequest implements HttpRequest {

    private final String method;
    private final String path;
    private final Map<String, Object> attributes = new HashMap<>();

    FakeHttpRequest(String method, String path) {
        this.method = method;
        this.path = path;
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
        return Map.of();
    }

    @Override
    public byte[] body() {
        return new byte[0];
    }

    @Override
    public String bodyAsString() {
        return "";
    }

    @Override
    public <T> T bodyAs(Class<T> type) {
        return Json.read(body(), type);
    }

    @Override
    public String remoteAddr() {
        return "loopback";
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
