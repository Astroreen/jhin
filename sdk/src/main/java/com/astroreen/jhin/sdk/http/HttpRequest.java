/**
 * One incoming HTTP request, as seen by filters and route handlers.
 *
 * <p>Implemented by the kernel (adapting the underlying servlet request) and
 * handed to {@link HttpFilter#filter} and {@link HttpHandler#handle}. Header
 * names are lower-cased; request attributes are the seam through which a
 * filter hands derived values (like an authenticated principal) to the route
 * handler.
 */
package com.astroreen.jhin.sdk.http;

public interface HttpRequest {

    /**
     * The HTTP method (for example {@code GET}), as received. Called by route
     * handlers that serve several methods on one path.
     *
     * @return the request method
     */
    String method();

    /**
     * The request path without the query string. Called by handlers that
     * inspect the URL beyond the template captures.
     *
     * @return the request path
     */
    String path();

    /**
     * Path template captures of the matched route (for example {@code id} for
     * {@code /sessions/{id}/events}), filled by the kernel's route matcher.
     * Called by handlers to read the captured identifiers.
     *
     * @return the captured path parameters
     */
    java.util.Map<String, String> pathParams();

    /**
     * Query string parameters, multi-valued and in order of appearance.
     * Called by handlers implementing pagination, filtering or other options.
     *
     * @return the query parameters
     */
    java.util.Map<String, java.util.List<String>> query();

    /**
     * Request headers with lower-cased names. Called by handlers and filters
     * that read protocol or client headers.
     *
     * @return the request headers
     */
    java.util.Map<String, String> headers();

    /**
     * The raw request body. Called by handlers that need the bytes as-is.
     *
     * @return the request body
     */
    byte[] body();

    /**
     * The request body decoded as a UTF-8 string. Called by handlers that
     * receive plain-text payloads.
     *
     * @return the request body as text
     */
    String bodyAsString();

    /**
     * The request body deserialized to {@code type} with Jackson. Called by
     * handlers that receive JSON payloads.
     *
     * @param <T>  the target type
     * @param type the class to deserialize into
     * @return the deserialized body
     */
    <T> T bodyAs(Class<T> type);

    /**
     * The remote address of the client. Called by rate-limiting and security
     * filters.
     *
     * @return the client address
     */
    String remoteAddr();

    /**
     * Parsed X-Jhin-Client (D-22). Never null; ClientInfo.UNKNOWN when absent
     * or malformed. Called by handlers and plugins to degrade output the
     * client cannot honour ({@link ClientInfo#supports(String)}).
     *
     * @return the parsed client info
     */
    ClientInfo client();

    /**
     * A request-scoped attribute set earlier on this request. Called by route
     * handlers to read values a filter stored — for example the authenticated
     * principal a security filter placed under a well-known key.
     *
     * @param key the attribute key
     * @return the attribute value, empty when absent
     */
    java.util.Optional<Object> attribute(String key);

    /**
     * Stores a request-scoped attribute: this is how a filter hands a
     * principal to a route. Called by filters before invoking
     * {@link FilterChain#proceed}.
     *
     * @param key   the attribute key
     * @param value the attribute value
     */
    void setAttribute(String key, Object value);
}
