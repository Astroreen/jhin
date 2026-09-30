/**
 * Minimal {@link com.astroreen.jhin.sdk.http.HttpRequest} fake for route
 * tests: fixed method, path, path captures, query parameters and body, with a
 * local attribute map for the request principal seam.
 */
package com.astroreen.jhin.plugin.llm;

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
    private final Map<String, String> pathParams;
    private final Map<String, List<String>> query;
    private final byte[] body;
    private final Map<String, Object> attributes = new HashMap<>();

    FakeHttpRequest(String method, String path, Map<String, String> pathParams,
                    Map<String, List<String>> query, String body) {
        this.method = method;
        this.path = path;
        this.pathParams = Map.copyOf(pathParams);
        this.query = Map.copyOf(query);
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
        return pathParams;
    }

    @Override
    public Map<String, List<String>> query() {
        return query;
    }

    @Override
    public Map<String, String> headers() {
        return Map.of();
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
        return "127.0.0.1";
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
