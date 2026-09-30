/**
 * A request filter: inspects or rewrites the request and/or response.
 *
 * <p>Implemented by a plugin and registered with a {@link FilterSpec} through
 * {@link HttpRegistry#filter(FilterSpec)}. The kernel calls it on every
 * request whose path matches the filter's {@link FilterSpec#pathPrefix()}, in
 * ascending {@link FilterSpec#order()}. Typical uses: authentication (storing
 * a principal attribute), rate limiting and response decoration.
 */
package com.astroreen.jhin.sdk.http;

public interface HttpFilter {

    /**
     * Filters one request. Called by the kernel before the route handler.
     * Invoke {@link FilterChain#proceed} to continue towards the handler;
     * returning without calling it short-circuits the chain and the returned
     * response is sent as-is.
     *
     * @param req   the request
     * @param chain the remainder of the chain
     * @return the response to send
     * @throws Exception when filtering fails; the kernel maps it to a 500
     *         response and logs the stack trace
     */
    HttpResponse filter(HttpRequest req, FilterChain chain) throws Exception;
}
