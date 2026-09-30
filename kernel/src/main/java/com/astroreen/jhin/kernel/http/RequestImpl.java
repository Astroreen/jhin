/**
 * The kernel's view of one incoming request, adapting the servlet exchange to
 * the SDK request contract.
 *
 * <p>Built once per request by the servlet bridge. Header names are
 * lower-cased; headers and query parameters are snapshotted at construction;
 * the body is read lazily on first access and cached; the client info is
 * parsed lazily from the {@code X-Jhin-Client} header and memoized. The path
 * template captures are injected by the route matcher after resolution and
 * then visible to filters and the route handler. Attributes live in a
 * request-local map and are the seam through which a filter hands derived
 * values to the route handler.
 */
package com.astroreen.jhin.kernel.http;

import com.astroreen.jhin.sdk.http.ClientInfo;
import com.astroreen.jhin.sdk.http.HttpRequest;
import com.astroreen.jhin.sdk.json.Json;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

public final class RequestImpl implements HttpRequest {

    /** Header carrying the client identity and capability declaration. */
    private static final String CLIENT_HEADER = "x-jhin-client";

    private final HttpServletRequest raw;
    private final String method;
    private final String path;
    private final Map<String, List<String>> query;
    private final Map<String, String> headers;
    private final Map<String, Object> attributes = new LinkedHashMap<>();

    private Map<String, String> pathParams = Map.of();
    private byte[] body;
    private ClientInfo client;

    /**
     * Adapts one servlet exchange, snapshotting its method, path, query and
     * headers. Called by the servlet bridge before route resolution.
     *
     * @param raw the servlet exchange to adapt
     */
    public RequestImpl(HttpServletRequest raw) {
        this.raw = Objects.requireNonNull(raw, "raw");
        this.method = raw.getMethod();
        this.path = pathOf(raw);
        this.query = queryOf(raw.getQueryString());
        this.headers = headersOf(raw);
    }

    /**
     * The request method as received.
     *
     * @return the request method
     */
    @Override
    public String method() {
        return method;
    }

    /**
     * The request path without the query string, without the context path.
     *
     * @return the request path
     */
    @Override
    public String path() {
        return path;
    }

    /**
     * The path template captures of the matched route, empty until the route
     * matcher injects them.
     *
     * @return the captured path parameters
     */
    @Override
    public Map<String, String> pathParams() {
        return pathParams;
    }

    /**
     * The query string parameters, multi-valued and in order of appearance.
     *
     * @return the query parameters
     */
    @Override
    public Map<String, List<String>> query() {
        return query;
    }

    /**
     * The request headers with lower-cased names.
     *
     * @return the request headers
     */
    @Override
    public Map<String, String> headers() {
        return headers;
    }

    /**
     * The raw request body. Read from the exchange once and cached; the
     * returned array is a copy, so callers may keep or mutate it freely.
     *
     * @return the request body
     */
    @Override
    public byte[] body() {
        if (body == null) {
            try (InputStream in = raw.getInputStream()) {
                body = in.readAllBytes();
            } catch (IOException e) {
                throw new UncheckedIOException("failed to read the request body", e);
            }
        }
        return body.clone();
    }

    /**
     * The request body decoded as UTF-8 text.
     *
     * @return the request body as text
     */
    @Override
    public String bodyAsString() {
        return new String(body(), StandardCharsets.UTF_8);
    }

    /**
     * The request body deserialized with the shared JSON codec.
     *
     * @param <T>  the target type
     * @param type the class to deserialize into
     * @return the deserialized body
     */
    @Override
    public <T> T bodyAs(Class<T> type) {
        return Json.read(body(), type);
    }

    /**
     * The remote address of the client as seen by the servlet container.
     *
     * @return the client address
     */
    @Override
    public String remoteAddr() {
        return raw.getRemoteAddr();
    }

    /**
     * The parsed {@code X-Jhin-Client} header. Parsed on first access and
     * memoized; {@link ClientInfo#UNKNOWN} when the header is absent or
     * malformed. The kernel only forwards the raw string to the parser, it
     * never branches on a capability.
     *
     * @return the parsed client info
     */
    @Override
    public ClientInfo client() {
        if (client == null) {
            client = ClientInfo.parse(headers.get(CLIENT_HEADER));
        }
        return client;
    }

    /**
     * A request-scoped attribute set earlier on this request.
     *
     * @param key the attribute key
     * @return the attribute value, empty when absent
     */
    @Override
    public Optional<Object> attribute(String key) {
        return Optional.ofNullable(attributes.get(key));
    }

    /**
     * Stores a request-scoped attribute: this is how a filter hands a derived
     * value to the route handler.
     *
     * @param key   the attribute key
     * @param value the attribute value
     */
    @Override
    public void setAttribute(String key, Object value) {
        attributes.put(key, value);
    }

    /**
     * Installs the path template captures of the matched route. Called by the
     * servlet bridge right after route resolution, before any filter runs.
     *
     * @param params the captured path parameters
     */
    void injectPathParams(Map<String, String> params) {
        pathParams = Map.copyOf(Objects.requireNonNull(params, "params"));
    }

    /** The request path: the URI without the context path, {@code /} at worst. */
    private static String pathOf(HttpServletRequest raw) {
        String uri = raw.getRequestURI();
        String context = raw.getContextPath();
        String result = (uri == null) ? "" : uri;
        if (context != null && !context.isEmpty() && result.startsWith(context)) {
            result = result.substring(context.length());
        }
        return result.isEmpty() ? "/" : result;
    }

    /** The query string parsed into multi-valued, order-preserving parameters. */
    private static Map<String, List<String>> queryOf(String queryString) {
        Map<String, List<String>> collected = new LinkedHashMap<>();
        if (queryString != null && !queryString.isEmpty()) {
            for (String pair : queryString.split("&")) {
                if (pair.isEmpty()) {
                    continue;
                }
                int eq = pair.indexOf('=');
                String key = decode((eq < 0) ? pair : pair.substring(0, eq));
                String value = (eq < 0) ? "" : decode(pair.substring(eq + 1));
                collected.computeIfAbsent(key, ignored -> new ArrayList<>()).add(value);
            }
        }
        Map<String, List<String>> frozen = new LinkedHashMap<>();
        collected.forEach((key, values) -> frozen.put(key, List.copyOf(values)));
        return Collections.unmodifiableMap(frozen);
    }

    /** The exchange headers copied with lower-cased names. */
    private static Map<String, String> headersOf(HttpServletRequest raw) {
        Map<String, String> collected = new LinkedHashMap<>();
        Enumeration<String> names = raw.getHeaderNames();
        if (names != null) {
            while (names.hasMoreElements()) {
                String name = names.nextElement();
                collected.put(name.toLowerCase(Locale.ROOT), raw.getHeader(name));
            }
        }
        return Collections.unmodifiableMap(collected);
    }

    /** One URL-encoded query fragment decoded as UTF-8. */
    private static String decode(String text) {
        return URLDecoder.decode(text, StandardCharsets.UTF_8);
    }
}
