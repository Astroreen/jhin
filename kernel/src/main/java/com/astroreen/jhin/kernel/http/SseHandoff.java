/**
 * Hand-off seam between the response writer and the streaming layer.
 *
 * <p>A route handler can answer with an
 * {@link com.astroreen.jhin.sdk.http.HttpResponse} that carries an SSE marker
 * instead of a body. The response writer does not stream such a connection
 * itself: it hands the raw exchange and the marker to the implementation
 * registered here, which owns the connection from then on. The stream layer
 * plugs in by implementing this interface and registering it as a bean; when
 * no implementation is registered, a marked response is answered with a
 * {@code 500} and the fact is logged.
 */
package com.astroreen.jhin.kernel.http;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Streams one SSE-marked response to the client.
 */
public interface SseHandoff {

    /**
     * Writes the SSE-marked response to the raw exchange and keeps the
     * connection open until the stream finishes. Called by the response writer
     * on the request thread once the status and headers are written.
     *
     * @param request  the raw request
     * @param response the raw response
     * @param sse      the SSE marker carried by the response
     * @throws Exception when streaming fails
     */
    void handOff(HttpServletRequest request, HttpServletResponse response, Object sse) throws Exception;
}
