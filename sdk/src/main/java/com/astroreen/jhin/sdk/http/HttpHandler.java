/**
 * Handles one matched HTTP request and produces the response.
 *
 * <p>Implemented by a plugin and registered with a {@link RouteSpec} through
 * {@link HttpRegistry#route(RouteSpec)}. The kernel invokes it when an
 * incoming request matches the route's method and path template and all
 * filters have run (or short-circuited).
 */
package com.astroreen.jhin.sdk.http;

public interface HttpHandler {

    /**
     * Produces the response for one request. Called by the kernel on the
     * request thread once the route has matched.
     *
     * @param req the request, with {@link HttpRequest#pathParams()} filled by
     *            the route matcher
     * @return the response to send
     * @throws Exception when handling fails; the kernel maps it to a 500
     *         response and logs the stack trace
     */
    HttpResponse handle(HttpRequest req) throws Exception;
}
