/**
 * Writes one SDK response to the raw servlet exchange.
 *
 * <p>Normal responses are written as status, headers and body bytes; a
 * response carrying an SSE marker is handed to the registered
 * {@link SseHandoff} instead. Uncaught failures from filters and route
 * handlers are turned into a {@code 500} answer whose body names only the
 * exception class — the full stack trace goes to the log, never to the
 * client.
 */
package com.astroreen.jhin.kernel.http;

import com.astroreen.jhin.sdk.http.HttpResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class ResponseWriter {

    private static final Logger LOG = LoggerFactory.getLogger(ResponseWriter.class);

    /** The streaming hand-off, or {@code null} when the stream layer is absent. */
    private final SseHandoff sseHandoff;

    /**
     * Creates a writer that answers SSE-marked responses with a {@code 500},
     * for a kernel without the stream layer.
     */
    public ResponseWriter() {
        this(null);
    }

    /**
     * Creates a writer that hands SSE-marked responses to the given seam.
     *
     * @param sseHandoff the streaming hand-off, {@code null} for none
     */
    public ResponseWriter(SseHandoff sseHandoff) {
        this.sseHandoff = sseHandoff;
    }

    /**
     * Writes one response: status and headers first, then either the hand-off
     * for an SSE-marked response or the body bytes. Called by the servlet
     * bridge for every answer that leaves the kernel.
     *
     * @param request  the raw request, needed by the streaming hand-off
     * @param raw      the raw response to write to
     * @param response the response to write
     * @throws IOException when the client connection fails
     */
    public void write(HttpServletRequest request, HttpServletResponse raw, HttpResponse response)
            throws IOException {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(raw, "raw");
        Objects.requireNonNull(response, "response");
        if (response.sse() != null) {
            writeStreamed(request, raw, response);
            return;
        }
        copyStatusAndHeaders(raw, response);
        byte[] body = response.body();
        if (body.length > 0) {
            raw.setContentLength(body.length);
            raw.getOutputStream().write(body);
        }
    }

    /**
     * Logs one uncaught failure with its stack trace and writes the generic
     * {@code 500} answer naming only the exception class. Called by the
     * servlet bridge when dispatching throws.
     *
     * @param request the raw request being served
     * @param raw     the raw response to write to
     * @param failure the uncaught failure
     * @throws IOException when the client connection fails
     */
    public void writeInternalError(HttpServletRequest request, HttpServletResponse raw, Exception failure)
            throws IOException {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(raw, "raw");
        Objects.requireNonNull(failure, "failure");
        LOG.error("unhandled failure while serving {} {}", request.getMethod(), request.getRequestURI(), failure);
        write(request, raw, HttpResponse.error(500, "internal", failure.getClass().getName()));
    }

    /** Copies status and headers, then hands the connection to the stream layer. */
    private void writeStreamed(HttpServletRequest request, HttpServletResponse raw, HttpResponse response)
            throws IOException {
        if (sseHandoff == null) {
            LOG.error("response carries an SSE marker but the stream layer is not installed");
            write(request, raw, HttpResponse.error(500, "internal", "streaming is not available"));
            return;
        }
        copyStatusAndHeaders(raw, response);
        try {
            sseHandoff.handOff(request, raw, response.sse());
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("streaming failed", e);
        }
    }

    /** Copies the response status and headers onto the raw response. */
    private static void copyStatusAndHeaders(HttpServletResponse raw, HttpResponse response) {
        raw.setStatus(response.status());
        for (Map.Entry<String, String> header : response.headers().entrySet()) {
            raw.setHeader(header.getKey(), header.getValue());
        }
    }
}
